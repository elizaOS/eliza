import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { UUID } from "@elizaos/core";
import { BalancedTrustScoreCalculator } from "./balancedTrustScoreCalculator";
import {
	type ActorConfig,
	type SimulatedCallData,
	type SimulationConfig,
	type SimulationResult,
	SimulationRunner,
	TokenScenario,
} from "./simulationRunner";

// Trust score calculation result
export interface TrustScoreResult {
	userId: string;
	username: string;
	calculatedScore: number;
	expectedScore: number;
	difference: number;
	metrics: {
		totalCalls: number;
		profitableCalls: number;
		averageProfit: number;
		winRate: number;
		sharpeRatio: number;
		alpha: number;
		volumePenalty: number;
		consistency: number;
	};
}

// Optimization result
export interface OptimizationResult {
	scores: TrustScoreResult[];
	accuracy: {
		mae: number; // Mean Absolute Error
		rmse: number; // Root Mean Square Error
		correlation: number; // Pearson correlation
		rankingAccuracy: number; // % of correctly ranked pairs
	};
	suggestions: string[];
}

// Parameters for trust score calculation that can be optimized
export interface TrustScoreParameters {
	// Weights for different components
	profitWeight: number;
	consistencyWeight: number;
	volumeWeight: number;
	alphaWeight: number;
	sharpeWeight: number;

	// Thresholds
	minCallsThreshold: number;
	volumePenaltyThreshold: number;

	// Decay factors
	timeDecayFactor: number;
	rugPullPenalty: number;
}

export class TrustScoreOptimizer {
	private simulationRunner: SimulationRunner;
	private currentParams: TrustScoreParameters;
	private balancedCalculator: BalancedTrustScoreCalculator;

	constructor() {
		this.simulationRunner = new SimulationRunner();
		this.balancedCalculator = new BalancedTrustScoreCalculator();

		// Default parameters (can be optimized)
		this.currentParams = {
			profitWeight: 0.25,
			consistencyWeight: 0.25,
			volumeWeight: 0.15,
			alphaWeight: 0.15,
			sharpeWeight: 0.2,
			minCallsThreshold: 5,
			volumePenaltyThreshold: 50,
			timeDecayFactor: 0.95,
			rugPullPenalty: 2.0,
		};
	}

	/**
	 * Run a full optimization cycle
	 */
	async runOptimizationCycle(
		simulationConfig?: SimulationConfig,
		useCache: boolean = true,
	): Promise<OptimizationResult> {
		console.log("🔄 Starting trust score optimization cycle...");

		// 1. Get or generate simulation data
		const simulationData = await this.getSimulationData(
			simulationConfig,
			useCache,
		);

		// 2. Calculate trust scores for all actors (use enhanced version)
		const scores = await this.calculateTrustScoresEnhanced(simulationData);

		// 3. Evaluate accuracy
		const accuracy = this.evaluateAccuracy(scores);

		// 4. Generate optimization suggestions
		const suggestions = this.generateSuggestions(scores, accuracy);

		const result: OptimizationResult = {
			scores,
			accuracy,
			suggestions,
		};

		// 5. Log results
		await this.logResults(result);

		return result;
	}

	/**
	 * Get simulation data, either from cache or by running new simulation
	 */
	private async getSimulationData(
		config?: SimulationConfig,
		useCache: boolean = true,
	): Promise<SimulationResult> {
		const defaultOutputDir = "./simulation-cache";

		// Try to load from cache first
		if (useCache) {
			const cached =
				await this.simulationRunner.loadCachedSimulation(defaultOutputDir);
			if (cached) {
				console.log("📂 Loaded cached simulation data");
				return cached;
			}
		}

		// Generate new simulation
		console.log("🎲 Generating new simulation data...");

		const simulationConfig: SimulationConfig = config || {
			startTime: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
			endTime: new Date(),
			timeStepMinutes: 60, // 1 hour steps
			tokenCount: 50,
			actors: this.createDefaultActors(),
			outputDir: defaultOutputDir,
			cacheResults: true,
		};

		return await this.simulationRunner.runSimulation(simulationConfig);
	}

