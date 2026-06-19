/**
 * PNL Normalization Utilities
 *
 * Converts profit/loss values to normalized 0-1 scale for reputation scoring.
 * Uses sigmoid function to map unbounded ROI to bounded reputation score.
 */

import { clamp, clamp01 } from "../utils/math-utils";

/**
 * Interface for decimal-like values that can be converted to numbers.
 * Used to accept both native numbers and Decimal objects from the database.
 * Defined locally to avoid importing from @feed/db in client-safe code.
 */
interface DecimalLike {
  toNumber(): number;
}

/**
 * Normalize PNL to 0-1 scale using sigmoid function
 *
 * The sigmoid function converts unbounded ROI values to a 0-1 scale:
 * - ROI = 0% → 0.5 (neutral)
 * - ROI = +100% → ~0.88 (very good)
 * - ROI = -50% → ~0.27 (bad)
 * - ROI = +200% → ~0.95 (excellent)
 * - ROI = -75% → ~0.11 (very bad)
 *
 * Formula: 1 / (1 + e^(-roi))
 *
 * @param pnl - Profit or loss amount (can be negative)
 * @param totalInvested - Total amount invested
 * @returns Normalized score from 0 to 1
 */
export function normalizePnL(
  pnl: number | DecimalLike,
  totalInvested: number | DecimalLike,
): number {
  const pnlNum = typeof pnl === "number" ? pnl : pnl.toNumber();
  const investedNum =
    typeof totalInvested === "number"
      ? totalInvested
      : totalInvested.toNumber();

  // Handle edge cases
  if (investedNum === 0) {
    return 0.5; // Neutral score if no investment
  }

  if (pnlNum === 0) {
    return 0.5; // Break-even = neutral
  }

  // Calculate ROI (return on investment)
  const roi = pnlNum / investedNum;

  // Apply sigmoid normalization
  // e^(-roi) for negative ROI dampening
  const normalized = 1 / (1 + Math.exp(-roi));

  // Clamp to [0, 1] range (should already be in range, but safety check)
  return clamp01(normalized);
}

/**
 * Denormalize a 0-1 score back to ROI percentage
 *
 * Inverse sigmoid function: roi = -ln((1/score) - 1)
 *
 * @param normalized - Normalized score from 0 to 1
 * @returns ROI as percentage (e.g., 0.5 → 0%, 0.88 → ~100%)
 */
export function denormalizePnL(normalized: number): number {
  // Clamp input to valid range
  const clamped = clamp(normalized, 0.001, 0.999);

  // Inverse sigmoid
  const roi = -Math.log(1 / clamped - 1);

  return roi;
}

/**
 * Calculate win rate from trading history
 *
 * @param profitableTrades - Number of profitable trades
 * @param totalTrades - Total number of trades
 * @returns Win rate as decimal (0-1)
 */
export function calculateWinRate(
  profitableTrades: number,
  totalTrades: number,
): number {
  if (totalTrades === 0) {
    return 0;
  }

  return profitableTrades / totalTrades;
}

/**
 * Calculate average ROI from multiple trades
 *
 * @param trades - Array of {pnl, invested} objects
 * @returns Average ROI as decimal
 */
export function calculateAverageROI(
  trades: Array<{ pnl: number; invested: number }>,
): number {
  if (trades.length === 0) {
    return 0;
  }

  const totalROI = trades.reduce((sum, trade) => {
    if (trade.invested === 0) {
      return sum;
    }
    return sum + trade.pnl / trade.invested;
  }, 0);

  return totalROI / trades.length;
}

/**
 * Calculate Sharpe Ratio (risk-adjusted returns)
 *
 * Sharpe Ratio measures excess return per unit of risk (volatility).
 * Higher values indicate better risk-adjusted performance.
 *
 * @param returns - Array of return values (ROI per trade)
 * @param riskFreeRate - Risk-free rate (default 0.02 for 2% annual)
 * @returns Sharpe ratio (higher is better)
 */
export function calculateSharpeRatio(
  returns: number[],
  riskFreeRate = 0.02,
): number | null {
  if (returns.length < 2) {
    return null; // Need at least 2 returns for meaningful calculation
  }

  // Calculate average return
  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;

  // Calculate standard deviation (volatility)
  const variance =
    returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) /
    (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return null; // No volatility = undefined Sharpe ratio
  }

  // Sharpe ratio = (average return - risk-free rate) / standard deviation
  return (avgReturn - riskFreeRate / 12) / stdDev; // Divide risk-free rate by 12 for monthly
}

/**
 * Get trust level classification from reputation score
 *
 * @param reputationScore - Composite reputation score (0-100)
 * @returns Trust level string
 */
export function getTrustLevel(reputationScore: number): string {
  if (reputationScore < 20) return "UNRATED";
  if (reputationScore < 40) return "LOW";
  if (reputationScore < 60) return "MEDIUM";
  if (reputationScore < 80) return "HIGH";
  return "EXCELLENT";
}

/**
 * Calculate confidence score based on sample size
 *
 * Uses Wilson score interval to determine confidence in reputation score.
 * More data = higher confidence.
 *
 * @param sampleSize - Number of feedback/trades used for score
 * @returns Confidence score (0-1), where 1 = highly confident
 */
export function calculateConfidenceScore(sampleSize: number): number {
  // Wilson score confidence increases with sample size
  // Asymptotically approaches 1 as sample size grows

  if (sampleSize === 0) {
    return 0;
  }

  // Confidence formula: 1 - e^(-samples/20)
  // Reaches ~50% confidence at 14 samples
  // Reaches ~75% confidence at 28 samples
  // Reaches ~90% confidence at 46 samples
  const confidence = 1 - Math.exp(-sampleSize / 20);

  return clamp01(confidence);
}
