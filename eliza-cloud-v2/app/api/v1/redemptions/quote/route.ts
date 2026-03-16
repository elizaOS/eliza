/**
 * Token Redemption Price Quote API
 *
 * GET /api/v1/redemptions/quote - Get current elizaOS price and calculate redemption
 *
 * This endpoint provides TWAP-based pricing with anti-arbitrage protection.
 * Quote validity is 2 minutes to reduce manipulation window.
 *
 * SECURITY FEATURES:
 * 1. Uses Time-Weighted Average Price (TWAP) instead of spot price
 * 2. Applies safety spread to protect against arbitrage
 * 3. Checks volatility circuit breakers
 * 4. Validates system-wide rate limits
 * 5. Shows if large redemption delay applies
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { ELIZA_TOKEN_ADDRESSES } from "@/lib/services/eliza-token-price";
import { payoutStatusService } from "@/lib/services/payout-status";
import { secureTokenRedemptionService } from "@/lib/services/token-redemption-secure";
import { twapPriceOracle } from "@/lib/services/twap-price-oracle";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { logger } from "@/lib/utils/logger";
import {
  ARBITRAGE_PROTECTION,
  SUPPLY_SHOCK_PROTECTION,
  ADMIN_CONTROLS,
  calculateEffectiveTokens,
} from "@/lib/config/redemption-security";

/**
 * GET /api/v1/redemptions/quote
 *
 * Query params:
 * - network: "ethereum" | "base" | "bnb" | "solana"
 * - pointsAmount: number (optional, defaults to 100 for just price check)
 */
async function getQuoteHandler(request: NextRequest): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  const networkParam = request.nextUrl.searchParams.get("network");
  const pointsParam = request.nextUrl.searchParams.get("pointsAmount");

  // Validate network
  const validNetworks = ["ethereum", "base", "bnb", "solana"] as const;
  if (
    !networkParam ||
    !validNetworks.includes(networkParam as (typeof validNetworks)[number])
  ) {
    return NextResponse.json(
      {
        success: false,
        error: `Invalid network. Must be one of: ${validNetworks.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const network = networkParam as (typeof validNetworks)[number];
  const pointsAmount = pointsParam ? parseInt(pointsParam, 10) : 100;

  if (isNaN(pointsAmount) || pointsAmount < 1) {
    return NextResponse.json(
      { success: false, error: "Invalid pointsAmount" },
      { status: 400 },
    );
  }

  // Check if payout system is configured and available for this network
  const networkAvailability =
    await payoutStatusService.isNetworkAvailable(network);
  if (!networkAvailability.available) {
    // Get available networks as alternatives
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

    return NextResponse.json(
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
      { status: 503 },
    );
  }

  // Get TWAP-based quote with all security checks
  const quoteResult = await twapPriceOracle.getRedemptionQuote(
    network,
    pointsAmount,
    user.id,
  );

  if (!quoteResult.success) {
    return NextResponse.json(
      {
        success: false,
        error: quoteResult.error,
        canRedeem: false,
      },
      { status: 400 },
    );
  }

  const quote = quoteResult.quote!;
  const usdValue = quote.usdValue;

  // Calculate effective tokens (after safety spread)
  const effectiveElizaAmount = calculateEffectiveTokens(
    usdValue,
    quote.twapPrice,
  );

  // Check token availability
  const availability =
    await secureTokenRedemptionService.checkTokenAvailability(
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

  return NextResponse.json({
    success: true,
    quote: {
      network,
      tokenAddress: ELIZA_TOKEN_ADDRESSES[network],

      // Input
      pointsAmount,
      usdValue, // 1 point = $0.01

      // Pricing (TWAP-based)
      twapPriceUsd: quote.twapPrice,
      spotPriceUsd: quote.spotPrice,
      priceMethod: "TWAP",

      // What user actually receives (after safety spread)
      elizaAmount: effectiveElizaAmount,
      safetySpreadPercent: ARBITRAGE_PROTECTION.SAFETY_SPREAD * 100,

      // Price quality indicators
      sampleCount: quote.sampleCount,
      volatilityPercent: (quote.volatility * 100).toFixed(2),

      // Token availability
      tokensAvailable: availability.available,
      hotWalletBalance: availability.balance,

      // Validity
      validUntil: quote.expiresAt.toISOString(),
      validitySeconds: ARBITRAGE_PROTECTION.QUOTE_VALIDITY_MS / 1000,

      // Delays & requirements
      requiresDelay: quote.requiresDelay,
      delayUntil: quote.delayUntil?.toISOString(),
      requiresAdminApproval:
        usdValue >= ADMIN_CONTROLS.ADMIN_APPROVAL_THRESHOLD_USD,

      // Limits info
      limits: {
        minRedemptionUsd: SUPPLY_SHOCK_PROTECTION.MIN_REDEMPTION_USD,
        maxRedemptionUsd: SUPPLY_SHOCK_PROTECTION.MAX_SINGLE_REDEMPTION_USD,
        userDailyLimitUsd: SUPPLY_SHOCK_PROTECTION.USER_DAILY_LIMIT_USD,
        userHourlyLimitUsd: SUPPLY_SHOCK_PROTECTION.USER_HOURLY_LIMIT_USD,
        largeRedemptionThresholdUsd:
          SUPPLY_SHOCK_PROTECTION.LARGE_REDEMPTION_THRESHOLD_USD,
        adminApprovalThresholdUsd: ADMIN_CONTROLS.ADMIN_APPROVAL_THRESHOLD_USD,
      },
    },
    warnings: quoteResult.warnings,
    message: availability.available
      ? `You will receive approximately ${effectiveElizaAmount.toFixed(4)} elizaOS tokens for ${pointsAmount} points ($${usdValue.toFixed(2)}). A ${(ARBITRAGE_PROTECTION.SAFETY_SPREAD * 100).toFixed(0)}% safety spread is applied.`
      : `Sorry, we don't have enough elizaOS tokens available on ${network} right now. Please try again later.`,
    canRedeem: availability.available && quoteResult.success,
  });
}

// Rate limit: Standard (60 req/min) - quotes are read-only
export const GET = withRateLimit(getQuoteHandler, RateLimitPresets.STANDARD);

/**
 * OPTIONS - CORS preflight
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-API-Key, X-App-Id",
    },
  });
}
