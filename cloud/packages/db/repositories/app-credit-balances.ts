import { and, desc, eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type AppCreditBalance,
  appCreditBalances,
  type NewAppCreditBalance,
} from "../schemas/app-credit-balances";

export type { AppCreditBalance, NewAppCreditBalance };

/**
 * Repository for app credit balance database operations.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class AppCreditBalancesRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds an app credit balance by ID.
   */
  async findById(id: string): Promise<AppCreditBalance | undefined> {
    return await dbRead.query.appCreditBalances.findFirst({
      where: eq(appCreditBalances.id, id),
    });
  }

  /**
   * Finds an app credit balance by app ID and user ID.
   */
  async findByAppAndUser(appId: string, userId: string): Promise<AppCreditBalance | undefined> {
    return await dbRead.query.appCreditBalances.findFirst({
      where: and(eq(appCreditBalances.app_id, appId), eq(appCreditBalances.user_id, userId)),
    });
  }

  /**
   * Lists all credit balances for an app, ordered by balance amount.
   */
  async listByApp(appId: string): Promise<AppCreditBalance[]> {
    return await dbRead.query.appCreditBalances.findMany({
      where: eq(appCreditBalances.app_id, appId),
      orderBy: [desc(appCreditBalances.credit_balance)],
    });
  }

  /**
   * Lists all credit balances for a user across all apps.
   */
  async listByUser(userId: string): Promise<AppCreditBalance[]> {
    return await dbRead.query.appCreditBalances.findMany({
      where: eq(appCreditBalances.user_id, userId),
      orderBy: [desc(appCreditBalances.updated_at)],
    });
  }

  /**
   * Gets current credit balance for an app user.
   *
   * Returns 0 if balance record doesn't exist.
   */
  async getBalance(appId: string, userId: string): Promise<number> {
    const balance = await this.findByAppAndUser(appId, userId);
    return balance ? Number(balance.credit_balance) : 0;
  }

  /**
   * Gets aggregated balance statistics for an app across all users.
   */
  async getTotalAppBalance(appId: string): Promise<{
    totalBalance: number;
    totalPurchased: number;
    totalSpent: number;
    userCount: number;
  }> {
    const result = await dbRead
      .select({
        totalBalance: sql<string>`COALESCE(SUM(${appCreditBalances.credit_balance}), 0)`,
        totalPurchased: sql<string>`COALESCE(SUM(${appCreditBalances.total_purchased}), 0)`,
        totalSpent: sql<string>`COALESCE(SUM(${appCreditBalances.total_spent}), 0)`,
        userCount: sql<number>`COUNT(*)`,
      })
      .from(appCreditBalances)
      .where(eq(appCreditBalances.app_id, appId));

    return {
      totalBalance: Number(result[0]?.totalBalance || 0),
      totalPurchased: Number(result[0]?.totalPurchased || 0),
      totalSpent: Number(result[0]?.totalSpent || 0),
      userCount: Number(result[0]?.userCount || 0),
    };
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new app credit balance record.
   */
  async create(data: NewAppCreditBalance): Promise<AppCreditBalance> {
    const [balance] = await dbWrite.insert(appCreditBalances).values(data).returning();
    return balance;
  }

  /**
   * Gets existing balance or creates a new one if it doesn't exist.
   */
  async getOrCreate(
    appId: string,
    userId: string,
    organizationId: string,
  ): Promise<AppCreditBalance> {
    const [created] = await dbWrite
      .insert(appCreditBalances)
      .values({
        app_id: appId,
        user_id: userId,
        organization_id: organizationId,
      })
      .onConflictDoNothing({
        target: [appCreditBalances.app_id, appCreditBalances.user_id],
      })
      .returning();

    if (created) {
      return created;
    }

    const existing = await dbWrite.query.appCreditBalances.findFirst({
      where: and(eq(appCreditBalances.app_id, appId), eq(appCreditBalances.user_id, userId)),
    });

    if (!existing) {
      throw new Error(
        `App credit balance not found after conflict for app ${appId}, user ${userId}`,
      );
    }

    return existing;
  }

  /**
   * Atomically adds credits to an app user's balance in a transaction.
   *
   * Creates balance record if it doesn't exist.
   */
  async addCredits(
    appId: string,
    userId: string,
    organizationId: string,
    amount: number,
  ): Promise<{
    balance: AppCreditBalance;
    newBalance: number;
  }> {
    return await dbWrite.transaction(async (tx) => {
      const balance = await tx.query.appCreditBalances.findFirst({
        where: and(eq(appCreditBalances.app_id, appId), eq(appCreditBalances.user_id, userId)),
      });

      if (!balance) {
        const [newBalance] = await tx
          .insert(appCreditBalances)
          .values({
            app_id: appId,
            user_id: userId,
            organization_id: organizationId,
            credit_balance: String(amount),
            total_purchased: String(amount),
          })
          .returning();

        return {
          balance: newBalance,
          newBalance: amount,
        };
      }

      const [updated] = await tx
        .update(appCreditBalances)
        .set({
          credit_balance: sql`${appCreditBalances.credit_balance} + ${amount}`,
          total_purchased: sql`${appCreditBalances.total_purchased} + ${amount}`,
          updated_at: new Date(),
        })
        .where(and(eq(appCreditBalances.app_id, appId), eq(appCreditBalances.user_id, userId)))
        .returning();

      return {
        balance: updated,
        newBalance: Number(updated.credit_balance),
      };
    });
  }

  /**
   * Atomically deducts credits from an app user's balance in a transaction.
   *
   * Uses row-level locking (FOR UPDATE) to prevent race conditions.
   * Returns success false if balance doesn't exist or is insufficient.
   */
  async deductCredits(
    appId: string,
    userId: string,
    amount: number,
  ): Promise<{
    success: boolean;
    balance: AppCreditBalance | null;
    newBalance: number;
  }> {
    return await dbWrite.transaction(async (tx) => {
      const [balance] = await tx
        .select()
        .from(appCreditBalances)
        .where(and(eq(appCreditBalances.app_id, appId), eq(appCreditBalances.user_id, userId)))
        .for("update");

      if (!balance) {
        return {
          success: false,
          balance: null,
          newBalance: 0,
        };
      }

      const currentBalance = Number(balance.credit_balance);

      if (currentBalance < amount) {
        return {
          success: false,
          balance,
          newBalance: currentBalance,
        };
      }

      const newBalance = currentBalance - amount;
      const [updated] = await tx
        .update(appCreditBalances)
        .set({
          credit_balance: String(newBalance),
          total_spent: sql`${appCreditBalances.total_spent} + ${amount}`,
          updated_at: new Date(),
        })
        .where(and(eq(appCreditBalances.app_id, appId), eq(appCreditBalances.user_id, userId)))
        .returning();

      return {
        success: true,
        balance: updated,
        newBalance,
      };
    });
  }
}

/**
 * Singleton instance of AppCreditBalancesRepository.
 */
export const appCreditBalancesRepository = new AppCreditBalancesRepository();
