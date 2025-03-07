import type { Entity } from "@elizaos/core";
import type {
	PositionWithBalance,
	Pretty,
	RecommenderMetrics,
	RecommenderMetricsHistory,
	TokenPerformance,
	Transaction,
} from "./types";

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

function formatPrice(price: number): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: price < 1 ? 6 : 2,
		maximumFractionDigits: price < 1 ? 6 : 2,
	}).format(price);
}

function formatPercent(value: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

function formatDate(dateString: string | Date): string {
	const date = dateString instanceof Date ? dateString : new Date(dateString);
	return date.toLocaleString();
}

function normalizeBalance(
	balanceStr: string | bigint,
	decimals: number,
): number {
	const balance =
		typeof balanceStr === "string" ? BigInt(balanceStr) : balanceStr;
	return Number(balance) / 10 ** decimals;
}

function calculateTradeMetrics(
	transactions: Transaction[],
	token: TokenPerformance,
): TradeMetrics {
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
		const price = tx.price
			? Number.parseFloat(tx.price as unknown as string)
			: 0;
		const value = normalizedAmount * price;

		if (tx.timestamp < firstTradeTime) firstTradeTime = new Date(tx.timestamp);
		if (tx.timestamp > lastTradeTime) lastTradeTime = new Date(tx.timestamp);

		switch (tx.type) {
			case "BUY":
				totalBought += normalizedAmount;
				totalBoughtValue += value;
				volumeUsd += value;
				break;
			case "SELL":
				totalSold += normalizedAmount;
				totalSoldValue += value;
				volumeUsd += value;
				break;
			case "transfer_in":
				totalTransferIn += normalizedAmount;
				break;
			case "transfer_out":
				totalTransferOut += normalizedAmount;
				break;
		}
	}

	const averageEntryPrice =
		totalBought > 0 ? totalBoughtValue / totalBought : 0;
	const averageExitPrice = totalSold > 0 ? totalSoldValue / totalSold : 0;
	const realizedPnL = totalSoldValue - totalSold * averageEntryPrice;
	const realizedPnLPercent =
		averageEntryPrice > 0
			? ((averageExitPrice - averageEntryPrice) / averageEntryPrice) * 100
			: 0;

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

function calculatePositionPerformance(
	position: PositionWithBalance,
	token: TokenPerformance,
	transactions: Transaction[],
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
			? ((currentPrice - trades.averageEntryPrice) / trades.averageEntryPrice) *
				100
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
  - Token Standard: ${token.metadata.security.isToken2022 ? "Token-2022" : "SPL Token"}
      `.trim();
}

function formatTransactionHistory(
	transactions: Transaction[],
	token: TokenPerformance,
): string[] {
	return transactions
		.sort(
			(a, b) =>
				new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
		)
		.map((tx) => {
			const normalizedAmount = normalizeBalance(tx.amount, token.decimals);
			const price = tx.price
				? formatPrice(Number.parseFloat(tx.price as unknown as string))
				: "N/A";
			const value = tx.valueUsd
				? formatPrice(Number.parseFloat(tx.valueUsd as unknown as string))
				: "N/A";

			return `
  ${formatDate(tx.timestamp)} - ${tx.type}
  Amount: ${formatNumber(normalizedAmount)} ${token.symbol}
  Price: ${price}
  Value: ${value}
  TX: ${tx.transactionHash}
          `.trim();
		});
}

function formatPositionPerformance(
	position: PositionWithBalance,
	token: TokenPerformance,
	transactions: Transaction[],
): string {
	const perfData = calculatePositionPerformance(position, token, transactions);

	return `
  Position ID: ${position.id}
  Type: ${position.isSimulation ? "Simulation" : "Real"}
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

export function formatFullReport(
	tokens: TokenPerformance[],
	positions: PositionWithBalance[],
	transactions: Transaction[],
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

	const filteredPositions = positions.filter((position) =>
		tokenMap.has(position.tokenAddress),
	);

	const positionsWithData = filteredPositions.map((position) => ({
		position,
		token: tokenMap.get(position.tokenAddress)!,
		transactions: txMap.get(position.id) || [],
	}));

	const positionReports = positionsWithData.map(
		({ position, token, transactions }) =>
			formatPositionPerformance(position, token, transactions),
	);

	const { totalCurrentValue, totalRealizedPnL, totalUnrealizedPnL } =
		positions.reduce(
			(acc, position) => {
				const token = tokenMap.get(position.tokenAddress);

				if (token) {
					const perfData = calculatePositionPerformance(
						position,
						token,
						txMap.get(position.id) || [],
					);

					return {
						totalCurrentValue: acc.totalCurrentValue + perfData.currentValue,
						totalRealizedPnL:
							acc.totalRealizedPnL + perfData.trades.realizedPnL,
						totalUnrealizedPnL: acc.totalUnrealizedPnL + perfData.unrealizedPnL,
					};
				}

				return acc;
			},
			{
				totalCurrentValue: 0,
				totalRealizedPnL: 0,
				totalUnrealizedPnL: 0,
			},
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

function formatScore(score: number): string {
	return score.toFixed(2);
}

function formatPercentMetric(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

type NumericKeys<T> = {
	[K in keyof T]: T[K] extends number ? K : never;
}[keyof T];

type RecommenderNumericMetrics = NumericKeys<RecommenderMetrics>;

function calculateMetricTrend<Metric extends RecommenderNumericMetrics>(
	current: RecommenderMetrics,
	metric: Metric,
	history: RecommenderMetricsHistory[],
): { trend: number; description: string } {
	if (history.length === 0)
		return { trend: 0, description: "No historical data" };

	const sortedHistory = history
		.slice()
		.sort(
			(a, b) =>
				new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
		);

	const previousValue = sortedHistory[0].metrics[metric];
	const trend = ((current[metric] - previousValue) / previousValue) * 100;

	let description = "stable";
	if (trend > 5) description = "improving";
	if (trend < -5) description = "declining";

	return { trend, description };
}

function calculateTrend(current: number, historicalValues: number[]): number {
	if (historicalValues.length === 0) return 0;
	const previousValue = historicalValues[0];
	return ((current - previousValue) / previousValue) * 100;
}

function formatTrendArrow(trend: number): string {
	if (trend > 5) return "↑";
	if (trend < -5) return "↓";
	return "→";
}

type TimePeriod = {
	label: string;
	days: number;
};

function calculatePeriodTrends(
	history: RecommenderMetricsHistory[],
	period: TimePeriod | null = null,
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
					performances: [
						...currentData.performances,
						record.metrics.avgTokenPerformance,
					],
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
			>(),
		);

		return Array.from(monthlyData.entries())
			.map(([month, data]) => ({
				period: month,
				avgPerformance:
					data.performances.reduce((a, b) => a + b, 0) /
					data.performances.length,
				successRate: data.successes / data.total,
				recommendations: data.total,
			}))
			.sort((a, b) => b.period.localeCompare(a.period));
	}

	// For daily and weekly periods
	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - period.days);

	const periodData = history.filter(
		(record) => new Date(record.timestamp) >= cutoffDate,
	);

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

	const performances = periodData.map(
		(record) => record.metrics.avgTokenPerformance,
	);
	const totalRecommendations = periodData.reduce(
		(sum, record) => sum + record.metrics.totalRecommendations,
		0,
	);
	const successfulRecs = periodData.reduce(
		(sum, record) => sum + record.metrics.successfulRecs,
		0,
	);

	return [
		{
			period: period.label,
			avgPerformance:
				performances.reduce((a, b) => a + b, 0) / performances.length,
			successRate:
				totalRecommendations > 0 ? successfulRecs / totalRecommendations : 0,
			recommendations: totalRecommendations,
		},
	];
}

function formatTrends(
	trends: Array<{
		period: string;
		avgPerformance: number;
		successRate: number;
		recommendations: number;
	}>,
): string {
	return trends
		.map((trend) =>
			`
${trend.period}:
- Performance: ${formatPercent(trend.avgPerformance)}
- Success Rate: ${formatPercentMetric(trend.successRate)}
- Recommendations: ${trend.recommendations}`.trim(),
		)
		.join("\n\n");
}

export function formatRecommenderProfile(
	entity: Entity,
	metrics: RecommenderMetrics,
	history: RecommenderMetricsHistory[],
): string {
	const successRate = metrics.successfulRecs / metrics.totalRecommendations;
	const trustTrend = calculateMetricTrend(metrics, "trustScore", history);
	const performanceTrend = calculateMetricTrend(
		metrics,
		"avgTokenPerformance",
		history,
	);

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

export function formatRecommenderReport(
	entity: Entity,
	metrics: RecommenderMetrics,
	history: RecommenderMetricsHistory[],
): string {
	const sortedHistory = [...history].sort(
		(a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
	);

	// Calculate performance trends for different time periods
	const dailyTrends = calculatePeriodTrends(sortedHistory, {
		label: "24 Hours",
		days: 1,
	});
	const weeklyTrends = calculatePeriodTrends(sortedHistory, {
		label: "7 Days",
		days: 7,
	});
	const monthlyTrends = calculatePeriodTrends(sortedHistory);

	// Calculate success trend
	const successTrend = calculateTrend(
		metrics.successfulRecs / metrics.totalRecommendations,
		sortedHistory.map(
			(h) => h.metrics.successfulRecs / h.metrics.totalRecommendations,
		),
	);

	// Calculate performance trend
	const performanceTrend = calculateTrend(
		metrics.avgTokenPerformance,
		sortedHistory.map((h) => h.metrics.avgTokenPerformance),
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

export function formatTopRecommendersOverview(
	recommenders: Entity[],
	metrics: Map<string, RecommenderMetrics>,
	history: Map<string, RecommenderMetricsHistory[]>,
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
		const trustTrend = calculateMetricTrend(
			metric,
			"trustScore",
			historicalData,
		);

		const performanceTrend = calculateMetricTrend(
			metric,
			"avgTokenPerformance",
			historicalData,
		);

		return `
${entity.metadata.username} (${entity.metadata.platform})
Trust Score: ${formatScore(metric.trustScore)} (${formatPercent(trustTrend.trend)} ${trustTrend.description})
Performance Score: ${formatScore(metric.avgTokenPerformance)} (${formatPercent(performanceTrend.trend)} ${performanceTrend.description})
Success Rate: ${formatPercentMetric(metric.successfulRecs / metric.totalRecommendations)}
Last Active: ${formatDate(metric.lastUpdated)}
  `.trim();
	})
	.filter((report) => report !== null)
	.join("\n\n")}
</top_recommenders>`.trim();
}
