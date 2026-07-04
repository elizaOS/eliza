// Persists app earnings records for cloud services through the shared DB boundary.
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type AppEarnings,
  type AppEarningsTransaction,
  appEarnings,
  appEarningsTransactions,
  type NewAppEarnings,
  type NewAppEarningsTransaction,
} from "../schemas/app-earnings";

export type { AppEarnings, AppEarningsTransaction, NewAppEarnings, NewAppEarningsTransaction };

type WithdrawalResult = {
  success: boolean;
  earnings: AppEarnings | null;
  message: string;
};

type IdempotentWithdrawalResult = WithdrawalResult & {
  transaction?: AppEarningsTransaction;
};

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
  ): Promise<AppEarningsTransaction | undefined> {
    const result = await dbRead
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

    const withdrawable = Number(earnings.withdrawable_balance);
    const threshold = Number(earnings.payout_threshold);

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
      const currentWithdrawable = Number(current?.withdrawable_balance ?? 0);
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

        const threshold = Number(earnings.payout_threshold);
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
          const currentWithdrawable = Number(current?.withdrawable_balance ?? 0);
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
  async createTransaction(data: NewAppEarningsTransaction): Promise<AppEarningsTransaction> {
    const [transaction] = await dbWrite.insert(appEarningsTransactions).values(data).returning();
    return transaction;
  }
}

/**
 * Singleton instance of AppEarningsRepository.
 */
export const appEarningsRepository = new AppEarningsRepository();
