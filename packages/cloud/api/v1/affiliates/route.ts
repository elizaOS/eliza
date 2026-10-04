/**
 * Affiliates API
 *
 * GET  /api/v1/affiliates  — current user's affiliate code (or { code: null })
 * POST /api/v1/affiliates  — create affiliate code with specified markup
 * PUT  /api/v1/affiliates  — update markup on the existing affiliate code
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { affiliatesService } from "@elizaos/cloud-shared/lib/services/affiliates";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

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
    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const body = decodedBody.value;
    const validation = MarkupSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: "Invalid markup. Must be a number between 0 and 1000%." },
        400,
      );
    }
    const { markupPercent } = validation.data;
    const code = await affiliatesService.getOrCreateAffiliateCode(
      user.id,
      markupPercent,
    );
    return c.json({ code });
  } catch (error) {
    logger.error("[Affiliates API] POST error:", error);
    return failureResponse(c, error);
  }
});

app.put("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const body = decodedBody.value;
    const validation = MarkupSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: "Invalid markup. Must be a number between 0 and 1000%." },
        400,
      );
    }
    const { markupPercent } = validation.data;
    try {
      const code = await affiliatesService.updateMarkup(user.id, markupPercent);
      return c.json({ code });
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("Affiliate code not found")
      ) {
        return c.json(
          { error: "No affiliate code. Create one with POST first." },
          404,
        );
      }
      throw err;
    }
  } catch (error) {
    logger.error("[Affiliates API] PUT error:", error);
    return failureResponse(c, error);
  }
});

export default app;
