import { defineRpcContract } from "@riftlabs/plugin-sdk";
import { z } from "zod";

const id = z.string().trim().min(1).max(256);
const text = z.string().trim().min(1).max(16_000);
const messageId = z.number().int().positive();
const projectIds = z.array(id).min(1).max(256);

export const INBOX_CHANGED_CHANNEL = "messages-changed";

export const operatorMessageSchema = z.object({
  messageId,
  projectId: id,
  senderThreadId: id,
  senderTitle: z.string().nullable(),
  severity: z.enum(["routine", "needs-decision", "urgent"]),
  text,
  createdAtMs: z.number().int().nonnegative(),
  readAtMs: z.number().int().nonnegative().nullable(),
  archivedAtMs: z.number().int().nonnegative().nullable(),
  replyText: text.nullable(),
  replyAcceptedAtMs: z.number().int().nonnegative().nullable(),
  replyDelivery: z.enum(["sent", "queued", "deferred"]).nullable(),
}).strict();

export const operatorMessagesInputSchema = z.object({
  projectIds,
  includeArchived: z.boolean().optional(),
}).strict();

export const messageMutationInputSchema = z.object({ projectId: id, messageId }).strict();
export const replyInputSchema = messageMutationInputSchema.extend({ text }).strict();

// Only canonical POSIX absolute paths are accepted. Encoded separators/dot segments
// are decoded once before validation; ambiguous double encoding remains inert.
export function safeAbsolutePath(path: string): boolean {
  try { encodeURIComponent(path); } catch { return false; }
  return path.startsWith("/") && !/[\\%?#\x00-\x1f\x7f]/.test(path)
    && path.slice(1).split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export const fileContextSchema = z.object({
  hostId: id,
  environmentId: id,
  workspacePath: z.string().refine(safeAbsolutePath).nullable(),
  threadId: id,
  storageRootPath: z.string().refine(safeAbsolutePath),
}).strict();

export const rpcContract = defineRpcContract({
  messageFileContext: {
    input: messageMutationInputSchema,
    output: fileContextSchema.nullable(),
  },
  operatorMessages: {
    input: operatorMessagesInputSchema,
    output: z.object({ messages: z.array(operatorMessageSchema) }).strict(),
  },
  unreadOperatorMessageCount: {
    input: z.object({ projectIds }).strict(),
    output: z.object({ count: z.number().int().nonnegative() }).strict(),
  },
  markOperatorMessageRead: { input: messageMutationInputSchema, output: operatorMessageSchema },
  archiveOperatorMessage: { input: messageMutationInputSchema, output: operatorMessageSchema },
  replyToOperatorMessage: { input: replyInputSchema, output: operatorMessageSchema },
});
