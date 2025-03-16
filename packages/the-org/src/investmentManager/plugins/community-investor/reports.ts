import type { Entity } from '@elizaos/core';
import type {
  PositionWithBalance,
  Pretty,
  RecommenderMetrics,
  RecommenderMetricsHistory,
  TokenPerformance,
  Transaction,
} from './types';

/**
 * Represents the metrics of a trade including total bought quantity, total bought value, total sold quantity,
 * total sold value, total transfer in quantity, total transfer out quantity, average entry price, average exit price,
 * realized profit and loss, realized profit and loss percentage, volume in USD, first trade time, and last trade time.
 * @typedef {Object} TradeMetrics
 * @property {number} totalBought - The total quantity bought
 * @property {number} totalBoughtValue - The total value of items bought
 * @property {number} totalSold - The total quantity sold
 * @property {number} totalSoldValue - The total value of items sold
 * @property {number} totalTransferIn - The total quantity transferred in
 * @property {number} totalTransferOut - The total quantity transferred out
 * @property {number} averageEntryPrice - The average price at which items were bought
 * @property {number} averageExitPrice - The average price at which items were sold
 * @property {number} realizedPnL - The realized profit and loss
 * @property {number} realizedPnLPercent - The realized profit and loss percentage
 * @property {number} volumeUsd - The volume in USD
 * @property {Date} firstTradeTime - The timestamp of the first trade
 * @property {Date} lastTradeTime - The timestamp of the last trade
 */
type TradeMetrics = {
  totalBought: number;
  totalBoughtValue: number;
  totalSold: number;
  totalSoldValue: number;
  totalTransferIn: number;
  totalTransferOut: number;
  averageEntryPrice: number;
  averageExitPrice: number;
  realizedPnL: number;
  realizedPnLPercent: number;
  volumeUsd: number;
  firstTradeTime: Date;
  lastTradeTime: Date;
};

/**
 * Type for position performance statistics.
 * Includes information about the position such as token, current value, initial value, profit/loss, profit/loss percentage,
 * price change, price change percentage, normalized balance, trade metrics, unrealized profit/loss, unrealized profit/loss percentage,
 * total profit/loss, and total profit/loss percentage.
 */
type PositionPerformance = Pretty<
  PositionWithBalance & {
    token: TokenPerformance;
    currentValue: number;
    initialValue: number;
    profitLoss: number;
    profitLossPercentage: number;
    priceChange: number;
    priceChangePercentage: number;
    normalizedBalance: number;
    trades: TradeMetrics;
    unrealizedPnL: number;
    unrealizedPnLPercent: number;
    totalPnL: number;
    totalPnLPercent: number;
  }
>;

/**
 * Formats a price into a currency format.
 *
 * @param {number} price - The price to be formatted.
 * @returns {string} The price formatted as a currency.
 */
function formatPrice(price: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: price < 1 ? 6 : 2,
    maximumFractionDigits: price < 1 ? 6 : 2,
  }).format(price);
}

/**
 * Formats a number as a percentage string with two decimal places.
 * @param {number} value - The number to be formatted as a percentage.
 * @returns {string} The formatted percentage string.
 */
function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/**
 * Formats a given number into a string representation using the "en-US" number format.
 *
 * @param {number} value - The number to be formatted.
 * @returns {string} The formatted number as a string.
 */
function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

/**
 * Formats a given date string or Date object into a locale-specific string representation.
 *
 * @param {string | Date} dateString - The date string to be formatted or a Date object.
 * @returns {string} The formatted date string.
 */
function formatDate(dateString: string | Date): string {
  const date = dateString instanceof Date ? dateString : new Date(dateString);
  return date.toLocaleString();
}

/**
 * Function to normalize the balance based on the decimals provided.
 * @param {string | bigint} balanceStr - The balance to normalize, can be a string or bigint.
 * @param {number} decimals - The number of decimal places to normalize to.
 * @returns {number} The normalized balance as a number.
 */
function normalizeBalance(balanceStr: string | bigint, decimals: number): number {
  const balance = typeof balanceStr === 'string' ? BigInt(balanceStr) : balanceStr;
  return Number(balance) / 10 ** decimals;
}

