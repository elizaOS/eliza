/**
 * Virtual Wallet Service
 *
 * @description Manages user's virtual USD balance for trading. Provides
 * methods for checking balances, debiting/crediting funds, and tracking
 * transaction history. All users start with $1,000 virtual balance.
 *
 * Features:
 * - Starting balance: $1,000
 * - Tracks all transactions
 * - Validates sufficient funds
 * - Calculates PnL
 */

import {
  balanceTransactions,
  type DrizzleClient,
  db,
  desc,
  eq,
  type Transaction,
  users,
  withTransaction,
} from '@feed/db';
import { generateSnowflakeId, InsufficientFundsError } from '@feed/shared';
import { EarnedPointsService } from './earned-points-service';

/**
 * User balance information
 *
 * @description Contains current balance and lifetime statistics.
 */
export interface BalanceInfo {
  balance: number;
  totalDeposited: number;
  totalWithdrawn: number;
  lifetimePnL: number;
}

/**
 * Transaction history item
 *
 * @description Represents a single balance transaction with before/after
 * balances and metadata.
 */
export interface TransactionHistoryItem {
  id: string;
  type: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  description: string | null;
  relatedId: string | null;
  createdAt: Date;
}

/**
 * Cache invalidation callback type
 *
 * @description Optional callback to invalidate user cache after balance changes.
 * This allows the web app to inject its caching strategy.
 */
export type CacheInvalidationCallback = (userId: string) => Promise<void>;

/**
 * Wallet Service Class
 *
 * @description Static service class for managing user virtual balances.
 * Provides methods for checking balances, debiting/crediting funds, and
 * retrieving transaction history.
 */
export class WalletService {
  /**
   * Starting balance for new users ($1,000 USD)
   *
   * @private
   */
  private static readonly STARTING_BALANCE = 1000; // $1,000 USD

  /**
   * Optional cache invalidation callback
   */
  private static cacheInvalidationCallback: CacheInvalidationCallback | null =
    null;

  /**
   * Set the cache invalidation callback
   *
   * @description Allows the web app to inject its caching strategy.
   *
   * @param {CacheInvalidationCallback} callback - Cache invalidation function
   */
  static setCacheInvalidationCallback(
    callback: CacheInvalidationCallback
  ): void {
    WalletService.cacheInvalidationCallback = callback;
  }

  /**
   * Invalidate user cache if callback is set
   */
  private static async invalidateCache(userId: string): Promise<void> {
    if (WalletService.cacheInvalidationCallback) {
      await WalletService.cacheInvalidationCallback(userId);
    }
  }

