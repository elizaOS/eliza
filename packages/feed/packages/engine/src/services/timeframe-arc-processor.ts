/**
 * Timeframe Arc Processor
 *
 * Manages arc state transitions for markets of different timeframes.
 * Unlike the day-based narrative processor, this uses actual timestamps
 * to determine state transitions.
 *
 * ## Timeframe State Machines
 *
 * Each timeframe has a different set of states and transition speeds:
 *
 * FLASH (15-30 min):
 *   live ──────────────────────────────────────────> resolving
 *   └── No intermediate states, just active trading then resolution
 *
 * INTRADAY (1-6 hours):
 *   setup ──> active ──> climax ──> resolution
 *   └── 4 phases, ~25% of time each
 *
 * DAILY (12-48 hours):
 *   morning ──> midday ──> afternoon ──> evening ──> resolution
 *   └── 5 phases following market day pattern
 *
 * WEEKLY (3-7 days):
 *   setup ──> tension ──> escalation ──> crisis ──> resolution
 *   └── Similar to long-term but compressed
 *
 * MONTHLY+ (2+ weeks):
 *   setup ──> tension ──> escalation ──> crisis ──> revelation ──> resolution
 *   └── Full 6-phase narrative arc
 *
 * Uses secureRandom for deterministic behavior in testing.
 */

import {
  asc,
  db,
  eq,
  type TimeframedMarket,
  timeframedMarkets,
} from "@feed/db";
import { logger } from "@feed/shared";
import { secureRandom } from "../utils/entropy";
import { formatError } from "../utils/error-utils";
import { clamp01 } from "../utils/math-utils";
import {
  getCurrentArcState,
  getEventCooldownMs,
  getEventMultiplier,
  getStateBoundaries,
} from "./market-timeframes";

// =============================================================================
// TYPES
// =============================================================================

export interface ArcTransitionResult {
  transitioned: boolean;
  previousState?: string;
  newState?: string;
  marketId: string;
}

export interface EventGenerationResult {
  generated: boolean;
  eventType?: string;
  marketId: string;
  reason?: string;
}

