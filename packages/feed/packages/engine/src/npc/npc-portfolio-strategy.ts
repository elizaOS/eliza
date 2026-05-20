/**
 * NPC Portfolio Strategy
 *
 * Defines sophisticated portfolio allocation strategies for NPCs based on:
 * - Personality traits (aggressive, conservative, balanced)
 * - Market conditions (volatility, sentiment, trends)
 * - Risk tolerance and investment horizons
 * - Modern Portfolio Theory principles
 */

import { logger } from '@babylon/shared';

interface MarketConditions {
  volatility: number; // 0-1, market volatility index
  sentiment: number; // -1 to 1, overall market sentiment
  trending: boolean; // Is market trending or ranging
  volume: number; // Relative volume index (0-1)
}

interface AssetAllocation {
  perps: number; // Percentage in perpetuals (0-100)
  predictions: number; // Percentage in predictions (0-100)
  cash: number; // Percentage in cash reserve (0-100)
}

interface PositionSizing {
  maxPositionSize: number; // Max % of portfolio per position
  minPositionSize: number; // Min % of portfolio per position
  maxConcentration: number; // Max % in single asset
  targetPositionCount: number; // Ideal number of positions
}

interface RiskParameters {
  maxDrawdown: number; // Max acceptable portfolio drawdown %
  maxLeverage: number; // Max leverage allowed
  stopLoss: number; // Stop loss % per position
  correlationLimit: number; // Max correlation between positions (0-1)
}

export interface StrategyConfig {
  name: string;
  description: string;
  assetAllocation: AssetAllocation;
  positionSizing: PositionSizing;
  riskParameters: RiskParameters;
  rebalanceThreshold: number; // % deviation before rebalance
  holdingPeriod: 'short' | 'medium' | 'long';
}

export class NPCPortfolioStrategy {
  /**
   * Get strategy configuration based on personality and conditions
   */
  static getStrategy(
    personality: string | null,
    marketConditions?: MarketConditions
  ): StrategyConfig {
    const personalityLower = (personality || '').toLowerCase();

    // Select base strategy from personality
    let baseStrategy: StrategyConfig;

    if (
      personalityLower.includes('erratic') ||
      personalityLower.includes('disaster profiteer')
    ) {
      baseStrategy = NPCPortfolioStrategy.getAggressiveStrategy();
    } else if (
      personalityLower.includes('vampire') ||
      personalityLower.includes('yacht')
    ) {
      baseStrategy = NPCPortfolioStrategy.getConservativeStrategy();
    } else if (
      personalityLower.includes('memecoin') ||
      personalityLower.includes('nft degen')
    ) {
      baseStrategy = NPCPortfolioStrategy.getHighVolatilityStrategy();
    } else {
      baseStrategy = NPCPortfolioStrategy.getBalancedStrategy();
    }

    // Adjust strategy based on market conditions
    if (marketConditions) {
      return NPCPortfolioStrategy.adjustForMarketConditions(
        baseStrategy,
        marketConditions
      );
    }

    return baseStrategy;
  }

  /**
   * Aggressive growth strategy
   * - High perp allocation with leverage
   * - Fewer positions, higher concentration
   * - Higher risk tolerance
   */
  private static getAggressiveStrategy(): StrategyConfig {
    return {
      name: 'Aggressive Growth',
      description:
        'High-risk, high-reward strategy with leverage and concentrated positions',
      assetAllocation: {
        perps: 70,
        predictions: 25,
        cash: 5,
      },
      positionSizing: {
        maxPositionSize: 25, // Up to 25% per position
        minPositionSize: 5,
        maxConcentration: 40, // Max 40% in single asset
        targetPositionCount: 6,
      },
      riskParameters: {
        maxDrawdown: 30, // Tolerate 30% drawdown
        maxLeverage: 10, // Up to 10x leverage
        stopLoss: 25, // 25% stop loss per position
        correlationLimit: 0.8, // Allow high correlation
      },
      rebalanceThreshold: 15, // Rebalance when >15% deviation
      holdingPeriod: 'short',
    };
  }

  /**
   * Conservative wealth preservation strategy
   * - Higher prediction allocation (less volatile)
   * - Many small positions for diversification
   * - Lower risk tolerance
   */
  private static getConservativeStrategy(): StrategyConfig {
    return {
      name: 'Conservative Wealth Preservation',
      description:
        'Low-risk strategy focused on capital preservation and steady returns',
      assetAllocation: {
        perps: 30,
        predictions: 50,
        cash: 20,
      },
      positionSizing: {
        maxPositionSize: 10, // Max 10% per position
        minPositionSize: 2,
        maxConcentration: 15, // Max 15% in single asset
        targetPositionCount: 15,
      },
      riskParameters: {
        maxDrawdown: 10, // Only tolerate 10% drawdown
        maxLeverage: 2, // Max 2x leverage
        stopLoss: 10, // Tight 10% stop loss
        correlationLimit: 0.4, // Require diversification
      },
      rebalanceThreshold: 5, // Rebalance when >5% deviation
      holdingPeriod: 'long',
    };
  }

