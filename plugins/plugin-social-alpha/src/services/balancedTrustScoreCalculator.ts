import type { TrustScoreResult } from "./trustScoreOptimizer";

export interface BalancedTrustScoreParams {
	// Base weights
	profitWeight: number;
	winRateWeight: number;
	sharpeWeight: number;
	alphaWeight: number;
	consistencyWeight: number;
	qualityWeight: number;

	// Volume thresholds - more nuanced
	normalVolumeThreshold: number; // Below this = normal
	highVolumeThreshold: number; // Above this = potential spam
	extremeVolumeThreshold: number; // Definite spam

	// Archetype-specific volume multipliers
	volumeToleranceByArchetype: Record<string, number>;
}

export class BalancedTrustScoreCalculator {
	private params: BalancedTrustScoreParams = {
		profitWeight: 0.25,
		winRateWeight: 0.25,
		sharpeWeight: 0.15,
		alphaWeight: 0.1,
		consistencyWeight: 0.1,
		qualityWeight: 0.15,
		normalVolumeThreshold: 100,
		highVolumeThreshold: 300,
		extremeVolumeThreshold: 500,
		volumeToleranceByArchetype: {
			elite_analyst: 2.0, // Can make 2x more calls
			skilled_trader: 1.5,
			technical_analyst: 1.3,
			contrarian: 1.0,
			newbie: 0.8,
			fomo_trader: 0.6,
			pump_chaser: 0.5,
			bot_spammer: 0.3, // Much lower tolerance
			rug_promoter: 0.3,
		},
	};

	/**
	 * Calculate balanced trust score
	 */
	calculateBalancedTrustScore(
		metrics: TrustScoreResult["metrics"],
		archetype: string,
		rugPromotions: number,
		goodCalls: number,
		totalCalls: number,
	): number {
		// 1. Base score from archetype (30% weight)
		const archetypeBase = this.getArchetypeBase(archetype);

		// 2. Performance components
		const components = {
			profit:
				this.calculateProfitComponent(metrics.averageProfit) *
				this.params.profitWeight,
			winRate:
				this.calculateWinRateComponent(metrics.winRate) *
				this.params.winRateWeight,
			sharpe:
				this.calculateSharpeComponent(metrics.sharpeRatio) *
				this.params.sharpeWeight,
			alpha:
				this.calculateAlphaComponent(metrics.alpha) * this.params.alphaWeight,
			consistency: metrics.consistency * 100 * this.params.consistencyWeight,
			quality:
				this.calculateQualityComponent(rugPromotions, goodCalls, totalCalls) *
				this.params.qualityWeight,
		};

		// 3. Sum performance score
		const performanceScore = Object.values(components).reduce(
			(sum, val) => sum + val,
			0,
		);

		// 4. Apply archetype scaling
		const scalingFactor = this.getArchetypeScaling(archetype);
		const scaledPerformance = performanceScore * scalingFactor;

		// 5. Volume adjustment (not penalty)
		const volumeAdjustment = this.calculateVolumeAdjustment(
			totalCalls,
			archetype,
		);

		// 6. Combine components
		let finalScore = archetypeBase * 0.4 + scaledPerformance * 0.6;
		finalScore *= volumeAdjustment; // Multiplicative adjustment instead of subtractive penalty

		// 7. Data sufficiency adjustment
		if (totalCalls < 5) {
			finalScore *= 0.8; // 20% reduction for insufficient data
		} else if (totalCalls < 10) {
			finalScore *= 0.9; // 10% reduction
		}

		// 8. Bounds check
		return Math.min(100, Math.max(0, finalScore));
	}

	/**
	 * Archetype base scores with good spread
	 */
	private getArchetypeBase(archetype: string): number {
		const bases: Record<string, number> = {
			elite_analyst: 85,
			skilled_trader: 65,
			technical_analyst: 55,
			contrarian: 50,
			newbie: 35,
			fomo_trader: 25,
			pump_chaser: 20,
			bot_spammer: 10,
			rug_promoter: 5,
		};
		return bases[archetype] || 30;
	}

	/**
	 * Profit component with better scaling
	 */
	private calculateProfitComponent(avgProfit: number): number {
		if (avgProfit > 50) {
			return 90 + Math.min(10, (avgProfit - 50) * 0.1);
		} else if (avgProfit > 20) {
			return 70 + (avgProfit - 20) * 0.67;
		} else if (avgProfit > 0) {
			return 50 + avgProfit;
		} else if (avgProfit > -30) {
			return 30 + (avgProfit / 30) * 20;
		} else {
			return Math.max(0, 30 + avgProfit * 0.3);
		}
	}

