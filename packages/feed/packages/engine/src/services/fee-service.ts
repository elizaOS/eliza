/**
 * Fee Service
 *
 * @description Manages trading fees and referral fee distribution. Calculates
 * fees for trades, processes fee payments, and distributes referral earnings.
 * Handles both platform fees and referrer share distribution.
 */

import {
  and,
  balanceTransactions,
  count,
  Decimal,
  type DrizzleClient,
  db,
  desc,
  eq,
  gte,
  lte,
  sql,
  sum,
  type Transaction,
  tradingFees,
  users,
  withTransaction,
} from '@feed/db';
import { generateSnowflakeId, logger } from '@feed/shared';
import type { SQL } from 'drizzle-orm';
import { FEE_CONFIG, type FeeType } from '../config/fees';
import { FeeRedistributionService } from './fee-redistribution-service';

/**
 * Transaction context type - either an existing transaction or the db client
 * Used to avoid nested transactions which can cause deadlocks
 */
export type TransactionContext = Transaction | DrizzleClient;

/**
 * Execute a function within a transaction context
 * If an existing transaction is provided, uses it directly; otherwise creates a new one
 * This prevents nested transaction deadlocks
 */
async function runInTransaction<T>(
  existingTx: TransactionContext | undefined,
  fn: (tx: TransactionContext) => Promise<T>
): Promise<T> {
  return existingTx ? fn(existingTx) : withTransaction(fn);
}

/**
 * Fee calculation result
 *
 * @description Contains calculated fee amounts and distribution breakdown.
 */
export interface FeeCalculation {
  feeAmount: number;
  netAmount: number; // Amount after fee deduction
  platformShare: number;
  referrerShare: number;
}

/**
 * Fee distribution result
 *
 * @description Result of processing a trading fee, including amounts charged
 * and distributed to platform and referrer.
 */
export interface FeeDistributionResult {
  feeCharged: number;
  referrerPaid: number;
  platformReceived: number;
  referrerId: string | null;
}

/**
 * Referral earnings information
 *
 * @description Comprehensive referral earnings data including totals, top
 * referrals, and recent fee history.
 */
export interface ReferralEarnings {
  totalEarned: number;
  totalReferrals: number;
  topReferrals: Array<{
    userId: string;
    username: string;
    displayName: string;
    profileImageUrl: string | null;
    totalFees: number;
    tradeCount: number;
  }>;
  recentFees: Array<{
    id: string;
    tradeType: string;
    feeAmount: number;
    traderId: string;
    traderUsername: string | null;
    createdAt: Date;
  }>;
}

/**
 * Fee Service Class
 *
 * @description Static service class for managing trading fees and referral
 * distributions. Provides methods for calculating fees, processing payments,
 * and retrieving referral earnings.
 */
export class FeeService {
  /**
   * Calculate fee for a trade amount
   *
   * @description Calculates trading fee based on configured fee rate (0.1%).
   * Returns fee amount, net amount after fee, and distribution breakdown.
   *
   * @param {number} tradeAmount - Trade amount to calculate fee for
   * @returns {FeeCalculation} Fee calculation with amounts and distribution
   *
   * @example
   * ```typescript
   * const calc = FeeService.calculateFee(1000);
   * // Returns: { feeAmount: 1, netAmount: 999, platformShare: 0.5, referrerShare: 0.5 }
   * ```
   */
  static calculateFee(tradeAmount: number): FeeCalculation {
    const feeAmount = tradeAmount * FEE_CONFIG.TRADING_FEE_RATE;
    const netAmount = tradeAmount - feeAmount;
    const platformShare = feeAmount * FEE_CONFIG.PLATFORM_SHARE;
    const referrerShare = feeAmount * FEE_CONFIG.REFERRER_SHARE;

    return {
      feeAmount: Number(feeAmount.toFixed(2)),
      netAmount: Number(netAmount.toFixed(2)),
      platformShare: Number(platformShare.toFixed(2)),
      referrerShare: Number(referrerShare.toFixed(2)),
    };
  }

