import type { Transaction } from './types';

/**
 * Defines the weights for each performance metric used in calculation.
 * @typedef {Object} PerformanceWeights
 * @property {number} profitWeight - The weight for profit metric.
 * @property {number} roiWeight - The weight for ROI metric.
 * @property {number} marketCapWeight - The weight for market capitalization metric.
 * @property {number} liquidityWeight - The weight for liquidity metric.
 * @property {number} holdingPeriodWeight - The weight for holding period metric.
 */
type PerformanceWeights = {
  profitWeight: number;
  roiWeight: number;
  marketCapWeight: number;
  liquidityWeight: number;
  holdingPeriodWeight: number;
};

export const PERFORMANCE_DEFAULT_WEIGHTS: PerformanceWeights = {
  profitWeight: 0.35, // Absolute profit is most important
  roiWeight: 0.25, // ROI shows efficiency
  marketCapWeight: 0.2, // Market growth
  liquidityWeight: 0.15, // Liquidity stability
  holdingPeriodWeight: 0.05, // Time held
};

/**
 * Represents the performance metrics for a particular position.
 *
 * @property {bigint} totalInvestment - The total investment amount in the position.
 * @property {number} totalInvestmentUsd - The total investment amount converted to USD.
 * @property {bigint} remainingAmount - The remaining amount in the position.
 * @property {bigint} totalProfitAmount - The total profit amount in the position.
 * @property {number} totalProfitUsd - The total profit amount converted to USD.
 * @property {number} roi - The return on investment percentage.
 * @property {number} roiUsd - The return on investment percentage converted to USD.
 * @property {number} marketCapChange - The percentage change in market capitalization.
 * @property {number} liquidityChange - The percentage change in liquidity.
 * @property {number} holdingPeriodHours - The holding period in hours.
 * @property {number} performanceScore - The performance score of the position.
 */

type PositionPerformance = {
  totalInvestment: bigint;
  totalInvestmentUsd: number;
  remainingAmount: bigint;
  totalProfitAmount: bigint;
  totalProfitUsd: number;
  roi: number;
  roiUsd: number;
  marketCapChange: number;
  liquidityChange: number;
  holdingPeriodHours: number;
  performanceScore: number;
};

/**
 * Calculates the position performance based on a series of transactions.
 * @param {Transaction[]} txs - The list of transactions to calculate performance for.
 * @returns {PositionPerformance} - The performance metrics of the position.
 */