export interface TimeframeTickResult {
  marketsProcessed: number;
  transitionsOccurred: number;
  eventsGenerated: number;
  errors: string[];
  /** Whether a catastrophic failure occurred during processing */
  failed?: boolean;
  /** Error message when failed is true */
  failureMessage?: string;
  /** Events that can trigger article generation */
  eventTriggers: Array<{
    marketId: string;
    eventType: string;
    timeframe: string;
    arcState: string;
  }>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Event types by arc state - more specific for different timeframes */
const STATE_EVENT_TYPES: Record<string, string[]> = {
  // Long-term states
  setup: ["rumor", "announcement", "speculation"],
  tension: ["leak", "insider_hint", "market_signal"],
  escalation: ["confirmation", "denial", "controversy"],
  crisis: ["breaking_news", "major_development", "uncertainty_peak"],
  revelation: ["proof", "official_statement", "definitive_signal"],
  resolution: ["final_answer", "market_close"],

  // Daily states
  morning: ["morning_news", "pre_market", "opening_signal"],
  midday: ["midday_update", "volume_spike", "institutional_move"],
  afternoon: ["afternoon_reversal", "trend_continuation", "volatility"],
  evening: ["closing_pressure", "after_hours", "final_moves"],

  // Intraday states
  active: ["price_move", "volume_surge", "breakout"],
  climax: ["peak_activity", "decisive_move"],

  // Flash states
  live: ["live_event", "real_time_update"],
  resolving: ["resolution_pending"],
};

/** Base probability of generating an event per tick, by state */
const STATE_EVENT_PROBABILITIES: Record<string, number> = {
  setup: 0.3,
  tension: 0.4,
  escalation: 0.5,
  crisis: 0.6,
  revelation: 0.7,
  resolution: 0.2, // Lower after resolution
  morning: 0.4,
  midday: 0.3,
  afternoon: 0.4,
  evening: 0.5,
  active: 0.5,
  climax: 0.7,
  live: 0.6,
  resolving: 0.1,
};

// =============================================================================
// SERVICE CLASS
// =============================================================================

export class TimeframeArcProcessor {
  /**
   * Process all active markets for the current tick
   */
  async processTick(now: Date = new Date()): Promise<TimeframeTickResult> {
    const BATCH_SIZE = 100; // Process markets in batches to avoid unbounded queries
    const result: TimeframeTickResult = {
      marketsProcessed: 0,
      transitionsOccurred: 0,
      eventsGenerated: 0,
      errors: [],
      eventTriggers: [],
    };

    try {
      // Get active markets in batches to avoid unbounded queries
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const activeMarkets = await db
          .select()
          .from(timeframedMarkets)
          .where(eq(timeframedMarkets.isActive, true))
          .orderBy(asc(timeframedMarkets.id)) // Stable order for pagination
          .limit(BATCH_SIZE)
          .offset(offset);

        if (activeMarkets.length < BATCH_SIZE) {
          hasMore = false;
        }

        if (activeMarkets.length === 0) {
          break;
        }

        logger.debug(
          `Processing batch of ${activeMarkets.length} active markets (offset: ${offset})`,
          {},
          "TimeframeArcProcessor",
        );

        for (const market of activeMarkets) {
          try {
            result.marketsProcessed++;

            // markets-tick owns actual market resolution and payouts. Once a
            // market reaches endTime, we only advance its narrative arc to the
            // terminal state and stop generating new arc events for it.
            if (now >= market.endTime) {
              const transition = await this.markResolutionPending(market, now);
              if (transition.transitioned) {
                result.transitionsOccurred++;
              }
              continue;
            }

            // Check for state transition
            const transition = await this.checkStateTransition(market, now);
            if (transition.transitioned) {
              result.transitionsOccurred++;
            }

            // Check for event generation
            const event = await this.tryGenerateEvent(market, now);
            if (event.generated) {
              result.eventsGenerated++;

              // Record event trigger for article generation
              if (event.eventType) {
                result.eventTriggers.push({
                  marketId: market.id,
                  eventType: event.eventType,
                  timeframe: market.timeframe,
                  arcState: market.arcState,
                });
              }
            }
          } catch (error) {
            const msg = formatError(error);
            result.errors.push(`Market ${market.id}: ${msg}`);
            logger.error(
              `Error processing market`,
              { marketId: market.id, error: msg },
              "TimeframeArcProcessor",
            );
          }
        }

        offset += BATCH_SIZE;
      }

      logger.info(
        `Tick complete`,
        {
          processed: result.marketsProcessed,
          transitions: result.transitionsOccurred,
          events: result.eventsGenerated,
          errors: result.errors.length,
        },
        "TimeframeArcProcessor",
      );
    } catch (error) {
      const errorMessage = formatError(error);
      logger.error(
        `Tick failed`,
        { error: errorMessage },
        "TimeframeArcProcessor",
      );
      result.failed = true;
      result.failureMessage = errorMessage;
    }

    return result;
  }

  /**
   * Check if a market should transition to a new state
   */
  async checkStateTransition(
    market: TimeframedMarket,
    now: Date = new Date(),
  ): Promise<ArcTransitionResult> {
    const expectedState = getCurrentArcState(
      market.startTime,
      market.endTime,
      market.timeframe,
      now,
    );

    if (expectedState !== market.arcState) {
      logger.info(
        `State transition`,
        {
          marketId: market.id,
          from: market.arcState,
          to: expectedState,
          timeframe: market.timeframe,
        },
        "TimeframeArcProcessor",
      );

      await db
        .update(timeframedMarkets)
        .set({
          arcState: expectedState,
          arcStateEnteredAt: now,
          updatedAt: now,
        })
        .where(eq(timeframedMarkets.id, market.id));

      return {
        transitioned: true,
        previousState: market.arcState,
        newState: expectedState,
        marketId: market.id,
      };
    }

    return {
      transitioned: false,
      marketId: market.id,
    };
  }

