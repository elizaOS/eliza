/**
 * Projects durable app-inference debit events into mutable usage counters.
 *
 * The credit transaction is the retryable source event. A projection row and
 * both counter updates commit in one transaction, so concurrent retries and
 * commit-acknowledgement loss cannot increment usage more than once.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { dbWrite, writeTransaction } from "../../db/helpers";
import { appUsageProjections } from "../../db/schemas/app-usage-projections";
import { apps, appUsers } from "../../db/schemas/apps";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { users } from "../../db/schemas/users";
import { logger } from "../utils/logger";

export const APP_USAGE_PROJECTION_VERSION = 1;

const PROJECTION_EPSILON = 0.000001;

export interface AppUsageProjectionResult {
  chargeTransactionId: string;
  status: "applied" | "skipped_missing_app" | "skipped_missing_user";
  deduplicated: boolean;
}

export interface AppUsageProjectionSweepStats {
  scanned: number;
  applied: number;
  skipped: number;
  deduplicated: number;
  failed: number;
  capHit: boolean;
}

interface AppUsageSource {
  appId: string;
  userId: string;
  creditsUsed: number;
  metadata: Record<string, unknown>;
}

function parseAppUsageSource(row: typeof creditTransactions.$inferSelect): AppUsageSource {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const appId =
    typeof metadata.appId === "string" && metadata.appId.length > 0 ? metadata.appId : null;
  const userId =
    typeof metadata.userId === "string" && metadata.userId.length > 0 ? metadata.userId : null;
  const creditsUsed = Math.abs(Number(row.amount));
  const recordedTotalCost = Number(metadata.totalCost);
  if (
    row.type !== "debit" ||
    metadata.appUsageProjectionVersion !== APP_USAGE_PROJECTION_VERSION ||
    !appId ||
    !userId ||
    !Number.isFinite(creditsUsed) ||
    creditsUsed <= 0 ||
    !Number.isFinite(recordedTotalCost) ||
    Math.abs(recordedTotalCost - creditsUsed) > PROJECTION_EPSILON
  ) {
    throw new Error(`Credit transaction ${row.id} is not a canonical app usage source`);
  }
  return { appId, userId, creditsUsed, metadata };
}

/**
 * Apply one app usage source exactly once.
 *
 * Missing app/user rows are terminal projection outcomes, not billing errors:
 * the source request already ran and its financial settlement remains valid.
 */
