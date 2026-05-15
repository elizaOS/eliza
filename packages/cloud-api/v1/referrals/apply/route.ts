/**
 * POST /api/v1/referrals/apply — apply a referral code to current user/org.
 */
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { referralsService } from "@/lib/services/referrals";
import { getCorsHeaders } from "@/lib/utils/cors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.options("/", (c) => {
  const origin = c.req.header("origin") ?? null;
  return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
});

app.use("*", rateLimit(RateLimitPresets.STRICT));

const ApplySchema = z.object({
  code: z.string().min(1),
});

app.post("/", async (c) => {
  const origin = c.req.header("origin") ?? null;
  const corsHeaders = getCorsHeaders(origin);

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    if (!user.organization_id) {
      return c.json({ error: "Organization not found" }, 400, corsHeaders);
    }

    const body = await c.req.json();
    const validation = ApplySchema.safeParse(body);
    if (!validation.success) {
      return c.json({ error: "Invalid referral code format." }, 400, corsHeaders);
    }

    const result = await referralsService.applyReferralCode(
      user.id,
      user.organization_id,
      validation.data.code,
    );

    if (!result.success) {
      const status =
        result.message === "Invalid referral code"
          ? 404
          : result.message === "Already used a referral code"
            ? 409
            : 400;

      return c.json({ error: result.message }, status, corsHeaders);
    }

    return c.json(result, 200, corsHeaders);
  } catch (error) {
    logger.error("[Referral Apply] Error applying referral code", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
