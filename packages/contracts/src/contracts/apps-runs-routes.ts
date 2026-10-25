/**
 * Zod schemas for the per-run steering HTTP routes:
 *
 *   POST /api/apps/runs/:runId/message   body: { content | message }
 *   POST /api/apps/runs/:runId/control   body: { action: 'pause'|'resume' }
 *
 * The message route historically accepted either `content` or `message`
 * as the field name (clients drifted, the handler tolerated both).
 * The schema preserves that compatibility and normalises down to a
 * single `content` field so the rest of the pipeline only sees one
 * shape.
 */

import z from "zod";

export const PostRunMessageRequestSchema = z
  .object({
    content: z.string().optional(),
    message: z.string().optional(),
  })
  .strict()
  .transform((value) => {
    const raw =
      typeof value.content === "string"
        ? value.content
        : typeof value.message === "string"
          ? value.message
          : "";
    return { content: raw.trim() };
  })
  .pipe(
    z
      .object({
        content: z.string().min(1, "content is required"),
      })
      .strict(),
  );

export const PostRunControlRequestSchema = z
  .object({
    action: z.enum(["pause", "resume"]),
  })
  .strict();

export type PostRunMessageRequest = z.infer<typeof PostRunMessageRequestSchema>;
export type PostRunControlRequest = z.infer<typeof PostRunControlRequestSchema>;
