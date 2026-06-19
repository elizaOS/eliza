/**
 * Concentrated Liquidity for Prediction Markets
 *
 * @module lib/prediction-concentrated-liquidity
 *
 * @description
 * Implements concentrated liquidity (similar to Uniswap V3) for prediction markets.
 * Allows liquidity providers to specify price ranges where their liquidity is active,
 * enabling more capital-efficient liquidity provision.
 *
 * **Why Concentrated Liquidity for Predictions?**
 *
 * Standard CPMM spreads liquidity across all prices (0-100%), but:
 * - Most prediction markets trade in narrow ranges (e.g., 30-70%)
 * - Capital at extreme prices (1-10% or 90-99%) is rarely used
 * - Concentrated liquidity lets providers focus capital where it matters
 *
 * **How It Works:**
 *
 * 1. Liquidity providers choose a price range [lowerPrice, upperPrice]
 * 2. Their liquidity is only active when market price is in that range
 * 3. When active, their liquidity depth is significantly higher
 * 4. Trade execution aggregates across all active liquidity positions
 *
 * @example
 * ```typescript
 * const pool = new ConcentratedLiquidityPool({
 *   baseYesShares: 5000,
 *   baseNoShares: 5000,
 * });
 *
 * // Add concentrated position
 * pool.addLiquidityPosition({
 *   liquidityAmount: 2000,
 *   lowerPrice: 0.4,
 *   upperPrice: 0.6,
 * });
 *
 * // Execute trade
 * const result = pool.buy('yes', 100);
 * console.log(`Effective liquidity: ${result.effectiveLiquidity}`);
 * ```
 */

import { PredictionPricing } from "@feed/core/markets/prediction/pricing";
import { logger } from "@feed/shared";

/**
 * A concentrated liquidity position
 */
export interface ConcentratedPosition {
  /** Unique position identifier */
  id: string;

  /** Owner of the position (user/agent ID) */
  ownerId: string;

  /** Total liquidity provided */
  liquidityAmount: number;

  /** Lower bound of price range (0-1) */
  lowerPrice: number;

  /** Upper bound of price range (0-1) */
  upperPrice: number;

  /** Accumulated fees earned */
  feesEarned: number;

  /** Time position was created */
  createdAt: Date;

  /** Whether position is active */
  isActive: boolean;
}

/**
 * Parameters for adding a concentrated liquidity position
 */
export interface AddPositionParams {
  /** Position owner ID */
  ownerId: string;

  /** Liquidity amount to provide */
  liquidityAmount: number;

  /** Lower price bound (0-1, default 0.2) */
  lowerPrice?: number;

  /** Upper price bound (0-1, default 0.8) */
  upperPrice?: number;
}

/**
 * Result of removing a liquidity position
 */
export interface RemovePositionResult {
  /** Liquidity returned to owner */
  liquidityReturned: number;

  /** Fees earned during position lifetime */
  feesEarned: number;

  /** Total value returned */
  totalValue: number;
}

/**
 * Trade execution result with concentrated liquidity
 */
export interface ConcentratedTradeResult {
  /** Shares received */
  sharesReceived: number;

  /** Average price per share */
  avgPrice: number;

  /** Price impact percentage */
  priceImpact: number;

  /** New YES share pool */
  newYesShares: number;

  /** New NO share pool */
  newNoShares: number;

  /** Current YES price after trade */
  newYesPrice: number;

  /** Current NO price after trade */
  newNoPrice: number;

  /** Effective liquidity used (may be higher than base due to concentration) */
  effectiveLiquidity: number;

  /** Fee paid */
  fee: number;

  /** Positions that provided liquidity */
  activePositionIds: string[];
}

/**
 * Pool state
 */
export interface PoolState {
  /** Base YES shares (always-on liquidity) */
  baseYesShares: number;

  /** Base NO shares (always-on liquidity) */
  baseNoShares: number;

  /** Total volume through pool */
  totalVolume: number;

  /** Total fees collected */
  totalFees: number;
}

/**
 * Concentrated liquidity pool configuration
 */
export interface PoolConfig {
  /** Initial base YES shares */
  baseYesShares: number;

  /** Initial base NO shares */
  baseNoShares: number;

  /** Fee rate for trades (default: 0.002 = 0.2%) */
  feeRate?: number;

  /** Liquidity concentration multiplier (default: 3x) */
  concentrationMultiplier?: number;
}

/** Default fee rate: 0.2% */
const DEFAULT_FEE_RATE = 0.002;

/** Default concentration multiplier */
const DEFAULT_CONCENTRATION = 3;

