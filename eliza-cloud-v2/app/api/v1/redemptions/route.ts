/**
 * Token Redemption API Routes
 *
 * POST /api/v1/redemptions - Create a new redemption request
 * GET /api/v1/redemptions - List user's redemption history
 *
 * SECURITY MEASURES:
 * 1. Rate limited (CRITICAL preset - 5 req/min for POST, STRICT for GET)
 * 2. Authenticated users only
 * 3. Input validation with strict bounds
 * 4. Idempotency key support
 * 5. Full audit logging
 * 6. TWAP pricing with anti-arbitrage protection
 *
 * @see lib/services/token-redemption-secure.ts for security implementation
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { secureTokenRedemptionService } from "@/lib/services/token-redemption-secure";
import { payoutStatusService } from "@/lib/services/payout-status";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";
import { SUPPLY_SHOCK_PROTECTION } from "@/lib/config/redemption-security";

/**
 * Request validation schema with strict bounds.
 *
 * IMPORTANT: Only EARNED points from miniapps, agents, and MCPs can be redeemed.
 * Purchased credits are NOT redeemable.
 */
const CreateRedemptionSchema = z.object({
  appId: z.string().uuid().optional(), // Optional - earnings are user-level
  pointsAmount: z
    .number()
    .int()
    .min(100, "Minimum redemption is 100 points ($1.00)")
    .max(100000, "Maximum redemption is 100,000 points ($1,000.00)"),
  network: z.enum(["ethereum", "base", "bnb", "solana"]),
  payoutAddress: z.string().min(20).max(100),
  signature: z.string().optional(), // EIP-712 signature for address ownership
  idempotencyKey: z.string().uuid().optional(), // For retry safety
});

// Rate limit: CRITICAL (5 req/min) - stricter for financial operations
const createRateLimitConfig = {
  ...RateLimitPresets.CRITICAL,
  prefix: "redemption:create",
};

/**
 * POST /api/v1/redemptions
 * Create a new token redemption request using the secure service.
 *
 * Features:
 * - TWAP pricing (not spot)
 * - Idempotency key support
 * - Contract address rejection
 * - Rate limiting
 * - Full audit trail
 */
async function createRedemptionHandler(
  request: NextRequest,
): Promise<Response> {
  // Check emergency pause
  if (process.env.REDEMPTION_EMERGENCY_PAUSE === "true") {
    logger.warn("[Redemption API] Emergency pause active - rejecting request");
    return NextResponse.json(
      {
        success: false,
        error:
          "Redemptions are temporarily paused for maintenance. Please try again later.",
        paused: true,
      },
      { status: 503 },
    );
  }

  const { user } = await requireAuthOrApiKeyWithOrg(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const validation = CreateRedemptionSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid request",
        details: validation.error.issues.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      },
      { status: 400 },
    );
  }

  const {
    appId,
    pointsAmount,
    network,
    payoutAddress,
    signature,
    idempotencyKey,
  } = validation.data;

  // Check if payout system is available for this network
  const networkAvailability =
    await payoutStatusService.isNetworkAvailable(network);
  if (!networkAvailability.available) {
    const status = await payoutStatusService.getStatus();
    const availableNetworks = status.networks
      .filter((n) => n.status === "operational" || n.status === "low_balance")
      .map((n) => n.network);

    logger.warn("[Redemption API] Network unavailable", {
      network,
      message: networkAvailability.message,
      availableNetworks,
      userId: user.id.slice(0, 8) + "...",
    });

    return NextResponse.json(
      {
        success: false,
        error: networkAvailability.message,
        availableNetworks,
        suggestion:
          availableNetworks.length > 0
            ? `Try one of these networks instead: ${availableNetworks.join(", ")}`
            : "Token redemption is temporarily unavailable. Please check back later.",
      },
      { status: 503 },
    );
  }

  // Get client metadata for audit
  const userAgent = request.headers.get("user-agent") ?? undefined;
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    request.headers.get("x-real-ip") ??
    undefined;

  // Mask address for logging (security)
  const maskedAddress =
    payoutAddress.length > 20
      ? `${payoutAddress.slice(0, 6)}...${payoutAddress.slice(-4)}`
      : "***";

  logger.info("[Redemption API] Creating secure redemption request", {
    userId: user.id.slice(0, 8) + "...",
    appId,
    pointsAmount,
    usdValue: (pointsAmount / 100).toFixed(2),
    network,
    payoutAddress: maskedAddress,
    hasSignature: !!signature,
    hasIdempotencyKey: !!idempotencyKey,
  });

  const result = await secureTokenRedemptionService.createRedemption({
    userId: user.id,
    appId,
    pointsAmount,
    network,
    payoutAddress,
    signature,
    idempotencyKey,
    metadata: {
      userAgent,
      ipAddress,
    },
  });

  if (!result.success) {
    logger.warn("[Redemption API] Secure redemption request failed", {
      userId: user.id.slice(0, 8) + "...",
      error: result.error,
    });

    return NextResponse.json(
      { success: false, error: result.error },
      { status: 400 },
    );
  }

  logger.info("[Redemption API] Secure redemption request created", {
    redemptionId: result.redemptionId,
    userId: user.id.slice(0, 8) + "...",
    usdValue: result.quote?.usdValue,
    elizaAmount: result.quote?.elizaAmount,
    requiresReview: result.quote?.requiresReview,
  });

  return NextResponse.json({
    success: true,
    redemptionId: result.redemptionId,
    quote: result.quote,
    warnings: result.warnings,
    message: result.quote?.requiresReview
      ? `Redemption created. Requires admin review for amounts over $${SUPPLY_SHOCK_PROTECTION.LARGE_REDEMPTION_THRESHOLD_USD}.`
      : "Redemption created and will be processed shortly.",
  });
}

/**
 * GET /api/v1/redemptions
 * List user's redemption history.
 */
async function listRedemptionsHandler(request: NextRequest): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 20;

  const redemptions = await secureTokenRedemptionService.listUserRedemptions(
    user.id,
    limit,
  );

  return NextResponse.json({
    success: true,
    redemptions: redemptions.map((r) => ({
      id: r.id,
      pointsAmount: Number(r.points_amount),
      usdValue: Number(r.usd_value),
      elizaAmount: Number(r.eliza_amount),
      elizaPriceUsd: Number(r.eliza_price_usd),
      network: r.network,
      // Mask address for privacy in list view
      payoutAddress: `${r.payout_address.slice(0, 6)}...${r.payout_address.slice(-4)}`,
      status: r.status,
      txHash: r.tx_hash,
      createdAt: r.created_at.toISOString(),
      completedAt: r.completed_at?.toISOString(),
      failureReason: r.failure_reason,
      requiresReview: r.requires_review,
    })),
    paused: process.env.REDEMPTION_EMERGENCY_PAUSE === "true",
  });
}

// Export rate-limited handlers
// POST: CRITICAL rate limit (5 req/min) for financial operations
// GET: STRICT rate limit (10 req/min) for read operations
export const POST = withRateLimit(
  createRedemptionHandler,
  createRateLimitConfig,
);
export const GET = withRateLimit(
  listRedemptionsHandler,
  RateLimitPresets.STRICT,
);

/**
 * OPTIONS - CORS preflight
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-API-Key, X-App-Id",
    },
  });
}