  /**
   * Apply balance change atomically
   *
   * @description Internal method to apply a balance change and create a
   * transaction record. Used by debit and credit methods.
   *
   * @param {Transaction} tx - Drizzle transaction client
   * @param {string} userId - User ID
   * @param {number} delta - Amount to change (positive for credit, negative for debit)
   * @param {string} type - Transaction type identifier
   * @param {string} description - Transaction description
   * @param {string} [relatedId] - Optional related entity ID
   * @returns {Promise<void>}
   * @private
   */
  private static async applyBalanceChange(
    tx: Transaction | DrizzleClient,
    userId: string,
    delta: number,
    type: string,
    description: string,
    relatedId?: string
  ): Promise<void> {
    const result = await tx
      .select({
        virtualBalance: users.virtualBalance,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const [user] = result;
    if (!user) {
      // Fail-fast: NPCs should have User records after bootstrap (ensureNpcUsers).
      // A missing user here indicates a bug in bootstrap or an invalid userId.
      throw new Error(
        `User not found for wallet operation: ${userId}. NPCs should have User records after bootstrap.`
      );
    }

    const currentBalance = Number(user.virtualBalance ?? 0);
    const newBalance = currentBalance + delta;

    // Reject non-finite values to prevent balance corruption
    if (
      !Number.isFinite(delta) ||
      !Number.isFinite(currentBalance) ||
      !Number.isFinite(newBalance)
    ) {
      throw new Error(
        `Invalid wallet mutation for ${userId}: delta=${delta}, balance=${currentBalance}, result=${newBalance}`
      );
    }

    // Prevent negative balance on debits
    if (delta < 0 && newBalance < 0) {
      throw new InsufficientFundsError(Math.abs(delta), currentBalance, 'USD');
    }

    await tx
      .update(users)
      .set({ virtualBalance: String(newBalance) })
      .where(eq(users.id, userId));

    await tx.insert(balanceTransactions).values({
      id: await generateSnowflakeId(),
      userId,
      type,
      amount: String(delta),
      balanceBefore: String(currentBalance),
      balanceAfter: String(newBalance),
      relatedId: relatedId ?? null,
      description,
    });
  }

  /**
   * Get user's current balance
   *
   * @description Retrieves user's current balance and lifetime statistics.
   *
   * @param {string} userId - User ID
   * @returns {Promise<BalanceInfo>} Balance information
   * @throws {Error} If user not found
   *
   * @example
   * ```typescript
   * const balance = await WalletService.getBalance(userId);
   * console.log(`Balance: $${balance.balance}`);
   * ```
   */
  static async getBalance(userId: string): Promise<BalanceInfo> {
    const result = await db
      .select({
        virtualBalance: users.virtualBalance,
        totalDeposited: users.totalDeposited,
        totalWithdrawn: users.totalWithdrawn,
        lifetimePnL: users.lifetimePnL,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const [user] = result;
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    return {
      balance: Number(user.virtualBalance ?? 0),
      totalDeposited: Number(user.totalDeposited ?? 0),
      totalWithdrawn: Number(user.totalWithdrawn ?? 0),
      lifetimePnL: Number(user.lifetimePnL ?? 0),
    };
  }

  /**
   * Check if user has sufficient balance
   *
   * @description Checks if user has enough balance for a transaction.
   *
   * @param {string} userId - User ID
   * @param {number} requiredAmount - Required amount
   * @returns {Promise<boolean>} True if user has sufficient balance
   *
   * @example
   * ```typescript
   * if (await WalletService.hasSufficientBalance(userId, 100)) {
   *   // Proceed with transaction
   * }
   * ```
   */
  static async hasSufficientBalance(
    userId: string,
    requiredAmount: number
  ): Promise<boolean> {
    const result = await db
      .select({
        virtualBalance: users.virtualBalance,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const [user] = result;
    if (!user) {
      return false;
    }

    return Number(user.virtualBalance ?? 0) >= requiredAmount;
  }

  /**
   * Debit from user's balance (opening position, buying shares)
   *
   * @description Debits an amount from user's balance. Used when opening
   * positions or buying shares. Creates a transaction record.
   *
   * @param {string} userId - User ID
   * @param {number} amount - Amount to debit
   * @param {string} type - Transaction type identifier
   * @param {string} description - Transaction description
   * @param {string} [relatedId] - Optional related entity ID
   * @param {Transaction} [tx] - Optional transaction client for atomic operations
   * @returns {Promise<void>}
   * @throws {Error} If user not found or insufficient balance
   *
   * @example
   * ```typescript
   * await WalletService.debit(userId, 100, 'pred_buy', 'Buying shares', tradeId);
   * ```
   */
  static async debit(
    userId: string,
    amount: number,
    type: string,
    description: string,
    relatedId?: string,
    tx?: Transaction | DrizzleClient
  ): Promise<void> {
    const delta = -amount;

    if (tx) {
      await WalletService.applyBalanceChange(
        tx,
        userId,
        delta,
        type,
        description,
        relatedId
      );
    } else {
      await withTransaction(async (transaction) => {
        await WalletService.applyBalanceChange(
          transaction,
          userId,
          delta,
          type,
          description,
          relatedId
        );
      });
    }

    await WalletService.invalidateCache(userId);
  }

  /**
   * Credit to user's balance (closing position with profit, payouts)
   */
  static async credit(
    userId: string,
    amount: number,
    type: string,
    description: string,
    relatedId?: string,
    tx?: Transaction | DrizzleClient
  ): Promise<void> {
    if (tx) {
      await WalletService.applyBalanceChange(
        tx,
        userId,
        amount,
        type,
        description,
        relatedId
      );
    } else {
      await withTransaction(async (transaction) => {
        await WalletService.applyBalanceChange(
          transaction,
          userId,
          amount,
          type,
          description,
          relatedId
        );
      });
    }

    await WalletService.invalidateCache(userId);
  }

  /**
   * Record PnL (update lifetime PnL and earned points)
   *
   * Uses a transaction to atomically update both lifetimePnL and earnedPoints
   * to prevent race conditions that could cause sync issues.
   */
  static async recordPnL(
    userId: string,
    pnl: number,
    tradeType: string,
    relatedId?: string
  ): Promise<{
    previousLifetimePnL: number;
    newLifetimePnL: number;
    earnedPointsDelta: number;
  }> {
    return await withTransaction(async (tx) => {
      const result = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      const [user] = result;
      if (!user) {
        // Fail-fast: NPCs should have User records after bootstrap (ensureNpcUsers).
        // A missing user here indicates a bug in bootstrap or an invalid userId.
        throw new Error(
          `User not found for PnL recording: ${userId}. NPCs should have User records after bootstrap.`
        );
      }

      // Reject non-finite PnL to prevent lifetime stats corruption
      if (!Number.isFinite(pnl)) {
        throw new Error(
          `Invalid PnL for ${userId}: pnl=${pnl}, tradeType=${tradeType}`
        );
      }

      const previousLifetimePnL = Number(user.lifetimePnL);
      const newLifetimePnL = previousLifetimePnL + pnl;

      if (!Number.isFinite(newLifetimePnL)) {
        throw new Error(
          `Invalid lifetimePnL for ${userId}: prev=${previousLifetimePnL}, delta=${pnl}`
        );
      }

      // Update lifetimePnL first within the transaction
      await tx
        .update(users)
        .set({ lifetimePnL: String(newLifetimePnL) })
        .where(eq(users.id, userId));

      // Now award earned points within the same transaction
      // This ensures atomicity and prevents race conditions
      const earnedPointsDelta =
        await EarnedPointsService.awardEarnedPointsForPnL(
          userId,
          newLifetimePnL,
          tradeType,
          relatedId,
          tx
        );

      return {
        previousLifetimePnL,
        newLifetimePnL,
        earnedPointsDelta,
      };
    });
  }

  /**
   * Get transaction history
   */
  static async getTransactionHistory(
    userId: string,
    limit = 50
  ): Promise<TransactionHistoryItem[]> {
    const transactions = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId))
      .orderBy(desc(balanceTransactions.createdAt))
      .limit(limit);

    return transactions.map((tx) => ({
      id: tx.id,
      type: tx.type,
      amount: Number(tx.amount),
      balanceBefore: Number(tx.balanceBefore),
      balanceAfter: Number(tx.balanceAfter),
      description: tx.description,
      relatedId: tx.relatedId,
      createdAt: tx.createdAt,
    }));
  }

  /**
   * Initialize user balance (for new users)
   */
  static async initializeBalance(userId: string): Promise<void> {
    const result = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const [user] = result;
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    if (Number(user.virtualBalance ?? 0) === 0) {
      await withTransaction(async (tx) => {
        await tx
          .update(users)
          .set({
            virtualBalance: String(WalletService.STARTING_BALANCE),
            totalDeposited: String(WalletService.STARTING_BALANCE),
          })
          .where(eq(users.id, userId));

        await tx.insert(balanceTransactions).values({
          id: await generateSnowflakeId(),
          userId,
          type: 'deposit',
          amount: String(WalletService.STARTING_BALANCE),
          balanceBefore: '0',
          balanceAfter: String(WalletService.STARTING_BALANCE),
          description: 'Initial deposit - Welcome to Feed!',
        });
      });
    }
  }
}
