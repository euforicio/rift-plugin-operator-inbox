import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server.js";

function host(delivery: "sent" | "queued" | "deferred" = "queued") {
  const get = vi.fn(async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, title: "Build worker" }));
  const storageLocation = vi.fn(async () => ({ hostId: "host-sender", storageRootPath: "/Users/pixexid/.bb/thread-storage/thread-sender" }));
  const send = vi.fn(async () => ({ ok: true as const, delivery }));
  const fixture = createFakePluginHost({
    pluginId: "operator-inbox",
    sdk: { threads: { get, send, storageLocation } },
  });
  plugin(fixture.bb);
  return { ...fixture, get, send, storageLocation };
}

async function storeMessage(fixture: ReturnType<typeof host>, overrides: Record<string, unknown> = {}) {
  return fixture.harness.behavior.callAgentTool(
    "send_operator_inbox_message",
    { severity: "needs-decision", text: "Choose the release window", ...overrides },
    { projectId: "project-a", threadId: "thread-sender" },
  );
}

describe("Operator Inbox backend", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requires concise structured Markdown in the agent tool contract", async () => {
    const fixture = host();
    const tool = fixture.harness.inspection.registrations.agentTools[0]!;
    const guidance = "Text must be concise, decision-first Markdown. Separate multi-part requests with blank lines and bullets or numbered items.";
    expect(tool.instructions).toContain(guidance);
    expect(tool.inputSchema).toEqual(expect.objectContaining({
      properties: expect.objectContaining({ text: expect.objectContaining({ description: guidance }) }),
    }));
    await fixture.harness.lifecycle.dispose();
  });

  it("stores a durable project-scoped message from native tool context", async () => {
    const fixture = host();
    await expect(storeMessage(fixture)).resolves.toBe("Stored Operator Inbox message #1 for project project-a.");

    await expect(fixture.harness.behavior.callRpc("operatorMessages", { projectIds: ["project-a"] })).resolves.toEqual({
      messages: [expect.objectContaining({
        messageId: 1,
        projectId: "project-a",
        senderThreadId: "thread-sender",
        senderTitle: "Build worker",
        severity: "needs-decision",
        text: "Choose the release window",
        readAtMs: null,
        archivedAtMs: null,
      })],
    });
    await expect(fixture.harness.behavior.callRpc("operatorMessages", { projectIds: ["project-b"] })).resolves.toEqual({ messages: [] });
    expect(fixture.get).toHaveBeenCalledWith({ threadId: "thread-sender" });
    expect(fixture.harness.inspection.realtimeSignals).toContainEqual({ channel: "messages-changed", payload: { projectId: "project-a" } });
    await fixture.harness.lifecycle.dispose();
  });

  it("validates severity and text before storing", async () => {
    const fixture = host();
    await expect(storeMessage(fixture, { severity: "critical" })).rejects.toThrow();
    await expect(storeMessage(fixture, { text: " " })).rejects.toThrow();
    await expect(fixture.harness.behavior.callRpc("operatorMessages", { projectIds: ["project-a"] })).resolves.toEqual({ messages: [] });
    await fixture.harness.lifecycle.dispose();
  });

  it("marks read and archives only the exact project message", async () => {
    const fixture = host();
    await storeMessage(fixture);

    await expect(fixture.harness.behavior.callRpc("markOperatorMessageRead", { projectId: "project-b", messageId: 1 })).rejects.toThrow("not found in this project");
    const read = await fixture.harness.behavior.callRpc("markOperatorMessageRead", { projectId: "project-a", messageId: 1 }) as { readAtMs: number | null };
    expect(read.readAtMs).toEqual(expect.any(Number));
    const archived = await fixture.harness.behavior.callRpc("archiveOperatorMessage", { projectId: "project-a", messageId: 1 }) as { archivedAtMs: number | null };
    expect(archived.archivedAtMs).toEqual(expect.any(Number));
    await expect(fixture.harness.behavior.callRpc("operatorMessages", { projectIds: ["project-a"] })).resolves.toEqual({ messages: [] });
    await expect(fixture.harness.behavior.callRpc("operatorMessages", { projectIds: ["project-a"], includeArchived: true })).resolves.toEqual({ messages: [expect.objectContaining({ messageId: 1 })] });
    await fixture.harness.lifecycle.dispose();
  });

  it("uses only threads.send and records BB acceptance without provider-consumption claims", async () => {
    const fixture = host("deferred");
    await storeMessage(fixture);

    const input = { projectId: "project-a", messageId: 1, text: "Use Tuesday" };
    const replied = await fixture.harness.behavior.callRpc("replyToOperatorMessage", input);
    const duplicate = await fixture.harness.behavior.callRpc("replyToOperatorMessage", { ...input, text: "Use Wednesday" });

    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledWith({
      threadId: "thread-sender",
      mode: "auto",
      input: [{ type: "text", text: "Operator reply to Inbox message #1:\n\nUse Tuesday", mentions: [] }],
    });
    expect(replied).toEqual(expect.objectContaining({ replyText: "Use Tuesday", replyDelivery: "deferred", replyAcceptedAtMs: expect.any(Number) }));
    expect(duplicate).toEqual(replied);
    expect(fixture.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    await fixture.harness.lifecycle.dispose();
  });

  it("registers no background, schedule, HTTP, CLI, or mention surfaces", async () => {
    const fixture = host();
    expect(fixture.harness.inspection.registrations.services).toEqual([]);
    expect(fixture.harness.inspection.registrations.schedules).toEqual([]);
    expect(fixture.harness.inspection.registrations.httpRoutes).toEqual([]);
    expect(fixture.harness.inspection.registrations.cli).toBeNull();
    expect(fixture.harness.inspection.registrations.mentionProviders).toEqual([]);
    await fixture.harness.lifecycle.dispose();
  });
});


