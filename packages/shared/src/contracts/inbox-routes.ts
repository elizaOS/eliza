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

export const PostInboxMessageRequestSchema = z
  .object({
    roomId: z.string().min(1, "roomId is required"),
    source: z.string().min(1, "source is required"),
    text: z.string().min(1, "text is required"),
    replyToMessageId: z.string().min(1).optional(),
  })
  .strict()
  .transform((value) => ({
    roomId: value.roomId.trim(),
    source: value.source.trim().toLowerCase(),
    text: value.text.trim(),
    ...(value.replyToMessageId
      ? { replyToMessageId: value.replyToMessageId.trim() }
      : {}),
  }))
  .pipe(
    z
      .object({
        roomId: z.string().min(1, "roomId is required"),
        source: z.string().min(1, "source is required"),
        text: z.string().min(1, "text is required"),
        replyToMessageId: z.string().min(1).optional(),
      })
      .strict(),
  );

export type PostInboxMessageRequest = z.infer<
  typeof PostInboxMessageRequestSchema
>;
