/**
 * Validates inbound connector messages at the authenticated HTTP boundary.
 * Account selection is deliberately limited to an opaque account id; arbitrary
 * client metadata cannot become connector-routing authority.
 */

import z from "zod";

// Required fields use `\S` (at least one non-whitespace character) so
// whitespace-only inputs are rejected at the wire — the post-trim
// values inside `transform` are always non-empty.
//
// `replyToMessageId` is optional, so a whitespace-only value is the same as
// absent. `accountId` instead identifies an explicit routing choice, so a
// present but blank value is invalid rather than equivalent to no choice.
export const PostInboxMessageRequestSchema = z
  .object({
    accountId: z.string().regex(/\S/, "accountId is required").optional(),
    roomId: z.string().regex(/\S/, "roomId is required"),
    source: z.string().regex(/\S/, "source is required"),
    text: z.string().regex(/\S/, "text is required"),
    replyToMessageId: z.string().optional(),
  })
  .strict()
  .transform((value) => ({
    ...(value.accountId ? { accountId: value.accountId.trim() } : {}),
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
