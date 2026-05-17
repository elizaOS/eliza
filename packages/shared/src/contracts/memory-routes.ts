/**
 * Zod schemas for the memory HTTP write surface.
 *
 * Routes covered:
 *   POST  /api/memory/remember   { text }
 *   PATCH /api/memories/:id      { text }
 *
 * The DELETE /api/memories/:id route has no body and isn't covered.
 */

import z from "zod";

export const PostMemoryRememberRequestSchema = z
  .object({
    text: z.string().regex(/\S/, "text is required"),
  })
  .strict()
  .transform((value) => ({ text: value.text.trim() }));

export const PatchMemoryRequestSchema = z
  .object({
    text: z.string().regex(/\S/, "text is required"),
  })
  .strict()
  .transform((value) => ({ text: value.text.trim() }));

export type PostMemoryRememberRequest = z.infer<
  typeof PostMemoryRememberRequestSchema
>;
export type PatchMemoryRequest = z.infer<typeof PatchMemoryRequestSchema>;
