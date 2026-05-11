/**
 * Zod schemas for the inbox HTTP routes.
 *
 * Routes covered:
 *   POST /api/inbox/messages   body: { roomId, source, text, replyToMessageId? }
 *
 * `source` is normalised to lowercase before validation so the schema
 * only needs to check for non-empty. The handler still runs its own
 * post-validation checks against the runtime (`runtimeHasSendHandler`,
 * `getRoom`) — the schema only ensures the wire shape is well-formed.
 *
 * Response shape (`{ ok: true, message?: InboxMessage }`) is
 * intentionally NOT modelled here: `InboxMessage` is a large
 * runtime-internal type and the inbox surface is mid-refactor.
 * Adding the response schema will be a follow-up after the
 * inbox-messages tree stabilises (mirrors the pattern from PR #7561 /
 * #7565 for apps-routes).
 */

import z from "zod";

// `\S` requires at least one non-whitespace character — rejects both
// empty strings and whitespace-only inputs (`"   "`) at the wire, so
// the post-trim values inside the transform are always non-empty.
export const PostInboxMessageRequestSchema = z
  .object({
    roomId: z.string().regex(/\S/, "roomId is required"),
    source: z.string().regex(/\S/, "source is required"),
    text: z.string().regex(/\S/, "text is required"),
    replyToMessageId: z.string().regex(/\S/).optional(),
  })
  .strict()
  .transform((value) => ({
    roomId: value.roomId.trim(),
    source: value.source.trim().toLowerCase(),
    text: value.text.trim(),
    ...(value.replyToMessageId?.trim()
      ? { replyToMessageId: value.replyToMessageId.trim() }
      : {}),
  }));

export type PostInboxMessageRequest = z.infer<
  typeof PostInboxMessageRequestSchema
>;
