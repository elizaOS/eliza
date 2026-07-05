/**
 * Time-Weighted Average Price (TWAP) Oracle for elizaOS Token
 *
 * ============================================================================
 * SECURITY: ANTI-ARBITRAGE & SUPPLY SHOCK PROTECTION
 * ============================================================================
 *
 * This oracle provides manipulation-resistant pricing by:
 * 1. Computing TWAP over configurable windows (15min, 1hr, 4hr)
 * 2. Requiring minimum price samples before allowing redemptions
 * 3. Detecting unusual price volatility
 * 4. Implementing withdrawal delays for large amounts
 * 5. Tracking system-wide redemption velocity
 *
 * ATTACK MITIGATIONS:
 *
 * 1. ARBITRAGE ATTACK
 *    - Attacker manipulates DEX price, redeems at favorable rate
 *    - Mitigation: TWAP averages out short-term manipulation
 *
 * 2. SUPPLY SHOCK ATTACK
 *    - Multiple users coordinate large withdrawals to dump tokens
 *    - Mitigation: System-wide hourly/daily limits, withdrawal delays
 *
 * 3. FRONT-RUNNING
 *    - Attacker sees pending redemption, front-runs to profit
 *    - Mitigation: Price locked at redemption time with tight slippage
 *
 * 4. ORACLE MANIPULATION
 *    - Attacker manipulates price sources
 *    - Mitigation: Multi-source validation + TWAP smoothing
 */

import { ElizaError } from "@elizaos/core";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../../db/client";
import { elizaTokenPrices } from "../../db/schemas/token-redemptions";
import { logger } from "../utils/logger";
import { type SupportedNetwork } from "./eliza-token-price";

// ============================================================================
// FAIL-CLOSED NUMERIC BOUNDARY (#13415 cloud-shared service-layer sweep)
// ============================================================================
//
// This oracle is a redemption-security money surface. Its inputs come from
// Postgres NUMERIC columns (`eliza_token_prices.price_usd`) and NUMERIC-typed
// SUM/COUNT aggregates (`token_redemptions.usd_value`), both returned by the
// driver as STRINGS. `'NaN'::numeric` is a valid stored value that reads back
// as the literal string "NaN", and `Number("NaN") === NaN`. Because EVERY
// comparison against NaN is `false`, a single corrupt/unexpected row silently
// DISABLED the supply-shock protections this file exists to enforce:
//   - getSystemHealth: `NaN >= LIMIT` false -> hourly/daily/velocity caps all
//     BYPASSED (fail-OPEN rate limit).
//   - validatePayoutPrice: `NaN > threshold` false -> a corrupt TWAP read
//     VALIDATES an arbitrage/manipulated payout at money-out time.
//   - getTWAP: a corrupt price sample poisons twapPrice/spotPrice into NaN.
// The boundary below refuses a corrupt value fail-closed instead of coercing
// it to NaN and pretending the guard passed.

const PLAIN_DECIMAL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** Thrown when a NUMERIC money/price field can't be parsed to a finite number. */
export class CorruptTwapNumericError extends ElizaError {
  override readonly name = "CorruptTwapNumericError";
  readonly field: string;
  readonly rawValue: unknown;

  constructor(field: string, rawValue: unknown) {
    super(
      `[TWAP] corrupt NUMERIC value for ${field}: ${JSON.stringify(rawValue)} is not valid for this money surface`,
      {
        code: "CORRUPT_TWAP_NUMERIC",
        context: { field, rawValue },
        severity: "fatal",
      },
    );
    this.field = field;
    this.rawValue = rawValue;
  }
}

/**
 * Fail-closed parse of a NUMERIC column / aggregate value.
 * - accepts a finite number or a plain numeric string (driver returns NUMERIC as string),
 * - allows an explicit domain zero (a legitimately-empty aggregate is 0, not corrupt),
 * - THROWS on null/undefined/empty/whitespace/"NaN"/Infinity/garbage/negative — never returns NaN.
 */
