import { BalancedTrustScoreCalculator } from "./balancedTrustScoreCalculator";
import { SimulationService } from "./SimulationService";
import {
	TrustScoreOptimizer,
	type TrustScoreResult,
} from "./trustScoreOptimizer";

export { BalancedTrustScoreParams } from "./balancedTrustScoreCalculator";
// Re-export types
export {
	OptimizationResult,
	TrustScoreParameters,
	TrustScoreResult,
} from "./trustScoreOptimizer";

/**
 * Consolidated Trust Score Service
 */
export class TrustScoreService {
	private calculator: BalancedTrustScoreCalculator;
	private optimizer: TrustScoreOptimizer;
	private simulationService: SimulationService;
	private simulationService: SimulationService;

	constructor() {
		this.calculator = new BalancedTrustScoreCalculator();
		this.optimizer = new TrustScoreOptimizer();
		this.simulationService = new SimulationService();
	}

	// ========== Calculator Methods ==========

	calculateBalancedTrustScore(
		metrics: TrustScoreResult["metrics"],
		archetype: string,
		rugPromotions: number,
		goodCalls: number,
		totalCalls: number,
	): number {
		return this.calculator.calculateBalancedTrustScore(
			metrics,
			archetype,
			rugPromotions,
			goodCalls,
			totalCalls,
		);
	}

	setCalculatorParameters(params: Partial<any>): void {
		this.calculator.setParameters(params);
	}

	getCalculatorParameters(): any {
		return this.calculator.getParameters();
	}

	// ========== Optimizer Methods ==========

	async runOptimizationCycle(
		simulationConfig?: any,
		useCache?: boolean,
	): Promise<any> {
		return this.optimizer.runOptimizationCycle(simulationConfig, useCache);
	}

	async optimizeParameters(
		parameterRanges: any,
		simulationConfig?: any,
	): Promise<any> {
		return this.optimizer.optimizeParameters(parameterRanges, simulationConfig);
	}

	// ========== Convenience Methods ==========

	/**
	 * Calculate trust score for a user based on their trading history
	 */
	calculateUserTrustScore(
		userCalls: any[],
		archetype?: string,
	): {
		score: number;
		metrics: TrustScoreResult["metrics"];
		breakdown: {
			profitComponent: number;
			winRateComponent: number;
			sharpeComponent: number;
			alphaComponent: number;
			consistencyComponent: number;
			qualityComponent: number;
		};
	} {
		// Calculate metrics from calls
		const profits = userCalls.map((call) => call.profit || 0);
		const profitableCalls = profits.filter((p) => p > 0).length;
		const totalCalls = userCalls.length;
		const averageProfit = profits.reduce((sum, p) => sum + p, 0) / totalCalls;
		const winRate = profitableCalls / totalCalls;

		// Calculate Sharpe ratio
		const mean = averageProfit;
		const variance =
			profits.reduce((sum, p) => sum + (p - mean) ** 2, 0) / profits.length;
		const stdDev = Math.sqrt(variance);
		const sharpeRatio = stdDev > 0 ? mean / stdDev : 0;

		// Calculate consistency
		const consistency = stdDev > 0 ? Math.max(0, 1 - stdDev / 100) : 1;

		// Count rug promotions and good calls
		let rugPromotions = 0;
		let goodCalls = 0;

		userCalls.forEach((call) => {
			if (call.isRugPromotion) rugPromotions++;
			if (call.isGoodCall) goodCalls++;
		});

		const metrics: TrustScoreResult["metrics"] = {
			totalCalls,
			profitableCalls,
			averageProfit,
			winRate,
			sharpeRatio,
			alpha: averageProfit, // Simplified
			volumePenalty: 0,
			consistency,
		};

		const score = this.calculateBalancedTrustScore(
			metrics,
			archetype || "unknown",
			rugPromotions,
			goodCalls,
			totalCalls,
		);

		// Get component breakdown
		const params = this.calculator.getParameters();
		const breakdown = {
			profitComponent: (averageProfit / 100) * params.profitWeight * 100,
			winRateComponent: winRate * params.winRateWeight * 100,
			sharpeComponent: (sharpeRatio / 2) * params.sharpeWeight * 100,
			alphaComponent: (averageProfit / 100) * params.alphaWeight * 100,
			consistencyComponent: consistency * params.consistencyWeight * 100,
			qualityComponent:
				((goodCalls - rugPromotions) / totalCalls) * params.qualityWeight * 100,
		};

		return { score, metrics, breakdown };
	}

	/**
	 * Run a complete optimization test
	 */
	async runOptimizationTest(): Promise<void> {
		console.log("🚀 Running Trust Score Optimization Test\n");

		// Run optimization
		const result = await this.runOptimizationCycle();

		console.log("\n📊 Optimization Results:");
		console.log(`   MAE: ${result.accuracy.mae.toFixed(2)}`);
		console.log(`   RMSE: ${result.accuracy.rmse.toFixed(2)}`);
		console.log(`   Correlation: ${result.accuracy.correlation.toFixed(3)}`);
		console.log(
			`   Ranking Accuracy: ${result.accuracy.rankingAccuracy.toFixed(1)}%`,
		);

		console.log("\n💡 Suggestions:");
		result.suggestions.forEach((suggestion: string) => {
			console.log(`   - ${suggestion}`);
		});

		// Run parameter optimization
		console.log("\n🔍 Optimizing parameters...");
		const optimizedParams = await this.optimizeParameters({
			profitWeight: [0.2, 0.25, 0.3],
			winRateWeight: [0.2, 0.25, 0.3],
			sharpeWeight: [0.1, 0.15, 0.2],
			alphaWeight: [0.05, 0.1, 0.15],
			consistencyWeight: [0.05, 0.1, 0.15],
			qualityWeight: [0.1, 0.15, 0.2],
		});

		console.log("\n✅ Optimized Parameters:", optimizedParams);
	}
}