/**
 * Calculate various trade metrics based on transactions and token performance.
 *
 * @param {Transaction[]} transactions - Array of transactions to calculate metrics for.
 * @param {TokenPerformance} token - Token performance object.
 * @returns {TradeMetrics} Object containing calculated trade metrics.
 */
function calculateTradeMetrics(transactions: Transaction[], token: TokenPerformance): TradeMetrics {
  let totalBought = 0;
  let totalBoughtValue = 0;
  let totalSold = 0;
  let totalSoldValue = 0;
  let totalTransferIn = 0;
  let totalTransferOut = 0;
  let volumeUsd = 0;
  let firstTradeTime = new Date();
  let lastTradeTime = new Date(0);

  for (const tx of transactions) {
    const normalizedAmount = normalizeBalance(tx.amount, token.decimals);
    const price = tx.price ? Number.parseFloat(tx.price as unknown as string) : 0;
    const value = normalizedAmount * price;

    if (tx.timestamp < firstTradeTime) firstTradeTime = new Date(tx.timestamp);
    if (tx.timestamp > lastTradeTime) lastTradeTime = new Date(tx.timestamp);

    switch (tx.type) {
      case 'BUY':
        totalBought += normalizedAmount;
        totalBoughtValue += value;
        volumeUsd += value;
        break;
      case 'SELL':
        totalSold += normalizedAmount;
        totalSoldValue += value;
        volumeUsd += value;
        break;
      case 'transfer_in':
        totalTransferIn += normalizedAmount;
        break;
      case 'transfer_out':
        totalTransferOut += normalizedAmount;
        break;
    }
  }

  const averageEntryPrice = totalBought > 0 ? totalBoughtValue / totalBought : 0;
  const averageExitPrice = totalSold > 0 ? totalSoldValue / totalSold : 0;
  const realizedPnL = totalSoldValue - totalSold * averageEntryPrice;
  const realizedPnLPercent =
    averageEntryPrice > 0 ? ((averageExitPrice - averageEntryPrice) / averageEntryPrice) * 100 : 0;

  return {
    totalBought,
    totalBoughtValue,
    totalSold,
    totalSoldValue,
    totalTransferIn,
    totalTransferOut,
    averageEntryPrice,
    averageExitPrice,
    realizedPnL,
    realizedPnLPercent,
    volumeUsd,
    firstTradeTime,
    lastTradeTime,
  };
}

/**
 * Calculate the performance metrics of a given position.
 *
 * @param {PositionWithBalance} position The position with balance information.
 * @param {TokenPerformance} token The performance metrics of the token.
 * @param {Transaction[]} transactions The list of transactions related to the position.
 * @returns {PositionPerformance} The performance metrics of the position including current value, initial value,
 * profit/loss, profit/loss percentage, price change, price change percentage, normalized balance, trade metrics,
 * unrealized profit/loss, unrealized profit/loss percentage, total profit/loss, and total profit/loss percentage.
 */

function calculatePositionPerformance(
  position: PositionWithBalance,
  token: TokenPerformance,
  transactions: Transaction[]
): PositionPerformance {
  const normalizedBalance = normalizeBalance(position.balance, token.decimals);
  const initialPrice = Number.parseFloat(position.initialPrice);
  const currentPrice = token.price;

  const trades = calculateTradeMetrics(transactions, token);

  const currentValue = normalizedBalance * currentPrice;
  const initialValue = normalizedBalance * initialPrice;

  // Calculate unrealized P&L based on average entry price
  const costBasis = normalizedBalance * trades.averageEntryPrice;
  const unrealizedPnL = currentValue - costBasis;
  const unrealizedPnLPercent =
    trades.averageEntryPrice > 0
      ? ((currentPrice - trades.averageEntryPrice) / trades.averageEntryPrice) * 100
      : 0;

  // Total P&L combines realized and unrealized
  const totalPnL = trades.realizedPnL + unrealizedPnL;
  const totalCost = trades.totalBought * trades.averageEntryPrice;
  const totalPnLPercent = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

  const profitLoss = currentValue - initialValue;
  const profitLossPercentage = (profitLoss / initialValue) * 100;
  const priceChange = currentPrice - initialPrice;
  const priceChangePercentage = (priceChange / initialPrice) * 100;

  return {
    ...position,
    token,
    currentValue,
    initialValue,
    profitLoss,
    profitLossPercentage,
    priceChange,
    priceChangePercentage,
    normalizedBalance,
    trades,
    unrealizedPnL,
    unrealizedPnLPercent,
    totalPnL,
    totalPnLPercent,
  };
}

