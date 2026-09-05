// @vitest-environment jsdom

import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
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
    messageFileContext: vi.fn(async () => null),
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

    expect((await rendered.findByText("Decision needed")).tagName).toBe("STRONG");
    expect(rendered.container.querySelector("img")).toBeNull();
    fireEvent.click(rendered.getByRole("link", { name: "Open sender thread Build worker" }));
    expect(rendered.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thread-sender" });
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

const fileContext = {
  hostId: "host-sender", environmentId: "env-sender", threadId: "thread-sender",
  workspacePath: "/Users/pixexid/Projects/nuvyr-landscaping-concept-2026-09-05",
  storageRootPath: "/Users/pixexid/.bb/thread-storage/thread-sender",
};
const png = `${fileContext.workspacePath}/showcase/demos/002-landscaping-hardscaping/evidence/qa-final/home-1440-900-true.png`;
const report = "/Users/pixexid/.bb/thread-storage/thr_tikuhzrqy8/REPORT.md";

async function renderBody(text: string, context: unknown = fileContext, openUrl = () => true) {
  const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  return renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [project], threads: [] },
    openUrl, openFilePreview: () => true,
    rpc: handlers({ operatorMessages: async () => ({ messages: [{ ...message, text }] }), messageFileContext: async () => context }) as never,
  });
}

it("routes the exact five-link matrix through native URL and file intents without browser file hrefs", async () => {
  const rendered = await renderBody(`[Preview](http://localhost:4422/) · [PNG](<${png}>) · [Report](${report}) · [GitHub](https://github.com/pixexid/nuvyr/pull/66) · [AGENTS](${fileContext.workspacePath}/AGENTS.md) · [Storage](${fileContext.storageRootPath}/REPORT.md)`);
  await rendered.findByRole("button", { name: "PNG" });
  for (const [name, url] of [["Preview", "http://localhost:4422/"], ["GitHub", "https://github.com/pixexid/nuvyr/pull/66"]]) {
    const link = rendered.getByRole("link", { name });
    expect(fireEvent.click(link)).toBe(false);
    expect(rendered.inspection.navigateCalls).toContainEqual({ method: "openUrl", url });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  }
  for (const [name, target] of [
    ["PNG", { kind: "workspace", environmentId: "env-sender", path: png.slice(fileContext.workspacePath.length + 1) }],
    ["Report", { kind: "host", hostId: "host-sender", path: report }],
    ["AGENTS", { kind: "workspace", environmentId: "env-sender", path: "AGENTS.md" }],
    ["Storage", { kind: "thread-storage", threadId: "thread-sender", path: "REPORT.md" }],
  ] as const) {
    const button = rendered.getByRole("button", { name });
    expect(button.hasAttribute("href")).toBe(false);
    fireEvent.click(button);
    expect(rendered.inspection.navigateCalls).toContainEqual({ method: "experimental_openFilePreview", options: { target, location: null } });
    const count = rendered.inspection.navigateCalls.length;
    fireEvent.contextMenu(button); fireEvent.dragStart(button); fireEvent(button, new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    expect(rendered.inspection.navigateCalls).toHaveLength(count);
    fireEvent.click(button, { ctrlKey: true });
    expect(rendered.inspection.navigateCalls.at(-1)).toEqual({ method: "experimental_openFilePreview", options: { target, location: null } });
  }
  expect(rendered.getByTestId("message-body").querySelectorAll("a")).toHaveLength(2);
  expect(rendered.getByLabelText("Reply text")).toBeTruthy();
});

it.each([null, { ...fileContext, threadId: "foreign" }, { ...fileContext, hostId: "" }, { ...fileContext, workspacePath: "/a/../b" }])("keeps invalid or unresolved context inert: %j", async (context) => {
  const rendered = await renderBody(`[PNG](${png})`, context);
  await rendered.findByText("PNG");
  await act(async () => { await Promise.resolve(); });
  expect(rendered.getByTestId("message-body").querySelector("a,button")).toBeNull();
  expect(rendered.inspection.navigateCalls).toEqual([]);
});

it("blocks image/reference/HTML media and unsafe or malformed destinations with the real parser", async () => {
  const unsafe = ["/a/../secret", "/a/%2e%2e/secret", "/a/%252e%252e/secret", "/a/%2F/secret", "//evil.test/file", "/a/%5csecret", "/a/%00secret", "/a/%ED%A0%80", "relative.png", "file:///etc/passwd", "javascript:alert%281%29", "data:text/html,hello", "/a/./b", "/a/%"];
  const rendered = await renderBody('**Strong**\n\n- item\n\n```html\n<img src="sample">\n```\n\n![beacon](https://evil.test/beacon)\n\n![ref][b]\n\n[b]: https://evil.test/ref\n\n<img src="https://evil.test/raw"><video src="https://evil.test/video"></video>\n\n<a href="javascript:alert(1)" target="_top" rel="opener">raw</a>\n\n' + unsafe.map((path, i) => `[Unsafe ${i}](<${path}>)`).join(' · '));
  const body = await rendered.findByTestId("message-body");
  await act(async () => { await Promise.resolve(); });
  expect(body.querySelector("img,video,audio,iframe,source,object,embed,a,button")).toBeNull();
  expect(body.querySelector("strong")).not.toBeNull();
  expect(body.querySelector("li")).not.toBeNull();
  expect(body.querySelector("pre code")).not.toBeNull();
  expect(rendered.inspection.navigateCalls).toEqual([]);
});

it("does not lend late sender context to another message or a reply", async () => {
  const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  let finish: (value: typeof fileContext) => void = () => {};
  const late = new Promise<typeof fileContext>((resolve) => { finish = resolve; });
  const second = { ...message, messageId: 2, senderThreadId: "thread-other", text: `[Second](${png})`, replyText: `[Reply](${png})`, replyAcceptedAtMs: 2 };
  const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [project], threads: [] },
    rpc: handlers({ operatorMessages: async () => ({ messages: [message, second] }), messageFileContext: async ({ messageId }: { messageId: number }) => messageId === 1 ? late : null }) as never,
  });
  await rendered.findByTestId("message-body");
  fireEvent.click(rendered.getByRole("button", { name: /^Expand message #2/ }));
  await rendered.findByText("Second");
  await act(async () => { finish(fileContext); await late; });
  for (const body of rendered.getAllByTestId("message-body")) expect(body.querySelector("a,button")).toBeNull();
});

it("retains only a safe new-tab fallback when native URL opening declines", async () => {
  const rendered = await renderBody("[Preview](http://localhost:4422/)", fileContext, () => false);
  await rendered.findByRole("link", { name: "Preview" });
  await act(async () => { await Promise.resolve(); });
  const link = rendered.getByRole("link", { name: "Preview" });
  let preventedByPlugin = true;
  rendered.container.addEventListener("click", (event) => {
    preventedByPlugin = event.defaultPrevented;
    event.preventDefault();
  }, { once: true });
  fireEvent.click(link);
  expect(preventedByPlugin).toBe(false);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(rendered.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: "http://localhost:4422/" });
});

