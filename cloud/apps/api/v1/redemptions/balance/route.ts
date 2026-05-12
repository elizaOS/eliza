/**
 * GET /api/v1/redemptions/balance — user's redeemable earnings balance.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead } from "@/db/client";
import { redeemableEarnings, redeemableEarningsLedger } from "@/db/schemas/redeemable-earnings";
import { tokenRedemptions } from "@/db/schemas/token-redemptions";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { SUPPLY_SHOCK_PROTECTION } from "@/lib/config/redemption-security";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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

    const lastRedemption = await dbRead.query.tokenRedemptions.findFirst({
      where: eq(tokenRedemptions.user_id, user.id),
      orderBy: (r, { desc: d }) => [d(r.created_at)],
    });

    const cooldownMs = SUPPLY_SHOCK_PROTECTION.USER_COOLDOWN_MS;
    const lastRedemptionTime = lastRedemption
      ? lastRedemption.created_at instanceof Date
        ? lastRedemption.created_at.getTime()
        : new Date(lastRedemption.created_at).getTime()
      : null;
    const cooldownEndsAt = lastRedemptionTime ? new Date(lastRedemptionTime + cooldownMs) : null;
    const isInCooldown = cooldownEndsAt && cooldownEndsAt > new Date();

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const dailyRedeemedResult = await dbRead.execute(sql`
      SELECT COALESCE(SUM(CAST(usd_value AS DECIMAL)), 0) as total
      FROM token_redemptions
      WHERE user_id = ${user.id}
      AND status IN ('completed', 'approved', 'processing')
      AND created_at >= ${todayStart}
    `);

    const dailyRedeemed = Number((dailyRedeemedResult.rows[0] as { total: string })?.total || 0);
    const dailyLimitRemaining = Math.max(
      0,
      SUPPLY_SHOCK_PROTECTION.USER_DAILY_LIMIT_USD - dailyRedeemed,
    );

    const availableBalance = earningsRecord ? Number(earningsRecord.available_balance) : 0;
    const pendingBalance = earningsRecord ? Number(earningsRecord.total_pending) : 0;
    const totalEarned = earningsRecord ? Number(earningsRecord.total_earned) : 0;
    const totalPending = earningsRecord ? Number(earningsRecord.total_pending) : 0;
    const totalConvertedToCredits = earningsRecord
      ? Number(earningsRecord.total_converted_to_credits)
      : 0;

    let canRedeem = true;
    let reason: string | undefined;

    if (availableBalance < SUPPLY_SHOCK_PROTECTION.MIN_REDEMPTION_USD) {
      canRedeem = false;
      reason = `Minimum redemption is $${SUPPLY_SHOCK_PROTECTION.MIN_REDEMPTION_USD.toFixed(2)}. You have $${availableBalance.toFixed(2)} available.`;
    } else if (isInCooldown) {
      canRedeem = false;
      reason = `Cooldown active. You can redeem again after ${cooldownEndsAt!.toISOString()}.`;
    } else if (dailyLimitRemaining <= 0) {
      canRedeem = false;
      reason = `Daily limit reached. Resets at midnight UTC.`;
    }

    const bySource: EarningsBySource[] = earningsBySource.map((e) => ({
      source: (e.source || "miniapp") as "miniapp" | "agent" | "mcp",
      totalEarned: Number(e.totalEarned || 0),
      count: Number(e.count || 0),
    }));

    const formattedRecentEarnings: RecentEarning[] = recentEarnings.map((e) => ({
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
    }));

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
      limits: {
        minRedemptionUsd: SUPPLY_SHOCK_PROTECTION.MIN_REDEMPTION_USD,
        maxSingleRedemptionUsd: SUPPLY_SHOCK_PROTECTION.MAX_SINGLE_REDEMPTION_USD,
        userDailyLimitUsd: SUPPLY_SHOCK_PROTECTION.USER_DAILY_LIMIT_USD,
        userHourlyLimitUsd: SUPPLY_SHOCK_PROTECTION.USER_HOURLY_LIMIT_USD,
      },
      eligibility: {
        canRedeem,
        reason,
        cooldownEndsAt: cooldownEndsAt?.toISOString(),
        dailyLimitRemaining,
      },
    });
  } catch (error) {
    logger.error("[Redemptions/Balance] Error fetching balance:", error);
    return failureResponse(c, error);
  }
});

export default app;
