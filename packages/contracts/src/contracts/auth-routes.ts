/**
 * Zod schemas for the auth HTTP routes.
 *
 * Routes covered:
 *   POST /api/auth/pair   body: { code: string, instanceId?: uuid }
 *                         → { token: string, instanceId?: uuid }
 *
 * `instanceId` binds the exchange to the server process that issued the code
 * (see `remote-agent-pairing.ts`); a mismatch fails instead of pairing a
 * restarted or different replica.
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
    instanceId: z.uuid().optional(),
  })
  .strict();

export const PostAuthPairResponseSchema = z
  .object({
    token: z.string(),
    instanceId: z.uuid().optional(),
  })
  .strict();

export type PostAuthPairRequest = z.infer<typeof PostAuthPairRequestSchema>;
export type PostAuthPairResponse = z.infer<typeof PostAuthPairResponseSchema>;