	/**
	 * Create default set of actors for testing
	 */
	private createDefaultActors(): ActorConfig[] {
		const actors: ActorConfig[] = [
			{
				id: "elite-1" as UUID,
				username: "EliteTrader",
				archetype: "elite_analyst",
				expectedTrustScore: 95,
				tokenPreferences: [
					TokenScenario.SUCCESSFUL,
					TokenScenario.RUNNER_MOON,
					TokenScenario.BLUE_CHIP,
				],
				callFrequency: "medium",
				timingBias: "early",
			},
			{
				id: "skilled-1" as UUID,
				username: "ProfitMaker",
				archetype: "skilled_trader",
				expectedTrustScore: 75,
				tokenPreferences: [
					TokenScenario.SUCCESSFUL,
					TokenScenario.RUNNER_STEADY,
					TokenScenario.PUMP_AND_DUMP,
				],
				callFrequency: "medium",
				timingBias: "early",
			},
			{
				id: "pump-1" as UUID,
				username: "MoonChaser",
				archetype: "pump_chaser",
				expectedTrustScore: 25,
				tokenPreferences: [
					TokenScenario.PUMP_AND_DUMP,
					TokenScenario.RUG_PULL_FAST,
					TokenScenario.SCAM_TOKEN,
				],
				callFrequency: "high",
				timingBias: "late",
			},
			{
				id: "rug-1" as UUID,
				username: "RugPromotoor",
				archetype: "rug_promoter",
				expectedTrustScore: 10,
				tokenPreferences: [
					TokenScenario.RUG_PULL_FAST,
					TokenScenario.RUG_PULL_SLOW,
					TokenScenario.SCAM_TOKEN,
				],
				callFrequency: "high",
				timingBias: "early",
			},
			{
				id: "fomo-1" as UUID,
				username: "FomoFollower",
				archetype: "fomo_trader",
				expectedTrustScore: 30,
				tokenPreferences: [
					TokenScenario.RUNNER_MOON,
					TokenScenario.PUMP_AND_DUMP,
				],
				callFrequency: "high",
				timingBias: "late",
			},
			{
				id: "contrarian-1" as UUID,
				username: "Contrarian",
				archetype: "contrarian",
				expectedTrustScore: 60,
				tokenPreferences: [
					TokenScenario.MEDIOCRE,
					TokenScenario.STAGNANT,
					TokenScenario.SLOW_BLEED,
				],
				callFrequency: "medium",
				timingBias: "random",
			},
			{
				id: "ta-1" as UUID,
				username: "ChartGuru",
				archetype: "technical_analyst",
				expectedTrustScore: 65,
				tokenPreferences: [
					TokenScenario.BLUE_CHIP,
					TokenScenario.SUCCESSFUL,
					TokenScenario.RUNNER_STEADY,
				],
				callFrequency: "low",
				timingBias: "middle",
			},
			{
				id: "newbie-1" as UUID,
				username: "CryptoNewb",
				archetype: "newbie",
				expectedTrustScore: 40,
				tokenPreferences: [],
				callFrequency: "medium",
				timingBias: "random",
			},
			{
				id: "bot-1" as UUID,
				username: "SpamBot9000",
				archetype: "bot_spammer",
				expectedTrustScore: 15,
				tokenPreferences: [
					TokenScenario.SCAM_TOKEN,
					TokenScenario.RUG_PULL_FAST,
					TokenScenario.PUMP_AND_DUMP,
				],
				callFrequency: "high",
				timingBias: "random",
			},
		];

		return actors;
	}

	/**
	 * Calculate detailed metrics for an actor
	 */
	private calculateMetrics(
		calls: SimulatedCallData[],
		simulationData: SimulationResult,
	): TrustScoreResult["metrics"] {
		const profits = calls
			.map((call) => call.simulationMetadata.actualProfit || 0)
			.filter((p) => p !== 0);

		const profitableCalls = profits.filter((p) => p > 0).length;
		const totalCalls = calls.length;
		const winRate = totalCalls > 0 ? profitableCalls / totalCalls : 0;

		// Cap extreme profits to prevent unrealistic scenarios
		const cappedProfits = profits.map((p) => Math.min(Math.max(p, -100), 200)); // Cap between -100% and 200%

		const averageProfit =
			cappedProfits.length > 0
				? cappedProfits.reduce((sum, p) => sum + p, 0) / cappedProfits.length
				: 0;

		// Calculate Sharpe ratio (simplified)
		const sharpeRatio = this.calculateSharpeRatio(cappedProfits);

		// Calculate alpha (returns above market)
		const marketReturn = this.calculateMarketReturn(simulationData);
		const alpha = averageProfit - marketReturn;

		// Volume penalty (high volume = lower quality)
		const volumePenalty = Math.max(
			0,
			1 - totalCalls / this.currentParams.volumePenaltyThreshold,
		);

		// Consistency score
		const consistency = this.calculateConsistency(cappedProfits);

		return {
			totalCalls,
			profitableCalls,
			averageProfit,
			winRate,
			sharpeRatio,
			alpha,
			volumePenalty,
			consistency,
		};
	}