/**
 * Formats the token performance information into a readable string.
 * @param {TokenPerformance} token - The token performance object to format.
 * @returns {string} The formatted token performance information.
 */
function formatTokenPerformance(token: TokenPerformance): string {
  return `
  Token: ${token.name} (${token.symbol})
  Address: ${token.address}
  Chain: ${token.chain}
  Last Updated: ${formatDate(token.updatedAt)}
  Price: ${formatPrice(token.price)} (24h: ${formatPercent(token.price24hChange)})
  Volume: ${formatPrice(token.volume)} (24h: ${formatPercent(token.volume24hChange)})
  Liquidity: ${formatPrice(token.liquidity)}
  Holders: ${formatNumber(token.holders)} (24h: ${formatPercent(token.holders24hChange)})
  Trades: ${formatNumber(token.trades)}
  Security Info:
  - Creator: ${token.metadata.security.creatorAddress}
  - Creation Time: ${new Date(token.metadata.security.creationTime * 1000).toLocaleString()}
  - Total Supply: ${formatNumber(token.metadata.security.totalSupply)}
  - Top 10 Holders: ${formatPercent(token.metadata.security.top10HolderPercent)}
  - Token Standard: ${token.metadata.security.isToken2022 ? 'Token-2022' : 'SPL Token'}
      `.trim();
}

/**
 * Formats transaction history data into an array of strings for display.
 * @param {Transaction[]} transactions - The list of transactions to format.
 * @param {TokenPerformance} token - The token performance data used for formatting.
 * @returns {string[]} - An array of formatted strings representing each transaction.
 */
function formatTransactionHistory(transactions: Transaction[], token: TokenPerformance): string[] {
  return transactions
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .map((tx) => {
      const normalizedAmount = normalizeBalance(tx.amount, token.decimals);
      const price = tx.price
        ? formatPrice(Number.parseFloat(tx.price as unknown as string))
        : 'N/A';
      const value = tx.valueUsd
        ? formatPrice(Number.parseFloat(tx.valueUsd as unknown as string))
        : 'N/A';

      return `
  ${formatDate(tx.timestamp)} - ${tx.type}
  Amount: ${formatNumber(normalizedAmount)} ${token.symbol}
  Price: ${price}
  Value: ${value}
  TX: ${tx.transactionHash}
          `.trim();
    });
}

/**
 * Format the performance metrics and details of a position.
 *
 * @param {PositionWithBalance} position The position object containing balance information.
 * @param {TokenPerformance} token The token performance object.
 * @param {Transaction[]} transactions The list of transactions associated with the position.
 * @returns {string} The formatted performance details of the position.
 */