export function parseTwapNumeric(
  field: string,
  value: unknown,
  options: { allowZero?: boolean; requireInteger?: boolean } = {},
): number {
  const { allowZero = true, requireInteger = false } = options;
  const validateDomain = (parsed: number): number => {
    if (parsed < 0 || (!allowZero && parsed === 0)) {
      throw new CorruptTwapNumericError(field, value);
    }
    if (requireInteger && !Number.isInteger(parsed)) {
      throw new CorruptTwapNumericError(field, value);
    }
    return parsed;
  };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CorruptTwapNumericError(field, value);
    }
    return validateDomain(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      throw new CorruptTwapNumericError(field, value);
    }
    if (!PLAIN_DECIMAL_RE.test(trimmed)) {
      throw new CorruptTwapNumericError(field, value);
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new CorruptTwapNumericError(field, value);
    }
    return validateDomain(parsed);
  }
  // null / undefined / object / boolean etc.
  throw new CorruptTwapNumericError(field, value);
}

/**
 * Fail-closed parse of an aggregate (SUM/COUNT) that COALESCEs to 0 in SQL.
 * The query already `COALESCE(..., 0)`s an empty aggregate, so a genuinely
 * missing value arrives as the string "0"/number 0 (allowed). A non-finite
 * value here means a corrupt row poisoned the aggregate — fail closed.
 */
function parseTwapAggregate(
  field: string,
  value: unknown,
  options?: { requireInteger?: boolean },
): number {
  return parseTwapNumeric(field, value, options);
}

// ============================================================================
// TWAP CONFIGURATION
// ============================================================================

export const TWAP_CONFIG = {
  // TWAP window duration (how far back to look for price samples)
  TWAP_WINDOW_MS: 15 * 60 * 1000, // 15 minutes (short for responsiveness)

  // Minimum samples required in TWAP window before allowing redemption
  MIN_TWAP_SAMPLES: 3,

  // How often to sample prices (must be less than TWAP window)
  SAMPLE_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes

  // Maximum price change allowed within TWAP window (volatility circuit breaker)
  MAX_VOLATILITY_PERCENT: 0.1, // 10% - if exceeded, pause redemptions

  // Maximum allowed slippage from TWAP to current spot
  MAX_TWAP_SLIPPAGE: 0.03, // 3%

  // Quote validity (shorter than before to reduce manipulation window)
  QUOTE_VALIDITY_MS: 2 * 60 * 1000, // 2 minutes (was 5)

  // Price must be stable for this long before redemptions enabled
  STABILITY_WINDOW_MS: 10 * 60 * 1000, // 10 minutes
};

// ============================================================================
// SYSTEM-WIDE RATE LIMITS (SUPPLY SHOCK PROTECTION)
// ============================================================================

export const SYSTEM_LIMITS = {
  // Maximum total redemptions per hour (across all users)
  MAX_HOURLY_REDEMPTION_USD: 10000, // $10,000/hour

  // Maximum total redemptions per day (across all users)
  MAX_DAILY_REDEMPTION_USD: 50000, // $50,000/day

  // Threshold for "large" redemption requiring delay
  LARGE_REDEMPTION_THRESHOLD_USD: 500, // $500

  // Delay for large redemptions (allows for detection of coordinated attacks)
  LARGE_REDEMPTION_DELAY_MS: 10 * 60 * 1000, // 10 minutes

  // Minimum time between any two system-wide redemptions
  MIN_REDEMPTION_INTERVAL_MS: 30 * 1000, // 30 seconds

  // If this many redemptions happen in quick succession, pause system
  VELOCITY_LIMIT_COUNT: 10,
  VELOCITY_LIMIT_WINDOW_MS: 5 * 60 * 1000, // 10 redemptions in 5 minutes = pause
};

// ============================================================================
// TYPES
// ============================================================================

interface TWAPQuote {
  twapPrice: number;
  spotPrice: number;
  sampleCount: number;
  windowStart: Date;
  windowEnd: Date;
  volatility: number;
  isStable: boolean;
  priceHistory: PricePoint[];
}

interface PricePoint {
  price: number;
  timestamp: Date;
  source: string;
}

interface RedemptionQuoteResult {
  success: boolean;
  error?: string;
  quote?: {
    twapPrice: number;
    spotPrice: number;
    usdValue: number;
    elizaAmount: number;
    expiresAt: Date;
    network: SupportedNetwork;
    requiresDelay: boolean;
    delayUntil?: Date;
    sampleCount: number;
    volatility: number;
  };
  warnings?: string[];
}

interface SystemHealthStatus {
  canProcessRedemptions: boolean;
  hourlyVolumeUsd: number;
  dailyVolumeUsd: number;
  recentRedemptionCount: number;
  isPaused: boolean;
  pauseReason?: string;
}

