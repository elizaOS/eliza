/**
 * Trade Feedback Calculator
 *
 * Calculates performance metrics and feedback scores for individual trades.
 * Analyzes entry timing, exit timing, hold duration, and risk management.
 */

import { db } from '@feed/db';
import { positions, questions, users } from '@feed/db/schema';
import { eq } from 'drizzle-orm';
import type { TradeMetrics } from './reputation-calculation-service';

interface TradePosition {
  id: string;
  userId: string;
  questionId: number;
  outcome: boolean;
  amount: number;
  pnl: number;
  createdAt: Date;
  resolvedAt: Date | null;
  entryPrice?: number;
  exitPrice?: number;
}

/**
 * Calculate timing score for trade entry
 *
 * Analyzes how well-timed the entry was relative to market resolution.
 * Earlier profitable positions show good predictive ability.
 *
 * @param position - Trade position data
 * @param marketResolutionDate - When the market resolved
 * @returns Score from 0-1 (higher is better timing)
 */
export function calculateEntryTimingScore(
  position: TradePosition,
  marketResolutionDate: Date
): number {
  const entryTime = position.createdAt.getTime();
  const resolutionTime = marketResolutionDate.getTime();

  // Calculate how early the position was taken (as fraction of total time)
  const totalDuration = resolutionTime - entryTime;
  const daysBeforeResolution = totalDuration / (1000 * 60 * 60 * 24);

  // Reward early correct predictions
  if (position.pnl > 0) {
    // Profitable early entry = excellent timing
    // 7+ days early: 0.9-1.0
    // 3-7 days: 0.7-0.9
    // 1-3 days: 0.5-0.7
    // <1 day: 0.3-0.5
    if (daysBeforeResolution >= 7) {
      return 0.9 + Math.random() * 0.1;
    }
    if (daysBeforeResolution >= 3) {
      return 0.7 + Math.random() * 0.2;
    }
    if (daysBeforeResolution >= 1) {
      return 0.5 + Math.random() * 0.2;
    }
    return 0.3 + Math.random() * 0.2;
  }
  // Unprofitable position = poor timing
  // Late entry to wrong outcome is worst (0.0-0.2)
  // Early entry to wrong outcome shows conviction but poor judgment (0.2-0.4)
  if (daysBeforeResolution >= 7) {
    return 0.2 + Math.random() * 0.2; // Wrong but early = committed mistake
  }
  return 0.0 + Math.random() * 0.2; // Wrong and late = bad timing
}

/**
 * Calculate exit timing score
 *
 * For positions that were closed before resolution, analyzes exit timing.
 *
 * @param position - Trade position data
 * @param marketResolutionDate - When the market resolved
 * @returns Score from 0-1
 */
export function calculateExitTimingScore(
  position: TradePosition,
  marketResolutionDate: Date
): number {
  if (!position.resolvedAt) {
    // Position held until resolution = perfect timing
    return 1.0;
  }

  const exitTime = position.resolvedAt.getTime();
  const resolutionTime = marketResolutionDate.getTime();
  const entryTime = position.createdAt.getTime();

  // If exit was after resolution, this shouldn't happen but handle it
  if (exitTime >= resolutionTime) {
    return 1.0;
  }

  const totalDuration = resolutionTime - entryTime;
  const heldDuration = exitTime - entryTime;
  const fractionHeld = heldDuration / totalDuration;

  if (position.pnl > 0) {
    // Profitable exit: score based on when they exited
    // Held to near resolution = better (0.7-1.0)
    // Early exit of profit = okay but suboptimal (0.5-0.7)
    return 0.5 + fractionHeld * 0.5;
  }
  // Unprofitable exit: exiting early is better (cutting losses)
  // Early exit of losing position = good risk management (0.6-0.8)
  // Late exit of losing position = poor risk management (0.2-0.4)
  return 0.8 - fractionHeld * 0.6;
}

/**
 * Calculate risk management score
 *
 * Analyzes position sizing and risk taken relative to available capital.
 *
 * @param position - Trade position data
 * @param userTotalBalance - User's total available balance at trade time
 * @returns Score from 0-1
 */
export function calculateRiskScore(
  position: TradePosition,
  userTotalBalance: number
): number {
  const positionSize = Number(position.amount);
  const riskPercentage = positionSize / userTotalBalance;

  // Optimal risk per position is typically 1-5% of total capital
  if (riskPercentage >= 0.01 && riskPercentage <= 0.05) {
    // Ideal position sizing
    return 0.9 + Math.random() * 0.1;
  }
  if (riskPercentage < 0.01) {
    // Too conservative
    return 0.6 + (riskPercentage / 0.01) * 0.3;
  }
  if (riskPercentage <= 0.1) {
    // Slightly aggressive but acceptable
    return 0.9 - ((riskPercentage - 0.05) / 0.05) * 0.3;
  }
  if (riskPercentage <= 0.25) {
    // Too aggressive
    return 0.6 - ((riskPercentage - 0.1) / 0.15) * 0.3;
  }
  // Extremely risky
  return Math.max(0.1, 0.3 - ((riskPercentage - 0.25) / 0.75) * 0.2);
}

