/**
 * Admin Redemption Management API
 *
 * GET /api/admin/redemptions - List redemptions pending review
 * POST /api/admin/redemptions - Approve or reject a redemption
 *
 * SECURITY:
 * - Requires admin authentication
 * - All actions are logged with admin user ID
 * - Rejections automatically refund user balance
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { secureTokenRedemptionService } from "@/lib/services/token-redemption-secure";
import { dbRead } from "@/db/client";
import {
  tokenRedemptions,
  type TokenRedemption,
} from "@/db/schemas/token-redemptions";
import { users } from "@/db/schemas/users";
import { apps } from "@/db/schemas/apps";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

// Request schemas
const AdminActionSchema = z.object({
  redemptionId: z.string().uuid(),
  action: z.enum(["approve", "reject"]),
  notes: z.string().max(1000).optional(),
});

/**
 * GET /api/admin/redemptions
 * List redemptions pending admin review.
 */
async function listPendingRedemptionsHandler(
  request: NextRequest,
): Promise<Response> {
  const { user: adminUser } = await requireAdmin(request);

  const statusFilter = request.nextUrl.searchParams.get("status") || "pending";
  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 50;

  // Build status filter
  const allowedStatuses: TokenRedemption["status"][] = [
    "pending",
    "approved",
    "processing",
    "completed",
    "failed",
    "rejected",
    "expired",
  ];
  const statusArray: TokenRedemption["status"][] =
    statusFilter === "all"
      ? allowedStatuses
      : statusFilter === "review"
        ? ["pending"]
        : allowedStatuses.includes(statusFilter as TokenRedemption["status"])
          ? [statusFilter as TokenRedemption["status"]]
          : ["pending"];

  // Get redemptions with user and app info
  const redemptions = await dbRead
    .select({
      id: tokenRedemptions.id,
      user_id: tokenRedemptions.user_id,
      app_id: tokenRedemptions.app_id,
      points_amount: tokenRedemptions.points_amount,
      usd_value: tokenRedemptions.usd_value,
      eliza_amount: tokenRedemptions.eliza_amount,
      eliza_price_usd: tokenRedemptions.eliza_price_usd,
      network: tokenRedemptions.network,
      payout_address: tokenRedemptions.payout_address,
      status: tokenRedemptions.status,
      requires_review: tokenRedemptions.requires_review,
      tx_hash: tokenRedemptions.tx_hash,
      failure_reason: tokenRedemptions.failure_reason,
      retry_count: tokenRedemptions.retry_count,
      reviewed_by: tokenRedemptions.reviewed_by,
      reviewed_at: tokenRedemptions.reviewed_at,
      review_notes: tokenRedemptions.review_notes,
      created_at: tokenRedemptions.created_at,
      completed_at: tokenRedemptions.completed_at,
      metadata: tokenRedemptions.metadata,
      user_email: users.email,
      app_name: apps.name,
    })
    .from(tokenRedemptions)
    .leftJoin(users, eq(tokenRedemptions.user_id, users.id))
    .leftJoin(apps, eq(tokenRedemptions.app_id, apps.id))
    .where(inArray(tokenRedemptions.status, statusArray))
    .orderBy(desc(tokenRedemptions.created_at))
    .limit(limit);

  // Get summary counts
  const counts = await dbRead
    .select({
      status: tokenRedemptions.status,
      count: sql<number>`COUNT(*)`,
      total_usd: sql<string>`COALESCE(SUM(CAST(${tokenRedemptions.usd_value} AS DECIMAL)), 0)`,
    })
    .from(tokenRedemptions)
    .groupBy(tokenRedemptions.status);

  const statusCounts: Record<string, { count: number; totalUsd: number }> = {};
  for (const row of counts) {
    statusCounts[row.status] = {
      count: Number(row.count),
      totalUsd: Number(row.total_usd),
    };
  }

  logger.info("[Admin Redemptions] Listed redemptions", {
    adminId: adminUser.id,
    statusFilter,
    count: redemptions.length,
  });

  return NextResponse.json({
    success: true,
    redemptions: redemptions.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userEmail: r.user_email,
      appId: r.app_id,
      appName: r.app_name,
      pointsAmount: Number(r.points_amount),
      usdValue: Number(r.usd_value),
      elizaAmount: Number(r.eliza_amount),
      elizaPriceUsd: Number(r.eliza_price_usd),
      network: r.network,
      payoutAddress: r.payout_address,
      status: r.status,
      requiresReview: r.requires_review,
      txHash: r.tx_hash,
      failureReason: r.failure_reason,
      retryCount: Number(r.retry_count),
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at?.toISOString(),
      reviewNotes: r.review_notes,
      createdAt: r.created_at.toISOString(),
      completedAt: r.completed_at?.toISOString(),
      metadata: r.metadata,
    })),
    summary: {
      statusCounts,
      pendingReview: statusCounts.pending?.count || 0,
      totalPendingUsd: statusCounts.pending?.totalUsd || 0,
    },
  });
}

/**
 * POST /api/admin/redemptions
 * Approve or reject a redemption.
 */
async function adminActionHandler(request: NextRequest): Promise<Response> {
  const { user: adminUser } = await requireAdmin(request);

  const body = await request.json();
  const validation = AdminActionSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid request",
        details: validation.error.issues,
      },
      { status: 400 },
    );
  }

  const { redemptionId, action, notes } = validation.data;

  logger.info("[Admin Redemptions] Processing action", {
    adminId: adminUser.id,
    redemptionId,
    action,
  });

  if (action === "approve") {
    const result = await secureTokenRedemptionService.approveRedemption(
      redemptionId,
      adminUser.id,
      notes,
    );

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 },
      );
    }

    logger.info("[Admin Redemptions] Approved redemption", {
      adminId: adminUser.id,
      redemptionId,
    });

    return NextResponse.json({
      success: true,
      message: "Redemption approved. It will be processed in the next batch.",
    });
  } else {
    // Reject
    const result = await secureTokenRedemptionService.rejectRedemption(
      redemptionId,
      adminUser.id,
      notes || "Rejected by admin",
    );

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 },
      );
    }

    logger.info("[Admin Redemptions] Rejected redemption", {
      adminId: adminUser.id,
      redemptionId,
      reason: notes,
    });

    return NextResponse.json({
      success: true,
      message: "Redemption rejected. User balance has been refunded.",
    });
  }
}

export const GET = withRateLimit(
  listPendingRedemptionsHandler,
  RateLimitPresets.STANDARD,
);
export const POST = withRateLimit(adminActionHandler, RateLimitPresets.STRICT);

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