/**
 * Concentrated Liquidity Pool for Prediction Markets
 *
 * Implements Uniswap V3-style concentrated liquidity for binary outcomes.
 */
export class ConcentratedLiquidityPool {
  private state: PoolState;
  private positions: Map<string, ConcentratedPosition> = new Map();
  private feeRate: number;
  private concentrationMultiplier: number;
  private positionCounter = 0;

  constructor(config: PoolConfig) {
    this.state = {
      baseYesShares: config.baseYesShares,
      baseNoShares: config.baseNoShares,
      totalVolume: 0,
      totalFees: 0,
    };
    this.feeRate = config.feeRate ?? DEFAULT_FEE_RATE;
    this.concentrationMultiplier =
      config.concentrationMultiplier ?? DEFAULT_CONCENTRATION;
  }

  /**
   * Get current pool state
   */
  getState(): PoolState {
    return { ...this.state };
  }

  /**
   * Get current YES price
   */
  getCurrentYesPrice(): number {
    const effectiveLiquidity = this.getEffectiveLiquidityAtCurrentPrice();
    return PredictionPricing.getCurrentPrice(
      effectiveLiquidity.yesShares,
      effectiveLiquidity.noShares,
      "yes",
    );
  }

  /**
   * Get current NO price
   */
  getCurrentNoPrice(): number {
    return 1 - this.getCurrentYesPrice();
  }

  /**
   * Add a concentrated liquidity position
   */
  addLiquidityPosition(params: AddPositionParams): ConcentratedPosition {
    const {
      ownerId,
      liquidityAmount,
      lowerPrice = 0.2,
      upperPrice = 0.8,
    } = params;

    // Validate price range
    if (lowerPrice < 0 || upperPrice > 1 || lowerPrice >= upperPrice) {
      throw new Error(`Invalid price range: [${lowerPrice}, ${upperPrice}]`);
    }

    if (liquidityAmount <= 0) {
      throw new Error("Liquidity amount must be positive");
    }

    const id = `clp-${++this.positionCounter}`;
    const position: ConcentratedPosition = {
      id,
      ownerId,
      liquidityAmount,
      lowerPrice,
      upperPrice,
      feesEarned: 0,
      createdAt: new Date(),
      isActive: true,
    };

    this.positions.set(id, position);

    logger.debug(
      "Added concentrated liquidity position",
      {
        id,
        ownerId,
        amount: liquidityAmount,
        range: `[${lowerPrice}, ${upperPrice}]`,
      },
      "ConcentratedLiquidityPool",
    );

    return position;
  }

  /**
   * Remove a liquidity position
   */
  removeLiquidityPosition(
    positionId: string,
    ownerId: string,
  ): RemovePositionResult {
    const position = this.positions.get(positionId);

    if (!position) {
      throw new Error(`Position not found: ${positionId}`);
    }

    if (position.ownerId !== ownerId) {
      throw new Error(`Not authorized to remove position: ${positionId}`);
    }

    // Mark as inactive and calculate returns
    position.isActive = false;

    const result: RemovePositionResult = {
      liquidityReturned: position.liquidityAmount,
      feesEarned: position.feesEarned,
      totalValue: position.liquidityAmount + position.feesEarned,
    };

    // Remove from map
    this.positions.delete(positionId);

    logger.debug(
      "Removed concentrated liquidity position",
      {
        id: positionId,
        returned: result.totalValue,
      },
      "ConcentratedLiquidityPool",
    );

    return result;
  }

  /**
   * Execute a buy order with concentrated liquidity
   */
  buy(side: "yes" | "no", usdAmount: number): ConcentratedTradeResult {
    // Get effective liquidity at current price
    const effective = this.getEffectiveLiquidityAtCurrentPrice();

    // Calculate fee
    const fee = usdAmount * this.feeRate;
    const netAmount = usdAmount - fee;

    // Execute trade against effective liquidity
    const calc = PredictionPricing.calculateBuy(
      effective.yesShares,
      effective.noShares,
      side,
      netAmount,
    );

    // Update base pool proportionally
    const liquidityRatio = this.state.baseYesShares / effective.yesShares;

    if (side === "yes") {
      this.state.baseYesShares = calc.newYesShares * liquidityRatio;
      this.state.baseNoShares = calc.newNoShares * liquidityRatio;
    } else {
      this.state.baseYesShares = calc.newYesShares * liquidityRatio;
      this.state.baseNoShares = calc.newNoShares * liquidityRatio;
    }

    // Distribute fees to active positions
    this.distributeFees(fee, effective.activePositionIds);

    // Update volume
    this.state.totalVolume += usdAmount;
    this.state.totalFees += fee;

    return {
      sharesReceived: calc.sharesBought,
      avgPrice: calc.avgPrice,
      priceImpact: calc.priceImpact,
      newYesShares: this.state.baseYesShares,
      newNoShares: this.state.baseNoShares,
      newYesPrice: this.getCurrentYesPrice(),
      newNoPrice: this.getCurrentNoPrice(),
      effectiveLiquidity: effective.yesShares + effective.noShares,
      fee,
      activePositionIds: effective.activePositionIds,
    };
  }