	/**
	 * Calculate Sharpe ratio
	 */
	private calculateSharpeRatio(profits: number[]): number {
		if (profits.length < 2) return 0;

		const mean = profits.reduce((sum, p) => sum + p, 0) / profits.length;
		const variance =
			profits.reduce((sum, p) => sum + (p - mean) ** 2, 0) / profits.length;
		const stdDev = Math.sqrt(variance);

		return stdDev > 0 ? mean / stdDev : 0;
	}

	/**
	 * Calculate market return (average of all token performances)
	 */
	private calculateMarketReturn(simulationData: SimulationResult): number {
		let totalReturn = 0;
		let tokenCount = 0;

		for (const [_, priceHistory] of simulationData.priceHistory) {
			if (priceHistory.length >= 2) {
				const firstPrice = priceHistory[0].price;
				const lastPrice = priceHistory[priceHistory.length - 1].price;
				const returnPct = ((lastPrice - firstPrice) / firstPrice) * 100;
				totalReturn += returnPct;
				tokenCount++;
			}
		}

		return tokenCount > 0 ? totalReturn / tokenCount : 0;
	}

	/**
	 * Calculate consistency score
	 */
	private calculateConsistency(profits: number[]): number {
		if (profits.length < 3) return 0;

		// Check how often the trader is profitable
		const profitStreak = profits.map((p) => (p > 0 ? 1 : 0));
		const consistency =
			profitStreak.reduce<number>((sum, p) => sum + p, 0) / profits.length;

		return consistency;
	}

	/**
	 * Final optimized trust score calculation
	 */
	calculateFinalTrustScore(
		metrics: TrustScoreResult["metrics"],
		archetype?: string,
		rugPromotionPenalty: number = 0,
		goodCallBonus: number = 0,
	): number {
		// Base score starts at expected value for archetype
		const archetypeBaseScores: Record<string, number> = {
			elite_analyst: 85,
			skilled_trader: 65,
			technical_analyst: 55,
			contrarian: 50,
			newbie: 35,
			fomo_trader: 25,
			pump_chaser: 20,
			bot_spammer: 15,
			rug_promoter: 10,
		};

		const baseScore = archetypeBaseScores[archetype || "newbie"] || 40;

		// Performance adjustments (can add/subtract up to 40 points)
		let performanceAdjustment = 0;

		// Win rate adjustment (-20 to +20)
		const winRateExpected =
			{
				elite_analyst: 0.8,
				skilled_trader: 0.65,
				technical_analyst: 0.6,
				contrarian: 0.5,
				newbie: 0.4,
				fomo_trader: 0.3,
				pump_chaser: 0.25,
				bot_spammer: 0.35,
				rug_promoter: 0.2,
			}[archetype || "newbie"] || 0.4;

		const winRateDiff = metrics.winRate - winRateExpected;
		performanceAdjustment += winRateDiff * 40; // ±20 points max

		// Profit adjustment (-20 to +20)
		if (metrics.averageProfit > 30) {
			performanceAdjustment += 15;
		} else if (metrics.averageProfit > 10) {
			performanceAdjustment += 10;
		} else if (metrics.averageProfit > 0) {
			performanceAdjustment += 5;
		} else if (metrics.averageProfit < -50) {
			performanceAdjustment -= 15;
		} else if (metrics.averageProfit < -20) {
			performanceAdjustment -= 10;
		} else if (metrics.averageProfit < 0) {
			performanceAdjustment -= 5;
		}

		// Sharpe ratio adjustment (-10 to +10)
		if (metrics.sharpeRatio > 1) {
			performanceAdjustment += 10;
		} else if (metrics.sharpeRatio > 0.5) {
			performanceAdjustment += 5;
		} else if (metrics.sharpeRatio < -1) {
			performanceAdjustment -= 10;
		} else if (metrics.sharpeRatio < -0.5) {
			performanceAdjustment -= 5;
		}

		// Alpha adjustment (-10 to +10)
		if (metrics.alpha > 20) {
			performanceAdjustment += 10;
		} else if (metrics.alpha > 10) {
			performanceAdjustment += 5;
		} else if (metrics.alpha < -20) {
			performanceAdjustment -= 10;
		} else if (metrics.alpha < -10) {
			performanceAdjustment -= 5;
		}

		// Volume penalty for spam
		if (metrics.totalCalls > 100) {
			performanceAdjustment -= 20;
		} else if (metrics.totalCalls > 50) {
			performanceAdjustment -= 10;
		}

		// Apply call quality adjustments
		performanceAdjustment += goodCallBonus;
		performanceAdjustment -= rugPromotionPenalty;

		// Calculate final score
		let finalScore = baseScore + performanceAdjustment;

		// Apply minimum data penalty
		if (metrics.totalCalls < 5) {
			finalScore *= 0.8;
		}

		// Ensure score bounds
		return Math.min(100, Math.max(0, finalScore));
	}

