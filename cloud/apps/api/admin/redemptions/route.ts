/**
 * /api/admin/redemptions
 * GET: list redemptions filtered by status (admin only).
 * POST: approve/reject a redemption (admin only). Rejection refunds balance.
 */

import { desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbRead } from "@/db/client";
import { apps } from "@/db/schemas/apps";
import { type TokenRedemption, tokenRedemptions } from "@/db/schemas/token-redemptions";
import { users } from "@/db/schemas/users";
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
});

const app = new Hono<AppEnv>();

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const { user: adminUser } = await requireAdmin(c);

    const statusFilter = c.req.query("status") || "pending";
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 50;

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

    return c.json({
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
      if (!result.success) return c.json({ success: false, error: result.error }, 400);
      return c.json({
        success: true,
        message: "Redemption approved. It will be processed in the next batch.",
      });
    }

    const result = await secureTokenRedemptionService.rejectRedemption(
      redemptionId,
      adminUser.id,
      notes || "Rejected by admin",
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