export function calculatePositionPerformance(txs: Transaction[]): PositionPerformance {
  const buyTx = txs.find((tx) => tx.type === 'BUY');
  const sellTxs = txs.filter((tx) => tx.type === 'SELL');

  const totalInvestment = buyTx?.amount ?? 0n;
  const totalInvestmentUsd = Number(buyTx?.valueUsd ?? 0);
  let remainingAmount = buyTx?.amount ?? 0n;
  let totalProfitAmount = BigInt(0);
  let totalProfitUsd = 0;

  // Sort sells by timestamp
  const sortedSells = [...sellTxs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // Calculate profits from all sells
  for (const sell of sortedSells) {
    // Skip if not enough remaining amount
    if (typeof remainingAmount === 'string') {
      remainingAmount = BigInt(remainingAmount);
    }
    if (remainingAmount <= BigInt(0)) break;

    // Calculate portion of this sell
    const sellAmount =
      BigInt(sell.amount) > remainingAmount ? remainingAmount : BigInt(sell.amount);
    const sellRatio = Number(sellAmount) / Number(sell.amount);

    // Calculate profit for this portion
    const sellProfitUsd = Number(sell.valueUsd ?? 0) * sellRatio;
    const buyPriceForPortion = (totalInvestmentUsd * Number(sellAmount)) / Number(totalInvestment);
    totalProfitUsd += sellProfitUsd - buyPriceForPortion;
    totalProfitAmount = totalProfitAmount + BigInt(sellAmount);
    remainingAmount = BigInt(remainingAmount) - BigInt(sellAmount);
  }

  // Calculate market metrics using the last sell
  const lastSell = sortedSells[sortedSells.length - 1];

  const marketCapChange = lastSell
    ? ((Number(lastSell.marketCap ?? 0) - Number(buyTx?.marketCap ?? 0)) /
        Number(buyTx?.marketCap ?? 0)) *
      100
    : 0;

  const liquidityChange = lastSell
    ? ((Number(lastSell.liquidity ?? 0) - Number(buyTx?.liquidity ?? 0)) /
        Number(buyTx?.liquidity ?? 0)) *
      100
    : 0;

  // Calculate holding period based on first buy to last sell

  const holdingPeriodHours =
    buyTx && lastSell
      ? (lastSell.timestamp.getTime() - buyTx.timestamp.getTime()) / (1000 * 60 * 60)
      : 0;

  // Calculate ROI
  const roi =
    totalInvestment !== BigInt(0) ? (Number(totalProfitAmount) * 100) / Number(totalInvestment) : 0;

  const roiUsd = totalInvestmentUsd !== 0 ? (totalProfitUsd * 100) / totalInvestmentUsd : 0;

  // Calculate performance score
  const performanceScore = calculatePerformanceScore({
    totalProfitUsd,
    roiUsd,
    marketCapChange,
    liquidityChange,
    holdingPeriodHours,
  });
  return {
    totalInvestment: BigInt(totalInvestment),
    totalInvestmentUsd,
    remainingAmount: BigInt(remainingAmount),
    totalProfitAmount,
    totalProfitUsd,
    roi,
    roiUsd,
    marketCapChange,
    liquidityChange,
    holdingPeriodHours,
    performanceScore,
  };
}

/**
 * Calculate the performance score based on the given metrics and weights.
 *
 * @param {Object} metrics - Object containing performance metrics:
 * @param {number} metrics.totalProfitUsd - Total profit in USD.
 * @param {number} metrics.roiUsd - Return on investment in USD.
 * @param {number} metrics.marketCapChange - Market capitalization change.
 * @param {number} metrics.liquidityChange - Liquidity change.
 * @param {number} metrics.holdingPeriodHours - Holding period in hours.
 * @param {Object} weights - Object containing performance weights (optional).
 * @param {number} weights.profitWeight - Weight for profit.
 * @param {number} weights.roiWeight - Weight for ROI.
 * @param {number} weights.marketCapWeight - Weight for market cap change.
 * @param {number} weights.liquidityWeight - Weight for liquidity change.
 * @param {number} weights.holdingPeriodWeight - Weight for holding period.
 * @returns {number} - Performance score calculated based on the metrics and weights.
 */
function calculatePerformanceScore(
  metrics: {
    totalProfitUsd: number;
    roiUsd: number;
    marketCapChange: number;
    liquidityChange: number;
    holdingPeriodHours: number;
  },
  weights: PerformanceWeights = PERFORMANCE_DEFAULT_WEIGHTS
): number {
  // Normalize metrics to 0-100 scale

  // Profit: Consider anything above $10,000 as max score
  const normalizedProfit = Math.min((metrics.totalProfitUsd / 10000) * 100, 100);

  // ROI: Normalize between -100% to +300%
  const normalizedRoi = Math.max(Math.min(metrics.roiUsd), -100);
  const mappedRoi = ((normalizedRoi + 100) / 400) * 100;

  // Market Cap: Normalize between -100% to +300%
  const normalizedMarketCap = Math.max(Math.min(metrics.marketCapChange), -100);

  const mappedMarketCap = ((normalizedMarketCap + 100) / 400) * 100;

  // Liquidity: Normalize between -100% to +200%
  const normalizedLiquidity = Math.max(Math.min(metrics.liquidityChange, 200), -100);
  const mappedLiquidity = ((normalizedLiquidity + 100) / 300) * 100;

  // Holding Period: Consider 7 days as optimal (168 hours)
  const optimalHoldingHours = 168; // 7 days
  const normalizedHolding = Math.min((metrics.holdingPeriodHours / optimalHoldingHours) * 100, 100);

  // Calculate weighted score
  return (
    normalizedProfit * weights.profitWeight +
    mappedRoi * weights.roiWeight +
    mappedMarketCap * weights.marketCapWeight +
    mappedLiquidity * weights.liquidityWeight +
    normalizedHolding * weights.holdingPeriodWeight
  );
}
