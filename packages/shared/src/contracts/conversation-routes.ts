/**
 * Zod schemas for the simple conversation HTTP routes.
 *
 * The chat-payload routes (`POST /api/conversations/:id/messages`
 * and the `/messages/stream` SSE variant) use a dedicated
 * `readChatRequestPayload` helper and aren't migrated here — they
 * share parsing with other chat endpoints and that helper is the
 * source of truth.
 *
 * Routes covered:
 *   POST  /api/conversations
 *     { title?, includeGreeting?, lang?, metadata? }
 *   POST  /api/conversations/:id/messages/truncate
 *     { messageId, inclusive? }
 *   PATCH /api/conversations/:id
 *     { title?, generate?, metadata? | null }
 *   POST  /api/conversations/cleanup-empty
 *     { keepId? }
 */

import z from "zod";

const ConversationScopeSchema = z.enum([
  "user",
  "page",
  "agent",
  "task",
  "workflow",
  "character",
  "trigger",
  "draft",
  "terminal",
]);

const ConversationAutomationTypeSchema = z.enum([
  "coordinator_text",
  "workflow",
]);

/**
 * Mirror of `ConversationMetadata` in agent/src/api/server-types.ts.
 * The server passes through `sanitizeConversationMetadata` which
 * strips empty / non-string fields, so the schema is permissive on
 * presence and strict on type.
 */
export const ConversationMetadataSchema = z
  .object({
    scope: ConversationScopeSchema.optional(),
    automationType: ConversationAutomationTypeSchema.optional(),
    taskId: z.string().optional(),
    triggerId: z.string().optional(),
    workflowId: z.string().optional(),
    workflowName: z.string().optional(),
    draftId: z.string().optional(),
    pageId: z.string().optional(),
    sourceConversationId: z.string().optional(),
    terminalBridgeConversationId: z.string().optional(),
  })
  .strict();

export const PostConversationRequestSchema = z
  .object({
    title: z.string().optional(),
    includeGreeting: z.boolean().optional(),
    lang: z.string().optional(),
    metadata: ConversationMetadataSchema.optional(),
  })
  .strict();

export const PostConversationTruncateRequestSchema = z
  .object({
    messageId: z.string().regex(/\S/, "messageId is required"),
    inclusive: z.boolean().optional(),
  })
  .strict()
  .transform((value) => ({
    messageId: value.messageId.trim(),
    ...(value.inclusive !== undefined ? { inclusive: value.inclusive } : {}),
  }));

export const PatchConversationRequestSchema = z
  .object({
    title: z.string().optional(),
    generate: z.boolean().optional(),
    metadata: z.union([ConversationMetadataSchema, z.null()]).optional(),
  })
  .strict();

export const PostConversationCleanupEmptyRequestSchema = z
  .object({
    keepId: z.string().optional(),
  })
  .strict()
  .transform((value) => {
    const trimmed = value.keepId?.trim();
    return trimmed ? { keepId: trimmed } : {};
  });

export type ConversationMetadataInput = z.infer<
  typeof ConversationMetadataSchema
>;
export type PostConversationRequest = z.infer<
  typeof PostConversationRequestSchema
>;
export type PostConversationTruncateRequest = z.infer<
  typeof PostConversationTruncateRequestSchema
>;
export type PatchConversationRequest = z.infer<
  typeof PatchConversationRequestSchema
>;
export type PostConversationCleanupEmptyRequest = z.infer<
  typeof PostConversationCleanupEmptyRequestSchema
>;