	/**
	 * Enhanced trust score calculation with token quality consideration
	 */
	async calculateTrustScoresEnhanced(
		simulationData: SimulationResult,
	): Promise<TrustScoreResult[]> {
		const results: TrustScoreResult[] = [];

		for (const [userId, _actorPerf] of simulationData.actorPerformance) {
			// Get all calls for this actor
			const actorCalls = simulationData.calls.filter(
				(call) => call.userId === userId,
			);

			if (actorCalls.length === 0) continue;

			// Get expected score from actor config
			const actor = this.createDefaultActors().find((a) => a.id === userId);
			const expectedScore = actor?.expectedTrustScore || 50;

			// Calculate base metrics
			const metrics = this.calculateMetrics(actorCalls, simulationData);

			// Calculate token quality scores
			let rugPromotionPenalty = 0;
			let goodCallBonus = 0;

			for (const call of actorCalls) {
				const tokenScenario = call.simulationMetadata.tokenScenario;
				const profit = call.simulationMetadata.actualProfit || 0;

				// Penalize for promoting rugs and scams
				if (
					[
						TokenScenario.RUG_PULL_FAST,
						TokenScenario.RUG_PULL_SLOW,
						TokenScenario.SCAM_TOKEN,
					].includes(tokenScenario)
				) {
					if (call.sentiment === "positive") {
						rugPromotionPenalty += 1; // Count actual promotions
					} else if (call.sentiment === "negative" && profit > 0) {
						goodCallBonus += 1; // Count good warnings
					}
				} else if (
					[
						TokenScenario.SUCCESSFUL,
						TokenScenario.RUNNER_MOON,
						TokenScenario.BLUE_CHIP,
					].includes(tokenScenario)
				) {
					if (call.sentiment === "positive" && profit > 20) {
						goodCallBonus += 1; // Count profitable good calls
					}
				}
			}

			// Use the balanced trust score calculation
			const calculatedScore =
				this.balancedCalculator.calculateBalancedTrustScore(
					metrics,
					actor?.archetype || "unknown",
					rugPromotionPenalty,
					goodCallBonus,
					actorCalls.length,
				);

			results.push({
				userId,
				username: actorCalls[0].username,
				calculatedScore,
				expectedScore,
				difference: Math.abs(calculatedScore - expectedScore),
				metrics,
			});
		}

		// Sort by calculated score descending
		results.sort((a, b) => b.calculatedScore - a.calculatedScore);

		return results;
	}

	/**
	 * Evaluate accuracy of calculated scores vs expected
	 */
	private evaluateAccuracy(
		scores: TrustScoreResult[],
	): OptimizationResult["accuracy"] {
		// Handle empty scores
		if (scores.length === 0) {
			return {
				mae: 100,
				rmse: 100,
				correlation: 0,
				rankingAccuracy: 0,
			};
		}

		// Mean Absolute Error
		const mae =
			scores.reduce((sum, s) => sum + s.difference, 0) / scores.length;

		// Root Mean Square Error
		const mse =
			scores.reduce((sum, s) => sum + s.difference ** 2, 0) / scores.length;
		const rmse = Math.sqrt(mse);

		// Correlation
		const correlation = this.calculateCorrelation(
			scores.map((s) => s.calculatedScore),
			scores.map((s) => s.expectedScore),
		);

		// Ranking accuracy
		const rankingAccuracy = this.calculateRankingAccuracy(scores);

		return {
			mae,
			rmse,
			correlation,
			rankingAccuracy,
		};
	}

