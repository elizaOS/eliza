/**
 * Zod schema for the diagnostics HTTP write surface.
 *
 * Routes covered:
 *   POST /api/logs/export
 *     { format: 'json'|'csv', source?, level?, tags?, since?, limit? }
 *
 * `since` accepts either a number (epoch ms) or a string parseable
 * by `Number(...)` or `Date.parse(...)`. `tags` accepts either a
 * single string or a string array — the handler picks the first
 * non-empty entry. Both unions are preserved at the schema level
 * so the handler's coercion still works on validated input.
 */

import z from "zod";

const LogExportFormatSchema = z.enum(["json", "csv"]);

export const PostLogExportRequestSchema = z
  .object({
    format: LogExportFormatSchema,
    source: z.string().optional(),
    level: z.string().optional(),
    tags: z.union([z.string(), z.array(z.string())]).optional(),
    since: z.union([z.string(), z.number()]).optional(),
    limit: z.number().optional(),
  })
  .strict();

export type PostLogExportRequest = z.infer<typeof PostLogExportRequestSchema>;
export type LogExportFormat = z.infer<typeof LogExportFormatSchema>;