  /**
   * Calculate fee on proceeds (for selling)
   *
   * @description Calculates fee on sale proceeds. Alias for calculateFee
   * for semantic clarity when processing sell transactions.
   *
   * @param {number} proceeds - Sale proceeds amount
   * @returns {FeeCalculation} Fee calculation with amounts and distribution
   */
  static calculateFeeOnProceeds(proceeds: number): FeeCalculation {
    return FeeService.calculateFee(proceeds);
  }

  /**
   * Process trading fee - charge user and distribute to platform/referrer
   *
   * @description Processes a trading fee by charging the user, creating a fee
   * record, and distributing referral fees if applicable. Skips fees below
   * minimum threshold. Executes atomically in a transaction.
   *
   * @param {string} userId - User ID who made the trade
   * @param {FeeType} tradeType - Type of trade (pred_buy, pred_sell, etc.)
   * @param {number} tradeAmount - Trade amount
   * @param {string} [tradeId] - Optional trade ID for reference
   * @param {string} [marketId] - Optional market ID for reference
   * @param {TransactionContext} [existingTx] - Optional existing transaction/client to reuse (avoids nested transactions)
   * @returns {Promise<FeeDistributionResult>} Fee distribution result
   *
   * @example
   * ```typescript
   * const result = await FeeService.processTradingFee(
   *   userId,
   *   'pred_buy',
   *   1000,
   *   tradeId,
   *   marketId
   * );
   * ```
   */
  static async processTradingFee(
    userId: string,
    tradeType: FeeType,
    tradeAmount: number,
    tradeId?: string,
    marketId?: string,
    existingTx?: TransactionContext
  ): Promise<FeeDistributionResult> {
    const feeCalc = FeeService.calculateFee(tradeAmount);

    // Skip if fee is below minimum
    if (feeCalc.feeAmount < FEE_CONFIG.MIN_FEE_AMOUNT) {
      logger.debug(
        `Fee ${feeCalc.feeAmount} below minimum, skipping`,
        {
          userId,
          tradeType,
          tradeAmount,
        },
        'FeeService'
      );

      return {
        feeCharged: 0,
        referrerPaid: 0,
        platformReceived: 0,
        referrerId: null,
      };
    }

    // Get user's referrer (use existing tx if provided to avoid deadlock)
    const referrerId = existingTx
      ? await FeeService.getUserReferrerInTx(userId, existingTx)
      : await FeeService.getUserReferrer(userId);

    // Core fee processing logic
    const processFee = async (tx: TransactionContext) => {
      // Create trading fee record
      await tx.insert(tradingFees).values({
        id: await generateSnowflakeId(),
        userId,
        tradeType,
        tradeId: tradeId || null,
        marketId: marketId || null,
        feeAmount: new Decimal(feeCalc.feeAmount).toString(),
        platformFee: new Decimal(feeCalc.platformShare).toString(),
        referrerFee: new Decimal(feeCalc.referrerShare).toString(),
        referrerId: referrerId || null,
      });

      // Get current totalFeesPaid
      const [currentUser] = await tx
        .select({ totalFeesPaid: users.totalFeesPaid })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      const currentTotalFees = currentUser
        ? Number(currentUser.totalFeesPaid)
        : 0;

      // Update trader's total fees paid
      await tx
        .update(users)
        .set({
          totalFeesPaid: new Decimal(
            currentTotalFees + feeCalc.feeAmount
          ).toString(),
        })
        .where(eq(users.id, userId));

      // Distribute referral fee if referrer exists
      if (referrerId) {
        await FeeService.distributeReferralFeeInTx(
          referrerId,
          feeCalc.referrerShare,
          userId,
          tx
        );
      }

      return {
        feeCharged: feeCalc.feeAmount,
        referrerPaid: referrerId ? feeCalc.referrerShare : 0,
        platformReceived: referrerId
          ? feeCalc.platformShare
          : feeCalc.feeAmount,
        referrerId,
      };
    };

    // Use existing transaction if provided, otherwise create a new one
    const result = await runInTransaction(existingTx, processFee);

    // Divert portion of platform fees to stability fund for NPC liquidity
    // This happens outside the transaction to avoid blocking on fund updates
    const stabilityFundDiversion =
      FeeRedistributionService.calculateDiversionAmount(
        result.platformReceived
      );
    if (stabilityFundDiversion > 0) {
      // Fire and forget - don't block fee processing on fund updates
      FeeRedistributionService.addToFund(stabilityFundDiversion).catch(
        (err) => {
          logger.warn(
            'Failed to add to stability fund',
            { error: err instanceof Error ? err.message : String(err) },
            'FeeService'
          );
        }
      );
    }

    logger.info(
      'Trading fee processed',
      {
        userId,
        tradeType,
        feeCharged: result.feeCharged,
        referrerPaid: result.referrerPaid,
        referrerId: result.referrerId,
        stabilityFundDiversion,
      },
      'FeeService'
    );

    return result;
  }