// ============================================================================
// TWAP ORACLE SERVICE
// ============================================================================

export class TWAPPriceOracle {
  /**
   * Record a new price sample for TWAP calculation.
   * Should be called periodically by a cron job.
   */
  async recordPriceSample(network: SupportedNetwork, price: number, source: string): Promise<void> {
    const now = new Date();
    const parsedPrice = parseTwapNumeric("price_usd", price, { allowZero: false });

    await dbWrite.insert(elizaTokenPrices).values({
      network,
      price_usd: String(parsedPrice),
      source,
      fetched_at: now,
      expires_at: new Date(now.getTime() + TWAP_CONFIG.TWAP_WINDOW_MS * 2),
      metadata: {
        is_twap_sample: true,
      },
    });

    logger.info("[TWAP] Price sample recorded", {
      network,
      price,
      source,
    });
  }

  /**
   * Get the TWAP for a network over the configured window.
   */
  async getTWAP(network: SupportedNetwork): Promise<TWAPQuote | null> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - TWAP_CONFIG.TWAP_WINDOW_MS);

    // Fetch price samples in the TWAP window
    const samples = await dbRead
      .select({
        price: elizaTokenPrices.price_usd,
        timestamp: elizaTokenPrices.fetched_at,
        source: elizaTokenPrices.source,
      })
      .from(elizaTokenPrices)
      .where(
        and(eq(elizaTokenPrices.network, network), gte(elizaTokenPrices.fetched_at, windowStart)),
      )
      .orderBy(desc(elizaTokenPrices.fetched_at));

    if (samples.length === 0) {
      return null;
    }

    const priceHistory: PricePoint[] = samples.map((s) => ({
      // Fail-closed: a corrupt price sample must not poison the TWAP/spot into
      // NaN (which would then silently pass the isStable/slippage checks below).
      price: parseTwapNumeric("price_usd", s.price, { allowZero: false }),
      timestamp: s.timestamp,
      source: s.source,
    }));

    // Calculate TWAP (time-weighted average)
    // For simplicity, we use a simple average. For production,
    // implement true time-weighted average with integration.
    const prices = priceHistory.map((p) => p.price);
    const twapPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

    // Get most recent price as spot
    const spotPrice = prices[0];

    // Calculate volatility (standard deviation / mean)
    const mean = twapPrice;
    const variance = prices.reduce((sum, p) => sum + (p - mean) ** 2, 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    const volatility = stdDev / mean;

    // Check if price has been stable
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = (maxPrice - minPrice) / mean;
    const isStable = priceRange <= TWAP_CONFIG.MAX_VOLATILITY_PERCENT;

    return {
      twapPrice,
      spotPrice,
      sampleCount: samples.length,
      windowStart,
      windowEnd: now,
      volatility,
      isStable,
      priceHistory,
    };
  }

  /**
   * Get a redemption quote with TWAP pricing and anti-manipulation checks.
   */
  async getRedemptionQuote(
    network: SupportedNetwork,
    pointsAmount: number,
    userId: string,
  ): Promise<RedemptionQuoteResult> {
    const warnings: string[] = [];

    // 1. Check system health first
    const systemHealth = await this.getSystemHealth();
    if (!systemHealth.canProcessRedemptions) {
      return {
        success: false,
        error: systemHealth.pauseReason || "Redemptions temporarily paused",
      };
    }

    // 2. Get TWAP
    const twap = await this.getTWAP(network);
    if (!twap) {
      return {
        success: false,
        error: "Insufficient price data. Please try again in a few minutes.",
      };
    }

    // 3. Check minimum samples
    if (twap.sampleCount < TWAP_CONFIG.MIN_TWAP_SAMPLES) {
      return {
        success: false,
        error: `Need ${TWAP_CONFIG.MIN_TWAP_SAMPLES} price samples, only have ${twap.sampleCount}. Please try again shortly.`,
      };
    }

    // 4. Check volatility circuit breaker
    if (!twap.isStable) {
      return {
        success: false,
        error: `Price too volatile (${(twap.volatility * 100).toFixed(1)}% variation). Redemptions paused until price stabilizes.`,
      };
    }

    // 5. Check slippage between TWAP and spot
    const slippage = Math.abs(twap.spotPrice - twap.twapPrice) / twap.twapPrice;
    if (slippage > TWAP_CONFIG.MAX_TWAP_SLIPPAGE) {
      return {
        success: false,
        error: `Price moving too fast (${(slippage * 100).toFixed(1)}% from average). Please try again in a few minutes.`,
      };
    }

    if (slippage > TWAP_CONFIG.MAX_TWAP_SLIPPAGE / 2) {
      warnings.push(`Price moved ${(slippage * 100).toFixed(1)}% from average`);
    }

    // 6. Calculate USD value and elizaOS amount using TWAP price
    const usdValue = pointsAmount / 100;
    const elizaAmount = usdValue / twap.twapPrice;

    // 7. Check if large redemption requires delay
    const requiresDelay = usdValue >= SYSTEM_LIMITS.LARGE_REDEMPTION_THRESHOLD_USD;
    const delayUntil = requiresDelay
      ? new Date(Date.now() + SYSTEM_LIMITS.LARGE_REDEMPTION_DELAY_MS)
      : undefined;

    if (requiresDelay) {
      warnings.push(
        `Large redemption - ${SYSTEM_LIMITS.LARGE_REDEMPTION_DELAY_MS / 60000} minute processing delay`,
      );
    }

    // 8. Check system-wide limits
    const hourlyRemaining = SYSTEM_LIMITS.MAX_HOURLY_REDEMPTION_USD - systemHealth.hourlyVolumeUsd;
    const dailyRemaining = SYSTEM_LIMITS.MAX_DAILY_REDEMPTION_USD - systemHealth.dailyVolumeUsd;

    if (usdValue > hourlyRemaining) {
      return {
        success: false,
        error: `Hourly redemption limit reached. Available: $${hourlyRemaining.toFixed(2)}. Resets in ~${60 - new Date().getMinutes()} minutes.`,
      };
    }

    if (usdValue > dailyRemaining) {
      return {
        success: false,
        error: `Daily redemption limit reached. Available: $${dailyRemaining.toFixed(2)}. Resets at midnight UTC.`,
      };
    }

    if (hourlyRemaining < SYSTEM_LIMITS.MAX_HOURLY_REDEMPTION_USD * 0.2) {
      warnings.push(`Only $${hourlyRemaining.toFixed(0)} remaining in hourly limit`);
    }

    const expiresAt = new Date(Date.now() + TWAP_CONFIG.QUOTE_VALIDITY_MS);

    logger.info("[TWAP] Redemption quote generated", {
      network,
      pointsAmount,
      usdValue,
      twapPrice: twap.twapPrice,
      spotPrice: twap.spotPrice,
      elizaAmount,
      sampleCount: twap.sampleCount,
      volatility: twap.volatility,
      requiresDelay,
      userId,
    });

    return {
      success: true,
      quote: {
        twapPrice: twap.twapPrice,
        spotPrice: twap.spotPrice,
        usdValue,
        elizaAmount,
        expiresAt,
        network,
        requiresDelay,
        delayUntil,
        sampleCount: twap.sampleCount,
        volatility: twap.volatility,
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Get system-wide health status for redemptions.
   */
  async getSystemHealth(): Promise<SystemHealthStatus> {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const velocityWindow = new Date(now.getTime() - SYSTEM_LIMITS.VELOCITY_LIMIT_WINDOW_MS);

    // Get hourly volume from token_redemptions table
    const hourlyResult = await dbRead.execute(sql`
      SELECT COALESCE(SUM(CAST(usd_value AS DECIMAL)), 0) as total
      FROM token_redemptions
      WHERE status IN ('approved', 'processing', 'completed')
      AND created_at >= ${hourAgo}
    `);

    const dailyResult = await dbRead.execute(sql`
      SELECT COALESCE(SUM(CAST(usd_value AS DECIMAL)), 0) as total
      FROM token_redemptions
      WHERE status IN ('approved', 'processing', 'completed')
      AND created_at >= ${dayAgo}
    `);

    const velocityResult = await dbRead.execute(sql`
      SELECT COUNT(*) as count
      FROM token_redemptions
      WHERE status IN ('approved', 'processing', 'completed')
      AND created_at >= ${velocityWindow}
    `);

    // Fail-closed: these SUM/COUNT aggregates feed the supply-shock rate limits.
    // A corrupt 'NaN'::numeric usd_value read back as "NaN" would make every
    // `>= LIMIT` check `false` and silently BYPASS the hourly/daily/velocity
    // caps (fail-OPEN). Parse through the boundary so a corrupt aggregate
    // surfaces instead of disabling protection.
    const hourlyVolumeUsd = parseTwapAggregate(
      "hourly_volume_usd",
      (hourlyResult.rows[0] as { total: string })?.total,
    );
    const dailyVolumeUsd = parseTwapAggregate(
      "daily_volume_usd",
      (dailyResult.rows[0] as { total: string })?.total,
    );
    const recentRedemptionCount = parseTwapAggregate(
      "recent_redemption_count",
      (velocityResult.rows[0] as { count: string })?.count,
      { requireInteger: true },
    );

    let canProcessRedemptions = true;
    let pauseReason: string | undefined;

    // Check hourly limit
    if (hourlyVolumeUsd >= SYSTEM_LIMITS.MAX_HOURLY_REDEMPTION_USD) {
      canProcessRedemptions = false;
      pauseReason = "Hourly redemption limit reached";
    }

    // Check daily limit
    if (dailyVolumeUsd >= SYSTEM_LIMITS.MAX_DAILY_REDEMPTION_USD) {
      canProcessRedemptions = false;
      pauseReason = "Daily redemption limit reached";
    }

    // Check velocity limit (detect coordinated attacks)
    if (recentRedemptionCount >= SYSTEM_LIMITS.VELOCITY_LIMIT_COUNT) {
      canProcessRedemptions = false;
      pauseReason = `Too many redemptions (${recentRedemptionCount}) in short period - possible coordinated attack`;

      logger.error("[TWAP] Velocity limit triggered!", {
        recentRedemptionCount,
        limit: SYSTEM_LIMITS.VELOCITY_LIMIT_COUNT,
        windowMs: SYSTEM_LIMITS.VELOCITY_LIMIT_WINDOW_MS,
      });
    }

    return {
      canProcessRedemptions,
      hourlyVolumeUsd,
      dailyVolumeUsd,
      recentRedemptionCount,
      isPaused: !canProcessRedemptions,
      pauseReason,
    };
  }

  /**
   * Validate that a redemption can proceed (check for arbitrage opportunities).
   * Called at payout time to ensure price hasn't moved unfavorably.
   */
  async validatePayoutPrice(
    network: SupportedNetwork,
    quotedPrice: number,
    elizaAmount: number,
  ): Promise<{ valid: boolean; error?: string }> {
    const twap = await this.getTWAP(network);

    if (!twap) {
      return { valid: false, error: "Cannot validate price - no recent data" };
    }

    const parsedQuotedPrice = parseTwapNumeric("quoted_price", quotedPrice, { allowZero: false });

    // Check if current TWAP is significantly different from quoted price
    const priceDrift = Math.abs(twap.twapPrice - parsedQuotedPrice) / parsedQuotedPrice;

    if (priceDrift > TWAP_CONFIG.MAX_TWAP_SLIPPAGE * 2) {
      logger.warn("[TWAP] Payout price drift too high", {
        quotedPrice: parsedQuotedPrice,
        currentTwap: twap.twapPrice,
        drift: priceDrift,
        network,
      });

      // If price went UP (unfavorable for us), reject
      if (twap.twapPrice > parsedQuotedPrice) {
        return {
          valid: false,
          error: `Price increased ${(priceDrift * 100).toFixed(1)}% since quote. Please get a new quote.`,
        };
      }

      // If price went DOWN (favorable for us), we could proceed
      // but this might indicate manipulation, so be cautious
      return {
        valid: false,
        error: `Price decreased ${(priceDrift * 100).toFixed(1)}% since quote. Possible manipulation detected.`,
      };
    }

    return { valid: true };
  }

  /**
   * Clean up old price samples.
   */
  async cleanupOldSamples(): Promise<number> {
    const cutoff = new Date(Date.now() - TWAP_CONFIG.TWAP_WINDOW_MS * 4);

    const result = await dbWrite
      .delete(elizaTokenPrices)
      .where(lt(elizaTokenPrices.fetched_at, cutoff));

    return result.rowCount ?? 0;
  }
}

// Export singleton
export const twapPriceOracle = new TWAPPriceOracle();
