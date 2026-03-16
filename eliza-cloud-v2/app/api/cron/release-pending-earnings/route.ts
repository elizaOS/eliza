/**
 * Cron Job: Release Pending Earnings to Withdrawable
 *
 * This job runs daily to move earnings from pending_balance to withdrawable_balance
 * after the vesting period has elapsed.
 *
 * Points must be held for a configurable period before they can be redeemed:
 * - Direct purchases: No vesting (immediately available)
 * - Social rewards: 24 hours
 * - App earnings: 7 days
 * - Referral bonuses: 14 days
 *
 * This prevents abuse like:
 * - Self-dealing through apps (earn → redeem → repeat)
 * - Referral fraud
 * - Flash loan-style attacks
 *
 * Schedule: Run daily at midnight UTC
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { dbRead, dbWrite } from "@/db/client";
import { appEarnings } from "@/db/schemas/app-earnings";
import { appEarningsTransactions } from "@/db/schemas/app-earnings";
import { sql, and, gt, lte } from "drizzle-orm";
import { logger } from "@/lib/utils/logger";
import { VESTING_CONFIG } from "@/lib/config/redemption-addresses";

/**
 * Verify cron secret for authentication using timing-safe comparison.
 * SECURITY: Uses timingSafeEqual to prevent timing attacks on secret.
 */
function verifyCronSecret(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    logger.warn("[ReleasePending] CRON_SECRET not configured");
    return false;
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return false;
  }

  const providedSecret = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  // SECURITY: Timing-safe comparison to prevent timing attacks
  try {
    const secretBuffer = Buffer.from(cronSecret, "utf-8");
    const providedBuffer = Buffer.from(providedSecret, "utf-8");

    if (secretBuffer.length !== providedBuffer.length) {
      return false;
    }

    return timingSafeEqual(secretBuffer, providedBuffer);
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  // Verify cron authorization
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  logger.info("[ReleasePending] Starting pending earnings release job");

  let appsProcessed = 0;
  let totalReleased = 0;

  // Calculate cutoff date for standard earnings (7 days ago)
  const cutoffDate = new Date(
    Date.now() - VESTING_CONFIG.APP_EARNINGS_HOLD_PERIOD_MS,
  );

  // Find all apps with pending balances where earnings are old enough
  // We look at the oldest transaction to determine if balance can be released
  const appsWithPending = await dbRead
    .select({
      app_id: appEarnings.app_id,
      pending_balance: appEarnings.pending_balance,
    })
    .from(appEarnings)
    .where(gt(sql`CAST(${appEarnings.pending_balance} AS DECIMAL)`, 0));

  for (const app of appsWithPending) {
    // Check if this app has any earnings older than the vesting period
    // that haven't been released yet
    const oldestPendingTransaction = await dbRead
      .select({
        created_at: appEarningsTransactions.created_at,
        amount: appEarningsTransactions.amount,
      })
      .from(appEarningsTransactions)
      .where(
        and(
          sql`${appEarningsTransactions.app_id} = ${app.app_id}`,
          sql`${appEarningsTransactions.type} IN ('inference_markup', 'purchase_share')`,
          lte(appEarningsTransactions.created_at, cutoffDate),
        ),
      )
      .orderBy(appEarningsTransactions.created_at)
      .limit(1);

    if (oldestPendingTransaction.length === 0) {
      // No old enough transactions, skip this app
      continue;
    }

    // Calculate total amount that can be released
    // (all transactions older than vesting period)
    const releasableResult = await dbRead
      .select({
        total: sql<string>`COALESCE(SUM(CAST(${appEarningsTransactions.amount} AS DECIMAL)), 0)`,
      })
      .from(appEarningsTransactions)
      .where(
        and(
          sql`${appEarningsTransactions.app_id} = ${app.app_id}`,
          sql`${appEarningsTransactions.type} IN ('inference_markup', 'purchase_share')`,
          lte(appEarningsTransactions.created_at, cutoffDate),
        ),
      );

    const releasableAmount = Number(releasableResult[0]?.total || 0);
    const pendingBalance = Number(app.pending_balance);

    // Release the lesser of: releasable transactions sum or pending balance
    const amountToRelease = Math.min(releasableAmount, pendingBalance);

    if (amountToRelease <= 0) {
      continue;
    }

    // Atomic release: move from pending to withdrawable
    await dbWrite.transaction(async (tx) => {
      await tx
        .update(appEarnings)
        .set({
          pending_balance: sql`GREATEST(0, ${appEarnings.pending_balance} - ${amountToRelease})`,
          withdrawable_balance: sql`${appEarnings.withdrawable_balance} + ${amountToRelease}`,
          updated_at: new Date(),
        })
        .where(sql`${appEarnings.app_id} = ${app.app_id}`);

      // Record the release as a transaction for audit trail
      await tx.insert(appEarningsTransactions).values({
        app_id: app.app_id,
        type: "vesting_release",
        amount: String(amountToRelease),
        description: `Vesting release: $${amountToRelease.toFixed(2)} now withdrawable`,
        metadata: {
          released_at: new Date().toISOString(),
          vesting_period_days:
            VESTING_CONFIG.APP_EARNINGS_HOLD_PERIOD_MS / (24 * 60 * 60 * 1000),
        },
      });
    });

    appsProcessed++;
    totalReleased += amountToRelease;

    logger.info("[ReleasePending] Released pending earnings", {
      appId: app.app_id,
      amountReleased: amountToRelease,
      remainingPending: pendingBalance - amountToRelease,
    });
  }

  const duration = Date.now() - startTime;

  logger.info("[ReleasePending] Job completed", {
    appsProcessed,
    totalReleased,
    durationMs: duration,
  });

  return NextResponse.json({
    success: true,
    stats: {
      appsProcessed,
      totalReleased,
      durationMs: duration,
    },
  });
}