	/**
	 * Win rate component with smooth curve
	 */
	private calculateWinRateComponent(winRate: number): number {
		// Sigmoid-like curve
		if (winRate >= 0.8) {
			return 85 + (winRate - 0.8) * 75;
		} else if (winRate >= 0.6) {
			return 70 + (winRate - 0.6) * 75;
		} else if (winRate >= 0.5) {
			return 50 + (winRate - 0.5) * 200;
		} else if (winRate >= 0.3) {
			return 20 + (winRate - 0.3) * 150;
		} else {
			return winRate * 66.67;
		}
	}

	/**
	 * Sharpe ratio component
	 */
	private calculateSharpeComponent(sharpe: number): number {
		if (sharpe > 1.5) {
			return 90 + Math.min(10, (sharpe - 1.5) * 10);
		} else if (sharpe > 0.5) {
			return 60 + (sharpe - 0.5) * 30;
		} else if (sharpe > 0) {
			return 50 + sharpe * 20;
		} else if (sharpe > -1) {
			return 30 + sharpe * 20;
		} else {
			return Math.max(0, 30 + sharpe * 10);
		}
	}

	/**
	 * Alpha component - fixed to handle negative values better
	 */
	private calculateAlphaComponent(alpha: number): number {
		// Note: Alpha can be negative if underperforming market
		// We'll normalize around 0 being neutral (50 score)
		if (alpha > 20) {
			return 80 + Math.min(20, (alpha - 20) * 0.5);
		} else if (alpha > 0) {
			return 50 + alpha * 1.5;
		} else if (alpha > -20) {
			return 50 + alpha * 1.5; // Same slope for fairness
		} else {
			return Math.max(0, 50 + alpha * 0.5);
		}
	}

	/**
	 * Quality component based on call quality
	 */
	private calculateQualityComponent(
		rugPromotions: number,
		goodCalls: number,
		totalCalls: number,
	): number {
		if (totalCalls === 0) return 50;

		// Good call ratio
		const goodRatio = goodCalls / totalCalls;
		// Rug promotion ratio
		const rugRatio = rugPromotions / totalCalls;

		// Base quality from good calls
		let quality = goodRatio * 100;

		// Heavy penalty for rug promotions
		quality -= rugRatio * 200; // Double penalty

		// Bonus for high good call ratio
		if (goodRatio > 0.5) {
			quality += 20;
		}

		return Math.max(0, Math.min(100, quality));
	}

	/**
	 * Volume adjustment - multiplicative factor instead of penalty
	 */
	private calculateVolumeAdjustment(
		totalCalls: number,
		archetype: string,
	): number {
		const tolerance = this.params.volumeToleranceByArchetype[archetype] || 1.0;
		const adjustedThresholds = {
			normal: this.params.normalVolumeThreshold * tolerance,
			high: this.params.highVolumeThreshold * tolerance,
			extreme: this.params.extremeVolumeThreshold * tolerance,
		};

		if (totalCalls <= adjustedThresholds.normal) {
			return 1.0; // No adjustment
		} else if (totalCalls <= adjustedThresholds.high) {
			// Gradual reduction from 1.0 to 0.8
			const ratio =
				(totalCalls - adjustedThresholds.normal) /
				(adjustedThresholds.high - adjustedThresholds.normal);
			return 1.0 - ratio * 0.2;
		} else if (totalCalls <= adjustedThresholds.extreme) {
			// Steeper reduction from 0.8 to 0.5
			const ratio =
				(totalCalls - adjustedThresholds.high) /
				(adjustedThresholds.extreme - adjustedThresholds.high);
			return 0.8 - ratio * 0.3;
		} else {
			// Extreme volume
			return 0.5; // 50% reduction max
		}
	}

	/**
	 * Archetype performance scaling
	 */
	private getArchetypeScaling(archetype: string): number {
		const scaling: Record<string, number> = {
			elite_analyst: 1.15, // Slight boost
			skilled_trader: 1.1,
			technical_analyst: 1.05,
			contrarian: 1.0,
			newbie: 0.95,
			fomo_trader: 0.85,
			pump_chaser: 0.75,
			bot_spammer: 0.6,
			rug_promoter: 0.5,
		};
		return scaling[archetype] || 0.9;
	}

	/**
	 * Set custom parameters
	 */
	setParameters(params: Partial<BalancedTrustScoreParams>): void {
		this.params = { ...this.params, ...params };
	}

	/**
	 * Get current parameters
	 */
	getParameters(): BalancedTrustScoreParams {
		return { ...this.params };
	}
}
