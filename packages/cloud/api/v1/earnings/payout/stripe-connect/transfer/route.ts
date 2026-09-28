/**
 * POST /api/v1/earnings/payout/stripe-connect/transfer — retired (#23022).
 *
 * This was the operator step that paid a creator's redeemable earnings to a
 * Stripe Connect account. Creator payouts are closed and unpaid balances are
 * frozen for manual settlement, so no code path may transfer them. Admin
 * callers get 410 `creator_monetization_retired`.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { CreatorMonetizationRetiredError } from "@/lib/services/creator-monetization-retirement";
import type { AppEnv } from "@/types/cloud-worker-env";

const honoRouter = new Hono<AppEnv>();
honoRouter.post("/", moneyRateLimit(RateLimitPresets.CRITICAL), async (c) => {
  try {
    await requireAdmin(c);
    return failureResponse(
      c,
      new CreatorMonetizationRetiredError("stripe_connect_payout"),
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