it("derives file context only from the stored sender and rejects missing/foreign/mismatched context", async () => {
  const fixture = host();
  await storeMessage(fixture);
  const environment = { id: "env-sender", projectId: "project-a", hostId: "host-sender", path: "/Users/pixexid/Projects/demo", status: "ready" };
  const native = { ...makeThreadResponse({ id: "thread-sender", projectId: "project-a", environmentId: "env-sender" }), environment };
  fixture.get.mockResolvedValue(native);
  const input = { projectId: "project-a", messageId: 1 };
  await expect(fixture.harness.behavior.callRpc("messageFileContext", input)).resolves.toEqual({
    hostId: "host-sender", environmentId: "env-sender", workspacePath: environment.path,
    threadId: "thread-sender", storageRootPath: "/Users/pixexid/.bb/thread-storage/thread-sender",
  });
  expect(fixture.get).toHaveBeenLastCalledWith({ threadId: "thread-sender", include: "environment" });
  expect(fixture.storageLocation).toHaveBeenLastCalledWith({ threadId: "thread-sender" });
  for (const broken of [
    { ...native, id: "foreign" }, { ...native, projectId: "foreign" }, { ...native, deletedAt: 1 },
    { ...native, environment: null }, { ...native, environment: { ...environment, id: "foreign" } },
    { ...native, environment: { ...environment, projectId: "foreign" } },
    { ...native, environment: { ...environment, status: "destroyed" } },
    { ...native, environment: { ...environment, hostId: "foreign-host" } },
    { ...native, environment: { ...environment, path: "/a/../b" } },
  ]) {
    fixture.get.mockResolvedValue(broken);
    await expect(fixture.harness.behavior.callRpc("messageFileContext", input)).resolves.toBeNull();
  }
  fixture.get.mockRejectedValue(new Error("Unavailable"));
  await expect(fixture.harness.behavior.callRpc("messageFileContext", input)).resolves.toBeNull();
  const calls = fixture.get.mock.calls.length;
  await expect(fixture.harness.behavior.callRpc("messageFileContext", { ...input, projectId: "foreign" })).rejects.toThrow("not found");
  expect(fixture.get).toHaveBeenCalledTimes(calls);
  await expect(fixture.harness.behavior.callRpc("messageFileContext", { ...input, threadId: "forged" })).rejects.toThrow();
  await fixture.harness.lifecycle.dispose();
});