  /**
   * Balanced growth and income strategy
   * - Equal perp and prediction allocation
   * - Moderate position sizing
   * - Balanced risk tolerance
   */
  private static getBalancedStrategy(): StrategyConfig {
    return {
      name: 'Balanced Growth',
      description: 'Moderate risk/reward with diversified allocation',
      assetAllocation: {
        perps: 50,
        predictions: 40,
        cash: 10,
      },
      positionSizing: {
        maxPositionSize: 15, // Max 15% per position
        minPositionSize: 3,
        maxConcentration: 25, // Max 25% in single asset
        targetPositionCount: 10,
      },
      riskParameters: {
        maxDrawdown: 20, // Tolerate 20% drawdown
        maxLeverage: 5, // Up to 5x leverage
        stopLoss: 15, // 15% stop loss per position
        correlationLimit: 0.6, // Moderate correlation allowed
      },
      rebalanceThreshold: 10, // Rebalance when >10% deviation
      holdingPeriod: 'medium',
    };
  }

  /**
   * High volatility / meme strategy
   * - Extreme concentration and leverage
   * - Very short holding periods
   * - High turnover
   */
  private static getHighVolatilityStrategy(): StrategyConfig {
    return {
      name: 'High Volatility Trading',
      description:
        'Extreme risk strategy for volatile assets with quick entries/exits',
      assetAllocation: {
        perps: 80,
        predictions: 15,
        cash: 5,
      },
      positionSizing: {
        maxPositionSize: 35, // Up to 35% per position
        minPositionSize: 8,
        maxConcentration: 50, // Max 50% in single asset
        targetPositionCount: 4, // Few concentrated bets
      },
      riskParameters: {
        maxDrawdown: 40, // Tolerate 40% drawdown
        maxLeverage: 15, // Up to 15x leverage
        stopLoss: 30, // Wide 30% stop loss
        correlationLimit: 0.9, // Correlation doesn't matter
      },
      rebalanceThreshold: 20, // Rebalance when >20% deviation
      holdingPeriod: 'short',
    };
  }

  /**
   * Adjust strategy based on current market conditions
   */
  private static adjustForMarketConditions(
    baseStrategy: StrategyConfig,
    conditions: MarketConditions
  ): StrategyConfig {
    const adjusted = { ...baseStrategy };

    // High volatility → Reduce leverage and increase cash
    if (conditions.volatility > 0.7) {
      adjusted.riskParameters = {
        ...adjusted.riskParameters,
        maxLeverage: Math.max(1, adjusted.riskParameters.maxLeverage * 0.7),
      };
      adjusted.assetAllocation = {
        ...adjusted.assetAllocation,
        cash: Math.min(30, adjusted.assetAllocation.cash * 1.5),
        perps: adjusted.assetAllocation.perps * 0.9,
      };

      logger.debug(
        'Adjusted strategy for high volatility: reduced leverage and increased cash',
        { volatility: conditions.volatility },
        'NPCPortfolioStrategy'
      );
    }

    // Negative sentiment → More defensive
    if (conditions.sentiment < -0.5) {
      adjusted.assetAllocation = {
        ...adjusted.assetAllocation,
        predictions: Math.min(60, adjusted.assetAllocation.predictions * 1.2),
        perps: adjusted.assetAllocation.perps * 0.8,
      };

      logger.debug(
        'Adjusted strategy for negative sentiment: shifted to predictions',
        { sentiment: conditions.sentiment },
        'NPCPortfolioStrategy'
      );
    }

    // Low volume → Reduce position sizes
    if (conditions.volume < 0.3) {
      adjusted.positionSizing = {
        ...adjusted.positionSizing,
        maxPositionSize: adjusted.positionSizing.maxPositionSize * 0.8,
        targetPositionCount: Math.floor(
          adjusted.positionSizing.targetPositionCount * 1.2
        ),
      };

      logger.debug(
        'Adjusted strategy for low volume: smaller positions, more diversification',
        { volume: conditions.volume },
        'NPCPortfolioStrategy'
      );
    }

    return adjusted;
  }

