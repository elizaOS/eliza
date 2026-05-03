/**
 * Affiliates API
 *
 * GET  /api/v1/affiliates  — current user's affiliate code (or { code: null })
 * POST /api/v1/affiliates  — create affiliate code with specified markup
 * PUT  /api/v1/affiliates  — update markup on the existing affiliate code
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { affiliatesService } from "@/lib/services/affiliates";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const MarkupSchema = z.object({
  markupPercent: z.number().min(0).max(1000),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const code = await affiliatesService.getAffiliateCode(user.id);
    return c.json({ code: code ?? null });
  } catch (error) {
    logger.error("[Affiliates API] GET error:", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = await c.req.json();
    const validation = MarkupSchema.safeParse(body);
    if (!validation.success) {
      return c.json({ error: "Invalid markup. Must be a number between 0 and 1000%." }, 400);
    }
    const { markupPercent } = validation.data;
    const code = await affiliatesService.getOrCreateAffiliateCode(user.id, markupPercent);
    return c.json({ code });
  } catch (error) {
    logger.error("[Affiliates API] POST error:", error);
    return failureResponse(c, error);
  }
});

app.put("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = await c.req.json();
    const validation = MarkupSchema.safeParse(body);
    if (!validation.success) {
      return c.json({ error: "Invalid markup. Must be a number between 0 and 1000%." }, 400);
    }
    const { markupPercent } = validation.data;
    try {
      const code = await affiliatesService.updateMarkup(user.id, markupPercent);
      return c.json({ code });
    } catch (err) {
      if (err instanceof Error && err.message.includes("Affiliate code not found")) {
        return c.json({ error: "No affiliate code. Create one with POST first." }, 404);
      }
      throw err;
    }
  } catch (error) {
    logger.error("[Affiliates API] PUT error:", error);
    return failureResponse(c, error);
  }
});

export default app;
