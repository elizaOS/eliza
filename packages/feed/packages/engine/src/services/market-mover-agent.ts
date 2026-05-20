/**
 * Market Mover Agent
 *
 * Translates world events into price movements for perpetual markets.
 * This is the bridge between the Narrative Layer (events) and the Financial Layer (prices).
 *
 * Architecture:
 * - Events occur in GameWorld (leaks, rumors, scandals, etc.)
 * - Market Mover determines how those events should affect prices
 * - Returns percentage changes (deltas), not absolute prices
 *
 * The agent uses volatility buckets to prevent overfitting:
 * - Low: ±2% to ±4%
 * - Medium: ±5% to ±10%
 * - High: ±15% to ±25%
 *
 * The exact percentage within a bucket is selected using seeded RNG for reproducibility.
 */

import type { WorldEvent } from '@babylon/shared';

/**
 * Volatility bucket for price movements
 */
export type VolatilityBucket = 'low' | 'medium' | 'high';

/**
 * Volatility bucket ranges for price changes
 * Each bucket defines min/max percentage change (absolute value)
 */
const VOLATILITY_BUCKET_RANGES: Record<
  VolatilityBucket,
  { min: number; max: number }
> = {
  low: { min: 0.02, max: 0.04 }, // 2% to 4%
  medium: { min: 0.05, max: 0.1 }, // 5% to 10%
  high: { min: 0.15, max: 0.25 }, // 15% to 25%
};

/**
 * Event type to volatility bucket mapping
 * Maps event types to their default volatility impact
 */
export const EVENT_TYPE_VOLATILITY: Record<
  string,
  { bucket: VolatilityBucket; isNegative: boolean }
> = {
  // Negative events
  leak: { bucket: 'medium', isNegative: true },
  rumor: { bucket: 'medium', isNegative: true },
  scandal: { bucket: 'high', isNegative: true },
  conflict: { bucket: 'medium', isNegative: true },
  revelation: { bucket: 'medium', isNegative: true },
  // Positive events
  development: { bucket: 'medium', isNegative: false },
  deal: { bucket: 'medium', isNegative: false },
  announcement: { bucket: 'low', isNegative: false },
  meeting: { bucket: 'low', isNegative: false },
  // Neutral/context-dependent (use sentiment signal)
  'development:occurred': { bucket: 'low', isNegative: false },
  'news:published': { bucket: 'low', isNegative: false },
};

/**
 * Context for price adjustment decisions
 */
export interface MarketMoverContext {
  /** Tickers that are explicitly affected by the events */
  affectedTickers?: string[];
}

/**
 * Configuration for MarketMoverAgent
 */
export interface MarketMoverConfig {
  /** Maximum price change per event (default: 0.30 for 30%) */
  maxPriceChangePerEvent?: number;
  /** Minimum price as fraction of initial (default: 0.10 for 10%) */
  minPriceFloor?: number;
  /** Maximum price as fraction of initial (default: 4.0 for 400%) */
  maxPriceCeiling?: number;
}

/**
 * RNG interface for price adjustments
 */
interface RNG {
  next(): number;
  nextFloat(min: number, max: number): number;
}

/**
 * Create a seeded RNG using linear congruential generator
 */
function createSeededRng(seed: number): RNG {
  let state = seed;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  return {
    next,
    nextFloat: (min: number, max: number) => min + next() * (max - min),
  };
}

/**
 * Market Mover Agent
 *
 * Deterministic rule-based engine that translates world events into price movements
 * using volatility buckets. Fast, cheap, and consistent.
 */
export class MarketMoverAgent {
  private rng: RNG;
  private config: Required<MarketMoverConfig>;

  constructor(seed: number, config?: MarketMoverConfig) {
    this.rng = createSeededRng(seed);
    this.config = {
      maxPriceChangePerEvent: config?.maxPriceChangePerEvent ?? 0.3,
      minPriceFloor: config?.minPriceFloor ?? 0.1,
      maxPriceCeiling: config?.maxPriceCeiling ?? 4.0,
    };
  }