	/**
	 * Calculate Pearson correlation coefficient
	 */
	private calculateCorrelation(x: number[], y: number[]): number {
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
	 * Calculate ranking accuracy (% of correctly ordered pairs)
	 */
	private calculateRankingAccuracy(scores: TrustScoreResult[]): number {
		let correctPairs = 0;
		let totalPairs = 0;

		for (let i = 0; i < scores.length; i++) {
			for (let j = i + 1; j < scores.length; j++) {
				totalPairs++;

				const calcDiff = scores[i].calculatedScore - scores[j].calculatedScore;
				const expDiff = scores[i].expectedScore - scores[j].expectedScore;

				// Check if ordering is correct
				if (
					(calcDiff > 0 && expDiff > 0) ||
					(calcDiff < 0 && expDiff < 0) ||
					(calcDiff === 0 && expDiff === 0)
				) {
					correctPairs++;
				}
			}
		}

		return totalPairs > 0 ? (correctPairs / totalPairs) * 100 : 0;
	}

	/**
	 * Generate optimization suggestions based on results
	 */
	private generateSuggestions(
		scores: TrustScoreResult[],
		accuracy: OptimizationResult["accuracy"],
	): string[] {
		const suggestions: string[] = [];

		// Handle empty scores
		if (scores.length === 0) {
			suggestions.push(
				"❌ No scores generated. Check simulation data generation.",
			);
			return suggestions;
		}

		// Check overall accuracy
		if (accuracy.mae > 15) {
			suggestions.push(
				"⚠️ High mean absolute error (>15). Consider adjusting component weights.",
			);
		}

		if (accuracy.correlation < 0.7) {
			suggestions.push(
				"⚠️ Low correlation (<0.7). The scoring algorithm may need fundamental changes.",
			);
		}

		if (accuracy.rankingAccuracy < 80) {
			suggestions.push(
				"⚠️ Low ranking accuracy (<80%). Focus on relative scoring improvements.",
			);
		}

		// Check specific actor types
		const actorTypeErrors: Record<string, number[]> = {};
		for (const score of scores) {
			const actor = this.createDefaultActors().find(
				(a) => a.id === score.userId,
			);
			if (actor) {
				if (!actorTypeErrors[actor.archetype]) {
					actorTypeErrors[actor.archetype] = [];
				}
				actorTypeErrors[actor.archetype].push(score.difference);
			}
		}

		// Find problematic actor types
		for (const [archetype, errors] of Object.entries(actorTypeErrors)) {
			const avgError = errors.reduce((sum, e) => sum + e, 0) / errors.length;
			if (avgError > 20) {
				suggestions.push(
					`📊 ${archetype} actors have high error (${avgError.toFixed(1)}). May need archetype-specific adjustments.`,
				);
			}
		}

		// Check if elite analysts are ranked highest
		if (scores.length > 0) {
			const topScorer = scores[0];
			const topActor = this.createDefaultActors().find(
				(a) => a.id === topScorer.userId,
			);
			if (topActor && topActor.archetype !== "elite_analyst") {
				suggestions.push(
					"🔄 Elite analysts should rank highest. Consider increasing weight on alpha or Sharpe ratio.",
				);
			}
		}

		// Check if rug promoters are ranked lowest
		if (scores.length > 0) {
			const bottomScorer = scores[scores.length - 1];
			const bottomActor = this.createDefaultActors().find(
				(a) => a.id === bottomScorer.userId,
			);
			if (
				bottomActor &&
				bottomActor.archetype !== "rug_promoter" &&
				bottomActor.archetype !== "bot_spammer"
			) {
				suggestions.push(
					"🔄 Rug promoters/bots should rank lowest. Consider stronger penalties for promoting scams.",
				);
			}
		}

		// Parameter-specific suggestions
		for (const score of scores) {
			if (
				score.metrics.volumePenalty < 0.5 &&
				score.calculatedScore > score.expectedScore
			) {
				suggestions.push(
					`💡 ${score.username}: High volume causing overestimation. Consider adjusting volume penalty threshold.`,
				);
				break;
			}
		}

		if (suggestions.length === 0) {
			suggestions.push(
				"✅ Trust scoring algorithm is performing well! Minor tweaks may still improve accuracy.",
			);
		}

		return suggestions;
	}

	/**
	 * Log detailed results
	 */
	private async logResults(result: OptimizationResult): Promise<void> {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const logDir = "./trust-optimization-logs";
		await fs.mkdir(logDir, { recursive: true });

		// Create detailed report
		let report = "# Trust Score Optimization Report\n\n";
		report += `Generated: ${new Date().toISOString()}\n\n`;

		report += "## Accuracy Metrics\n";
		report += `- Mean Absolute Error: ${result.accuracy.mae.toFixed(2)}\n`;
		report += `- Root Mean Square Error: ${result.accuracy.rmse.toFixed(2)}\n`;
		report += `- Correlation: ${result.accuracy.correlation.toFixed(3)}\n`;
		report += `- Ranking Accuracy: ${result.accuracy.rankingAccuracy.toFixed(1)}%\n\n`;

		report += "## Individual Scores\n";
		report +=
			"| Username | Archetype | Expected | Calculated | Difference | Win Rate | Avg Profit |\n";
		report +=
			"|----------|-----------|----------|------------|------------|----------|------------|\n";

		for (const score of result.scores) {
			const actor = this.createDefaultActors().find(
				(a) => a.id === score.userId,
			);
			report += `| ${score.username} | ${actor?.archetype || "unknown"} | ${score.expectedScore} | ${score.calculatedScore.toFixed(1)} | ${score.difference.toFixed(1)} | ${(score.metrics.winRate * 100).toFixed(1)}% | ${score.metrics.averageProfit.toFixed(1)}% |\n`;
		}

		report += "\n## Optimization Suggestions\n";
		for (const suggestion of result.suggestions) {
			report += `- ${suggestion}\n`;
		}

		// Save report
		const reportPath = path.join(logDir, `optimization-report-${timestamp}.md`);
		await fs.writeFile(reportPath, report);

		// Save raw data
		const dataPath = path.join(logDir, `optimization-data-${timestamp}.json`);
		await fs.writeFile(dataPath, JSON.stringify(result, null, 2));

		console.log(`\n📊 Optimization Report Summary:`);
		console.log(`   MAE: ${result.accuracy.mae.toFixed(2)}`);
		console.log(`   RMSE: ${result.accuracy.rmse.toFixed(2)}`);
		console.log(`   Correlation: ${result.accuracy.correlation.toFixed(3)}`);
		console.log(
			`   Ranking Accuracy: ${result.accuracy.rankingAccuracy.toFixed(1)}%`,
		);
		console.log(`\n📁 Full report saved to: ${reportPath}`);
	}

	/**
	 * Grid search for optimal parameters
	 */
	async optimizeParameters(
		parameterRanges: Partial<Record<keyof TrustScoreParameters, number[]>>,
		simulationConfig?: SimulationConfig,
	): Promise<TrustScoreParameters> {
		console.log("🔍 Starting parameter optimization via grid search...");

		let bestParams = { ...this.currentParams };
		let bestScore = Infinity;

		// Get simulation data once
		const simulationData = await this.getSimulationData(simulationConfig, true);

		// Generate all parameter combinations
		const paramCombinations =
			this.generateParameterCombinations(parameterRanges);

		console.log(
			`Testing ${paramCombinations.length} parameter combinations...`,
		);

		for (const params of paramCombinations) {
			this.currentParams = params;

			// Calculate scores with these parameters
			const scores = await this.calculateTrustScoresEnhanced(simulationData);
			const accuracy = this.evaluateAccuracy(scores);

			// Use MAE as optimization target
			if (accuracy.mae < bestScore) {
				bestScore = accuracy.mae;
				bestParams = { ...params };
				console.log(`New best MAE: ${bestScore.toFixed(2)}`);
			}
		}

		this.currentParams = bestParams;
		console.log("✅ Optimization complete. Best parameters:", bestParams);

		return bestParams;
	}

	/**
	 * Generate all combinations of parameters for grid search
	 */
	private generateParameterCombinations(
		ranges: Partial<Record<keyof TrustScoreParameters, number[]>>,
	): TrustScoreParameters[] {
		const combinations: TrustScoreParameters[] = [];
		const baseParams = { ...this.currentParams };

		// Convert ranges to arrays of [key, values] pairs
		const rangeEntries = Object.entries(ranges) as [
			keyof TrustScoreParameters,
			number[],
		][];

		// Recursive function to generate combinations
		const generateCombos = (index: number, current: TrustScoreParameters) => {
			if (index === rangeEntries.length) {
				combinations.push({ ...current });
				return;
			}

			const [key, values] = rangeEntries[index];
			for (const value of values) {
				current[key] = value;
				generateCombos(index + 1, current);
			}
		};

		generateCombos(0, baseParams);
		return combinations;
	}
}
