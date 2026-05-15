/**
 * POST /api/v1/affiliates/link — link the current user to a referring
 * affiliate code. CORS handled globally.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { ERRORS as AFFILIATE_ERRORS, affiliatesService } from "@/lib/services/affiliates";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

const LinkSchema = z.object({
  code: z.string().min(1),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const body = await c.req.json();
    const validation = LinkSchema.safeParse(body);
    if (!validation.success) {
      return c.json({ error: "Invalid affiliate code format." }, 400);
    }

    const link = await affiliatesService.linkUserToAffiliateCode(user.id, validation.data.code);
    return c.json({ success: true, link });
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (
        error.message === AFFILIATE_ERRORS.INVALID_CODE ||
        error.message === AFFILIATE_ERRORS.CODE_NOT_FOUND
      ) {
        return c.json({ error: error.message }, 404);
      }
      if (error.message === AFFILIATE_ERRORS.SELF_REFERRAL) {
        return c.json({ error: error.message }, 400);
      }
      if (error.message === AFFILIATE_ERRORS.ALREADY_LINKED) {
        return c.json({ error: error.message }, 409);
      }
    }

    logger.error("[Affiliates Link] Error linking user to affiliate code", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
