/**
 * Perpetual Markets Configuration
 *
 * Centralized configuration for perp market pricing mechanics.
 * Used by both real-time price impact (API routes) and periodic updates (game-tick).
 */

/**
 * Resolution Confidence Configuration
 *
 * Thresholds for the manual resolution review system.
 */
export const RESOLUTION_CONFIDENCE_CONFIG = {
  /**
   * Confidence threshold below which resolutions require manual review.
   * Resolutions with confidence < this value are flagged for admin approval.
   */
  MANUAL_REVIEW_THRESHOLD: 0.7,

  /**
   * Base confidence score when no speculative signals are detected.
   */
  BASE_CONFIDENCE: 0.95,

  /**
   * Minimum confidence score (floor).
   */
  MIN_CONFIDENCE: 0.2,
} as const;

/**
 * vAMM (Virtual Automated Market Maker) configuration for perp markets.
 *
 * The effective supply determines price sensitivity:
 * effectiveSupply = SYNTHETIC_SUPPLY / LIQUIDITY_FACTOR
 *
 * With LIQUIDITY_FACTOR = 20 and SYNTHETIC_SUPPLY = 10000:
 * - effectiveSupply = 500
 * - $100 trade → ~0.02% impact
 * - $1000 trade → ~0.2% impact
 * - $5000 trade → ~1% impact
 *
 * This makes our simulation markets 20x less liquid than real exchanges,
 * providing visible price impact from user trades.
 */
export const PERP_MARKET_CONFIG = {
  /**
   * Base synthetic supply for vAMM calculations.
   * This is the "nominal" supply shown externally.
   */
  SYNTHETIC_SUPPLY: 10_000,

  /**
   * Liquidity factor - controls price volatility.
   *
   * - 1: Normal liquidity (like real exchanges, minimal impact)
   * - 10: 10x less liquid (noticeable impact)
   * - 20: 20x less liquid (recommended for simulation)
   * - 50: Very volatile (for testing)
   *
   * Higher = more volatile = more price impact per trade.
   */
  LIQUIDITY_FACTOR: 20,

  /**
   * Maximum price change per single trade (safety limit).
   * Prevents flash crashes from single large trades.
   */
  MAX_CHANGE_PER_TRADE: 0.1, // 10%

  /**
   * Absolute price floor as ratio of initial price.
   * Price can never go below initialPrice * PRICE_FLOOR_RATIO.
   */
  PRICE_FLOOR_RATIO: 0.25, // 25% of initial

  /**
   * Absolute price ceiling as ratio of initial price.
   * Price can never go above initialPrice * PRICE_CEILING_RATIO.
   */
  PRICE_CEILING_RATIO: 4.0, // 400% of initial
} as const;

/**
 * Type for the perp market configuration.
 * Uses widened number types to allow overrides in tests.
 */
export type PerpMarketConfig = {
  [K in keyof typeof PERP_MARKET_CONFIG]: (typeof PERP_MARKET_CONFIG)[K] extends number
    ? number
    : (typeof PERP_MARKET_CONFIG)[K];
};

/**
 * Calculates the effective supply based on liquidity factor.
 * Lower effective supply = more price impact per trade.
 */
export function getEffectiveSupply(
  config: PerpMarketConfig = PERP_MARKET_CONFIG,
): number {
  return config.SYNTHETIC_SUPPLY / config.LIQUIDITY_FACTOR;
}

/**
 * Calculates the new price based on net holdings using the vAMM formula.
 *
 * Formula:
 * - effectiveSupply = SYNTHETIC_SUPPLY / LIQUIDITY_FACTOR
 * - baseMarketCap = initialPrice × effectiveSupply
 * - newMarketCap = baseMarketCap + netHoldings
 * - rawPrice = newMarketCap / effectiveSupply
 * - Apply limits (max change per trade, floor, ceiling)
 *
 * @param initialPrice - The initial/reference price of the asset
 * @param currentPrice - The current price before this calculation
 * @param netHoldings - Net holdings (longs - shorts) in dollar value
 * @param config - Optional config override for testing
 * @returns The new calculated price, clamped to limits
 */
export function calculatePriceFromHoldings(
  initialPrice: number,
  currentPrice: number,
  netHoldings: number,
  config: PerpMarketConfig = PERP_MARKET_CONFIG,
): number {
  const effectiveSupply = getEffectiveSupply(config);

  // vAMM formula
  const baseMarketCap = initialPrice * effectiveSupply;
  const newMarketCap = baseMarketCap + netHoldings;
  const rawPrice = newMarketCap / effectiveSupply;

  // Apply per-trade change limit
  const maxChange = currentPrice * config.MAX_CHANGE_PER_TRADE;
  const minFromChange = currentPrice - maxChange;
  const maxFromChange = currentPrice + maxChange;

  // Apply absolute limits
  const absoluteMin = initialPrice * config.PRICE_FLOOR_RATIO;
  const absoluteMax = initialPrice * config.PRICE_CEILING_RATIO;

  // Combine limits
  const minPrice = Math.max(absoluteMin, minFromChange);
  const maxPrice = Math.min(absoluteMax, maxFromChange);

  // Clamp and return
  return Math.max(minPrice, Math.min(rawPrice, maxPrice));
}

/**
 * Calculates the raw price without any limits (for testing/debugging).
 */
export function calculateRawPriceFromHoldings(
  initialPrice: number,
  netHoldings: number,
  config: PerpMarketConfig = PERP_MARKET_CONFIG,
): number {
  const effectiveSupply = getEffectiveSupply(config);
  const baseMarketCap = initialPrice * effectiveSupply;
  const newMarketCap = baseMarketCap + netHoldings;
  return newMarketCap / effectiveSupply;
}
