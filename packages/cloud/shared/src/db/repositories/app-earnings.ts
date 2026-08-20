/** Persists app earnings records for cloud services through the shared DB boundary. */

import Decimal from "decimal.js";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { logger } from "../../lib/utils/logger";
import type { DbTransaction } from "../client";
import { dbRead, dbWrite } from "../helpers";
import {
  type AppEarnings,
  type AppEarningsTransaction,
  appEarnings,
  appEarningsTransactions,
  type NewAppEarnings,
  type NewAppEarningsTransaction,
} from "../schemas/app-earnings";
import { apps } from "../schemas/apps";
import { redeemableEarningsLedger } from "../schemas/redeemable-earnings";
import { parseEarningsNumber } from "./app-earnings-numeric";

export type { AppEarnings, AppEarningsTransaction, NewAppEarnings, NewAppEarningsTransaction };

type WithdrawalResult = {
  success: boolean;
  earnings: AppEarnings | null;
  message: string;
};

type IdempotentWithdrawalResult = WithdrawalResult & {
  transaction?: AppEarningsTransaction;
};

export interface ApplyCreatorMovementParams {
  appId: string;
  userId: string;
  type: "inference_markup" | "purchase_share";
  creatorAmount: number;
  platformRevenueAmount: number;
  description: string;
  metadata: Record<string, unknown>;
  redeemableLedgerEntryId: string;
  redeemableDeduplicated: boolean;
}

export interface ApplyCreatorMovementResult {
  deduplicated: boolean;
  transaction: AppEarningsTransaction | null;
}

export class CreatorMovementReplayMismatchError extends Error {
  constructor(
    readonly redeemableLedgerEntryId: string,
    readonly mismatch: string = "committed projection differs from replay",
  ) {
    super(
      `Creator movement replay mismatch for redeemable ledger ${redeemableLedgerEntryId}: ${mismatch}`,
    );
    this.name = "CreatorMovementReplayMismatchError";
  }
}

class WithdrawalRollback extends Error {
  constructor(readonly result: WithdrawalResult) {
    super(result.message);
    this.name = "WithdrawalRollback";
  }
}