  /**
   * Execute a sell order with concentrated liquidity
   */
  sell(side: "yes" | "no", sharesToSell: number): ConcentratedTradeResult {
    // Get effective liquidity at current price
    const effective = this.getEffectiveLiquidityAtCurrentPrice();

    // Execute trade against effective liquidity
    const calc = PredictionPricing.calculateSell(
      effective.yesShares,
      effective.noShares,
      side,
      sharesToSell,
    );

    // For sell, totalCost contains the proceeds (USD received)
    const proceeds = calc.totalCost;

    // Calculate fee
    const fee = proceeds * this.feeRate;
    const netPayout = proceeds - fee;

    // Update base pool proportionally
    const liquidityRatio = this.state.baseYesShares / effective.yesShares;

    this.state.baseYesShares = calc.newYesShares * liquidityRatio;
    this.state.baseNoShares = calc.newNoShares * liquidityRatio;

    // Distribute fees to active positions
    this.distributeFees(fee, effective.activePositionIds);

    // Update volume
    this.state.totalVolume += proceeds;
    this.state.totalFees += fee;

    return {
      sharesReceived: netPayout, // For sell, this is payout
      avgPrice: calc.avgPrice,
      priceImpact: calc.priceImpact,
      newYesShares: this.state.baseYesShares,
      newNoShares: this.state.baseNoShares,
      newYesPrice: this.getCurrentYesPrice(),
      newNoPrice: this.getCurrentNoPrice(),
      effectiveLiquidity: effective.yesShares + effective.noShares,
      fee,
      activePositionIds: effective.activePositionIds,
    };
  }

  /**
   * Get effective liquidity at current price
   *
   * This aggregates base liquidity plus concentrated positions
   * whose ranges contain the current price.
   */
  private getEffectiveLiquidityAtCurrentPrice(): {
    yesShares: number;
    noShares: number;
    activePositionIds: string[];
  } {
    // Start with base liquidity
    let yesShares = this.state.baseYesShares;
    let noShares = this.state.baseNoShares;
    const activePositionIds: string[] = [];

    // Get current price from base liquidity
    const currentPrice = PredictionPricing.getCurrentPrice(
      yesShares,
      noShares,
      "yes",
    );

    // Add concentrated positions that are in range
    for (const [id, position] of this.positions) {
      if (!position.isActive) continue;

      if (
        currentPrice >= position.lowerPrice &&
        currentPrice <= position.upperPrice
      ) {
        // Position is active! Add concentrated liquidity
        // Concentration factor: liquidity is spread over smaller range
        const rangeWidth = position.upperPrice - position.lowerPrice;
        const concentration = (1 / rangeWidth) * this.concentrationMultiplier;

        // Add liquidity proportionally
        const addedLiquidity = position.liquidityAmount * concentration;
        yesShares += addedLiquidity / 2;
        noShares += addedLiquidity / 2;

        activePositionIds.push(id);
      }
    }

    return { yesShares, noShares, activePositionIds };
  }

  /**
   * Distribute fees to active liquidity providers
   */
  private distributeFees(feeAmount: number, activePositionIds: string[]): void {
    if (activePositionIds.length === 0 || feeAmount === 0) return;

    // Calculate total active liquidity
    let totalActiveLiquidity =
      this.state.baseYesShares + this.state.baseNoShares;

    for (const id of activePositionIds) {
      const pos = this.positions.get(id);
      if (pos) {
        totalActiveLiquidity += pos.liquidityAmount;
      }
    }

    // Distribute fees proportionally
    for (const id of activePositionIds) {
      const pos = this.positions.get(id);
      if (pos) {
        const share = pos.liquidityAmount / totalActiveLiquidity;
        pos.feesEarned += feeAmount * share;
      }
    }

    // Note: remaining fees go to protocol (base liquidity)
  }