function formatPositionPerformance(
  position: PositionWithBalance,
  token: TokenPerformance,
  transactions: Transaction[]
): string {
  const perfData = calculatePositionPerformance(position, token, transactions);

  return `
  Position ID: ${position.id}
  Type: ${position.isSimulation ? 'Simulation' : 'Real'}
  Token: ${token.name} (${token.symbol})
  Wallet: ${position.walletAddress}

  Trading Summary:
  - Total Bought: ${formatNumber(perfData.trades.totalBought)} ${token.symbol}
  - Total Sold: ${formatNumber(perfData.trades.totalSold)} ${token.symbol}
  - Average Entry: ${formatPrice(perfData.trades.averageEntryPrice)}
  - Average Exit: ${formatPrice(perfData.trades.averageExitPrice)}
  - Trading Volume: ${formatPrice(perfData.trades.volumeUsd)}
  - First Trade: ${formatDate(perfData.trades.firstTradeTime)}
  - Last Trade: ${formatDate(perfData.trades.lastTradeTime)}

  Performance Metrics:
  - Current Price: ${formatPrice(token.price)}
  - Initial Price: ${formatPrice(Number.parseFloat(position.initialPrice))}
  - Price Change: ${formatPrice(perfData.priceChange)} (${formatPercent(perfData.priceChangePercentage)})

  Position Value:
  - Current Balance: ${formatNumber(perfData.normalizedBalance)} ${token.symbol}
  - Current Value: ${formatPrice(perfData.currentValue)}
  - Realized P&L: ${formatPrice(perfData.trades.realizedPnL)} (${formatPercent(perfData.trades.realizedPnLPercent)})
  - Unrealized P&L: ${formatPrice(perfData.unrealizedPnL)} (${formatPercent(perfData.unrealizedPnLPercent)})
  - Total P&L: ${formatPrice(perfData.totalPnL)} (${formatPercent(perfData.totalPnLPercent)})

  Market Info:
  - Current Liquidity: ${formatPrice(token.liquidity)}
  - 24h Volume: ${formatPrice(token.volume)}

  Transaction History:
  ${formatTransactionHistory(transactions, token)}
      `.trim();
}

/**
 * Formats a full report based on the provided data.
 *
 * @param {TokenPerformance[]} tokens - Array of token performance data.
 * @param {PositionWithBalance[]} positions - Array of positions with balance data.
 * @param {Transaction[]} transactions - Array of transactions data.
 * @returns {{
 *   tokenReports: Object[],
 *   positionReports: Object[],
 *   totalCurrentValue: string,
 *   totalRealizedPnL: string,
 *   totalUnrealizedPnL: string,
 *   totalPnL: string,
 *   positionsWithBalance: Object[],
 * }} Formatted full report containing token reports, position reports, total values, and positions with balance.
 */
export function formatFullReport(
  tokens: TokenPerformance[],
  positions: PositionWithBalance[],
  transactions: Transaction[]
) {
  const tokenMap = new Map(tokens.map((token) => [token.address, token]));
  const txMap = new Map<string, Transaction[]>();

  // Group transactions by position ID
  transactions.forEach((tx) => {
    if (!txMap.has(tx.positionId)) {
      txMap.set(tx.positionId, []);
    }
    txMap.get(tx.positionId)?.push(tx);
  });

  const tokenReports = tokens.map((token) => formatTokenPerformance(token));

  const filteredPositions = positions.filter((position) => tokenMap.has(position.tokenAddress));

  const positionsWithData = filteredPositions.map((position) => ({
    position,
    token: tokenMap.get(position.tokenAddress)!,
    transactions: txMap.get(position.id) || [],
  }));

  const positionReports = positionsWithData.map(({ position, token, transactions }) =>
    formatPositionPerformance(position, token, transactions)
  );

  const { totalCurrentValue, totalRealizedPnL, totalUnrealizedPnL } = positions.reduce(
    (acc, position) => {
      const token = tokenMap.get(position.tokenAddress);

      if (token) {
        const perfData = calculatePositionPerformance(
          position,
          token,
          txMap.get(position.id) || []
        );

        return {
          totalCurrentValue: acc.totalCurrentValue + perfData.currentValue,
          totalRealizedPnL: acc.totalRealizedPnL + perfData.trades.realizedPnL,
          totalUnrealizedPnL: acc.totalUnrealizedPnL + perfData.unrealizedPnL,
        };
      }

      return acc;
    },
    {
      totalCurrentValue: 0,
      totalRealizedPnL: 0,
      totalUnrealizedPnL: 0,
    }
  );

  const totalPnL = totalRealizedPnL + totalUnrealizedPnL;

  return {
    tokenReports,
    positionReports,
    totalCurrentValue: formatPrice(totalCurrentValue),
    totalRealizedPnL: formatPrice(totalRealizedPnL),
    totalUnrealizedPnL: formatPrice(totalUnrealizedPnL),
    totalPnL: formatPrice(totalPnL),
    positionsWithBalance: positionsWithData,
  };
}

