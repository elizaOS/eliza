#!/usr/bin/env node
/**
 * Analyze Trust Scores
 *
 * This script analyzes trust scores from enriched trading call data:
 * 1. Load enriched call data
 * 2. Calculate trust scores using the balanced algorithm
 * 3. Generate rankings and statistics
 * 4. Compare different algorithms if requested
 * 5. Visualize results
 *
 * Usage:
 *   npm run analyze-trust-scores [--input <file>] [--output <dir>] [--compare] [--visualize]
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { TrustScoreService } from "../services/TrustScoreService";

// Parse command line arguments
const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		input: { type: "string", default: "./enriched-data/enriched_calls.json" },
		output: { type: "string", default: "./trust-analysis" },
		compare: { type: "boolean", default: false },
		visualize: { type: "boolean", default: false },
	},
});

const INPUT_FILE = values.input as string;
const OUTPUT_DIR = values.output as string;
const COMPARE_ALGORITHMS = values.compare as boolean;
const VISUALIZE_RESULTS = values.visualize as boolean;

interface EnrichedCall {
	id: string;
	userId: string;
	username: string;
	timestamp: number;
	tokenSymbol: string;
	tokenAddress: string;
	chain: string;
	priceData?: {
		callPrice: number;
		maxPrice: number;
		currentPrice: number;
		profit: number;
		profitPercent: number;
	};
	isRugPull?: boolean;
	isScam?: boolean;
}

interface UserMetrics {
	userId: string;
	username: string;
	totalCalls: number;
	profitableCalls: number;
	averageProfit: number;
	winRate: number;
	sharpeRatio: number;
	consistency: number;
	rugPromotions: number;
	goodCalls: number;
	trustScore: number;
	breakdown?: any;
}

/**
 * Calculate user metrics from their calls
 */
function calculateUserMetrics(
	userCalls: EnrichedCall[],
): Omit<UserMetrics, "trustScore" | "breakdown"> {
	const profits = userCalls
		.map((c) => c.priceData?.profit)
		.filter((p): p is number => p !== undefined);

	const profitableCalls = profits.filter((p) => p > 0).length;
	const totalCalls = userCalls.length;
	const averageProfit =
		profits.length > 0
			? profits.reduce((sum, p) => sum + p, 0) / profits.length
			: 0;
	const winRate = totalCalls > 0 ? profitableCalls / totalCalls : 0;

	// Calculate Sharpe ratio
	const mean = averageProfit;
	const variance =
		profits.length > 0
			? profits.reduce((sum, p) => sum + (p - mean) ** 2, 0) / profits.length
			: 0;
	const stdDev = Math.sqrt(variance);
	const sharpeRatio = stdDev > 0 ? mean / stdDev : 0;

	// Calculate consistency
	const consistency = stdDev > 0 ? Math.max(0, 1 - stdDev / 100) : 1;

	// Count rug promotions and good calls
	const rugPromotions = userCalls.filter((c) => c.isRugPull || c.isScam).length;
	const goodCalls = userCalls.filter(
		(c) => c.priceData && c.priceData.profit > 50 && !c.isRugPull && !c.isScam,
	).length;

	return {
		userId: userCalls[0].userId,
		username: userCalls[0].username,
		totalCalls,
		profitableCalls,
		averageProfit,
		winRate,
		sharpeRatio,
		consistency,
		rugPromotions,
		goodCalls,
	};
}

/**
 * Generate rankings and statistics
 */
