/**
 * Perpetual Markets — Constant-Product AMM
 *
 * Each perp market is a virtual x*y=k pool:
 *   baseReserve (synthetic tokens) × quoteReserve (USD) = k (invariant)
 *   spotPrice = quoteReserve / baseReserve
 *
 * Trades shift reserves along the constant-product curve.
 * Larger trades get worse prices (natural slippage).
 * Locked base liquidity prevents price from reaching zero.
 * Runtime callers may still apply conservative safety limits on top.
 */

/**
 * Resolution Confidence Configuration
 */
export const RESOLUTION_CONFIDENCE_CONFIG = {
  MANUAL_REVIEW_THRESHOLD: 0.7,
  BASE_CONFIDENCE: 0.95,
  MIN_CONFIDENCE: 0.2,
} as const;

/**
 * AMM Configuration
 */
export const PERP_MARKET_CONFIG = {
  /**
   * Initial base reserve for each market's virtual AMM pool.
   * Higher = deeper liquidity = less price impact per trade.
   *
   * With INITIAL_BASE_RESERVE=5000 and initialPrice=$450:
   *   k = 5000 × $2,250,000 = 11.25B
   *   $10K buy → ~2% impact
   *   $50K buy → ~10% impact
   */
  INITIAL_BASE_RESERVE: 5000,
  SYNTHETIC_SUPPLY: 10_000,
  LIQUIDITY_FACTOR: 50,
  MAX_CHANGE_PER_TRADE: 0.3,
  PRICE_FLOOR_RATIO: 0.05,
  /**
   * Maximum price as a multiple of initialPrice. Reduced from 10.0 to 4.0 to
   * align with the volatility simulation ceiling (SIMULATED_PRICE_CEILING_RATIO
   * = 4.0 in game-tick.ts). Prices above 4× initialPrice are unreachable via
   * the volatility simulation anyway, so this prevents the position-imbalance
   * AMM from creating a wider band than the sim can generate.
   */
  PRICE_CEILING_RATIO: 4.0,
} as const;

/**
 * Legacy bonding-curve config kept for backwards-compatible tests and tools.
 */
export const BONDING_CURVE_CONFIG = {
  EXPONENT: 2,
  RESERVE_DEPTH: 100_000,
  USE_BONDING_CURVE: true,
} as const;

export type PerpMarketConfig = {
  [K in keyof typeof PERP_MARKET_CONFIG]: (typeof PERP_MARKET_CONFIG)[K] extends number
    ? number
    : (typeof PERP_MARKET_CONFIG)[K];
};

export type BondingCurveConfig = {
  [K in keyof typeof BONDING_CURVE_CONFIG]: (typeof BONDING_CURVE_CONFIG)[K] extends number
    ? number
    : (typeof BONDING_CURVE_CONFIG)[K];
};

// =============================================================================
// AMM Functions
// =============================================================================

/**
 * Get the initial AMM reserves for a market.
 */
export function getInitialReserves(
  initialPrice: number,
  config: PerpMarketConfig = PERP_MARKET_CONFIG
): { baseReserve: number; quoteReserve: number; k: number } {
  const baseReserve = config.INITIAL_BASE_RESERVE;
  const quoteReserve = baseReserve * initialPrice;
  return { baseReserve, quoteReserve, k: baseReserve * quoteReserve };
}

/**
 * Legacy effective-supply helper kept for older tests.
 */
export function getEffectiveSupply(
  config: PerpMarketConfig = PERP_MARKET_CONFIG
): number {
  return config.SYNTHETIC_SUPPLY / config.LIQUIDITY_FACTOR;
}

/**
 * Legacy bonding-curve helper kept for older tests.
 */
export function calculateBondingCurvePrice(
  basePrice: number,
  netHoldings: number,
  bondingConfig: BondingCurveConfig = BONDING_CURVE_CONFIG
): number {
  const { EXPONENT, RESERVE_DEPTH } = bondingConfig;
  const ratio = netHoldings / RESERVE_DEPTH;
  const base = 1 + ratio;

  let multiplier: number;
  if (base >= 0) {
    multiplier = Math.pow(base, EXPONENT);
  } else {
    multiplier = 1 / (1 + Math.abs(base) * EXPONENT);
  }

  return basePrice * Math.max(0.01, multiplier);
}

