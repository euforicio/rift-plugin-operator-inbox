import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  INBOX_CHANGED_CHANNEL,
  fileContextSchema,
  operatorMessageSchema,
  operatorMessagesInputSchema,
  replyInputSchema,
  rpcContract,
} from "./contract.js";

type Message = z.infer<typeof operatorMessageSchema>;
type MessageRow = {
  id: number;
  project_id: string;
  sender_thread_id: string;
  sender_title: string | null;
  severity: Message["severity"];
  body: string;
  created_at_ms: number;
  read_at_ms: number | null;
  archived_at_ms: number | null;
  reply_text: string | null;
  reply_accepted_at_ms: number | null;
  reply_delivery: Message["replyDelivery"];
};

const messageBodyGuidance = "Text must be concise, decision-first Markdown. Separate multi-part requests with blank lines and bullets or numbered items.";
const messageToolInput = z.object({
  severity: z.enum(["routine", "needs-decision", "urgent"]),
  text: z.string().trim().min(1).max(16_000).describe(messageBodyGuidance),
}).strict();

function toMessage(row: MessageRow): Message {
  return {
    messageId: row.id,
    projectId: row.project_id,
    senderThreadId: row.sender_thread_id,
    senderTitle: row.sender_title,
    severity: row.severity,
    text: row.body,
    createdAtMs: row.created_at_ms,
    readAtMs: row.read_at_ms,
    archivedAtMs: row.archived_at_ms,
    replyText: row.reply_text,
    replyAcceptedAtMs: row.reply_accepted_at_ms,
    replyDelivery: row.reply_delivery,
  };
}

function getMessage(db: Database.Database, projectId: string, messageId: number): Message {
  const row = db.prepare("SELECT * FROM messages WHERE project_id = ? AND id = ?").get(projectId, messageId) as MessageRow | undefined;
  if (!row) throw new Error("Operator Inbox message not found in this project");
  return toMessage(row);
}

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      sender_thread_id TEXT NOT NULL,
      sender_title TEXT,
      severity TEXT NOT NULL CHECK (severity IN ('routine', 'needs-decision', 'urgent')),
      body TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      read_at_ms INTEGER,
      archived_at_ms INTEGER,
      reply_text TEXT,
      reply_accepted_at_ms INTEGER,
      reply_delivery TEXT CHECK (reply_delivery IN ('sent', 'queued', 'deferred'))
    );
    CREATE INDEX messages_project_created ON messages(project_id, created_at_ms DESC);
    CREATE INDEX messages_project_unread ON messages(project_id, read_at_ms, archived_at_ms);`,
  ]);

  const publishChange = (projectId: string) => bb.realtime.publish(INBOX_CHANGED_CHANNEL, { projectId });
  const updateTimestamp = (column: "read_at_ms" | "archived_at_ms", projectId: string, messageId: number) => {
    db.prepare(`UPDATE messages SET ${column} = COALESCE(${column}, ?) WHERE project_id = ? AND id = ?`).run(Date.now(), projectId, messageId);
    const message = getMessage(db, projectId, messageId);
    publishChange(projectId);
    return message;
  };
  const replies = new Map<string, Promise<Message>>();

  bb.agents.registerTool({
    name: "send_operator_inbox_message",
    description: "Store a message for the human operator in this thread's project-scoped Operator Inbox.",
    instructions: `Use this only when the human operator should see a durable message. Choose routine, urgent, or needs-decision severity. ${messageBodyGuidance}`,
    presentation: { label: { pending: "Sending Operator Inbox message", completed: "Sent Operator Inbox message" } },
    parameters: messageToolInput,
    async execute({ severity, text }, { projectId, threadId }) {
      let senderTitle: string | null = null;
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        senderTitle = typeof thread.title === "string" && thread.title.trim() ? thread.title : null;
      } catch {
        // The durable thread id is enough for navigation when title lookup is unavailable.
      }
      const result = db.prepare(`INSERT INTO messages
        (project_id, sender_thread_id, sender_title, severity, body, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)`).run(projectId, threadId, senderTitle, severity, text, Date.now());
      publishChange(projectId);
      return `Stored Operator Inbox message #${Number(result.lastInsertRowid)} for project ${projectId}.`;
    },
  });

  bb.rpc.register(rpcContract, {
    async messageFileContext({ projectId, messageId }) {
      const message = getMessage(db, projectId, messageId);
      try {
        const thread = await bb.sdk.threads.get({ threadId: message.senderThreadId, include: "environment" });
        const environment = "environment" in thread ? thread.environment : null;
        if (thread.id !== message.senderThreadId || thread.projectId !== projectId || thread.deletedAt !== null
          || !environment || environment.id !== thread.environmentId || environment.projectId !== projectId
          || environment.status !== "ready") return null;
        const storage = await bb.sdk.threads.storageLocation({ threadId: thread.id });
        if (storage.hostId !== environment.hostId) return null;
        const context = fileContextSchema.safeParse({
          hostId: environment.hostId, environmentId: environment.id, workspacePath: environment.path,
          threadId: thread.id, storageRootPath: storage.storageRootPath,
        });
        return context.success ? context.data : null;
      } catch {
        return null; // Missing native context must never fall back to this plugin's host/cwd.
      }
    },
    operatorMessages(input: z.infer<typeof operatorMessagesInputSchema>) {
      const placeholders = input.projectIds.map(() => "?").join(", ");
      const rows = db.prepare(`SELECT * FROM messages
        WHERE project_id IN (${placeholders}) ${input.includeArchived ? "" : "AND archived_at_ms IS NULL"}
        ORDER BY (read_at_ms IS NOT NULL), created_at_ms DESC, id DESC
        LIMIT 256`).all(...input.projectIds) as MessageRow[];
      return { messages: rows.map(toMessage) };
    },
    unreadOperatorMessageCount({ projectIds }) {
      const placeholders = projectIds.map(() => "?").join(", ");
      const row = db.prepare(`SELECT COUNT(*) AS count FROM messages
        WHERE project_id IN (${placeholders}) AND read_at_ms IS NULL AND archived_at_ms IS NULL`).get(...projectIds) as { count: number };
      return { count: row.count };
    },
    markOperatorMessageRead({ projectId, messageId }) {
      return updateTimestamp("read_at_ms", projectId, messageId);
    },
    archiveOperatorMessage({ projectId, messageId }) {
      return updateTimestamp("archived_at_ms", projectId, messageId);
    },
    replyToOperatorMessage(input: z.infer<typeof replyInputSchema>) {
      const key = `${input.projectId}:${input.messageId}`;
      const existing = replies.get(key);
      if (existing) return existing;
      const operation = (async () => {
        const message = getMessage(db, input.projectId, input.messageId);
        if (message.replyAcceptedAtMs !== null) return message;
        const accepted = await bb.sdk.threads.send({
          threadId: message.senderThreadId,
          mode: "auto",
          input: [{ type: "text", text: `Operator reply to Inbox message #${message.messageId}:\n\n${input.text}`, mentions: [] }],
        });
        const acceptedAt = Date.now();
        db.prepare(`UPDATE messages SET reply_text = ?, reply_accepted_at_ms = ?, reply_delivery = ?,
          read_at_ms = COALESCE(read_at_ms, ?) WHERE project_id = ? AND id = ? AND reply_accepted_at_ms IS NULL`)
          .run(input.text, acceptedAt, accepted.delivery, acceptedAt, input.projectId, input.messageId);
        const updated = getMessage(db, input.projectId, input.messageId);
        publishChange(input.projectId);
        return updated;
      })().finally(() => replies.delete(key));
      replies.set(key, operation);
      return operation;
    },
  });
}
