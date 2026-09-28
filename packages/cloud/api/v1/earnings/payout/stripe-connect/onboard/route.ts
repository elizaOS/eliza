/**
 * POST /api/v1/earnings/payout/stripe-connect/onboard — retired (#23022).
 *
 * Stripe Connect onboarding only served creator payouts, which are closed.
 * Authenticated callers get 410 `creator_monetization_retired`. Existing
 * connected-account rows and the Connect webhook stay in place so account
 * status for any historical transfer remains readable.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { CreatorMonetizationRetiredError } from "@/lib/services/creator-monetization-retirement";
import type { AppEnv } from "@/types/cloud-worker-env";

const honoRouter = new Hono<AppEnv>();
honoRouter.post("/", moneyRateLimit(RateLimitPresets.CRITICAL), async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    return failureResponse(
      c,
      new CreatorMonetizationRetiredError("stripe_connect_payout"),
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
