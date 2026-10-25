import { z } from "zod";

/** Query contract for GET /api/v1/apps/:id/earnings/history. */
export const earningsHistoryQuerySchema = z.object({
  // 0 is an empty page. `.positive()` rejected it before the service saw it.
  limit: z.coerce.number().int().min(0).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  type: z
    .enum(["inference_markup", "purchase_share", "withdrawal", "adjustment"])
    .optional(),
});