export async function projectAppUsageForDebit(
  chargeTransactionId: string,
): Promise<AppUsageProjectionResult> {
  if (!chargeTransactionId) {
    throw new Error("App usage projection requires a charge transaction id");
  }

  return await writeTransaction(async (tx) => {
    const [sourceRow] = await tx
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.id, chargeTransactionId))
      .limit(1);
    if (!sourceRow) {
      throw new Error(`App usage source transaction ${chargeTransactionId} was not found`);
    }
    const source = parseAppUsageSource(sourceRow);
    const creditsUsed = source.creditsUsed.toFixed(6);

    const [claim] = await tx
      .insert(appUsageProjections)
      .values({
        charge_transaction_id: chargeTransactionId,
        app_id: source.appId,
        user_id: source.userId,
        credits_used: creditsUsed,
        status: "pending",
      })
      .onConflictDoNothing({
        target: appUsageProjections.charge_transaction_id,
      })
      .returning();
    if (!claim) {
      const [existing] = await tx
        .select({ status: appUsageProjections.status })
        .from(appUsageProjections)
        .where(eq(appUsageProjections.charge_transaction_id, chargeTransactionId))
        .limit(1);
      if (!existing || existing.status === "pending") {
        throw new Error(
          `App usage projection ${chargeTransactionId} has an ambiguous commit state`,
        );
      }
      return {
        chargeTransactionId,
        status: existing.status,
        deduplicated: true,
      };
    }

    const [currentApp] = await tx
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.id, source.appId))
      .limit(1)
      .for("key share");
    if (!currentApp) {
      await tx
        .update(appUsageProjections)
        .set({
          status: "skipped_missing_app",
          projected_at: new Date(),
        })
        .where(eq(appUsageProjections.charge_transaction_id, chargeTransactionId));
      return {
        chargeTransactionId,
        status: "skipped_missing_app",
        deduplicated: false,
      };
    }

    const [currentUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, source.userId))
      .limit(1)
      .for("key share");
    if (!currentUser) {
      await tx
        .update(appUsageProjections)
        .set({
          status: "skipped_missing_user",
          projected_at: new Date(),
        })
        .where(eq(appUsageProjections.charge_transaction_id, chargeTransactionId));
      return {
        chargeTransactionId,
        status: "skipped_missing_user",
        deduplicated: false,
      };
    }

    const [createdAppUser] = await tx
      .insert(appUsers)
      .values({
        app_id: source.appId,
        user_id: source.userId,
        total_requests: 1,
        total_credits_used: creditsUsed,
        metadata: {
          ...source.metadata,
          firstUsageChargeTransactionId: chargeTransactionId,
        },
      })
      .onConflictDoNothing({
        target: [appUsers.app_id, appUsers.user_id],
      })
      .returning({ id: appUsers.id });

    if (!createdAppUser) {
      await tx
        .update(appUsers)
        .set({
          total_requests: sql`${appUsers.total_requests} + 1`,
          total_credits_used: sql`${appUsers.total_credits_used} + ${creditsUsed}`,
          last_seen_at: new Date(),
        })
        .where(and(eq(appUsers.app_id, source.appId), eq(appUsers.user_id, source.userId)));
    }

    const [updatedApp] = await tx
      .update(apps)
      .set({
        total_requests: sql`${apps.total_requests} + 1`,
        total_users: sql`${apps.total_users} + ${createdAppUser ? 1 : 0}`,
        total_credits_used: sql`${apps.total_credits_used} + ${creditsUsed}`,
        last_used_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(apps.id, source.appId))
      .returning({ id: apps.id });
    if (!updatedApp) {
      throw new Error(`App ${source.appId} disappeared while projecting ${chargeTransactionId}`);
    }

    await tx
      .update(appUsageProjections)
      .set({ status: "applied", projected_at: new Date() })
      .where(eq(appUsageProjections.charge_transaction_id, chargeTransactionId));

    return {
      chargeTransactionId,
      status: "applied",
      deduplicated: false,
    };
  });
}

/**
 * Retry debit-backed projections that were not acknowledged by their caller.
 * Any failed source remains absent from the projection table and is retried by
 * the next cron run; this invocation still throws so the failure is observable.
 */
export async function sweepPendingAppUsageProjections(
  options: { limit?: number; concurrency?: number } = {},
): Promise<AppUsageProjectionSweepStats> {
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 2_000);
  const concurrency = Math.min(Math.max(options.concurrency ?? 10, 1), 50);
  const candidates = await dbWrite
    .select({ id: creditTransactions.id })
    .from(creditTransactions)
    .leftJoin(
      appUsageProjections,
      eq(appUsageProjections.charge_transaction_id, creditTransactions.id),
    )
    .where(
      and(
        eq(creditTransactions.type, "debit"),
        sql`${creditTransactions.metadata} ->> 'appUsageProjectionVersion' = '1'`,
        isNull(appUsageProjections.charge_transaction_id),
      ),
    )
    .orderBy(asc(creditTransactions.created_at))
    .limit(limit);

  const stats: AppUsageProjectionSweepStats = {
    scanned: candidates.length,
    applied: 0,
    skipped: 0,
    deduplicated: 0,
    failed: 0,
    capHit: candidates.length === limit,
  };
  const failures: unknown[] = [];

  for (let offset = 0; offset < candidates.length; offset += concurrency) {
    const batch = candidates.slice(offset, offset + concurrency);
    const results = await Promise.allSettled(batch.map(({ id }) => projectAppUsageForDebit(id)));
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      const chargeTransactionId = batch[index]!.id;
      if (result.status === "rejected") {
        stats.failed++;
        failures.push(result.reason);
        logger.error("[AppUsageProjection] Durable projection retry failed", {
          chargeTransactionId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        continue;
      }
      if (result.value.deduplicated) stats.deduplicated++;
      if (result.value.status === "applied") {
        stats.applied++;
      } else {
        stats.skipped++;
      }
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to project ${failures.length} durable app usage event(s)`,
    );
  }
  return stats;
}