  /**
   * Get user's referrer
   */
  static async getUserReferrer(userId: string): Promise<string | null> {
    const [user] = await db
      .select({ referredBy: users.referredBy })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return user?.referredBy || null;
  }

  /**
   * Get user's referrer within an existing transaction
   */
  private static async getUserReferrerInTx(
    userId: string,
    tx: TransactionContext
  ): Promise<string | null> {
    const [user] = await tx
      .select({ referredBy: users.referredBy })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return user?.referredBy || null;
  }

  /**
   * Distribute referral fee to referrer (within transaction)
   */
  private static async distributeReferralFeeInTx(
    referrerId: string,
    feeAmount: number,
    traderId: string,
    tx: TransactionContext
  ): Promise<void> {
    // Credit referrer's virtual balance
    const [referrer] = await tx
      .select({
        virtualBalance: users.virtualBalance,
        totalFeesEarned: users.totalFeesEarned,
      })
      .from(users)
      .where(eq(users.id, referrerId))
      .limit(1);

    if (!referrer) {
      logger.warn(
        `Referrer not found: ${referrerId}`,
        { referrerId, traderId },
        'FeeService'
      );
      return;
    }

    const currentBalance = Number(referrer.virtualBalance ?? 0);
    const newBalance = currentBalance + feeAmount;
    const feeStr = new Decimal(feeAmount).toString();

    // Atomic increment to prevent lost-update race under concurrent
    // referral fee distributions within overlapping transactions.
    await tx
      .update(users)
      .set({
        virtualBalance: sql`CAST(COALESCE(CAST(${users.virtualBalance} AS DECIMAL), 0) + ${feeAmount} AS TEXT)`,
        totalFeesEarned: sql`CAST(COALESCE(CAST(${users.totalFeesEarned} AS DECIMAL), 0) + ${feeAmount} AS TEXT)`,
      })
      .where(eq(users.id, referrerId));

    // Create balance transaction
    await tx.insert(balanceTransactions).values({
      id: await generateSnowflakeId(),
      userId: referrerId,
      type: FEE_CONFIG.TRANSACTION_TYPES.REFERRAL_FEE_EARNED,
      amount: feeStr,
      balanceBefore: new Decimal(currentBalance).toString(),
      balanceAfter: new Decimal(newBalance).toString(),
      relatedId: traderId,
      description: 'Referral fee earned from trading activity',
    });

    logger.info(
      'Referral fee distributed',
      {
        referrerId,
        traderId,
        feeAmount,
      },
      'FeeService'
    );
  }

