/**
 * Token Redemption Price Quote API
 *
 * GET /api/v1/redemptions/quote - Get current elizaOS price and calculate redemption.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  ADMIN_CONTROLS,
  ARBITRAGE_PROTECTION,
  calculateEffectiveTokens,
  SUPPLY_SHOCK_PROTECTION,
} from "@/lib/config/redemption-security";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { ELIZA_TOKEN_ADDRESSES } from "@/lib/services/eliza-token-price";
import { payoutStatusService } from "@/lib/services/payout-status";
import { secureTokenRedemptionService } from "@/lib/services/token-redemption-secure";
import { twapPriceOracle } from "@/lib/services/twap-price-oracle";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const validNetworkParams = ["ethereum", "base", "bnb", "bsc", "solana"] as const;
type NetworkParam = (typeof validNetworkParams)[number];

function normalizeNetworkParam(network: NetworkParam) {
  return network === "bsc" ? "bnb" : network;
}

app.options(
  "/",
  (c) =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-App-Id",
      },
    }),
);

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const networkParam = c.req.query("network");
    const pointsParam = c.req.query("pointsAmount");

    if (!networkParam || !validNetworkParams.includes(networkParam as NetworkParam)) {
      return c.json(
        {
          success: false,
          error: `Invalid network. Must be one of: ${validNetworkParams.join(", ")}`,
        },
        400,
      );
    }

    const network = normalizeNetworkParam(networkParam as NetworkParam);
    const pointsAmount = pointsParam ? parseInt(pointsParam, 10) : 100;

    if (isNaN(pointsAmount) || pointsAmount < 1) {
      return c.json({ success: false, error: "Invalid pointsAmount" }, 400);
    }

    const networkAvailability = await payoutStatusService.isNetworkAvailable(network);
    if (!networkAvailability.available) {
      const status = await payoutStatusService.getStatus();
      const availableNetworks = status.networks
        .filter((n) => n.status === "operational" || n.status === "low_balance")
        .map((n) => n.network);

      logger.warn("[Redemption Quote] Network unavailable", {
        network,
        message: networkAvailability.message,
        availableNetworks,
        userId: user.id,
      });

      return c.json(
        {
          success: false,
          error: networkAvailability.message,
          canRedeem: false,
          availableNetworks,
          suggestion:
            availableNetworks.length > 0
              ? `Try one of these networks instead: ${availableNetworks.join(", ")}`
              : "Token redemption is temporarily unavailable. Please check back later.",
        },
        503,
      );
    }

    const quoteResult = await twapPriceOracle.getRedemptionQuote(network, pointsAmount, user.id);

    if (!quoteResult.success) {
      return c.json(
        {
          success: false,
          error: quoteResult.error,
          canRedeem: false,
        },
        400,
      );
    }

    const quote = quoteResult.quote!;
    const usdValue = quote.usdValue;

    const effectiveElizaAmount = calculateEffectiveTokens(usdValue, quote.twapPrice);

    const availability = await secureTokenRedemptionService.checkTokenAvailability(
      network,
      effectiveElizaAmount,
    );

    logger.debug("[Redemption Quote] TWAP quote generated", {
      network,
      pointsAmount,
      twapPrice: quote.twapPrice,
      spotPrice: quote.spotPrice,
      effectiveElizaAmount,
      tokensAvailable: availability.available,
      sampleCount: quote.sampleCount,
      volatility: quote.volatility,
      requiresDelay: quote.requiresDelay,
      userId: user.id,
    });

    return c.json({
      success: true,
      quote: {
        network,
        tokenAddress: ELIZA_TOKEN_ADDRESSES[network],
        pointsAmount,
        usdValue,
        twapPriceUsd: quote.twapPrice,
        spotPriceUsd: quote.spotPrice,
        priceMethod: "TWAP",
        elizaAmount: effectiveElizaAmount,
        safetySpreadPercent: ARBITRAGE_PROTECTION.SAFETY_SPREAD * 100,
        sampleCount: quote.sampleCount,
        volatilityPercent: (quote.volatility * 100).toFixed(2),
        tokensAvailable: availability.available,
        hotWalletBalance: availability.balance,
        validUntil: quote.expiresAt.toISOString(),
        validitySeconds: ARBITRAGE_PROTECTION.QUOTE_VALIDITY_MS / 1000,
        requiresDelay: quote.requiresDelay,
        delayUntil: quote.delayUntil?.toISOString(),
        requiresAdminApproval: true,
        limits: {
          minRedemptionUsd: SUPPLY_SHOCK_PROTECTION.MIN_REDEMPTION_USD,
          maxRedemptionUsd: SUPPLY_SHOCK_PROTECTION.MAX_SINGLE_REDEMPTION_USD,
          userDailyLimitUsd: SUPPLY_SHOCK_PROTECTION.USER_DAILY_LIMIT_USD,
          userHourlyLimitUsd: SUPPLY_SHOCK_PROTECTION.USER_HOURLY_LIMIT_USD,
          largeRedemptionThresholdUsd: SUPPLY_SHOCK_PROTECTION.LARGE_REDEMPTION_THRESHOLD_USD,
          adminApprovalThresholdUsd: ADMIN_CONTROLS.ADMIN_APPROVAL_THRESHOLD_USD,
        },
      },
      warnings: quoteResult.warnings,
      message: availability.available
        ? `You will receive approximately ${effectiveElizaAmount.toFixed(4)} elizaOS tokens for ${pointsAmount} points ($${usdValue.toFixed(2)}). A ${(ARBITRAGE_PROTECTION.SAFETY_SPREAD * 100).toFixed(0)}% safety spread is applied.`
        : `Sorry, we don't have enough elizaOS tokens available on ${network} right now. Please try again later.`,
      canRedeem: availability.available && quoteResult.success,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
