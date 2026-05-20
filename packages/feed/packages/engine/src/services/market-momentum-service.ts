/**
 * Market Momentum Service
 *
 * Provides cascade/herd behavior for NPC trading.
 * - Tracks recent price movements per market
 * - Calculates panic sell / FOMO buy probabilities
 * - Adjusts NPC trading decisions based on momentum
 *
 * This creates realistic market dynamics where:
 * - Price drops trigger panic selling (amplifying the drop)
 * - Price pumps trigger FOMO buying (amplifying the pump)
 * - Contrarian NPCs do the opposite (buy dips, sell pumps)
 *
 * @module engine/services/market-momentum-service
 */

import { db, desc, gte, perpMarketSnapshots } from "@feed/db";
import { logger } from "@feed/shared";

/**
 * Configuration for momentum-based trading behavior
 */
export const MOMENTUM_CONFIG = {
  /**
   * Price change threshold to trigger panic mode (10% drop)
   */
  PANIC_THRESHOLD: -0.1,

  /**
   * Price change threshold for severe panic (20% drop)
   */
  SEVERE_PANIC_THRESHOLD: -0.2,

  /**
   * Price change threshold to trigger FOMO mode (10% pump)
   */
  FOMO_THRESHOLD: 0.1,

  /**
   * Price change threshold for severe FOMO (20% pump)
   */
  SEVERE_FOMO_THRESHOLD: 0.2,

  /**
   * Base probability multiplier for panic selling
   * Applied when price drops past PANIC_THRESHOLD
   */
  PANIC_SELL_MULTIPLIER: 2.0,

  /**
   * Severe panic multiplier (even conservative NPCs consider selling)
   */
  SEVERE_PANIC_MULTIPLIER: 3.5,

  /**
   * Base probability multiplier for FOMO buying
   */
  FOMO_BUY_MULTIPLIER: 2.0,

  /**
   * Severe FOMO multiplier
   */
  SEVERE_FOMO_MULTIPLIER: 3.5,

  /**
   * Contrarian NPCs react opposite to momentum
   * They buy when others panic, sell when others FOMO
   */
  CONTRARIAN_INVERSION: true,

  /**
   * Time window for momentum calculation (1 hour in ms)
   */
  MOMENTUM_WINDOW_MS: 60 * 60 * 1000,

  /**
   * Personality keywords that indicate herd behavior (follow the crowd)
   */
  HERD_KEYWORDS: [
    "follower",
    "reactive",
    "emotional",
    "impulsive",
    "trend",
    "momentum",
    "fomo",
    "panic",
  ],

  /**
   * Personality keywords that indicate contrarian behavior
   */
  CONTRARIAN_KEYWORDS: [
    "contrarian",
    "independent",
    "skeptic",
    "value",
    "patient",
    "rational",
    "analytical",
    "buffett",
    "munger",
  ],
} as const;

/**
 * Momentum signal for a market
 */
export interface MarketMomentum {
  ticker: string;
  organizationId: string;
  priceChange1h: number; // Percentage change in last hour
  priceChangePercent: number; // Same as above, for clarity
  currentPrice: number;
  previousPrice: number;
  signal: "panic" | "severe_panic" | "fomo" | "severe_fomo" | "neutral";
  strength: number; // 0-1, how strong the signal is
}

/**
 * NPC behavior type based on personality
 */
export type NPCBehaviorType = "herd" | "contrarian" | "balanced";

/**
 * Trading adjustment based on momentum
 */
export interface MomentumAdjustment {
  ticker: string;
  originalAction: string;
  adjustedAction: string;
  multiplier: number;
  reason: string;
}

/**
 * Market Momentum Service
 *
 * Analyzes market momentum and provides trading behavior adjustments
 * to create realistic cascade/herd effects.
 */
export class MarketMomentumService {
  /**
   * Get momentum signals for all markets
   */
  static async getAllMarketMomentum(): Promise<MarketMomentum[]> {
    const oneHourAgo = new Date(
      Date.now() - MOMENTUM_CONFIG.MOMENTUM_WINDOW_MS,
    );

    // Get latest snapshots for each market
    const latestSnapshots = await db
      .select({
        ticker: perpMarketSnapshots.ticker,
        organizationId: perpMarketSnapshots.organizationId,
        currentPrice: perpMarketSnapshots.currentPrice,
        createdAt: perpMarketSnapshots.createdAt,
      })
      .from(perpMarketSnapshots)
      .orderBy(desc(perpMarketSnapshots.createdAt))
      .limit(100);

    // Group by ticker and get latest
    const latestByTicker = new Map<string, (typeof latestSnapshots)[0]>();
    for (const snap of latestSnapshots) {
      if (!latestByTicker.has(snap.ticker)) {
        latestByTicker.set(snap.ticker, snap);
      }
    }

    // Get older snapshots for comparison (1 hour ago)
    const olderSnapshots = await db
      .select({
        ticker: perpMarketSnapshots.ticker,
        currentPrice: perpMarketSnapshots.currentPrice,
        createdAt: perpMarketSnapshots.createdAt,
      })
      .from(perpMarketSnapshots)
      .where(gte(perpMarketSnapshots.createdAt, oneHourAgo))
      .orderBy(perpMarketSnapshots.createdAt)
      .limit(100);

    // Group by ticker and get oldest in window
    const oldestByTicker = new Map<string, (typeof olderSnapshots)[0]>();
    for (const snap of olderSnapshots) {
      if (!oldestByTicker.has(snap.ticker)) {
        oldestByTicker.set(snap.ticker, snap);
      }
    }

    const momentum: MarketMomentum[] = [];

    for (const [ticker, latest] of latestByTicker) {
      const older = oldestByTicker.get(ticker);
      if (!older) continue;

      const currentPrice = Number(latest.currentPrice);
      const previousPrice = Number(older.currentPrice);

      if (previousPrice <= 0) continue;

      const priceChange = (currentPrice - previousPrice) / previousPrice;
      const signal = MarketMomentumService.calculateSignal(priceChange);
      const strength = MarketMomentumService.calculateStrength(priceChange);

      momentum.push({
        ticker,
        organizationId: latest.organizationId,
        priceChange1h: priceChange,
        priceChangePercent: priceChange * 100,
        currentPrice,
        previousPrice,
        signal,
        strength,
      });
    }

    return momentum;
  }