/**
 * Formats a numerical score to have exactly two decimal places.
 *
 * @param {number} score - The numerical score to be formatted.
 * @returns {string} The formatted score with two decimal places.
 */

function formatScore(score: number): string {
  return score.toFixed(2);
}

/**
 * Formats a numeric value into a percentage string with one decimal place.
 *
 * @param {number} value - The numeric value to be formatted as a percentage.
 * @returns {string} The formatted percentage string.
 */
function formatPercentMetric(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * TypeScript type to retrieve the keys of a given object `T` that have numeric values.
 */
type NumericKeys<T> = {
  [K in keyof T]: T[K] extends number ? K : never;
}[keyof T];

/**
 * Represents the numeric keys from the `RecommenderMetrics` type.
 */
type RecommenderNumericMetrics = NumericKeys<RecommenderMetrics>;

/**
 * Calculate the trend of a specific metric based on historical data.
 * @template Metric - The type of metric to calculate trend for.
 * @param {RecommenderMetrics} current - The current metrics values.
 * @param {Metric} metric - The specific metric to calculate trend for.
 * @param {RecommenderMetricsHistory[]} history - Array of historical metrics data.
 * @returns {{ trend: number; description: string }} - Object containing trend value and description.
 */
function calculateMetricTrend<Metric extends RecommenderNumericMetrics>(
  current: RecommenderMetrics,
  metric: Metric,
  history: RecommenderMetricsHistory[]
): { trend: number; description: string } {
  if (history.length === 0) return { trend: 0, description: 'No historical data' };

  const sortedHistory = history
    .slice()
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const previousValue = sortedHistory[0].metrics[metric];
  const trend = ((current[metric] - previousValue) / previousValue) * 100;

  let description = 'stable';
  if (trend > 5) description = 'improving';
  if (trend < -5) description = 'declining';

  return { trend, description };
}

/**
 * Calculate the percentage trend between the current value and the first value in the historical values array.
 *
 * @param {number} current - The current value.
 * @param {number[]} historicalValues - An array of historical values.
 * @returns {number} The calculated trend percentage.
 */
function calculateTrend(current: number, historicalValues: number[]): number {
  if (historicalValues.length === 0) return 0;
  const previousValue = historicalValues[0];
  return ((current - previousValue) / previousValue) * 100;
}

/**
 * Formats the trend arrow based on the trend value.
 * An arrow pointing upwards ("↑") is returned if the trend is greater than 5.
 * An arrow pointing downwards ("↓") is returned if the trend is less than -5.
 * A horizontal arrow ("→") is returned if the trend is between -5 and 5 (inclusive).
 *
 * @param trend The value representing the trend
 * @returns The formatted arrow representing the trend direction
 */
function formatTrendArrow(trend: number): string {
  if (trend > 5) return '↑';
  if (trend < -5) return '↓';
  return '→';
}

/**
 * Represents a time period with a label and number of days.
 * @typedef {Object} TimePeriod
 * @property {string} label - The label for the time period.
 * @property {number} days - The number of days in the time period.
 */
type TimePeriod = {
  label: string;
  days: number;
};

/**
 * Calculates and returns trends for a given history of recommended metrics.
 * If a specific period is provided, trends are calculated for that period.
 * If no period is provided, monthly trends are calculated.
 *
 * @param {RecommenderMetricsHistory[]} history - The history of recommended metrics.
 * @param {TimePeriod} period - The time period for which trends should be calculated. If not provided, monthly trends are calculated.
 * @returns {Array<{
 * 	period: string;
 * 	avgPerformance: number;
 * 	successRate: number;
 * 	recommendations: number;
 * }>} An array of objects containing period, average performance, success rate, and total recommendations.
 */
function calculatePeriodTrends(
  history: RecommenderMetricsHistory[],
  period: TimePeriod | null = null
): Array<{
  period: string;
  avgPerformance: number;
  successRate: number;
  recommendations: number;
}> {
  // For monthly grouping
  if (!period) {
    const monthlyData = history.reduce(
      (acc, record) => {
        const month = new Date(record.timestamp).toISOString().slice(0, 7);

        const currentData = acc.get(month) ?? {
          performances: [],
          successes: 0,
          total: 0,
        };

        acc.set(month, {
          performances: [...currentData.performances, record.metrics.avgTokenPerformance],
          successes: currentData.successes + record.metrics.successfulRecs,
          total: currentData.total + record.metrics.totalRecommendations,
        });

        return acc;
      },
      new Map<
        string,
        {
          performances: number[];
          successes: number;
          total: number;
        }
      >()
    );

    return Array.from(monthlyData.entries())
      .map(([month, data]) => ({
        period: month,
        avgPerformance: data.performances.reduce((a, b) => a + b, 0) / data.performances.length,
        successRate: data.successes / data.total,
        recommendations: data.total,
      }))
      .sort((a, b) => b.period.localeCompare(a.period));
  }

  // For daily and weekly periods
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - period.days);

  const periodData = history.filter((record) => new Date(record.timestamp) >= cutoffDate);

  if (periodData.length === 0) {
    return [
      {
        period: period.label,
        avgPerformance: 0,
        successRate: 0,
        recommendations: 0,
      },
    ];
  }

  const performances = periodData.map((record) => record.metrics.avgTokenPerformance);
  const totalRecommendations = periodData.reduce(
    (sum, record) => sum + record.metrics.totalRecommendations,
    0
  );
  const successfulRecs = periodData.reduce((sum, record) => sum + record.metrics.successfulRecs, 0);

  return [
    {
      period: period.label,
      avgPerformance: performances.reduce((a, b) => a + b, 0) / performances.length,
      successRate: totalRecommendations > 0 ? successfulRecs / totalRecommendations : 0,
      recommendations: totalRecommendations,
    },
  ];
}