  /**
   * Try to generate an event for a market
   */
  async tryGenerateEvent(
    market: TimeframedMarket,
    now: Date = new Date(),
  ): Promise<EventGenerationResult> {
    // Check cooldown
    const cooldownMs = getEventCooldownMs(market.timeframe);
    if (market.lastEventAt) {
      const elapsed = now.getTime() - market.lastEventAt.getTime();
      if (elapsed < cooldownMs) {
        return {
          generated: false,
          marketId: market.id,
          reason: "cooldown",
        };
      }
    }

    // Get base probability for current state
    const baseProbability = STATE_EVENT_PROBABILITIES[market.arcState] ?? 0.3;

    // Apply timeframe multiplier
    const multiplier = getEventMultiplier(market.timeframe);
    const probability = Math.min(1, baseProbability * multiplier);

    // Roll for event
    if (secureRandom() > probability) {
      return {
        generated: false,
        marketId: market.id,
        reason: "probability_check_failed",
      };
    }

    // Select event type with nullish coalescing fallback to ensure non-undefined result
    const eventTypes = STATE_EVENT_TYPES[market.arcState] ?? ["generic_event"];
    const eventType =
      eventTypes.length > 0
        ? (eventTypes[Math.floor(secureRandom() * eventTypes.length)] ??
          "generic_event")
        : "generic_event";

    // Update market
    await db
      .update(timeframedMarkets)
      .set({
        eventsGenerated: (market.eventsGenerated ?? 0) + 1,
        lastEventAt: now,
        updatedAt: now,
      })
      .where(eq(timeframedMarkets.id, market.id));

    logger.debug(
      `Generated event`,
      {
        marketId: market.id,
        eventType,
        state: market.arcState,
        probability,
      },
      "TimeframeArcProcessor",
    );

    return {
      generated: true,
      eventType,
      marketId: market.id,
    };
  }

  /**
   * Advance an expired market to its terminal arc state without closing it.
   *
   * Actual market/question settlement is handled by markets-tick so prediction
   * markets are not removed from the active lifecycle before payouts run.
   */
  async markResolutionPending(
    market: TimeframedMarket,
    now: Date = new Date(),
  ): Promise<ArcTransitionResult> {
    const terminalState = getCurrentArcState(
      market.startTime,
      market.endTime,
      market.timeframe,
      now,
    );

    if (market.arcState === terminalState) {
      return {
        transitioned: false,
        marketId: market.id,
      };
    }

    await db
      .update(timeframedMarkets)
      .set({
        arcState: terminalState,
        arcStateEnteredAt: now,
        updatedAt: now,
      })
      .where(eq(timeframedMarkets.id, market.id));

    logger.info(
      `Market reached end time and is awaiting markets-tick resolution`,
      {
        marketId: market.id,
        timeframe: market.timeframe,
        previousState: market.arcState,
        terminalState,
      },
      "TimeframeArcProcessor",
    );

    return {
      transitioned: true,
      previousState: market.arcState,
      newState: terminalState,
      marketId: market.id,
    };
  }

  /**
   * Get the current phase boundaries for a market
   */
  getPhaseBoundaries(
    market: TimeframedMarket,
  ): Array<{ state: string; start: Date; end: Date }> {
    return getStateBoundaries(
      market.startTime,
      market.endTime,
      market.timeframe,
    );
  }

  /**
   * Get progress through current arc (0-1)
   */
  getArcProgress(market: TimeframedMarket, now: Date = new Date()): number {
    const totalDuration = market.endTime.getTime() - market.startTime.getTime();
    const elapsed = now.getTime() - market.startTime.getTime();
    return clamp01(elapsed / totalDuration);
  }

  /**
   * Get time remaining until resolution
   */
  getTimeRemaining(market: TimeframedMarket, now: Date = new Date()): number {
    return Math.max(0, market.endTime.getTime() - now.getTime());
  }

  /**
   * Format time remaining as human-readable string
   */
  formatTimeRemaining(
    market: TimeframedMarket,
    now: Date = new Date(),
  ): string {
    const ms = this.getTimeRemaining(market, now);

    if (ms <= 0) return "Resolved";

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }
}

// Singleton instance
export const timeframeArcProcessor = new TimeframeArcProcessor();

// =============================================================================
// CRON TICK INTERVALS
// =============================================================================

/**
 * Recommended tick intervals for different use cases
 */
export const TICK_INTERVALS = {
  /** For flash markets - every 30 seconds */
  flash: 30 * 1000,
  /** For intraday markets - every 2 minutes */
  intraday: 2 * 60 * 1000,
  /** For daily+ markets - every 5 minutes */
  standard: 5 * 60 * 1000,
} as const;