  /**
   * Calculate optimal position size using Kelly Criterion
   *
   * Kelly Criterion: f* = (bp - q) / b
   * Where:
   * - f* = optimal fraction of capital to bet
   * - b = odds received (payout ratio)
   * - p = probability of winning
   * - q = probability of losing (1-p)
   */
  static calculateOptimalPositionSize(
    winProbability: number,
    payoutRatio: number,
    strategy: StrategyConfig
  ): number {
    // Kelly Criterion
    const p = Math.max(0.01, Math.min(0.99, winProbability)); // Clamp to (0.01, 0.99)
    const q = 1 - p;
    const b = payoutRatio;

    const kellyFraction = (b * p - q) / b;

    // Apply fractional Kelly for risk management (typically use 25-50% of Kelly)
    const fractionalKelly = kellyFraction * 0.5;

    // Clamp to strategy limits
    const minSize = strategy.positionSizing.minPositionSize / 100;
    const maxSize = strategy.positionSizing.maxPositionSize / 100;

    const optimalSize = Math.max(minSize, Math.min(maxSize, fractionalKelly));

    return optimalSize * 100; // Return as percentage
  }

  /**
   * Determine if rebalancing is needed
   */
  static shouldRebalance(
    currentAllocation: AssetAllocation,
    targetAllocation: AssetAllocation,
    threshold: number
  ): boolean {
    const perpDeviation = Math.abs(
      currentAllocation.perps - targetAllocation.perps
    );
    const predDeviation = Math.abs(
      currentAllocation.predictions - targetAllocation.predictions
    );
    const cashDeviation = Math.abs(
      currentAllocation.cash - targetAllocation.cash
    );

    const maxDeviation = Math.max(perpDeviation, predDeviation, cashDeviation);

    return maxDeviation > threshold;
  }

  /**
   * Generate rebalancing actions to reach target allocation
   */
  static generateRebalancePlan(
    currentAllocation: AssetAllocation,
    targetAllocation: AssetAllocation,
    totalPortfolioValue: number
  ): {
    perpAdjustment: number;
    predictionAdjustment: number;
    cashAdjustment: number;
  } {
    const perpDiff = targetAllocation.perps - currentAllocation.perps;
    const predDiff =
      targetAllocation.predictions - currentAllocation.predictions;
    const cashDiff = targetAllocation.cash - currentAllocation.cash;

    return {
      perpAdjustment: (perpDiff / 100) * totalPortfolioValue,
      predictionAdjustment: (predDiff / 100) * totalPortfolioValue,
      cashAdjustment: (cashDiff / 100) * totalPortfolioValue,
    };
  }

  /**
   * Get recommended holding period in hours
   */
  static getHoldingPeriodHours(period: 'short' | 'medium' | 'long'): number {
    const periods = {
      short: 24, // 1 day
      medium: 168, // 1 week
      long: 720, // 30 days
    };

    return periods[period];
  }

  /**
   * Evaluate strategy performance metrics
   */
  static evaluateStrategy(
    actualReturns: number[],
    benchmarkReturns: number[],
    riskFreeRate = 0.02 // 2% annual
  ): {
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    alpha: number;
    beta: number;
  } {
    // Calculate Sharpe Ratio
    const avgReturn =
      actualReturns.reduce((a, b) => a + b, 0) / actualReturns.length;
    const variance =
      actualReturns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) /
      actualReturns.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgReturn - riskFreeRate) / stdDev : 0;

    // Calculate Maximum Drawdown
    let peak = actualReturns[0] || 0;
    let maxDrawdown = 0;
    for (const value of actualReturns) {
      if (value > peak) peak = value;
      const drawdown = ((peak - value) / peak) * 100;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    // Calculate Win Rate
    const wins = actualReturns.filter((r) => r > 0).length;
    const winRate =
      actualReturns.length > 0 ? (wins / actualReturns.length) * 100 : 0;

    // Calculate Alpha and Beta (vs benchmark)
    const benchmarkAvg =
      benchmarkReturns.reduce((a, b) => a + b, 0) / benchmarkReturns.length;
    const covariance =
      actualReturns.reduce((sum, r, i) => {
        return (
          sum + (r - avgReturn) * ((benchmarkReturns[i] || 0) - benchmarkAvg)
        );
      }, 0) / actualReturns.length;
    const benchmarkVariance =
      benchmarkReturns.reduce((sum, r) => {
        return sum + (r - benchmarkAvg) ** 2;
      }, 0) / benchmarkReturns.length;

    const beta = benchmarkVariance > 0 ? covariance / benchmarkVariance : 1;
    const alpha =
      avgReturn - (riskFreeRate + beta * (benchmarkAvg - riskFreeRate));

    return {
      sharpeRatio,
      maxDrawdown,
      winRate,
      alpha,
      beta,
    };
  }
}
