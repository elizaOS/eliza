/**
 * Token Redemption API Routes
 *
 * POST /api/v1/redemptions - Retired (#23022). Creator payouts are closed;
 *   answers 410 `creator_monetization_retired`. Unpaid balances are frozen and
 *   readable at GET /api/v1/earnings/statement.
 * GET /api/v1/redemptions - List user's redemption history (read-only)
 */

import type { ListRedemptionsResponse } from "@elizaos/cloud-sdk/redemption-contract";
import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  moneyRateLimit,
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { CreatorMonetizationRetiredError } from "@elizaos/cloud-shared/lib/services/creator-monetization-retirement";
import { secureTokenRedemptionService } from "@elizaos/cloud-shared/lib/services/token-redemption-secure";
import { parseClampedLimit } from "@elizaos/cloud-shared/lib/utils/clamp-limit";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.options(
  "/",
  (_c) =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-API-Key, X-App-Id",
      },
    }),
);

app.post("/", moneyRateLimit(RateLimitPresets.CRITICAL), async (c) => {
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

app.get("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const limitParam = c.req.query("limit");
    const limit = parseClampedLimit(limitParam, 20);

    const redemptions = await secureTokenRedemptionService.listUserRedemptions(
      user.id,
      limit,
    );

    const response = {
      success: true,
      redemptions: redemptions.map((r) => ({
        id: r.id,
        pointsAmount: Number(r.points_amount),
        usdValue: Number(r.usd_value),
        elizaAmount: Number(r.eliza_amount),
        elizaPriceUsd: Number(r.eliza_price_usd),
        asset: r.asset,
        network: r.network,
        payoutAddress: `${r.payout_address.slice(0, 6)}...${r.payout_address.slice(-4)}`,
        status: r.status,
        txHash: r.tx_hash,
        createdAt: r.created_at.toISOString(),
        completedAt: r.completed_at?.toISOString(),
        failureReason: r.failure_reason,
        requiresReview: r.requires_review,
      })),
      paused: c.env.REDEMPTION_EMERGENCY_PAUSE === "true",
    } satisfies ListRedemptionsResponse;

    return c.json(response);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
