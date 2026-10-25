/**
 * GET /api/v1/redemptions/balance — user's redeemable earnings balance.
 *
 * Read-only. Creator payouts are retired (#23022), so `eligibility.canRedeem`
 * is always false; the frozen statement lives at GET /api/v1/earnings/statement.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { dbRead } from "@elizaos/cloud-shared/db/client";
import {
  redeemableEarnings,
  redeemableEarningsLedger,
} from "@elizaos/cloud-shared/db/schemas/redeemable-earnings";
import { tokenRedemptions } from "@elizaos/cloud-shared/db/schemas/token-redemptions";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";

interface EarningsBySource {
  source: "miniapp" | "agent" | "mcp";
  totalEarned: number;
  count: number;
}

interface RecentEarning {
  id: string;
  source: "miniapp" | "agent" | "mcp";
  sourceId: string;
  amount: number;
  description: string;
  createdAt: string;
}

const app = new Hono<AppEnv>();

app.options(
  "/",
  (_c) =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-API-Key, X-App-Id",
      },
    }),
);

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const earningsRecord = await dbRead.query.redeemableEarnings.findFirst({
      where: eq(redeemableEarnings.user_id, user.id),
    });

    const earningsBySource = await dbRead
      .select({
        source: redeemableEarningsLedger.earnings_source,
        totalEarned: sql<string>`SUM(CAST(${redeemableEarningsLedger.amount} AS DECIMAL))`,
        count: sql<number>`COUNT(*)`,
      })
      .from(redeemableEarningsLedger)
      .where(
        and(
          eq(redeemableEarningsLedger.user_id, user.id),
          eq(redeemableEarningsLedger.entry_type, "earning"),
        ),
      )
      .groupBy(redeemableEarningsLedger.earnings_source);

    const recentEarnings = await dbRead
      .select({
        id: redeemableEarningsLedger.id,
        source: redeemableEarningsLedger.earnings_source,
        sourceId: redeemableEarningsLedger.source_id,
        amount: redeemableEarningsLedger.amount,
        description: redeemableEarningsLedger.description,
        createdAt: redeemableEarningsLedger.created_at,
      })
      .from(redeemableEarningsLedger)
      .where(
        and(
          eq(redeemableEarningsLedger.user_id, user.id),
          eq(redeemableEarningsLedger.entry_type, "earning"),
        ),
      )
      .orderBy(desc(redeemableEarningsLedger.created_at))
      .limit(10);

    const redeemedResult = await dbRead
      .select({
        total: sql<string>`COALESCE(SUM(CAST(${tokenRedemptions.usd_value} AS DECIMAL)), 0)`,
      })
      .from(tokenRedemptions)
      .where(
        and(
          eq(tokenRedemptions.user_id, user.id),
          sql`${tokenRedemptions.status} IN ('completed', 'approved', 'processing')`,
        ),
      );

    const totalRedeemed = Number(redeemedResult[0]?.total || 0);

    const availableBalance = earningsRecord
      ? Number(earningsRecord.available_balance)
      : 0;
    const pendingBalance = earningsRecord
      ? Number(earningsRecord.total_pending)
      : 0;
    const totalEarned = earningsRecord
      ? Number(earningsRecord.total_earned)
      : 0;
    const totalPending = earningsRecord
      ? Number(earningsRecord.total_pending)
      : 0;
    const totalConvertedToCredits = earningsRecord
      ? Number(earningsRecord.total_converted_to_credits)
      : 0;

    const bySource: EarningsBySource[] = earningsBySource.map((e) => ({
      source: (e.source || "miniapp") as "miniapp" | "agent" | "mcp",
      totalEarned: Number(e.totalEarned || 0),
      count: Number(e.count || 0),
    }));

    const formattedRecentEarnings: RecentEarning[] = recentEarnings.map(
      (e) => ({
        id: e.id,
        source: (e.source || "miniapp") as "miniapp" | "agent" | "mcp",
        sourceId: e.sourceId || "",
        amount: Number(e.amount),
        description: e.description || "",
        createdAt: e.createdAt
          ? e.createdAt instanceof Date
            ? e.createdAt.toISOString()
            : String(e.createdAt)
          : "",
      }),
    );

    return c.json({
      success: true,
      balance: {
        totalEarned,
        availableBalance,
        pendingBalance,
        totalRedeemed,
        totalPending,
        totalConvertedToCredits,
      },
      bySource,
      recentEarnings: formattedRecentEarnings,
      payoutsRetired: true,
      eligibility: {
        canRedeem: false,
        reason: "Creator payouts have been retired.",
      },
    });
  } catch (error) {
    logger.error("[Redemptions/Balance] Error fetching balance:", error);
    return failureResponse(c, error);
  }
});

export default app;
