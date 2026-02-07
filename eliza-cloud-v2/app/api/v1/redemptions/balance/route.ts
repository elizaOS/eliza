/**
 * Redemption Balance API
 *
 * GET /api/v1/redemptions/balance
 *
 * Returns user's REDEEMABLE balance (earnings from miniapps, agents, MCPs).
 *
 * IMPORTANT: This uses the redeemable_earnings table, NOT app_credit_balances.
 * - app_credit_balances = purchased credits (NOT redeemable)
 * - redeemable_earnings = earned credits (redeemable for elizaOS tokens)
 *
 * Response includes:
 * - Total earned from all sources
 * - Available balance (ready to redeem)
 * - Pending balance (still vesting)
 * - Already redeemed
 * - Earnings breakdown by source (miniapp, agent, mcp)
 * - Eligibility status for redemption
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { dbRead } from "@/db/client";
import {
  redeemableEarnings,
  redeemableEarningsLedger,
} from "@/db/schemas/redeemable-earnings";
import { tokenRedemptions } from "@/db/schemas/token-redemptions";
import { eq, and, sql, desc } from "drizzle-orm";
import { SUPPLY_SHOCK_PROTECTION } from "@/lib/config/redemption-security";

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

interface BalanceResponse {
  success: boolean;
  balance: {
    totalEarned: number;
    availableBalance: number;
    pendingBalance: number;
    totalRedeemed: number;
    totalPending: number;
  };
  bySource: EarningsBySource[];
  recentEarnings: RecentEarning[];
  limits: {
    minRedemptionUsd: number;
    maxSingleRedemptionUsd: number;
    userDailyLimitUsd: number;
    userHourlyLimitUsd: number;
  };
  eligibility: {
    canRedeem: boolean;
    reason?: string;
    cooldownEndsAt?: string;
    dailyLimitRemaining?: number;
  };
}

/**
 * GET /api/v1/redemptions/balance
 * Get user's redeemable earnings balance.
 */
async function getBalanceHandler(request: NextRequest): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  try {
    // Get user's redeemable earnings record
    const earningsRecord = await dbRead.query.redeemableEarnings.findFirst({
      where: eq(redeemableEarnings.user_id, user.id),
    });

    // Get earnings breakdown by source
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

    // Get recent earnings (last 10)
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

    // Get total redeemed
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

    // Check for cooldown (last redemption time)
    const lastRedemption = await dbRead.query.tokenRedemptions.findFirst({
      where: eq(tokenRedemptions.user_id, user.id),
      orderBy: (r, { desc: d }) => [d(r.created_at)],
    });

    const cooldownMs = SUPPLY_SHOCK_PROTECTION.USER_COOLDOWN_MS;
    // Handle created_at as either Date object or string (depends on DB driver)
    const lastRedemptionTime = lastRedemption
      ? lastRedemption.created_at instanceof Date
        ? lastRedemption.created_at.getTime()
        : new Date(lastRedemption.created_at).getTime()
      : null;
    const cooldownEndsAt = lastRedemptionTime
      ? new Date(lastRedemptionTime + cooldownMs)
      : null;
    const isInCooldown = cooldownEndsAt && cooldownEndsAt > new Date();

    // Check daily limit
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const dailyRedeemedResult = await dbRead.execute(sql`
    SELECT COALESCE(SUM(CAST(usd_value AS DECIMAL)), 0) as total
    FROM token_redemptions
    WHERE user_id = ${user.id}
    AND status IN ('completed', 'approved', 'processing')
    AND created_at >= ${todayStart}
  `);

    const dailyRedeemed = Number(
      (dailyRedeemedResult.rows[0] as { total: string })?.total || 0,
    );
    const dailyLimitRemaining = Math.max(
      0,
      SUPPLY_SHOCK_PROTECTION.USER_DAILY_LIMIT_USD - dailyRedeemed,
    );

    // Build balance
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

    // Determine eligibility
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

    // Format earnings by source
    const bySource: EarningsBySource[] = earningsBySource.map((e) => ({
      source: (e.source || "miniapp") as "miniapp" | "agent" | "mcp",
      totalEarned: Number(e.totalEarned || 0),
      count: Number(e.count || 0),
    }));

    // Format recent earnings (handle createdAt as Date or string)
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

    return NextResponse.json({
      success: true,
      balance: {
        totalEarned,
        availableBalance,
        pendingBalance,
        totalRedeemed,
        totalPending,
      },
      bySource,
      recentEarnings: formattedRecentEarnings,
      limits: {
        minRedemptionUsd: SUPPLY_SHOCK_PROTECTION.MIN_REDEMPTION_USD,
        maxSingleRedemptionUsd:
          SUPPLY_SHOCK_PROTECTION.MAX_SINGLE_REDEMPTION_USD,
        userDailyLimitUsd: SUPPLY_SHOCK_PROTECTION.USER_DAILY_LIMIT_USD,
        userHourlyLimitUsd: SUPPLY_SHOCK_PROTECTION.USER_HOURLY_LIMIT_USD,
      },
      eligibility: {
        canRedeem,
        reason,
        cooldownEndsAt: cooldownEndsAt?.toISOString(),
        dailyLimitRemaining,
      },
    } satisfies BalanceResponse);
  } catch (error) {
    console.error("[Redemptions/Balance] Error fetching balance:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch balance",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export const GET = withRateLimit(getBalanceHandler, RateLimitPresets.STANDARD);

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
