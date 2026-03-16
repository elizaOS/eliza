/**
 * Single Redemption API Routes
 *
 * GET /api/v1/redemptions/[id] - Get redemption details
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { secureTokenRedemptionService } from "@/lib/services/token-redemption-secure";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

/**
 * GET /api/v1/redemptions/[id]
 * Get details of a specific redemption.
 */
async function getRedemptionHandler(
  request: NextRequest,
  context?: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Missing route params" },
      { status: 400 },
    );
  }
  const { id } = await context.params;

  const redemption = await secureTokenRedemptionService.getRedemption(
    id,
    user.id,
  );

  if (!redemption) {
    return NextResponse.json(
      { success: false, error: "Redemption not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    success: true,
    redemption: {
      id: redemption.id,
      pointsAmount: Number(redemption.points_amount),
      usdValue: Number(redemption.usd_value),
      elizaAmount: Number(redemption.eliza_amount),
      elizaPriceUsd: Number(redemption.eliza_price_usd),
      network: redemption.network,
      payoutAddress: redemption.payout_address,
      status: redemption.status,
      txHash: redemption.tx_hash,
      requiresReview: redemption.requires_review,
      createdAt: redemption.created_at.toISOString(),
      priceQuoteExpiresAt: redemption.price_quote_expires_at.toISOString(),
      processingStartedAt: redemption.processing_started_at?.toISOString(),
      completedAt: redemption.completed_at?.toISOString(),
      failureReason: redemption.failure_reason,
      retryCount: Number(redemption.retry_count),
      reviewedAt: redemption.reviewed_at?.toISOString(),
      reviewNotes: redemption.review_notes,
    },
  });
}

export const GET = withRateLimit(
  getRedemptionHandler,
  RateLimitPresets.STANDARD,
);

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
