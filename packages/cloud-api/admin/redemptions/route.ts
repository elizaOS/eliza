/**
 * /api/admin/redemptions
 * GET: list redemptions filtered by status (admin only).
 * POST: approve/reject a redemption (admin only). Rejection refunds balance.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  type TokenRedemptionStatus,
  tokenRedemptionsRepository,
} from "@/db/repositories/token-redemptions";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { secureTokenRedemptionService } from "@/lib/services/token-redemption-secure";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const AdminActionSchema = z.object({
  redemptionId: z.string().uuid(),
  action: z.enum(["approve", "reject"]),
  notes: z.string().max(1000).optional(),
  reason: z.string().max(1000).optional(),
});

const app = new Hono<AppEnv>();

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const { user: adminUser } = await requireAdmin(c);

    const statusFilter = c.req.query("status") || "pending";
    const networkFilter = c.req.query("network") || "all";
    const searchQuery = c.req.query("search")?.trim().toLowerCase() || "";
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 50;

    const allowedStatuses: TokenRedemptionStatus[] = [
      "pending",
      "approved",
      "processing",
      "completed",
      "failed",
      "rejected",
      "expired",
    ];
    const statusArray: TokenRedemptionStatus[] =
      statusFilter === "all"
        ? allowedStatuses
        : statusFilter === "review"
          ? ["pending"]
          : allowedStatuses.includes(statusFilter as TokenRedemptionStatus)
            ? [statusFilter as TokenRedemptionStatus]
            : ["pending"];

    const [allRedemptions, counts] = await Promise.all([
      tokenRedemptionsRepository.listForAdmin(statusArray, limit),
      tokenRedemptionsRepository.countByStatusForAdmin(),
    ]);
    const redemptions = allRedemptions.filter((r) => {
      if (networkFilter !== "all" && r.network !== networkFilter) return false;
      if (!searchQuery) return true;
      return (
        r.user_id.toLowerCase().includes(searchQuery) ||
        r.payout_address.toLowerCase().includes(searchQuery) ||
        r.id.toLowerCase().includes(searchQuery) ||
        (r.user_email?.toLowerCase().includes(searchQuery) ?? false)
      );
    });

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

    const rows = redemptions.map((r) => ({
      id: r.id,
      userId: r.user_id,
      user_id: r.user_id,
      userEmail: r.user_email,
      user_email: r.user_email,
      appId: r.app_id,
      app_id: r.app_id,
      appName: r.app_name,
      app_name: r.app_name,
      pointsAmount: Number(r.points_amount),
      points_amount: r.points_amount,
      usdValue: Number(r.usd_value),
      usd_value: r.usd_value,
      elizaAmount: Number(r.eliza_amount),
      eliza_amount: r.eliza_amount,
      elizaPriceUsd: Number(r.eliza_price_usd),
      eliza_price_usd: r.eliza_price_usd,
      network: r.network,
      payoutAddress: r.payout_address,
      payout_address: r.payout_address,
      status: r.status,
      requiresReview: r.requires_review,
      requires_review: r.requires_review,
      txHash: r.tx_hash,
      tx_hash: r.tx_hash,
      failureReason: r.failure_reason,
      failure_reason: r.failure_reason,
      retryCount: Number(r.retry_count),
      retry_count: r.retry_count,
      reviewedBy: r.reviewed_by,
      reviewed_by: r.reviewed_by,
      reviewedAt: r.reviewed_at?.toISOString(),
      reviewed_at: r.reviewed_at?.toISOString(),
      reviewNotes: r.review_notes,
      review_notes: r.review_notes,
      createdAt: r.created_at.toISOString(),
      created_at: r.created_at.toISOString(),
      updated_at: r.created_at.toISOString(),
      completedAt: r.completed_at?.toISOString(),
      completed_at: r.completed_at?.toISOString(),
      rejection_reason: r.status === "rejected" ? r.failure_reason : null,
      metadata: r.metadata,
    }));

    const stats = {
      pending: statusCounts.pending?.count || 0,
      approved: statusCounts.approved?.count || 0,
      processing: statusCounts.processing?.count || 0,
      completed: statusCounts.completed?.count || 0,
      failed: statusCounts.failed?.count || 0,
      rejected: statusCounts.rejected?.count || 0,
      totalPendingUsd: statusCounts.pending?.totalUsd || 0,
    };

    return c.json({
      success: true,
      redemptions: rows,
      stats,
      summary: {
        statusCounts,
        pendingReview: stats.pending,
        totalPendingUsd: stats.totalPendingUsd,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const { user: adminUser } = await requireAdmin(c);
    const body = await c.req.json();
    const validation = AdminActionSchema.safeParse(body);

    if (!validation.success) {
      return c.json(
        { success: false, error: "Invalid request", details: validation.error.issues },
        400,
      );
    }

    const { redemptionId, action, notes, reason } = validation.data;
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
      if (!result.success) return c.json({ success: false, error: result.error }, 400);
      return c.json({
        success: true,
        message: "Redemption approved. It will be processed in the next batch.",
      });
    }

    const result = await secureTokenRedemptionService.rejectRedemption(
      redemptionId,
      adminUser.id,
      reason || notes || "Rejected by admin",
    );
    if (!result.success) return c.json({ success: false, error: result.error }, 400);
    return c.json({
      success: true,
      message: "Redemption rejected. User balance has been refunded.",
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.options("/", (c) =>
  c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-App-Id",
  }),
);

export default app;