  /**
   * Get momentum for a specific market
   */
  static async getMarketMomentum(
    ticker: string,
  ): Promise<MarketMomentum | null> {
    const allMomentum = await MarketMomentumService.getAllMarketMomentum();
    return allMomentum.find((m) => m.ticker === ticker) || null;
  }

  /**
   * Calculate the signal type based on price change
   */
  private static calculateSignal(
    priceChange: number,
  ): MarketMomentum["signal"] {
    if (priceChange <= MOMENTUM_CONFIG.SEVERE_PANIC_THRESHOLD) {
      return "severe_panic";
    }
    if (priceChange <= MOMENTUM_CONFIG.PANIC_THRESHOLD) {
      return "panic";
    }
    if (priceChange >= MOMENTUM_CONFIG.SEVERE_FOMO_THRESHOLD) {
      return "severe_fomo";
    }
    if (priceChange >= MOMENTUM_CONFIG.FOMO_THRESHOLD) {
      return "fomo";
    }
    return "neutral";
  }

  /**
   * Calculate signal strength (0-1)
   */
  private static calculateStrength(priceChange: number): number {
    const absChange = Math.abs(priceChange);
    // Strength scales from 0 at threshold to 1 at severe threshold
    if (priceChange < 0) {
      // Panic side
      if (absChange >= Math.abs(MOMENTUM_CONFIG.SEVERE_PANIC_THRESHOLD)) {
        return 1.0;
      }
      if (absChange >= Math.abs(MOMENTUM_CONFIG.PANIC_THRESHOLD)) {
        const range =
          Math.abs(MOMENTUM_CONFIG.SEVERE_PANIC_THRESHOLD) -
          Math.abs(MOMENTUM_CONFIG.PANIC_THRESHOLD);
        return (absChange - Math.abs(MOMENTUM_CONFIG.PANIC_THRESHOLD)) / range;
      }
    } else {
      // FOMO side
      if (absChange >= MOMENTUM_CONFIG.SEVERE_FOMO_THRESHOLD) {
        return 1.0;
      }
      if (absChange >= MOMENTUM_CONFIG.FOMO_THRESHOLD) {
        const range =
          MOMENTUM_CONFIG.SEVERE_FOMO_THRESHOLD -
          MOMENTUM_CONFIG.FOMO_THRESHOLD;
        return (absChange - MOMENTUM_CONFIG.FOMO_THRESHOLD) / range;
      }
    }
    return 0;
  }

  /**
   * Determine NPC behavior type from personality
   */
  static getNPCBehaviorType(personality: string | null): NPCBehaviorType {
    if (!personality) return "balanced";

    const personalityLower = personality.toLowerCase();

    // Check for contrarian keywords
    for (const keyword of MOMENTUM_CONFIG.CONTRARIAN_KEYWORDS) {
      if (personalityLower.includes(keyword)) {
        return "contrarian";
      }
    }

    // Check for herd keywords
    for (const keyword of MOMENTUM_CONFIG.HERD_KEYWORDS) {
      if (personalityLower.includes(keyword)) {
        return "herd";
      }
    }

    return "balanced";
  }