  /**
   * Get all positions for an owner
   */
  getPositionsByOwner(ownerId: string): ConcentratedPosition[] {
    const result: ConcentratedPosition[] = [];
    for (const position of this.positions.values()) {
      if (position.ownerId === ownerId) {
        result.push({ ...position });
      }
    }
    return result;
  }

  /**
   * Get position by ID
   */
  getPosition(positionId: string): ConcentratedPosition | undefined {
    return this.positions.get(positionId);
  }

  /**
   * Get total concentrated liquidity
   */
  getTotalConcentratedLiquidity(): number {
    let total = 0;
    for (const position of this.positions.values()) {
      if (position.isActive) {
        total += position.liquidityAmount;
      }
    }
    return total;
  }

  /**
   * Get pool statistics
   */
  getPoolStats(): {
    baseLiquidity: number;
    concentratedLiquidity: number;
    totalLiquidity: number;
    totalVolume: number;
    totalFees: number;
    activePositions: number;
    currentYesPrice: number;
    currentNoPrice: number;
  } {
    const baseLiquidity = this.state.baseYesShares + this.state.baseNoShares;
    const concentratedLiquidity = this.getTotalConcentratedLiquidity();
    const activePositions = Array.from(this.positions.values()).filter(
      (p) => p.isActive,
    ).length;

    return {
      baseLiquidity,
      concentratedLiquidity,
      totalLiquidity: baseLiquidity + concentratedLiquidity,
      totalVolume: this.state.totalVolume,
      totalFees: this.state.totalFees,
      activePositions,
      currentYesPrice: this.getCurrentYesPrice(),
      currentNoPrice: this.getCurrentNoPrice(),
    };
  }
}

/**
 * Create a concentrated liquidity pool from existing market state
 */
export function createPoolFromMarket(market: {
  yesShares: number;
  noShares: number;
}): ConcentratedLiquidityPool {
  return new ConcentratedLiquidityPool({
    baseYesShares: market.yesShares,
    baseNoShares: market.noShares,
  });
}

/**
 * Calculate optimal position range based on expected probability
 *
 * @param expectedProbability - Expected final probability (0-1)
 * @param uncertainty - Uncertainty radius (default 0.15 = ±15%)
 * @returns Recommended position range
 */
export function calculateOptimalRange(
  expectedProbability: number,
  uncertainty = 0.15,
): { lowerPrice: number; upperPrice: number } {
  const lowerPrice = Math.max(0.05, expectedProbability - uncertainty);
  const upperPrice = Math.min(0.95, expectedProbability + uncertainty);

  return { lowerPrice, upperPrice };
}

/**
 * Estimate fee APR for a hypothetical position
 *
 * @param pool - The liquidity pool
 * @param liquidityAmount - Amount of liquidity to provide
 * @param lowerPrice - Lower price bound
 * @param upperPrice - Upper price bound
 * @param dailyVolume - Expected daily volume through pool
 * @returns Estimated annual fee income
 */
export function estimateFeeAPR(
  pool: ConcentratedLiquidityPool,
  liquidityAmount: number,
  lowerPrice: number,
  upperPrice: number,
  dailyVolume: number,
): {
  estimatedDailyFees: number;
  estimatedAnnualFees: number;
  estimatedAPR: number;
  timeInRange: number; // Estimated % of time position is in range
} {
  const poolStats = pool.getPoolStats();
  const currentPrice = poolStats.currentYesPrice;

  // Estimate time in range (simplified: assume price stays near current)
  let timeInRange = 0;
  if (currentPrice >= lowerPrice && currentPrice <= upperPrice) {
    // Position is currently in range
    // Estimate based on range width
    const rangeWidth = upperPrice - lowerPrice;
    timeInRange = Math.min(1, rangeWidth * 2); // Wider range = more time in range
  } else {
    // Currently out of range
    const distanceToRange = Math.min(
      Math.abs(currentPrice - lowerPrice),
      Math.abs(currentPrice - upperPrice),
    );
    timeInRange = Math.max(0, 1 - distanceToRange * 5);
  }

  // Fee share based on liquidity proportion
  const totalLiquidity = poolStats.totalLiquidity + liquidityAmount;
  const liquidityShare = liquidityAmount / totalLiquidity;

  // Pool fee rate (assumed)
  const feeRate = 0.002; // 0.2%

  // Daily fees earned
  const dailyFees = dailyVolume * feeRate * liquidityShare * timeInRange;
  const annualFees = dailyFees * 365;
  const apr = (annualFees / liquidityAmount) * 100;

  return {
    estimatedDailyFees: dailyFees,
    estimatedAnnualFees: annualFees,
    estimatedAPR: apr,
    timeInRange,
  };
}
