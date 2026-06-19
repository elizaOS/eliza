/**
 * Zod schemas for the auth HTTP routes.
 *
 * Routes covered:
 *   POST /api/auth/pair   body: { code: string }   → { token: string }
 *
 * The pairing code is whatever the user typed in the device-pairing
 * flow; the server already normalises it via `normalizePairingCode`
 * (strip whitespace, uppercase) before the timing-safe compare. The
 * schema's job is wire-boundary validation: reject non-string and
 * empty inputs at 400 instead of letting them through to the
 * normalisation step where they'd silently compare to "".
 */

import z from "zod";

export const PostAuthPairRequestSchema = z
  .object({
    code: z.string().min(1, "code is required"),
  })
  .strict();

export const PostAuthPairResponseSchema = z
  .object({
    token: z.string(),
  })
  .strict();

export type PostAuthPairRequest = z.infer<typeof PostAuthPairRequestSchema>;
export type PostAuthPairResponse = z.infer<typeof PostAuthPairResponseSchema>;