it("expands one card at a time, preserves drafts, and keeps all cards collapsed across refresh", async () => {
  const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  const second = { ...message, messageId: 2, text: "Second message body" };
  const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [project], threads: [] },
    rpc: handlers({ operatorMessages: async () => ({ messages: [message, second] }) }) as never,
  });
  const firstToggle = await rendered.findByRole("button", { name: /^Collapse message #1/ });
  expect(firstToggle.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(firstToggle.getAttribute("aria-controls")!)?.contains(rendered.getByTestId("message-body"))).toBe(true);
  fireEvent.change(rendered.getByLabelText("Reply text"), { target: { value: "Keep this draft" } });
  fireEvent.click(firstToggle);
  expect(rendered.queryByTestId("message-body")).toBeNull();
  expect(rendered.queryByLabelText("Reply text")).toBeNull();
  fireEvent.click(rendered.getByRole("button", { name: "Refresh inbox" }));
  await waitFor(() => expect(rendered.queryByText("Loading messages…")).toBeNull());
  expect(rendered.queryByTestId("message-body")).toBeNull();
  fireEvent.click(rendered.getByRole("button", { name: /^Expand message #2/ }));
  expect(rendered.getAllByTestId("message-body")).toHaveLength(1);
  expect(rendered.getByTestId("message-body").textContent).toBe(second.text);
  expect((rendered.getByLabelText("Reply text") as HTMLTextAreaElement).value).toBe("");
  fireEvent.click(rendered.getByRole("button", { name: /^Expand message #1/ }));
  expect(rendered.getAllByTestId("message-body")).toHaveLength(1);
  expect((rendered.getByLabelText("Reply text") as HTMLTextAreaElement).value).toBe("Keep this draft");
});

it("keeps the message expanded when opening a native file panel", async () => {
  const rendered = await renderBody(`[PNG](${png})`);
  fireEvent.click(await rendered.findByRole("button", { name: "PNG" }));
  expect(rendered.getByRole("button", { name: /^Collapse message #1/ }).getAttribute("aria-expanded")).toBe("true");
  expect(rendered.getAllByTestId("message-body")).toHaveLength(1);
  expect(rendered.inspection.navigateCalls.at(-1)).toEqual({ method: "experimental_openFilePreview", options: {
    target: { kind: "workspace", environmentId: "env-sender", path: png.slice(fileContext.workspacePath.length + 1) }, location: null,
  } });
});