function generateStatistics(users: UserMetrics[]) {
	const stats = {
		totalUsers: users.length,
		averageTrustScore:
			users.reduce((sum, u) => sum + u.trustScore, 0) / users.length,
		trustScoreDistribution: {
			excellent: users.filter((u) => u.trustScore >= 80).length,
			good: users.filter((u) => u.trustScore >= 60 && u.trustScore < 80).length,
			average: users.filter((u) => u.trustScore >= 40 && u.trustScore < 60)
				.length,
			poor: users.filter((u) => u.trustScore >= 20 && u.trustScore < 40).length,
			terrible: users.filter((u) => u.trustScore < 20).length,
		},
		topPerformers: users.slice(0, 10).map((u) => ({
			username: u.username,
			trustScore: u.trustScore,
			winRate: u.winRate,
			averageProfit: u.averageProfit,
		})),
		bottomPerformers: users.slice(-10).map((u) => ({
			username: u.username,
			trustScore: u.trustScore,
			winRate: u.winRate,
			averageProfit: u.averageProfit,
		})),
		correlations: {
			trustScoreVsWinRate: calculateCorrelation(
				users.map((u) => u.trustScore),
				users.map((u) => u.winRate * 100),
			),
			trustScoreVsProfit: calculateCorrelation(
				users.map((u) => u.trustScore),
				users.map((u) => u.averageProfit),
			),
			trustScoreVsCalls: calculateCorrelation(
				users.map((u) => u.trustScore),
				users.map((u) => u.totalCalls),
			),
		},
	};

	return stats;
}

/**
 * Calculate Pearson correlation coefficient
 */
