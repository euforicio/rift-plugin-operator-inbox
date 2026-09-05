// @vitest-environment jsdom

import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarkdownProps } from "@get-bb/plugin-sdk/app";
import { INBOX_CHANGED_CHANNEL } from "../contract";

// The SDK harness intentionally does not parse Markdown. Inspect the public
// props/resolver here; real rendering/navigation negatives live in the core slice.
const markdown = vi.hoisted(() => vi.fn<(props: MarkdownProps) => void>());
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return { ...actual, Markdown: (props: MarkdownProps) => {
    markdown(props);
    return <actual.Markdown {...props} />;
  } };
});
function bodyProps(): MarkdownProps { return markdown.mock.calls.at(-1)![0]; }

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
  markdown.mockClear();
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

    expect((await rendered.findByTestId("bb-markdown")).textContent).toBe(message.text);
    expect(bodyProps().experimental_imagePolicy).toBe("alt-text");
    expect(bodyProps().experimental_resolveFileLink?.("/tmp/unknown.png")).toBeNull();
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

it("passes the unchanged #133 matrix to host Markdown with validated native file options", async () => {
  const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  const text = `[Live local preview](http://localhost:4422/) · [Desktop](<${png}>) · [Independent report](${report}) · [PR #66](https://github.com/pixexid/nuvyr/pull/66) · [AGENTS.md](${fileContext.workspacePath}/AGENTS.md)`;
  const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [project], threads: [] },
    rpc: handlers({ operatorMessages: async () => ({ messages: [{ ...message, text }] }), messageFileContext: async () => fileContext }) as never,
  });
  expect((await rendered.findByTestId("bb-markdown")).textContent).toBe(text);
  await waitFor(() => expect(bodyProps().experimental_resolveFileLink?.(png)).toEqual({
    target: { kind: "workspace", environmentId: "env-sender", path: png.slice(fileContext.workspacePath.length + 1) }, location: null,
  }));
  const resolve = bodyProps().experimental_resolveFileLink!;
  expect(resolve(`${fileContext.workspacePath}/AGENTS.md`)).toEqual({ target: { kind: "workspace", environmentId: "env-sender", path: "AGENTS.md" }, location: null });
  expect(resolve(report)).toEqual({ target: { kind: "host", hostId: "host-sender", path: report }, location: null });
  expect(resolve(`${fileContext.storageRootPath}/REPORT.md`)).toEqual({ target: { kind: "thread-storage", threadId: "thread-sender", path: "REPORT.md" }, location: null });
  expect(resolve(`${fileContext.workspacePath}-sibling/file.png`)).toEqual({ target: { kind: "host", hostId: "host-sender", path: `${fileContext.workspacePath}-sibling/file.png` }, location: null });
  expect(resolve("http://localhost:4422/")).toBeNull();
  expect(resolve("https://github.com/pixexid/nuvyr/pull/66")).toBeNull();
  expect(bodyProps().experimental_imagePolicy).toBe("alt-text");
  expect(rendered.inspection.navigateCalls).toEqual([]);
});

it.each([null, { ...fileContext, threadId: "foreign" }, { ...fileContext, hostId: "" }, { ...fileContext, workspacePath: "/a/../b" }])("keeps unresolved or invalid native context inert: %j", async (context) => {
  const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  const lookup = vi.fn(async () => context);
  const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [project], threads: [] },
    rpc: handlers({ messageFileContext: lookup }) as never,
  });
  await rendered.findByTestId("bb-markdown");
  await act(async () => { await Promise.resolve(); });
  expect(lookup).toHaveBeenCalledWith({ projectId: "project-a", messageId: 1 });
  expect(bodyProps().experimental_resolveFileLink?.(png)).toBeNull();
  expect(rendered.inspection.navigateCalls).toEqual([]);
});

it("rejects unsafe local destinations and delegates unmodified Markdown safety to the host policy", async () => {
  const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  const text = '# Heading\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- item\n\n```html\n<img src="sample">\n```\n\n![beacon](https://evil.test/beacon)\n\n![ref][b]\n\n[b]: https://evil.test/ref\n\n<img src="https://evil.test/raw">\n\n<a href="javascript:alert(1)" target="_top" rel="opener">raw</a>';
  const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [project], threads: [] },
    rpc: handlers({ operatorMessages: async () => ({ messages: [{ ...message, text }] }), messageFileContext: async () => fileContext }) as never,
  });
  expect((await rendered.findByTestId("bb-markdown")).textContent).toBe(text);
  await waitFor(() => expect(bodyProps().experimental_resolveFileLink?.(png)).not.toBeNull());
  for (const path of ["/a/../secret", "/a/%2e%2e/secret", "/a/%252e%252e/secret", "/a/%2F/secret", "//evil.test/file", "/a/%5csecret", "/a/%00secret", "/a/%ED%A0%80", "relative.png", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "/a/./b", "/a/%", String.fromCharCode(0xd800)]) {
    expect(bodyProps().experimental_resolveFileLink?.(path), path).toBeNull();
  }
  expect(bodyProps().experimental_imagePolicy).toBe("alt-text");
});

it("does not lend a late sender context to another selected message or to a reply", async () => {
  const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  let finish: (value: typeof fileContext) => void = () => {};
  const late = new Promise<typeof fileContext>((resolve) => { finish = resolve; });
  const second = { ...message, messageId: 2, senderThreadId: "thread-other", text: "Second body", replyText: "Reply body", replyAcceptedAtMs: 2 };
  const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [project], threads: [] },
    rpc: handlers({
      operatorMessages: async () => ({ messages: [message, second] }),
      messageFileContext: async ({ messageId }: { messageId: number }) => messageId === 1 ? late : null,
    }) as never,
  });
  await rendered.findByTestId("bb-markdown");
  fireEvent.click(rendered.getByRole("button", { name: /^Select message #2/ }));
  await waitFor(() => expect(rendered.getAllByTestId("bb-markdown").some((body) => body.textContent === "Second body")).toBe(true));
  await act(async () => { finish(fileContext); await late; });
  const current = markdown.mock.calls.map(([props]) => props).filter((props) => props.content === "Second body" || props.content === "Reply body");
  expect(current.length).toBeGreaterThan(0);
  for (const props of current) {
    expect(props.experimental_imagePolicy).toBe("alt-text");
    expect(props.experimental_resolveFileLink?.(png)).toBeNull();
  }
});