  /**
   * Get referral fee earnings for a user
   */
  static async getReferralEarnings(
    userId: string,
    options?: {
      startDate?: Date;
      endDate?: Date;
      limit?: number;
    }
  ): Promise<ReferralEarnings> {
    const { startDate, endDate, limit = 10 } = options || {};

    // Build where conditions
    const conditions = [eq(tradingFees.referrerId, userId)];
    if (startDate) {
      conditions.push(gte(tradingFees.createdAt, startDate));
    }
    if (endDate) {
      conditions.push(lte(tradingFees.createdAt, endDate));
    }
    const whereClause = and(...conditions);

    // Get total earnings
    const [totalResult] = await db
      .select({
        totalReferrerFee: sum(tradingFees.referrerFee),
        count: count(),
      })
      .from(tradingFees)
      .where(whereClause);

    const totalEarned = Number(totalResult?.totalReferrerFee || 0);

    // Get unique traders (referrals)
    const uniqueTraders = await db
      .selectDistinct({ userId: tradingFees.userId })
      .from(tradingFees)
      .where(whereClause);

    // Get top referrals by fees generated
    const topReferralsData = await db
      .select({
        userId: tradingFees.userId,
        totalReferrerFee: sum(tradingFees.referrerFee),
        tradeCount: count(),
      })
      .from(tradingFees)
      .where(whereClause)
      .groupBy(tradingFees.userId)
      .orderBy(desc(sum(tradingFees.referrerFee)))
      .limit(limit);

    // Enrich with user data
    const topReferrals = await Promise.all(
      topReferralsData.map(async (item) => {
        const [user] = await db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            profileImageUrl: users.profileImageUrl,
          })
          .from(users)
          .where(eq(users.id, item.userId))
          .limit(1);

        return {
          userId: item.userId,
          username: user?.username || 'Unknown',
          displayName: user?.displayName || 'Unknown User',
          profileImageUrl: user?.profileImageUrl || null,
          totalFees: Number(item.totalReferrerFee || 0),
          tradeCount: item.tradeCount,
        };
      })
    );

    // Get recent fees
    const recentFees = await db
      .select({
        id: tradingFees.id,
        tradeType: tradingFees.tradeType,
        referrerFee: tradingFees.referrerFee,
        userId: tradingFees.userId,
        createdAt: tradingFees.createdAt,
      })
      .from(tradingFees)
      .where(whereClause)
      .orderBy(desc(tradingFees.createdAt))
      .limit(limit);

    // Get trader usernames for recent fees
    const recentFeesWithUsers = await Promise.all(
      recentFees.map(async (fee) => {
        const [trader] = await db
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, fee.userId))
          .limit(1);

        return {
          id: fee.id,
          tradeType: fee.tradeType,
          feeAmount: Number(fee.referrerFee),
          traderId: fee.userId,
          traderUsername: trader?.username || null,
          createdAt: fee.createdAt,
        };
      })
    );

    return {
      totalEarned,
      totalReferrals: uniqueTraders.length,
      topReferrals,
      recentFees: recentFeesWithUsers,
    };
  }

  /**
   * Get fee statistics for the platform
   */
  static async getPlatformFeeStats(
    startDate?: Date,
    endDate?: Date
  ): Promise<{
    totalFeesCollected: number;
    totalReferrerFees: number;
    totalPlatformFees: number;
    totalTrades: number;
  }> {
    const conditions: SQL<unknown>[] = [];
    if (startDate) {
      conditions.push(gte(tradingFees.createdAt, startDate));
    }
    if (endDate) {
      conditions.push(lte(tradingFees.createdAt, endDate));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [result] = await db
      .select({
        totalFeeAmount: sum(tradingFees.feeAmount),
        totalPlatformFee: sum(tradingFees.platformFee),
        totalReferrerFee: sum(tradingFees.referrerFee),
        count: count(),
      })
      .from(tradingFees)
      .where(whereClause);

    return {
      totalFeesCollected: Number(result?.totalFeeAmount || 0),
      totalReferrerFees: Number(result?.totalReferrerFee || 0),
      totalPlatformFees: Number(result?.totalPlatformFee || 0),
      totalTrades: result?.count || 0,
    };
  }
}
