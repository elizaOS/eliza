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

// Required fields use `\S` (at least one non-whitespace character) so
// whitespace-only inputs are rejected at the wire — the post-trim
// values inside `transform` are always non-empty.
//
// `replyToMessageId` is optional, so a whitespace-only value is the
// same as absent (no reply). The transform absorbs that case rather
// than rejecting at the wire — matches greptile's note on PR #7566:
// "a confusing 400 for a field that is legitimately optional".
export const PostInboxMessageRequestSchema = z
  .object({
    roomId: z.string().regex(/\S/, "roomId is required"),
    source: z.string().regex(/\S/, "source is required"),
    text: z.string().regex(/\S/, "text is required"),
    replyToMessageId: z.string().optional(),
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
