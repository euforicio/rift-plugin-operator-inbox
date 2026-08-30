import { defineRpcContract } from "@get-bb/plugin-sdk";
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

export const rpcContract = defineRpcContract({
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