/**
 * Repository for app earnings database operations.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class AppEarningsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds app earnings record by app ID.
   */
  async findByAppId(appId: string): Promise<AppEarnings | undefined> {
    return await dbRead.query.appEarnings.findFirst({
      where: eq(appEarnings.app_id, appId),
    });
  }

  /**
   * Lists earnings transactions for an app, ordered by creation date.
   */
  async listTransactions(
    appId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<AppEarningsTransaction[]> {
    return await dbRead.query.appEarningsTransactions.findMany({
      where: eq(appEarningsTransactions.app_id, appId),
      orderBy: [desc(appEarningsTransactions.created_at)],
      limit,
      offset,
    });
  }

  /**
   * Lists earnings transactions filtered by type.
   */
  async listTransactionsByType(
    appId: string,
    type: string,
    limit: number = 50,
  ): Promise<AppEarningsTransaction[]> {
    return await dbRead.query.appEarningsTransactions.findMany({
      where: and(eq(appEarningsTransactions.app_id, appId), eq(appEarningsTransactions.type, type)),
      orderBy: [desc(appEarningsTransactions.created_at)],
      limit,
    });
  }

  /**
   * Finds an earnings transaction by Stripe payment intent ID.
   *
   * Uses JSONB containment query for efficient lookup.
   */
  async findTransactionByPaymentIntent(
    appId: string,
    paymentIntentId: string,
    transaction?: DbTransaction,
  ): Promise<AppEarningsTransaction | undefined> {
    const result = await (transaction ?? dbRead)
      .select()
      .from(appEarningsTransactions)
      .where(
        and(
          eq(appEarningsTransactions.app_id, appId),
          sql`${appEarningsTransactions.metadata} @> ${JSON.stringify({ stripePaymentIntentId: paymentIntentId })}::jsonb`,
        ),
      )
      .limit(1);

    return result[0];
  }

  /**
   * Finds an earnings transaction by idempotency key.
   *
   * Used for withdrawal deduplication when clients retry failed requests.
   * Uses JSONB containment query for efficient lookup (covered by GIN index).
   */
  async findTransactionByIdempotencyKey(
    appId: string,
    idempotencyKey: string,
  ): Promise<AppEarningsTransaction | undefined> {
    return this.findTransactionByIdempotencyKeyFromDb(dbRead, appId, idempotencyKey);
  }

  /**
   * Finds a withdrawal transaction by idempotency key on the primary.
   *
   * Use this in write/idempotency flows where read-replica lag would otherwise
   * make a completed withdrawal look "still in progress" immediately after the
   * unique-index conflict resolves.
   */
  async findTransactionByIdempotencyKeyOnPrimary(
    appId: string,
    idempotencyKey: string,
  ): Promise<AppEarningsTransaction | undefined> {
    return this.findTransactionByIdempotencyKeyFromDb(dbWrite, appId, idempotencyKey);
  }

  private async findTransactionByIdempotencyKeyFromDb(
    database: typeof dbRead,
    appId: string,
    idempotencyKey: string,
  ): Promise<AppEarningsTransaction | undefined> {
    const result = await database
      .select()
      .from(appEarningsTransactions)
      .where(
        and(
          eq(appEarningsTransactions.app_id, appId),
          eq(appEarningsTransactions.type, "withdrawal"),
          sql`${appEarningsTransactions.metadata} @> ${JSON.stringify({ idempotencyKey })}::jsonb`,
        ),
      )
      .limit(1);

    return result[0];
  }

  /**
   * Gets transaction totals grouped by type within a date range.
   */
  async getTransactionTotalsByType(
    appId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<{
    inference_markup: number;
    purchase_share: number;
    withdrawal: number;
    adjustment: number;
  }> {
    const result = await dbRead
      .select({
        type: appEarningsTransactions.type,
        total: sql<string>`COALESCE(SUM(${appEarningsTransactions.amount}), 0)`,
      })
      .from(appEarningsTransactions)
      .where(
        and(
          eq(appEarningsTransactions.app_id, appId),
          gte(appEarningsTransactions.created_at, startDate),
          lte(appEarningsTransactions.created_at, endDate),
        ),
      )
      .groupBy(appEarningsTransactions.type);

    const totals = {
      inference_markup: 0,
      purchase_share: 0,
      withdrawal: 0,
      adjustment: 0,
    };

    for (const row of result) {
      if (row.type in totals) {
        totals[row.type as keyof typeof totals] = Number(row.total);
      }
    }

    return totals;
  }

  /**
   * Gets daily earnings breakdown within a date range.
   */
  async getDailyEarnings(
    appId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<
    Array<{
      date: string;
      inference_earnings: number;
      purchase_earnings: number;
      total: number;
    }>
  > {
    const result = await dbRead
      .select({
        date: sql<string>`DATE(${appEarningsTransactions.created_at})`,
        type: appEarningsTransactions.type,
        total: sql<string>`COALESCE(SUM(${appEarningsTransactions.amount}), 0)`,
      })
      .from(appEarningsTransactions)
      .where(
        and(
          eq(appEarningsTransactions.app_id, appId),
          gte(appEarningsTransactions.created_at, startDate),
          lte(appEarningsTransactions.created_at, endDate),
        ),
      )
      .groupBy(sql`DATE(${appEarningsTransactions.created_at})`, appEarningsTransactions.type)
      .orderBy(sql`DATE(${appEarningsTransactions.created_at})`);

    const byDate: Record<
      string,
      { inference_earnings: number; purchase_earnings: number; total: number }
    > = {};

    for (const row of result) {
      if (!byDate[row.date]) {
        byDate[row.date] = {
          inference_earnings: 0,
          purchase_earnings: 0,
          total: 0,
        };
      }

      const amount = Number(row.total);
      if (row.type === "inference_markup") {
        byDate[row.date].inference_earnings = amount;
      } else if (row.type === "purchase_share") {
        byDate[row.date].purchase_earnings = amount;
      }
      byDate[row.date].total += amount;
    }

    return Object.entries(byDate).map(([date, data]) => ({
      date,
      ...data,
    }));
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Gets existing earnings record or creates a new one if it doesn't exist.
   */
  async getOrCreate(appId: string): Promise<AppEarnings> {
    const existing = await this.findByAppId(appId);
    if (existing) {
      return existing;
    }

    const [created] = await dbWrite
      .insert(appEarnings)
      .values({ app_id: appId })
      .onConflictDoNothing()
      .returning();

    if (!created) {
      // Race condition - refetch from write DB.
      const refetched = await dbWrite.query.appEarnings.findFirst({
        where: eq(appEarnings.app_id, appId),
      });
      if (!refetched) {
        throw new Error(`Failed to create or find earnings for app ${appId}`);
      }
      return refetched;
    }

    return created;
  }

  /**
   * Projects one immutable redeemable-ledger movement into all app reporting
   * balances in a single transaction. The global ledger UUID is the claim key,
   * so a retry either heals a missing projection or validates the committed one.
   */
  async applyCreatorMovement(
    params: ApplyCreatorMovementParams,
    transaction?: DbTransaction,
  ): Promise<ApplyCreatorMovementResult> {
    const expectedCreatorAmount = new Decimal(params.creatorAmount);
    const platformRevenueAmount = new Decimal(params.platformRevenueAmount);
    if (
      !expectedCreatorAmount.isFinite() ||
      expectedCreatorAmount.isZero() ||
      !platformRevenueAmount.isFinite() ||
      (!platformRevenueAmount.isZero() &&
        expectedCreatorAmount.isPositive() !== platformRevenueAmount.isPositive())
    ) {
      throw new Error(
        "Creator movement amounts must be finite and creator amount must be non-zero",
      );
    }

    const expectedCreatorAmountRounded = expectedCreatorAmount
      .toDecimalPlaces(6)
      .toDecimalPlaces(4, Decimal.ROUND_DOWN);
    if (expectedCreatorAmountRounded.isZero()) {
      throw new Error("Creator movement amount is below the minimum ledger precision of 0.0001");
    }
    const platformRevenueDelta = platformRevenueAmount.toFixed(6);

    const apply = async (tx: DbTransaction): Promise<ApplyCreatorMovementResult> => {
      const [redeemableLedger] = await tx
        .select({
          amount: redeemableEarningsLedger.amount,
          entryType: redeemableEarningsLedger.entry_type,
          earningsSource: redeemableEarningsLedger.earnings_source,
          metadata: redeemableEarningsLedger.metadata,
        })
        .from(redeemableEarningsLedger)
        .where(eq(redeemableEarningsLedger.id, params.redeemableLedgerEntryId))
        .limit(1);

      const ledgerMetadata =
        redeemableLedger?.metadata && typeof redeemableLedger.metadata === "object"
          ? redeemableLedger.metadata
          : {};
      const creatorDelta = new Decimal(redeemableLedger?.amount ?? Number.NaN);
      const expectedEntryType = expectedCreatorAmount.isPositive() ? "earning" : "adjustment";
      const committedPlatformDelta = new Decimal(
        typeof ledgerMetadata.appPlatformRevenueDelta === "string" &&
          ledgerMetadata.appPlatformRevenueDelta.trim() !== ""
          ? ledgerMetadata.appPlatformRevenueDelta
          : Number.NaN,
      );
      // Identity fields (owner app/user, direction, source, type) must match on
      // EVERY replay — a divergence there is corruption. The amounts are held
      // to strict equality only when THIS call created the ledger row: a keyed
      // dedupe onto an existing row is a settlement-slot collision (e.g. stale
      // sweep vs late route settle computing from different actual costs), and
      // the design everywhere on this path is first-committed-wins — the
      // committed ledger row is authoritative and the request's amounts are
      // advisory (mirrors the org-refund dedupe and debitInferenceCost replay).
      const ledgerMismatch = !redeemableLedger
        ? "redeemable ledger row is missing"
        : !creatorDelta.isFinite()
          ? "redeemable amount is non-finite"
          : redeemableLedger.entryType !== expectedEntryType
            ? "redeemable entry type differs from creator movement direction"
            : redeemableLedger.earningsSource !== "miniapp"
              ? "redeemable source is not miniapp"
              : ledgerMetadata.app_id !== params.appId
                ? "redeemable app identity differs"
                : ledgerMetadata.earnings_type !== params.type
                  ? "redeemable earnings type differs"
                  : ledgerMetadata.transaction_user_id !== params.userId
                    ? "redeemable transaction user differs"
                    : !committedPlatformDelta.isFinite()
                      ? "redeemable platform revenue is non-finite"
                      : creatorDelta.isPositive() !== committedPlatformDelta.isPositive()
                        ? "redeemable platform revenue direction differs"
                        : !params.redeemableDeduplicated &&
                            !creatorDelta.equals(expectedCreatorAmountRounded)
                          ? `redeemable amount ${creatorDelta.toFixed()} differs from requested creator movement ${expectedCreatorAmountRounded.toFixed()}`
                          : !params.redeemableDeduplicated &&
                              !committedPlatformDelta.equals(platformRevenueDelta)
                            ? "redeemable platform revenue differs"
                            : null;
      if (ledgerMismatch) {
        throw new CreatorMovementReplayMismatchError(
          params.redeemableLedgerEntryId,
          ledgerMismatch,
        );
      }
      if (
        params.redeemableDeduplicated &&
        (!creatorDelta.equals(expectedCreatorAmountRounded) ||
          !committedPlatformDelta.equals(platformRevenueDelta))
      ) {
        logger.warn("[AppEarnings] Creator movement replay retained the first committed amounts", {
          appId: params.appId,
          redeemableLedgerEntryId: params.redeemableLedgerEntryId,
          requestedCreatorAmount: expectedCreatorAmountRounded.toFixed(4),
          committedCreatorAmount: creatorDelta.toFixed(),
          requestedPlatformRevenueDelta: platformRevenueDelta,
          committedPlatformRevenueDelta: committedPlatformDelta.toFixed(6),
        });
      }

      // Ledger rows predating the atomic projection have no version marker.
      // Treat their dedupe as already projected: replaying them cannot safely
      // distinguish a historical committed shadow write from a missing one.
      if (params.redeemableDeduplicated && ledgerMetadata.appCreatorShadowVersion !== 1) {
        return { deduplicated: true, transaction: null };
      }

      const creatorDeltaValue = creatorDelta.toFixed(6);
      const projectedPlatformDelta = committedPlatformDelta.toFixed(6);
      const movementMetadata = {
        ...params.metadata,
        redeemableLedgerEntryId: params.redeemableLedgerEntryId,
        platformRevenueDelta: projectedPlatformDelta,
        creatorShadowVersion: 1,
      };
      const [inserted] = await tx
        .insert(appEarningsTransactions)
        .values({
          app_id: params.appId,
          user_id: params.userId,
          type: params.type,
          amount: creatorDeltaValue,
          description: params.description,
          metadata: movementMetadata,
        })
        .onConflictDoNothing()
        .returning();

      if (!inserted) {
        const [existing] = await tx
          .select()
          .from(appEarningsTransactions)
          .where(
            sql`${appEarningsTransactions.metadata} ->> 'redeemableLedgerEntryId' = ${params.redeemableLedgerEntryId}`,
          )
          .limit(1);
        const existingMetadata =
          existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {};
        if (
          !existing ||
          existing.app_id !== params.appId ||
          existing.user_id !== params.userId ||
          existing.type !== params.type ||
          !new Decimal(existing.amount).equals(creatorDelta) ||
          existingMetadata.platformRevenueDelta !== projectedPlatformDelta
        ) {
          throw new CreatorMovementReplayMismatchError(params.redeemableLedgerEntryId);
        }
        return { deduplicated: true, transaction: existing };
      }

      await tx.insert(appEarnings).values({ app_id: params.appId }).onConflictDoNothing();

      const appEarningsPredicate = creatorDelta.isNegative()
        ? and(
            eq(appEarnings.app_id, params.appId),
            gte(appEarnings.total_lifetime_earnings, creatorDelta.abs().toFixed(6)),
            gte(
              params.type === "inference_markup"
                ? appEarnings.total_inference_earnings
                : appEarnings.total_purchase_earnings,
              creatorDelta.abs().toFixed(6),
            ),
            gte(appEarnings.withdrawable_balance, creatorDelta.abs().toFixed(6)),
          )
        : eq(appEarnings.app_id, params.appId);
      const typeColumn =
        params.type === "inference_markup"
          ? appEarnings.total_inference_earnings
          : appEarnings.total_purchase_earnings;
      const [updatedEarnings] = await tx
        .update(appEarnings)
        .set({
          total_lifetime_earnings: sql`${appEarnings.total_lifetime_earnings} + ${creatorDeltaValue}`,
          [typeColumn.name]: sql`${typeColumn} + ${creatorDeltaValue}`,
          withdrawable_balance: sql`${appEarnings.withdrawable_balance} + ${creatorDeltaValue}`,
          updated_at: new Date(),
        })
        .where(appEarningsPredicate)
        .returning({ id: appEarnings.id });
      if (!updatedEarnings) {
        throw new Error(
          `Insufficient app earnings balance for creator movement on ${params.appId}`,
        );
      }

      const appPredicate =
        creatorDelta.isNegative() || committedPlatformDelta.isNegative()
          ? and(
              eq(apps.id, params.appId),
              sql`${apps.total_creator_earnings} IS NOT NULL`,
              sql`${apps.total_platform_revenue} IS NOT NULL`,
              gte(apps.total_creator_earnings, creatorDelta.abs().toFixed(6)),
              gte(apps.total_platform_revenue, committedPlatformDelta.abs().toFixed(6)),
            )
          : and(
              eq(apps.id, params.appId),
              sql`${apps.total_creator_earnings} IS NOT NULL`,
              sql`${apps.total_platform_revenue} IS NOT NULL`,
            );
      const [updatedApp] = await tx
        .update(apps)
        .set({
          total_creator_earnings: sql`${apps.total_creator_earnings} + ${creatorDeltaValue}`,
          total_platform_revenue: sql`${apps.total_platform_revenue} + ${projectedPlatformDelta}`,
          updated_at: new Date(),
        })
        .where(appPredicate)
        .returning({ id: apps.id });
      if (!updatedApp) {
        throw new Error(
          `Insufficient app aggregate balance for creator movement on ${params.appId}`,
        );
      }

      return { deduplicated: false, transaction: inserted };
    };
    return transaction ? await apply(transaction) : await dbWrite.transaction(apply);
  }

  /**
   * Atomically adds inference earnings to app earnings.
   *
   * Earnings go directly to withdrawable_balance for immediate availability.
   * This provides a better developer experience for solo creators.
   */
  async addInferenceEarnings(appId: string, amount: number): Promise<AppEarnings> {
    await this.getOrCreate(appId);

    const [updated] = await dbWrite
      .update(appEarnings)
      .set({
        total_lifetime_earnings: sql`${appEarnings.total_lifetime_earnings} + ${amount}`,
        total_inference_earnings: sql`${appEarnings.total_inference_earnings} + ${amount}`,
        withdrawable_balance: sql`${appEarnings.withdrawable_balance} + ${amount}`,
        updated_at: new Date(),
      })
      .where(eq(appEarnings.app_id, appId))
      .returning();

    return updated;
  }

  /**
   * Atomically adds purchase earnings to app earnings.
   *
   * Earnings go directly to withdrawable_balance for immediate availability.
   * This provides a better developer experience for solo creators.
   */
  async addPurchaseEarnings(appId: string, amount: number): Promise<AppEarnings> {
    await this.getOrCreate(appId);

    const [updated] = await dbWrite
      .update(appEarnings)
      .set({
        total_lifetime_earnings: sql`${appEarnings.total_lifetime_earnings} + ${amount}`,
        total_purchase_earnings: sql`${appEarnings.total_purchase_earnings} + ${amount}`,
        withdrawable_balance: sql`${appEarnings.withdrawable_balance} + ${amount}`,
        updated_at: new Date(),
      })
      .where(eq(appEarnings.app_id, appId))
      .returning();

    return updated;
  }

  /**
   * Processes a withdrawal request with an atomic conditional update.
   *
   * Neon HTTP does not support Drizzle transactions. The balance mutation
   * still remains race-safe because the update predicate requires sufficient
   * withdrawable balance at write time.
   */
  async processWithdrawal(appId: string, amount: number): Promise<WithdrawalResult> {
    const earnings = await this.findByAppId(appId);
    if (!earnings) {
      return {
        success: false,
        earnings: null,
        message: "Earnings record not found",
      };
    }

    // error-policy:J1 corrupt NUMERIC must throw, not become NaN — `amount < NaN`
    // and `NaN < amount` are both false, which would fail the payout gates OPEN.
    const withdrawable = parseEarningsNumber(earnings.withdrawable_balance, "withdrawable_balance");
    const threshold = parseEarningsNumber(earnings.payout_threshold, "payout_threshold");

    if (amount < threshold) {
      return {
        success: false,
        earnings,
        message: `Amount must be at least $${threshold.toFixed(2)}`,
      };
    }

    if (withdrawable < amount) {
      return {
        success: false,
        earnings,
        message: `Insufficient withdrawable balance: $${withdrawable.toFixed(2)}`,
      };
    }

    const [updated] = await dbWrite
      .update(appEarnings)
      .set({
        withdrawable_balance: sql`${appEarnings.withdrawable_balance} - ${amount}`,
        total_withdrawn: sql`${appEarnings.total_withdrawn} + ${amount}`,
        last_withdrawal_at: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(appEarnings.app_id, appId),
          gte(appEarnings.withdrawable_balance, amount.toFixed(2)),
        ),
      )
      .returning();

    if (!updated) {
      const current = await this.findByAppId(appId);
      // error-policy:J1 the DB predicate already denied the debit; report the
      // live balance but never let a corrupt NUMERIC surface as "NaN".
      const currentWithdrawable =
        current === undefined
          ? 0
          : parseEarningsNumber(current.withdrawable_balance, "withdrawable_balance");
      return {
        success: false,
        earnings: current ?? earnings,
        message: `Insufficient withdrawable balance: $${currentWithdrawable.toFixed(2)}`,
      };
    }

    return {
      success: true,
      earnings: updated,
      message: "Withdrawal processed successfully",
    };
  }

  /**
   * Claims a withdrawal idempotency key and debits the app balance atomically.
   *
   * The unique index on (app_id, metadata->>'idempotencyKey') is acquired before
   * the debit. If validation or the conditional debit fails, the transaction is
   * rolled back so no phantom claim can be observed by a retry.
   */
  async processIdempotentWithdrawal(
    appId: string,
    amount: number,
    transactionData: NewAppEarningsTransaction,
  ): Promise<IdempotentWithdrawalResult> {
    try {
      return await dbWrite.transaction(async (tx) => {
        const earnings = await tx.query.appEarnings.findFirst({
          where: eq(appEarnings.app_id, appId),
        });
        if (!earnings) {
          throw new WithdrawalRollback({
            success: false,
            earnings: null,
            message: "Earnings record not found",
          });
        }

        // error-policy:J1 corrupt NUMERIC threshold must throw, not become NaN
        // (`amount < NaN` is false → the minimum-payout gate fails OPEN). This
        // runs before the idempotency-key insert, so a corrupt row aborts the
        // transaction with no phantom claim.
        const threshold = parseEarningsNumber(earnings.payout_threshold, "payout_threshold");
        if (amount < threshold) {
          throw new WithdrawalRollback({
            success: false,
            earnings,
            message: `Amount must be at least $${threshold.toFixed(2)}`,
          });
        }

        const [transaction] = await tx
          .insert(appEarningsTransactions)
          .values(transactionData)
          .returning();

        const [updated] = await tx
          .update(appEarnings)
          .set({
            withdrawable_balance: sql`${appEarnings.withdrawable_balance} - ${amount}`,
            total_withdrawn: sql`${appEarnings.total_withdrawn} + ${amount}`,
            last_withdrawal_at: new Date(),
            updated_at: new Date(),
          })
          .where(
            and(
              eq(appEarnings.app_id, appId),
              gte(appEarnings.withdrawable_balance, amount.toFixed(2)),
            ),
          )
          .returning();

        if (!updated) {
          const current = await tx.query.appEarnings.findFirst({
            where: eq(appEarnings.app_id, appId),
          });
          // error-policy:J1 DB predicate already denied the debit; report the
          // live balance but never surface a corrupt NUMERIC as "NaN".
          const currentWithdrawable =
            current === undefined
              ? 0
              : parseEarningsNumber(current.withdrawable_balance, "withdrawable_balance");
          throw new WithdrawalRollback({
            success: false,
            earnings: current ?? earnings,
            message: `Insufficient withdrawable balance: $${currentWithdrawable.toFixed(2)}`,
          });
        }

        return {
          success: true,
          earnings: updated,
          message: "Withdrawal processed successfully",
          transaction,
        };
      });
    } catch (error) {
      // error-policy:J1 translate the transaction rollback sentinel into the
      // repository's explicit insufficient-balance result.
      if (error instanceof WithdrawalRollback) {
        return error.result;
      }
      throw error;
    }
  }

  /**
   * Updates the payout threshold for an app.
   */
  async updatePayoutThreshold(appId: string, threshold: number): Promise<AppEarnings> {
    const [updated] = await dbWrite
      .update(appEarnings)
      .set({
        payout_threshold: String(threshold),
        updated_at: new Date(),
      })
      .where(eq(appEarnings.app_id, appId))
      .returning();

    return updated;
  }

  /**
   * Creates a new earnings transaction record.
   */
  async createTransaction(
    data: NewAppEarningsTransaction,
    transaction?: DbTransaction,
  ): Promise<AppEarningsTransaction> {
    const [created] = await (transaction ?? dbWrite)
      .insert(appEarningsTransactions)
      .values(data)
      .returning();
    return created;
  }
}

/**
 * Singleton instance of AppEarningsRepository.
 */
export const appEarningsRepository = new AppEarningsRepository();