/**
 * Derive current reserves from initial price and cumulative net holdings.
 *
 * netHoldings = Σ(long positions) − Σ(short positions) in USD.
 * Positive = net buying pressure (quote added to pool).
 * Negative = net selling pressure (quote removed from pool).
 */
export function getReservesFromHoldings(
  initialPrice: number,
  netHoldings: number,
  config: PerpMarketConfig = PERP_MARKET_CONFIG
): { baseReserve: number; quoteReserve: number; spotPrice: number } {
  const { quoteReserve: initQuote, k } = getInitialReserves(
    initialPrice,
    config
  );
  const currentQuote = Math.max(initQuote + netHoldings, 1);
  const currentBase = k / currentQuote;
  return {
    baseReserve: currentBase,
    quoteReserve: currentQuote,
    spotPrice: currentQuote / currentBase,
  };
}

/**
 * Spot price from net holdings.
 * Primary price function — called after every trade to recompute equilibrium.
 */
export function calculatePriceFromHoldings(
  initialPrice: number,
  currentPrice: number,
  netHoldings: number,
  config: PerpMarketConfig = PERP_MARKET_CONFIG,
  _bondingConfig: BondingCurveConfig = BONDING_CURVE_CONFIG
): number {
  const rawPrice = getReservesFromHoldings(
    initialPrice,
    netHoldings,
    config
  ).spotPrice;

  const maxChange = currentPrice * config.MAX_CHANGE_PER_TRADE;
  const minFromChange = currentPrice - maxChange;
  const maxFromChange = currentPrice + maxChange;
  const absoluteMin = initialPrice * config.PRICE_FLOOR_RATIO;
  const absoluteMax = initialPrice * config.PRICE_CEILING_RATIO;
  const minPrice = Math.max(absoluteMin, minFromChange);
  const maxPrice = Math.min(absoluteMax, maxFromChange);

  return Math.min(maxPrice, Math.max(minPrice, rawPrice));
}

/**
 * Same as calculatePriceFromHoldings (no separate "raw" version needed).
 */
export function calculateRawPriceFromHoldings(
  initialPrice: number,
  netHoldings: number,
  config: PerpMarketConfig = PERP_MARKET_CONFIG
): number {
  return getReservesFromHoldings(initialPrice, netHoldings, config).spotPrice;
}

/**
 * Exact swap output and price impact using Uniswap v2 math.
 *
 * Buy (add quote, get base):  baseOut = B × dx / (Q + dx)
 * Sell (add base, get quote): quoteOut = Q × dy / (B + dy)
 *
 * avgFillPrice = input / output  (always worse than spot = slippage)
 */
export function calculateTradeImpact(
  initialPrice: number,
  netHoldingsBefore: number,
  tradeSize: number,
  config: PerpMarketConfig = PERP_MARKET_CONFIG
): {
  avgFillPrice: number;
  newSpotPrice: number;
  slippage: number;
  baseAmount: number;
} {
  const {
    baseReserve,
    quoteReserve,
    spotPrice: spotBefore,
  } = getReservesFromHoldings(initialPrice, netHoldingsBefore, config);
  const k = baseReserve * quoteReserve;

  if (tradeSize >= 0) {
    // BUY: trader adds quote (USD) to pool, receives base tokens
    const newQuote = quoteReserve + tradeSize;
    const newBase = k / newQuote;
    const baseOut = baseReserve - newBase;
    const avgFillPrice = baseOut > 0 ? tradeSize / baseOut : spotBefore;
    const newSpotPrice = newQuote / newBase;
    const slippage =
      spotBefore > 0 ? Math.abs(avgFillPrice - spotBefore) / spotBefore : 0;
    return { avgFillPrice, newSpotPrice, slippage, baseAmount: baseOut };
  }

  // SELL: trader adds base tokens to pool, receives quote (USD)
  const absTradeSize = Math.abs(tradeSize);
  const baseIn = spotBefore > 0 ? absTradeSize / spotBefore : 0;
  const newBase = baseReserve + baseIn;
  const newQuote = k / newBase;
  const quoteOut = quoteReserve - newQuote;
  const avgFillPrice = baseIn > 0 ? quoteOut / baseIn : spotBefore;
  const newSpotPrice = newQuote / newBase;
  const slippage =
    spotBefore > 0 ? Math.abs(spotBefore - avgFillPrice) / spotBefore : 0;
  return { avgFillPrice, newSpotPrice, slippage, baseAmount: -baseIn };
}