/**
 * Calculate comprehensive trade metrics
 *
 * Analyzes a closed trade and returns detailed performance metrics.
 *
 * @param positionId - Position ID to analyze
 * @returns TradeMetrics or null if position not found
 */
export async function calculateTradeMetrics(
  positionId: string
): Promise<TradeMetrics | null> {
  // Fetch position with related data using Drizzle
  const positionResult = await db
    .select({
      id: positions.id,
      userId: positions.userId,
      questionId: positions.questionId,
      outcome: positions.outcome,
      amount: positions.amount,
      pnl: positions.pnl,
      createdAt: positions.createdAt,
      resolvedAt: positions.resolvedAt,
      questionResolutionDate: questions.resolutionDate,
    })
    .from(positions)
    .leftJoin(questions, eq(positions.questionId, questions.questionNumber))
    .where(eq(positions.id, positionId))
    .limit(1);

  const position = positionResult[0];
  if (!position || !position.questionId) {
    return null;
  }

  // Fetch user balance separately
  const userResult = await db
    .select({
      virtualBalance: users.virtualBalance,
      totalDeposited: users.totalDeposited,
    })
    .from(users)
    .where(eq(users.id, position.userId))
    .limit(1);

  const userBalance = userResult[0];
  if (!userBalance) {
    return null;
  }

  // Build trade position object
  const tradePosition: TradePosition = {
    id: position.id,
    userId: position.userId,
    questionId: position.questionId,
    outcome: position.outcome ?? false,
    amount: Number(position.amount),
    pnl: Number(position.pnl ?? 0),
    createdAt: position.createdAt,
    resolvedAt: position.resolvedAt,
  };

  // Market resolution date (use question's resolution date or current date)
  const marketResolutionDate = position.questionResolutionDate
    ? new Date(position.questionResolutionDate)
    : new Date();

  // Calculate component scores
  const entryTimingScore = calculateEntryTimingScore(
    tradePosition,
    marketResolutionDate
  );
  const exitTimingScore = calculateExitTimingScore(
    tradePosition,
    marketResolutionDate
  );

  // User's total balance at trade time (approximate with current balance + PnL)
  const totalUserBalance =
    Number(userBalance.virtualBalance ?? 0) +
    Number(userBalance.totalDeposited ?? 0);
  const riskScore = calculateRiskScore(tradePosition, totalUserBalance);

  // Combined timing score (weighted average of entry and exit)
  const timingScore = entryTimingScore * 0.6 + exitTimingScore * 0.4;

  // Calculate holding period in hours
  const holdingPeriod = position.resolvedAt
    ? (position.resolvedAt.getTime() - position.createdAt.getTime()) /
      (1000 * 60 * 60)
    : (marketResolutionDate.getTime() - position.createdAt.getTime()) /
      (1000 * 60 * 60);

  // ROI calculation
  const roi =
    tradePosition.amount > 0 ? tradePosition.pnl / tradePosition.amount : 0;

  return {
    profitable: tradePosition.pnl > 0,
    roi,
    holdingPeriod,
    timingScore,
    riskScore,
  };
}

/**
 * Get trade feedback summary
 *
 * Returns a human-readable summary of trade performance.
 *
 * @param metrics - Trade metrics
 * @returns Feedback summary string
 */
export function getTradeFeedbackSummary(metrics: TradeMetrics): string {
  const profitLabel = metrics.profitable ? 'profitable' : 'unprofitable';
  const roiPercent = (metrics.roi * 100).toFixed(1);

  let summary = `Trade was ${profitLabel} with ${roiPercent}% ROI. `;

  // Timing feedback
  if (metrics.timingScore >= 0.8) {
    summary += 'Excellent entry and exit timing. ';
  } else if (metrics.timingScore >= 0.6) {
    summary += 'Good timing overall. ';
  } else if (metrics.timingScore >= 0.4) {
    summary += 'Timing could be improved. ';
  } else {
    summary += 'Poor timing on entry or exit. ';
  }

  // Risk management feedback
  if (metrics.riskScore >= 0.8) {
    summary += 'Strong risk management with appropriate position sizing.';
  } else if (metrics.riskScore >= 0.6) {
    summary += 'Acceptable risk management.';
  } else if (metrics.riskScore >= 0.4) {
    summary += 'Risk management needs improvement - consider position sizing.';
  } else {
    summary += 'High risk taken - be more cautious with position sizes.';
  }

  return summary;
}