  /**
   * Generate price adjustments for events that occurred this tick
   *
   * @param currentPrices - Map of ticker -> current price
   * @param events - World events that occurred this tick
   * @param context - Optional context with affected tickers
   * @returns Map of ticker -> percentage change
   */
  async generatePriceAdjustments(
    currentPrices: Map<string, number>,
    events: WorldEvent[],
    context?: MarketMoverContext
  ): Promise<Map<string, number>> {
    // If no events, no price changes
    if (events.length === 0) {
      return new Map();
    }

    const adjustments = new Map<string, number>();

    for (const event of events) {
      // Determine which tickers are affected
      const affectedTickers = this.determineAffectedTickers(
        event,
        currentPrices,
        context
      );

      if (affectedTickers.length === 0) {
        continue;
      }

      // Get volatility bucket and direction for this event type
      const eventVolatility = this.getEventVolatility(event);

      // Generate price change for each affected ticker
      for (const ticker of affectedTickers) {
        const percentageChange = this.selectPercentageFromBucket(
          eventVolatility.bucket,
          !eventVolatility.isNegative
        );

        // Aggregate with existing adjustments for this ticker
        const existingChange = adjustments.get(ticker) ?? 0;
        const newChange = existingChange + percentageChange;

        // Clamp to max change per tick
        const clampedChange = Math.max(
          -this.config.maxPriceChangePerEvent,
          Math.min(this.config.maxPriceChangePerEvent, newChange)
        );

        adjustments.set(ticker, clampedChange);
      }
    }

    return adjustments;
  }

  /**
   * Determine which tickers are affected by an event
   */
  private determineAffectedTickers(
    event: WorldEvent,
    currentPrices: Map<string, number>,
    context?: MarketMoverContext
  ): string[] {
    // If context specifies affected tickers, use those
    if (context?.affectedTickers && context.affectedTickers.length > 0) {
      return context.affectedTickers.filter((t) => currentPrices.has(t));
    }

    // Check if event description mentions any tickers
    const tickers = Array.from(currentPrices.keys());
    const mentionedTickers = tickers.filter((ticker) =>
      event.description.toUpperCase().includes(ticker.toUpperCase())
    );

    if (mentionedTickers.length > 0) {
      return mentionedTickers;
    }

    // No specific ticker identified - return empty (no price change)
    return [];
  }

  /**
   * Get volatility bucket and direction for an event type
   */
  private getEventVolatility(event: WorldEvent): {
    bucket: VolatilityBucket;
    isNegative: boolean;
  } {
    // Check if we have a mapping for this event type
    const mapping = EVENT_TYPE_VOLATILITY[event.type];

    if (mapping) {
      // Use sentiment signal if available to override direction
      if (event.sentimentSignal !== undefined) {
        return {
          bucket: mapping.bucket,
          isNegative: event.sentimentSignal < 0,
        };
      }
      return mapping;
    }

    // Default: use sentiment signal if available
    if (event.sentimentSignal !== undefined) {
      // Map sentiment magnitude to bucket
      const magnitude = Math.abs(event.sentimentSignal);
      let bucket: VolatilityBucket;
      if (magnitude > 0.7) {
        bucket = 'high';
      } else if (magnitude > 0.4) {
        bucket = 'medium';
      } else {
        bucket = 'low';
      }

      return {
        bucket,
        isNegative: event.sentimentSignal < 0,
      };
    }

    // Default: low volatility, direction based on pointsToward
    return {
      bucket: 'low',
      isNegative: event.pointsToward === 'NO',
    };
  }

  /**
   * Select a percentage change within a volatility bucket using seeded RNG
   */
  private selectPercentageFromBucket(
    bucket: VolatilityBucket,
    isPositive: boolean
  ): number {
    const range = VOLATILITY_BUCKET_RANGES[bucket];
    const magnitude = this.rng.nextFloat(range.min, range.max);
    return isPositive ? magnitude : -magnitude;
  }

  /**
   * Apply price adjustments to current prices, respecting bounds
   *
   * @param currentPrices - Map of ticker -> current price
   * @param adjustments - Map of ticker -> percentage change
   * @param initialPrices - Map of ticker -> initial price (for bounds)
   * @returns Map of ticker -> new price
   */
  applyAdjustments(
    currentPrices: Map<string, number>,
    adjustments: Map<string, number>,
    initialPrices: Map<string, number>
  ): Map<string, number> {
    const newPrices = new Map<string, number>();

    for (const [ticker, currentPrice] of currentPrices) {
      const adjustment = adjustments.get(ticker) ?? 0;
      let newPrice = currentPrice * (1 + adjustment);

      // Apply price bounds based on initial price
      const initialPrice = initialPrices.get(ticker) ?? currentPrice;
      const minPrice = initialPrice * this.config.minPriceFloor;
      const maxPrice = initialPrice * this.config.maxPriceCeiling;
      newPrice = Math.max(minPrice, Math.min(maxPrice, newPrice));

      newPrices.set(ticker, newPrice);
    }

    return newPrices;
  }
}
