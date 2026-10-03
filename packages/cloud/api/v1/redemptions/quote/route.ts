/**
 * GET /api/v1/redemptions/quote — retired (#23022).
 *
 * Quotes only existed to start a creator payout, and creator payouts are
 * closed. Authenticated callers get 410 `creator_monetization_retired`; unpaid
 * balances are frozen and readable at GET /api/v1/earnings/statement.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { CreatorMonetizationRetiredError } from "@/lib/services/creator-monetization-retirement";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    return failureResponse(
      c,
      new CreatorMonetizationRetiredError("token_redemption"),
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