function calculateCorrelation(x: number[], y: number[]): number {
	const n = x.length;
	const sumX = x.reduce((a, b) => a + b, 0);
	const sumY = y.reduce((a, b) => a + b, 0);
	const sumXY = x.reduce((total, xi, i) => total + xi * y[i], 0);
	const sumX2 = x.reduce((total, xi) => total + xi * xi, 0);
	const sumY2 = y.reduce((total, yi) => total + yi * yi, 0);

	const numerator = n * sumXY - sumX * sumY;
	const denominator = Math.sqrt(
		(n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY),
	);

	return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Compare different trust score algorithms
 */
async function compareAlgorithms(users: UserMetrics[]): Promise<void> {
	console.log("\n🔄 Comparing Trust Score Algorithms...\n");

	// Simple average algorithm
	const simpleScores = users.map((u) => ({
		username: u.username,
		balanced: u.trustScore,
		simple: u.winRate * 50 + Math.min(u.averageProfit / 2, 50),
	}));

	// Profit-weighted algorithm
	const profitWeightedScores = users.map((u) => ({
		username: u.username,
		balanced: u.trustScore,
		profitWeighted: Math.max(0, Math.min(100, 50 + u.averageProfit / 2)),
	}));

	// Calculate differences
	const avgDiffSimple =
		simpleScores.reduce((sum, s) => sum + Math.abs(s.balanced - s.simple), 0) /
		simpleScores.length;

	const avgDiffProfit =
		profitWeightedScores.reduce(
			(sum, s) => sum + Math.abs(s.balanced - s.profitWeighted),
			0,
		) / profitWeightedScores.length;

	console.log("📊 Algorithm Comparison:");
	console.log(
		`   Average difference (Balanced vs Simple): ${avgDiffSimple.toFixed(2)}`,
	);
	console.log(
		`   Average difference (Balanced vs Profit-Weighted): ${avgDiffProfit.toFixed(2)}`,
	);

	// Save comparison data
	const comparisonFile = path.join(OUTPUT_DIR, "algorithm_comparison.json");
	await fs.writeFile(
		comparisonFile,
		JSON.stringify(
			{
				simpleScores: simpleScores.slice(0, 20),
				profitWeightedScores: profitWeightedScores.slice(0, 20),
				statistics: {
					avgDiffSimple,
					avgDiffProfit,
				},
			},
			null,
			2,
		),
	);
}

/**
 * Visualize results (create CSV for charting)
 */
async function visualizeResults(users: UserMetrics[]): Promise<void> {
	console.log("\n📈 Creating visualization data...\n");

	// Create CSV for scatter plot
	const csvLines = [
		"username,trustScore,winRate,averageProfit,totalCalls,sharpeRatio",
	];

	for (const user of users) {
		csvLines.push(
			[
				user.username,
				user.trustScore.toFixed(2),
				(user.winRate * 100).toFixed(2),
				user.averageProfit.toFixed(2),
				user.totalCalls,
				user.sharpeRatio.toFixed(3),
			].join(","),
		);
	}

	const csvFile = path.join(OUTPUT_DIR, "trust_scores_visualization.csv");
	await fs.writeFile(csvFile, csvLines.join("\n"));

	console.log(`   ✅ Created visualization data: ${csvFile}`);
	console.log("   📊 Import this CSV into your favorite charting tool!");
}

/**
 * Main analysis function
 */
async function main() {
	try {
		console.log("🚀 Analyzing Trust Scores\n");
		console.log(`   Input: ${INPUT_FILE}`);
		console.log(`   Output: ${OUTPUT_DIR}\n`);

		// Create output directory
		await fs.mkdir(OUTPUT_DIR, { recursive: true });

		// Load enriched calls
		console.log("📁 Loading enriched call data...");
		const content = await fs.readFile(INPUT_FILE, "utf-8");
		const enrichedCalls: EnrichedCall[] = JSON.parse(content);
		console.log(`   ✅ Loaded ${enrichedCalls.length} enriched calls`);

		// Group calls by user
		const callsByUser = new Map<string, EnrichedCall[]>();
		for (const call of enrichedCalls) {
			const userCalls = callsByUser.get(call.userId) || [];
			userCalls.push(call);
			callsByUser.set(call.userId, userCalls);
		}
		console.log(`   ✅ Found ${callsByUser.size} unique users`);

		// Calculate metrics and trust scores
		console.log("\n📊 Calculating trust scores...");
		const trustService = new TrustScoreService();
		const users: UserMetrics[] = [];

		for (const [_userId, userCalls] of callsByUser) {
			const metrics = calculateUserMetrics(userCalls);
			const { score, breakdown } =
				trustService.calculateUserTrustScore(userCalls);

			users.push({
				...metrics,
				trustScore: score,
				breakdown,
			});
		}

		// Sort by trust score
		users.sort((a, b) => b.trustScore - a.trustScore);

		// Generate statistics
		const stats = generateStatistics(users);

		// Save results
		console.log("\n💾 Saving results...");

		const resultsFile = path.join(OUTPUT_DIR, "trust_scores.json");
		await fs.writeFile(resultsFile, JSON.stringify(users, null, 2));

		const statsFile = path.join(OUTPUT_DIR, "statistics.json");
		await fs.writeFile(statsFile, JSON.stringify(stats, null, 2));

		// Print summary
		console.log("\n📊 Trust Score Analysis Summary:");
		console.log(`   Total Users: ${stats.totalUsers}`);
		console.log(
			`   Average Trust Score: ${stats.averageTrustScore.toFixed(2)}`,
		);
		console.log("\n   Distribution:");
		console.log(
			`     Excellent (80+): ${stats.trustScoreDistribution.excellent}`,
		);
		console.log(`     Good (60-79): ${stats.trustScoreDistribution.good}`);
		console.log(
			`     Average (40-59): ${stats.trustScoreDistribution.average}`,
		);
		console.log(`     Poor (20-39): ${stats.trustScoreDistribution.poor}`);
		console.log(
			`     Terrible (<20): ${stats.trustScoreDistribution.terrible}`,
		);
		console.log("\n   Top Performers:");
		stats.topPerformers.slice(0, 5).forEach((p) => {
			console.log(
				`     ${p.username}: ${p.trustScore.toFixed(2)} (Win Rate: ${(p.winRate * 100).toFixed(1)}%)`,
			);
		});

		// Compare algorithms if requested
		if (COMPARE_ALGORITHMS) {
			await compareAlgorithms(users);
		}

		// Visualize results if requested
		if (VISUALIZE_RESULTS) {
			await visualizeResults(users);
		}

		console.log("\n✅ Analysis complete!");
		console.log(`   Results saved to: ${OUTPUT_DIR}`);
	} catch (error) {
		console.error("❌ Error analyzing trust scores:", error);
		process.exit(1);
	}
}

// Run if called directly
if (require.main === module) {
	main();
}