/**
 * Formats an array of trends into a string representation.
 *
 * @param {Array<{ period: string; avgPerformance: number; successRate: number; recommendations: number; }>} trends The array of trends to format.
 * @returns {string} The formatted trends as a string with each trend separated by two new lines.
 */
function formatTrends(
  trends: Array<{
    period: string;
    avgPerformance: number;
    successRate: number;
    recommendations: number;
  }>
): string {
  return trends
    .map((trend) =>
      `
${trend.period}:
- Performance: ${formatPercent(trend.avgPerformance)}
- Success Rate: ${formatPercentMetric(trend.successRate)}
- Recommendations: ${trend.recommendations}`.trim()
    )
    .join('\n\n');
}

/**
 * Formats the recommender profile for a given entity based on the provided metrics and history.
 * @param {Entity} entity - The entity for which the profile is being formatted.
 * @param {RecommenderMetrics} metrics - The metrics related to the recommendations for the entity.
 * @param {RecommenderMetricsHistory[]} history - The history of metrics for the entity.
 * @returns {string} The formatted recommender profile string.
 */
export function formatRecommenderProfile(
  entity: Entity,
  metrics: RecommenderMetrics,
  history: RecommenderMetricsHistory[]
): string {
  const successRate = metrics.successfulRecs / metrics.totalRecommendations;
  const trustTrend = calculateMetricTrend(metrics, 'trustScore', history);
  const performanceTrend = calculateMetricTrend(metrics, 'avgTokenPerformance', history);

  return `
Entity Profile: ${entity.metadata.username}
Platform: ${entity.metadata.platform}
ID: ${entity.id}

Performance Metrics:
- Trust Score: ${formatScore(metrics.trustScore)} (${formatPercent(trustTrend.trend)} ${trustTrend.description})
- Success Rate: ${formatPercentMetric(successRate)}
- Recommendations: ${metrics.totalRecommendations} total, ${metrics.successfulRecs} successful
- Avg Token Performance: ${formatPercent(metrics.avgTokenPerformance)} (${formatPercent(performanceTrend.trend)} ${performanceTrend.description})

Risk Assessment:
- Consistency Score: ${formatScore(metrics.consistencyScore)}

Activity:
- Last Active: ${formatDate(metrics.lastUpdated)}
    `.trim();
}

