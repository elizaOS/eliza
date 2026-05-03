/**
 * GET /api/cron/release-pending-earnings
 * Daily cron — moves vested earnings from pending → withdrawable so creators
 * can redeem them. Protected by CRON_SECRET.
 */

import { and, gt, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead, dbWrite } from "@/db/client";
import { appEarnings, appEarningsTransactions } from "@/db/schemas/app-earnings";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { VESTING_CONFIG } from "@/lib/config/redemption-addresses";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    requireCronSecret(c);
    const startTime = Date.now();
    logger.info("[ReleasePending] Starting pending earnings release job");

    let appsProcessed = 0;
    let totalReleased = 0;

    const cutoffDate = new Date(Date.now() - VESTING_CONFIG.APP_EARNINGS_HOLD_PERIOD_MS);

    const appsWithPending = await dbRead
      .select({
        app_id: appEarnings.app_id,
        pending_balance: appEarnings.pending_balance,
      })
      .from(appEarnings)
      .where(gt(sql`CAST(${appEarnings.pending_balance} AS DECIMAL)`, 0));

    for (const row of appsWithPending) {
      const oldestPendingTransaction = await dbRead
        .select({
          created_at: appEarningsTransactions.created_at,
          amount: appEarningsTransactions.amount,
        })
        .from(appEarningsTransactions)
        .where(
          and(
            sql`${appEarningsTransactions.app_id} = ${row.app_id}`,
            sql`${appEarningsTransactions.type} IN ('inference_markup', 'purchase_share')`,
            lte(appEarningsTransactions.created_at, cutoffDate),
          ),
        )
        .orderBy(appEarningsTransactions.created_at)
        .limit(1);

      if (oldestPendingTransaction.length === 0) continue;

      const releasableResult = await dbRead
        .select({
          total: sql<string>`COALESCE(SUM(CAST(${appEarningsTransactions.amount} AS DECIMAL)), 0)`,
        })
        .from(appEarningsTransactions)
        .where(
          and(
            sql`${appEarningsTransactions.app_id} = ${row.app_id}`,
            sql`${appEarningsTransactions.type} IN ('inference_markup', 'purchase_share')`,
            lte(appEarningsTransactions.created_at, cutoffDate),
          ),
        );

      const releasableAmount = Number(releasableResult[0]?.total || 0);
      const pendingBalance = Number(row.pending_balance);
      const amountToRelease = Math.min(releasableAmount, pendingBalance);

      if (amountToRelease <= 0) continue;

      await dbWrite.transaction(async (tx) => {
        await tx
          .update(appEarnings)
          .set({
            pending_balance: sql`GREATEST(0, ${appEarnings.pending_balance} - ${amountToRelease})`,
            withdrawable_balance: sql`${appEarnings.withdrawable_balance} + ${amountToRelease}`,
            updated_at: new Date(),
          })
          .where(sql`${appEarnings.app_id} = ${row.app_id}`);

        await tx.insert(appEarningsTransactions).values({
          app_id: row.app_id,
          type: "vesting_release",
          amount: String(amountToRelease),
          description: `Vesting release: $${amountToRelease.toFixed(2)} now withdrawable`,
          metadata: {
            released_at: new Date().toISOString(),
            vesting_period_days: VESTING_CONFIG.APP_EARNINGS_HOLD_PERIOD_MS / (24 * 60 * 60 * 1000),
          },
        });
      });

      appsProcessed++;
      totalReleased += amountToRelease;

      logger.info("[ReleasePending] Released pending earnings", {
        appId: row.app_id,
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

    return c.json({
      success: true,
      stats: { appsProcessed, totalReleased, durationMs: duration },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
