/**
 * POST /api/v1/apps/[id]/earnings/withdraw — retired (#23022).
 *
 * App creator withdrawals are a creator payout, and creator payouts are
 * closed. Authenticated callers get 410 `creator_monetization_retired`.
 * Historical app earnings stay readable through GET
 * /api/v1/apps/[id]/earnings and the frozen statement at
 * GET /api/v1/earnings/statement.
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
      new CreatorMonetizationRetiredError("app_earnings_withdrawal"),
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