  /**
   * Get trading probability multiplier based on momentum and NPC type
   *
   * @param momentum - Market momentum signal
   * @param behaviorType - NPC behavior type
   * @param intendedAction - What the NPC wants to do ('buy' or 'sell')
   * @returns Multiplier for the trading probability (0 = don't trade, >1 = more likely)
   */
  static getTradingMultiplier(
    momentum: MarketMomentum,
    behaviorType: NPCBehaviorType,
    intendedAction: "buy" | "sell",
  ): { multiplier: number; reason: string } {
    const { signal, strength } = momentum;

    // Neutral momentum = no adjustment
    if (signal === "neutral") {
      return { multiplier: 1.0, reason: "neutral market" };
    }

    // Calculate base multiplier based on signal
    let baseMultiplier = 1.0;
    const isPanic = signal === "panic" || signal === "severe_panic";
    const isFomo = signal === "fomo" || signal === "severe_fomo";

    if (isPanic) {
      baseMultiplier =
        signal === "severe_panic"
          ? MOMENTUM_CONFIG.SEVERE_PANIC_MULTIPLIER
          : MOMENTUM_CONFIG.PANIC_SELL_MULTIPLIER;
    } else if (isFomo) {
      baseMultiplier =
        signal === "severe_fomo"
          ? MOMENTUM_CONFIG.SEVERE_FOMO_MULTIPLIER
          : MOMENTUM_CONFIG.FOMO_BUY_MULTIPLIER;
    }

    // Scale by strength
    const scaledMultiplier = 1.0 + (baseMultiplier - 1.0) * strength;

    // Apply behavior type logic
    switch (behaviorType) {
      case "herd":
        // Herd NPCs follow the crowd more strongly
        if (isPanic && intendedAction === "sell") {
          return {
            multiplier: scaledMultiplier * 1.5, // 50% more likely to sell during panic
            reason: `herd behavior: panic selling (${(momentum.priceChangePercent).toFixed(1)}% drop)`,
          };
        }
        if (isFomo && intendedAction === "buy") {
          return {
            multiplier: scaledMultiplier * 1.5,
            reason: `herd behavior: FOMO buying (${(momentum.priceChangePercent).toFixed(1)}% pump)`,
          };
        }
        // Herd NPCs are LESS likely to go against the trend
        if (isPanic && intendedAction === "buy") {
          return {
            multiplier: 0.3, // 70% less likely to buy during panic
            reason: "herd behavior: hesitant to buy during panic",
          };
        }
        if (isFomo && intendedAction === "sell") {
          return {
            multiplier: 0.3,
            reason: "herd behavior: hesitant to sell during FOMO",
          };
        }
        break;

      case "contrarian":
        // Contrarians do the opposite
        if (isPanic && intendedAction === "buy") {
          return {
            multiplier: scaledMultiplier * 1.5,
            reason: `contrarian: buying the dip (${(momentum.priceChangePercent).toFixed(1)}% drop)`,
          };
        }
        if (isFomo && intendedAction === "sell") {
          return {
            multiplier: scaledMultiplier * 1.5,
            reason: `contrarian: taking profits (${(momentum.priceChangePercent).toFixed(1)}% pump)`,
          };
        }
        // Contrarians avoid following the crowd
        if (isPanic && intendedAction === "sell") {
          return {
            multiplier: 0.5,
            reason: "contrarian: not panic selling",
          };
        }
        if (isFomo && intendedAction === "buy") {
          return {
            multiplier: 0.5,
            reason: "contrarian: not FOMO buying",
          };
        }
        break;
      default:
        // Balanced NPCs have moderate reactions
        if (isPanic && intendedAction === "sell") {
          return {
            multiplier: scaledMultiplier,
            reason: `market panic (${(momentum.priceChangePercent).toFixed(1)}% drop)`,
          };
        }
        if (isFomo && intendedAction === "buy") {
          return {
            multiplier: scaledMultiplier,
            reason: `market FOMO (${(momentum.priceChangePercent).toFixed(1)}% pump)`,
          };
        }
        break;
    }

    return { multiplier: 1.0, reason: "no momentum adjustment" };
  }

  /**
   * Get momentum context for NPC trading decisions
   * Returns a formatted string to include in LLM prompts
   */
  static async getMomentumPromptContext(): Promise<string> {
    const momentum = await MarketMomentumService.getAllMarketMomentum();

    const activeSignals = momentum.filter((m) => m.signal !== "neutral");

    if (activeSignals.length === 0) {
      return "";
    }

    const lines = ["### MARKET MOMENTUM ALERTS ###"];

    for (const m of activeSignals) {
      const changeStr =
        m.priceChangePercent >= 0
          ? `+${m.priceChangePercent.toFixed(1)}%`
          : `${m.priceChangePercent.toFixed(1)}%`;

      let alertType = "";
      switch (m.signal) {
        case "severe_panic":
          alertType = "🚨 SEVERE CRASH";
          break;
        case "panic":
          alertType = "⚠️ FALLING";
          break;
        case "severe_fomo":
          alertType = "🚀 MOONING";
          break;
        case "fomo":
          alertType = "📈 PUMPING";
          break;
      }

      lines.push(`${alertType}: ${m.ticker} ${changeStr} in last hour`);
    }

    lines.push("");
    lines.push(
      "Consider: Herd behavior may cause cascades. Contrarians may buy dips / sell pumps.",
    );

    return lines.join("\n");
  }

  /**
   * Log current momentum state (for debugging)
   */
  static async logMomentumState(): Promise<void> {
    const momentum = await MarketMomentumService.getAllMarketMomentum();

    const summary = momentum.map((m) => ({
      ticker: m.ticker,
      change: `${(m.priceChangePercent).toFixed(2)}%`,
      signal: m.signal,
      strength: m.strength.toFixed(2),
    }));

    logger.info(
      "Market momentum state",
      { markets: summary },
      "MarketMomentumService",
    );
  }
}
