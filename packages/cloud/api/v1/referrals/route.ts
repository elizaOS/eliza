/**
 * GET /api/v1/referrals — current user's referral code (creates one if missing).
 */

import {
  coerceNonNegativeIntegerCount,
  type ReferralMeResponse,
} from "@elizaos/cloud-sdk/contracts";
import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  ApiError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { referralsService } from "@elizaos/cloud-shared/lib/services/referrals";
import { getCorsHeaders } from "@elizaos/cloud-shared/lib/utils/cors";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.options("/", (c) => {
  const origin = c.req.header("origin") ?? null;
  return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
});

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  const origin = c.req.header("origin") ?? null;
  const corsHeaders = getCorsHeaders(origin);

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const row = await referralsService.getOrCreateCode(user.id);

    if (row == null || typeof row !== "object") {
      throw new Error(
        "Referrals API: getOrCreateCode returned no referral row",
      );
    }
    if (typeof row.code !== "string" || row.code.length === 0) {
      throw new Error("Referrals API: referral row missing code");
    }
    if (typeof row.is_active !== "boolean") {
      throw new Error("Referrals API: referral row missing is_active");
    }

    const totalReferrals = coerceNonNegativeIntegerCount(row.total_referrals);
    if (totalReferrals === null) {
      throw new Error(
        `Referrals API: total_referrals is not a valid non-negative integer (row.total_referrals=${String(row.total_referrals)})`,
      );
    }

    const body: ReferralMeResponse = {
      code: row.code,
      total_referrals: totalReferrals,
      is_active: row.is_active,
    };

    return c.json(body, 200, corsHeaders);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      return c.json({ error: error.message }, 403, corsHeaders);
    }
    if (error instanceof ApiError && error.status === 401) {
      return c.json({ error: "Unauthorized" }, 401, corsHeaders);
    }

    logger.error("[Referrals API] Error getting referral code", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
