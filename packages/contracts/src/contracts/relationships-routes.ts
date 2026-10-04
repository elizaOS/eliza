/**
 * Zod schema for the relationships HTTP write surface.
 *
 * Routes covered:
 *   POST /api/relationships/people/:id/link
 *     { targetEntityId, evidence? }
 *
 * The accept/reject endpoints (`/candidates/:id/accept|reject`) take
 * no body — the action is encoded in the path.
 */

import z from "zod";

export const PostRelationshipLinkRequestSchema = z
  .object({
    targetEntityId: z.string().regex(/\S/, "targetEntityId is required"),
    evidence: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .transform((value) => ({
    targetEntityId: value.targetEntityId.trim(),
    ...(value.evidence ? { evidence: value.evidence } : {}),
  }));

export type PostRelationshipLinkRequest = z.infer<
  typeof PostRelationshipLinkRequestSchema
>;
