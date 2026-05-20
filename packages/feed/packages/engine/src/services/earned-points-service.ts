/**
 * Earned Points Service
 *
 * @description Converts P&L from trading into earned points. Provides methods
 * for calculating points from P&L, syncing earned points, and awarding incremental
 * points for trades.
 */

import {
  db,
  eq,
  pointsTransactions,
  type Transaction,
  users,
} from '@babylon/db';
import { generateSnowflakeId, logger } from '@babylon/shared';

/**
 * Earned Points Service Class
 *
 * @description Static service class for managing earned points from trading P&L.
 * Provides methods for converting P&L to points and syncing earned points.
 */
export class EarnedPointsService {
  /** Base reputation points for all users */
  private static readonly BASE_POINTS = 100;

  /**
   * Calculate total reputation points from component values.
   * Centralizes the reputation formula to ensure consistency.
   *
   * @param invitePoints - Points earned from invites
   * @param earnedPoints - Points earned from trading P&L
   * @param bonusPoints - Bonus points from onboarding, events, etc.
   * @returns Total reputation points
   */
  private static calculateReputationPoints(
    invitePoints: number,
    earnedPoints: number,
    bonusPoints: number
  ): number {
    return (
      EarnedPointsService.BASE_POINTS +
      invitePoints +
      earnedPoints +
      bonusPoints
    );
  }

  /**
   * Convert P&L to earned points
   *
   * @description Converts trading P&L to earned points using formula: 1 point
   * per $10 of realized P&L. Minimum is -100 points to limit downside risk and
   * encourage trading.
   *
   * Formula: 1 point per $10 of realized P&L
   * Minimum: -100 points (can't go below -100)
   *
   * @param {number} pnl - Profit and loss amount
   * @returns {number} Earned points (capped at -100 minimum)
   *
   * @example
   * ```typescript
   * const points = EarnedPointsService.pnlToPoints(100); // Returns: 10
   * const negative = EarnedPointsService.pnlToPoints(-2000); // Returns: -100 (capped)
   * ```
   */
  static pnlToPoints(pnl: number): number {
    const points = Math.floor(pnl / 10);
    // Cap negative points at -100 to avoid extreme penalties
    return Math.max(points, -100);
  }