/**
 * Formats a recommender report for an entity with provided metrics and history.
 * @param {Entity} entity - The entity for which the report is being generated.
 * @param {RecommenderMetrics} metrics - The metrics for the entity's recommendations.
 * @param {RecommenderMetricsHistory[]} history - The historical metrics for the entity's recommendations.
 * @returns {string} The formatted recommender report.
 */
export function formatRecommenderReport(
  entity: Entity,
  metrics: RecommenderMetrics,
  history: RecommenderMetricsHistory[]
): string {
  const sortedHistory = [...history].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  // Calculate performance trends for different time periods
  const dailyTrends = calculatePeriodTrends(sortedHistory, {
    label: '24 Hours',
    days: 1,
  });
  const weeklyTrends = calculatePeriodTrends(sortedHistory, {
    label: '7 Days',
    days: 7,
  });
  const monthlyTrends = calculatePeriodTrends(sortedHistory);

  // Calculate success trend
  const successTrend = calculateTrend(
    metrics.successfulRecs / metrics.totalRecommendations,
    sortedHistory.map((h) => h.metrics.successfulRecs / h.metrics.totalRecommendations)
  );

  // Calculate performance trend
  const performanceTrend = calculateTrend(
    metrics.avgTokenPerformance,
    sortedHistory.map((h) => h.metrics.avgTokenPerformance)
  );

  return `
Username: ${entity.metadata.username}
Platform: ${entity.metadata.platform}
ID: ${entity.id}

=== CURRENT METRICS ===
Trust Score: ${formatScore(metrics.trustScore)}
Success Rate: ${formatPercentMetric(metrics.successfulRecs / metrics.totalRecommendations)} (${formatTrendArrow(successTrend)})
Total Recommendations: ${metrics.totalRecommendations}
Average Token Performance: ${formatPercent(metrics.avgTokenPerformance)} (${formatTrendArrow(performanceTrend)})

Risk Analysis:
- Consistency: ${formatScore(metrics.consistencyScore)}

Activity Status:
- Last Active: ${formatDate(metrics.lastUpdated)}

=== PERFORMANCE TRENDS ===
${formatTrends(dailyTrends)}

${formatTrends(weeklyTrends)}

Monthly Average Performance:
${formatTrends(monthlyTrends)}`.trim();
}

/**
 * Formats the top recommenders overview based on the provided data.
 *
 * @param {Entity[]} recommenders - The list of recommenders to be formatted
 * @param {Map<string, RecommenderMetrics>} metrics - The map of recommender metrics
 * @param {Map<string, RecommenderMetricsHistory[]>} history - The map of historical metrics data
 * @returns {string} The formatted top recommenders overview in XML format
 */
export function formatTopRecommendersOverview(
  recommenders: Entity[],
  metrics: Map<string, RecommenderMetrics>,
  history: Map<string, RecommenderMetricsHistory[]>
): string {
  const sortedRecommenders = [...recommenders].sort((a, b) => {
    const metricsA = metrics.get(a.id);
    const metricsB = metrics.get(b.id);
    if (!metricsA || !metricsB) return 0;
    return metricsB.trustScore - metricsA.trustScore;
  });

  return `
<top_recommenders>
${sortedRecommenders
  .map((entity) => {
    const metric = metrics.get(entity.id);
    if (!metric) return null;
    const historicalData = history.get(entity.id) || [];
    const trustTrend = calculateMetricTrend(metric, 'trustScore', historicalData);

    const performanceTrend = calculateMetricTrend(metric, 'avgTokenPerformance', historicalData);

    return `
${entity.metadata.username} (${entity.metadata.platform})
Trust Score: ${formatScore(metric.trustScore)} (${formatPercent(trustTrend.trend)} ${trustTrend.description})
Performance Score: ${formatScore(metric.avgTokenPerformance)} (${formatPercent(performanceTrend.trend)} ${performanceTrend.description})
Success Rate: ${formatPercentMetric(metric.successfulRecs / metric.totalRecommendations)}
Last Active: ${formatDate(metric.lastUpdated)}
  `.trim();
  })
  .filter((report) => report !== null)
  .join('\n\n')}
</top_recommenders>`.trim();
}
