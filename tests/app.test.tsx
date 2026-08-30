// @vitest-environment jsdom

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INBOX_CHANGED_CHANNEL } from "../contract";

const project = { id: "project-a", name: "Project A", isPersonal: false };
const message = {
  messageId: 1,
  projectId: "project-a",
  senderThreadId: "thread-sender",
  senderTitle: "Build worker",
  severity: "urgent" as const,
  text: "**Decision needed**\n\n- keep this\n\n![tracking](https://example.test/beacon.png)",
  createdAtMs: 1,
  readAtMs: null,
  archivedAtMs: null,
  replyText: null,
  replyAcceptedAtMs: null,
  replyDelivery: null,
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function loadApp() {
  const { loadPluginApp } = await import("@get-bb/plugin-sdk/testing/app");
  return loadPluginApp(() => import("../app"));
}

function handlers(overrides: Record<string, unknown> = {}) {
  return {
    operatorMessages: vi.fn(async () => ({ messages: [message] })),
    unreadOperatorMessageCount: vi.fn(async () => ({ count: 1 })),
    markOperatorMessageRead: vi.fn(async () => ({ ...message, readAtMs: 2 })),
    archiveOperatorMessage: vi.fn(async () => ({ ...message, archivedAtMs: 3 })),
    replyToOperatorMessage: vi.fn(async ({ text }: { text: string }) => ({ ...message, readAtMs: 4, replyText: text, replyAcceptedAtMs: 4, replyDelivery: "queued" as const })),
    ...overrides,
  };
}

describe("Operator Inbox panel", () => {
  it("renders safe Markdown and navigates to the recorded sender thread", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    const rendered = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers() as never,
    });

    expect(await rendered.findByText("Decision needed")).toBeTruthy();
    expect(rendered.getByText("tracking")).toBeTruthy();
    expect(rendered.container.querySelector("img")).toBeNull();
    fireEvent.click(rendered.getByRole("link", { name: "Open sender thread Build worker" }));
    expect(rendered.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thread-sender" });
  });

  it("presents long sequential one-line request sections as readable paragraphs", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    const text = [
      "Decision needed before the release train closes at 16:00 UTC:",
      "(1) Confirm whether the manager should keep the candidate frozen at build_2026_08_30 while the remaining browser evidence is collected. The current checks cover package integrity, exact project scoping, and reply acceptance, but they do not prove that the provider consumed the reply. Approving this option keeps the current evidence boundary and delays the operator-visible cutover until the browser check is attached.",
      "(2) Choose whether to reopen the candidate for the narrow presentation repair described in [the run record](https://example.test/runs/build_2026_08_30?view=operator). This option changes only future agent guidance and the Inbox rendering fallback; it does not rewrite stored messages, widen project access, change sender identity, alter reply delivery, add polling, or load remote images. If selected, the manager will rerun the existing verify and package checks before returning the new local commit.",
    ].join(" ");
    const rendered = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers({ operatorMessages: async () => ({ messages: [{ ...message, text }] }) }) as never,
    });

    const body = (await rendered.findByRole("heading", { name: "Message" })).closest("section")!;
    expect(Array.from(body.querySelectorAll("p"), (paragraph) => paragraph.textContent)).toEqual([
      "Decision needed before the release train closes at 16:00 UTC:",
      expect.stringMatching(/^\(1\) Confirm whether/),
      expect.stringMatching(/^\(2\) Choose whether/),
    ]);
    expect(body.querySelector("a")?.getAttribute("href")).toBe("https://example.test/runs/build_2026_08_30?view=operator");
    rendered.lifecycle.unmount();

    const short = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers({ operatorMessages: async () => ({ messages: [{ ...message, text: "Choose option (1) Tuesday or (2) Wednesday." }] }) }) as never,
    });
    const shortBody = (await short.findByRole("heading", { name: "Message" })).closest("section")!;
    expect(Array.from(shortBody.querySelectorAll("p"), (paragraph) => paragraph.textContent)).toEqual(["Choose option (1) Tuesday or (2) Wednesday."]);
  });

  it("keeps sender navigation when the stored title is unavailable", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    const rendered = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers({ operatorMessages: async () => ({ messages: [{ ...message, senderTitle: null }] }) }) as never,
    });

    fireEvent.click(await rendered.findByRole("link", { name: "Open sender thread Sender thread" }));
    expect(rendered.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thread-sender" });
    expect(rendered.queryByText("thread-sender")).toBeNull();
  });

  it("records reply acceptance without claiming provider delivery or consumption", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    const rpc = handlers();
    const rendered = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: rpc as never,
    });

    const editor = await rendered.findByLabelText("Reply text");
    fireEvent.change(editor, { target: { value: "Proceed Tuesday" } });
    fireEvent.click(rendered.getByRole("button", { name: "Send reply" }));
    expect(await rendered.findByText("Reply accepted by BB (queued). Provider consumption is not observed.")).toBeTruthy();
    expect(rpc.replyToOperatorMessage).toHaveBeenCalledWith({ projectId: "project-a", messageId: 1, text: "Proceed Tuesday" });
    expect(rendered.queryByText(/reply delivered/i)).toBeNull();
  });

  it("marks read, archives, and fails closed on a foreign-project row", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    const rpc = handlers();
    const rendered = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: rpc as never,
    });

    fireEvent.click(await rendered.findByRole("button", { name: "Mark message read" }));
    expect(await rendered.findByText("Marked read. This message is no longer counted as unread.")).toBeTruthy();
    fireEvent.click(rendered.getAllByRole("button", { name: "Archive message" }).at(-1)!);
    expect(await rendered.findByText("Archived. Turn on Show archived to include it again.")).toBeTruthy();

    const contaminated = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers({ operatorMessages: async () => ({ messages: [{ ...message, projectId: "project-b" }] }) }) as never,
    });
    expect(await contaminated.findByText(/returned a message from another project/)).toBeTruthy();
    expect(contaminated.queryByText("Decision needed")).toBeNull();
  });

  it("updates the unread accessory from realtime without polling", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    let count = 1;
    const unread = vi.fn(async () => ({ count }));
    const rendered = renderSlot({ component: app.navPanels[0]!.experimental_sidebarAccessory! }, {}, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers({ unreadOperatorMessageCount: unread }) as never,
    });

    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("1"));
    count = 2;
    await rendered.behavior.emitRealtime(INBOX_CHANGED_CHANNEL, { projectId: "project-a" });
    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("2"));
    expect(unread).toHaveBeenCalledTimes(2);
  });
});