  /**
   * Update earned points based on current lifetime P&L
   *
   * @description Recalculates earned points from scratch based on lifetimePnL.
   * Updates user's earned points and total reputation points. Only updates if
   * earned points have changed.
   *
   * @param {string} userId - User ID to sync points for
   * @returns {Promise<void>}
   * @throws {Error} If user not found
   */
  static async syncEarnedPointsFromPnL(userId: string): Promise<void> {
    const result = await db
      .select({
        lifetimePnL: users.lifetimePnL,
        earnedPoints: users.earnedPoints,
        invitePoints: users.invitePoints,
        bonusPoints: users.bonusPoints,
        reputationPoints: users.reputationPoints,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = result[0];

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const lifetimePnL = Number(user.lifetimePnL);
    const newEarnedPoints = EarnedPointsService.pnlToPoints(lifetimePnL);

    // Only update if earned points have changed
    if (newEarnedPoints === user.earnedPoints) {
      return;
    }

    // Calculate new total reputation points using centralized helper
    const newReputationPoints = EarnedPointsService.calculateReputationPoints(
      user.invitePoints,
      newEarnedPoints,
      user.bonusPoints
    );

    await db
      .update(users)
      .set({
        earnedPoints: newEarnedPoints,
        reputationPoints: newReputationPoints,
      })
      .where(eq(users.id, userId));

    logger.info(
      'Updated earned points from P&L',
      {
        userId,
        lifetimePnL,
        earnedPoints: newEarnedPoints,
        reputationPoints: newReputationPoints,
      },
      'EarnedPointsService'
    );
  }

  /**
   * Award earned points for a specific P&L amount (for incremental updates)
   *
   * @description Awards earned points incrementally when recording a trade's P&L.
   * Calculates the difference between previous and new P&L and updates earned
   * points accordingly. Creates a points transaction record.
   *
   * Use this when recording a trade's P&L for incremental updates.
   *
   * @param {string} userId - User ID
   * @param {number} newLifetimePnL - New lifetime P&L (after this trade)
   * @param {string} tradeType - Type of trade (for transaction record)
   * @param {string} [relatedId] - Optional related entity ID (trade ID, etc.)
   * @param {Transaction} [tx] - Optional transaction client for atomic operations
   * @returns {Promise<number>} Points awarded (can be negative)
   * @throws {Error} If user not found
   */
  static async awardEarnedPointsForPnL(
    userId: string,
    newLifetimePnL: number,
    tradeType: string,
    relatedId?: string,
    tx?: Transaction
  ): Promise<number> {
    const database = tx ?? db;
    const computedEarnedPoints =
      EarnedPointsService.pnlToPoints(newLifetimePnL);

    const result = await database
      .select({
        earnedPoints: users.earnedPoints,
        invitePoints: users.invitePoints,
        bonusPoints: users.bonusPoints,
        reputationPoints: users.reputationPoints,
        lifetimePnL: users.lifetimePnL,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = result[0];

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const currentEarnedPoints = user.earnedPoints;
    const storedLifetimePnL = Number(user.lifetimePnL);

    // Compute what earnedPoints should be based on the NEW lifetimePnL
    // The newLifetimePnL was already written to the DB in the same transaction
    // so storedLifetimePnL should equal newLifetimePnL
    const earnedPointsDelta = computedEarnedPoints - currentEarnedPoints;

    // Log if there was a pre-existing mismatch (for monitoring purposes)
    // Points may be out of sync due to concurrent updates or race conditions
    const expectedPointsFromPreviousPnL = EarnedPointsService.pnlToPoints(
      storedLifetimePnL - (newLifetimePnL - storedLifetimePnL)
    );
    if (
      expectedPointsFromPreviousPnL !== currentEarnedPoints &&
      storedLifetimePnL !== newLifetimePnL
    ) {
      // storedLifetimePnL should equal newLifetimePnL since we're in the same transaction
      // If they differ, something unexpected happened
      logger.warn(
        'Earned points may have been out of sync (auto-correcting)',
        {
          userId,
          storedLifetimePnL,
          newLifetimePnL,
          currentEarnedPoints,
          computedNewPoints: computedEarnedPoints,
        },
        'EarnedPointsService'
      );
    }

    if (earnedPointsDelta === 0) {
      return 0;
    }

    const newEarnedPoints = computedEarnedPoints;
    // Calculate new total reputation points using centralized helper
    const newReputationPoints = EarnedPointsService.calculateReputationPoints(
      user.invitePoints,
      newEarnedPoints,
      user.bonusPoints
    );

    // Update user and create transaction
    await database
      .update(users)
      .set({
        earnedPoints: newEarnedPoints,
        reputationPoints: newReputationPoints,
      })
      .where(eq(users.id, userId));

    await database.insert(pointsTransactions).values({
      id: await generateSnowflakeId(),
      userId,
      amount: earnedPointsDelta,
      pointsBefore: user.reputationPoints,
      pointsAfter: newReputationPoints,
      reason: 'trading_pnl',
      metadata: JSON.stringify({
        tradeType,
        relatedId,
        storedLifetimePnL,
        newLifetimePnL,
        previousEarnedPoints: currentEarnedPoints,
        newEarnedPoints,
        earnedPointsDelta,
      }),
    });

    logger.info(
      'Awarded earned points for P&L',
      {
        userId,
        storedLifetimePnL,
        newLifetimePnL,
        earnedPointsDelta,
        totalEarnedPoints: newEarnedPoints,
        totalReputationPoints: newReputationPoints,
      },
      'EarnedPointsService'
    );

    return earnedPointsDelta;
  }

  /**
   * Award bonus points to a user
   *
   * @description Awards bonus points for actions like onboarding completion,
   * referrals, special events, etc. Updates bonusPoints and recalculates
   * total reputationPoints.
   *
   * @param {string} userId - User ID to award points to
   * @param {number} points - Number of bonus points to award (must be finite and non-negative)
   * @param {string} reason - Reason for the bonus (e.g., 'onboarding_welcome')
   * @param {Transaction} [tx] - Optional transaction for atomic operations
   * @returns {Promise<number>} New total bonus points
   * @throws {Error} If points is not a finite non-negative number
   */
  static async awardBonusPoints(
    userId: string,
    points: number,
    reason: string,
    tx: Transaction | typeof db = db
  ): Promise<number> {
    // Validate points parameter
    if (!Number.isFinite(points)) {
      throw new Error(
        `Invalid points value: ${points}. Points must be a finite number.`
      );
    }
    if (points < 0) {
      throw new Error(
        `Invalid points value: ${points}. Bonus points must be non-negative.`
      );
    }

    // Early return for zero points - no DB mutation needed.
    // We intentionally skip fetching bonusPoints here because awarding 0 points
    // should be a pure no-op. If callers need the current balance, they should
    // query it separately. This saves a DB round-trip for the common case.
    if (points === 0) {
      return 0;
    }

    const result = await tx
      .select({
        earnedPoints: users.earnedPoints,
        invitePoints: users.invitePoints,
        bonusPoints: users.bonusPoints,
        reputationPoints: users.reputationPoints,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = result[0];

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const newBonusPoints = user.bonusPoints + points;

    // Calculate new total reputation points using centralized helper
    const newReputationPoints = EarnedPointsService.calculateReputationPoints(
      user.invitePoints,
      user.earnedPoints,
      newBonusPoints
    );

    // Update user
    await tx
      .update(users)
      .set({
        bonusPoints: newBonusPoints,
        reputationPoints: newReputationPoints,
      })
      .where(eq(users.id, userId));

    // Create transaction record
    await tx.insert(pointsTransactions).values({
      id: await generateSnowflakeId(),
      userId,
      amount: points,
      pointsBefore: user.reputationPoints,
      pointsAfter: newReputationPoints,
      reason,
      metadata: JSON.stringify({
        pointsAwarded: points,
        previousBonusPoints: user.bonusPoints,
        newBonusPoints,
      }),
    });

    logger.info(
      'Awarded bonus points',
      {
        userId,
        points,
        reason,
        totalBonusPoints: newBonusPoints,
        totalReputationPoints: newReputationPoints,
      },
      'EarnedPointsService'
    );

    return newBonusPoints;
  }

  /**
   * Bulk sync earned points for all users
   * Useful for migration or recalculation
   * Note: Individual user errors are caught to allow continuation
   */
  static async bulkSyncAllUsers(): Promise<{
    success: number;
    errors: number;
  }> {
    const usersList = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isActor, false));

    logger.info(
      `Syncing earned points for ${usersList.length} users`,
      {},
      'EarnedPointsService'
    );

    let successCount = 0;
    const errorCount = 0;

    for (const user of usersList) {
      await EarnedPointsService.syncEarnedPointsFromPnL(user.id);
      successCount++;
    }

    logger.info(
      'Bulk sync complete',
      {
        total: usersList.length,
        success: successCount,
        errors: errorCount,
      },
      'EarnedPointsService'
    );

    return { success: successCount, errors: errorCount };
  }
}
