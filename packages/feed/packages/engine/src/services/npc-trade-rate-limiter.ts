/**
 * NPC Trade Rate Limiter
 *
 * Rate limiting for NPC trading decisions. Enforces:
 * - Cooldown between trades (minimum minutes between trades per NPC)
 * - Daily trade cap (maximum trades per day per NPC)
 *
 * ## Architecture
 *
 * Uses a provider pattern for extensibility. By default, uses an in-memory
 * implementation suitable for single-instance deployments (e.g., a single
 * cron job process). For multi-instance/serverless deployments, inject a
 * distributed provider via `setNpcTradeRateLimitProvider()`.
 *
 * **Single-instance assumption**: The default in-memory provider assumes that
 * NPC trading is processed by a single cron job instance. This is the case for
 * the markets-tick cron which uses a global distributed lock to ensure only one
 * instance runs at a time. If this changes, swap in a Redis-based provider.
 *
 * ## Usage
 *
 * ```typescript
 * import { NpcTradeRateLimiter } from './npc-trade-rate-limiter';
 *
 * // Check if NPC can trade
 * if (await NpcTradeRateLimiter.canTrade(npcId)) {
 *   // Execute trade...
 *   await NpcTradeRateLimiter.recordTrade(npcId);
 * }
 * ```
 *
 * ## Distributed Provider
 *
 * To use with Redis (for multi-instance deployments):
 *
 * ```typescript
 * import { setNpcTradeRateLimitProvider } from './npc-trade-rate-limiter';
 *
 * setNpcTradeRateLimitProvider({
 *   canTrade: async (npcId, config) => {
 *     // Implement with Redis ZADD/ZCARD or similar
 *   },
 *   recordTrade: async (npcId) => {
 *     // Implement with Redis ZADD
 *   },
 *   resetForTesting: async () => {
 *     // Clear Redis keys
 *   },
 * });
 * ```
 *
 * @module engine/services/npc-trade-rate-limiter
 */

import { logger } from "@feed/shared";
import {
  getMaxTradesPerDay,
  getMinMinutesBetweenTrades,
} from "../config/npc-activity";
import { getTodayDateString } from "../utils/date-utils";

// =============================================================================
// TYPES
// =============================================================================

export interface NpcTradeRateLimitConfig {
  /** Maximum trades per NPC per day */
  maxTradesPerDay: number;
  /** Minimum minutes between trades for the same NPC */
  minMinutesBetweenTrades: number;
}

export interface NpcTradeRateLimitProvider {
  /**
   * Check if an NPC is allowed to trade based on cooldown and daily limits.
   *
   * @param npcId - The NPC's actor ID
   * @param config - Rate limit configuration
   * @returns true if the NPC can trade, false if rate limited
   */
  canTrade(npcId: string, config: NpcTradeRateLimitConfig): Promise<boolean>;

  /**
   * Record that an NPC has made a trade.
   * Updates both the last trade timestamp and daily count.
   *
   * @param npcId - The NPC's actor ID
   */
  recordTrade(npcId: string): Promise<void>;

  /**
   * Reset all rate limiting state.
   * Primarily used for testing scenarios.
   */
  resetForTesting(): Promise<void>;

  /**
   * Get current stats for an NPC (for debugging/observability).
   *
   * @param npcId - The NPC's actor ID
   * @returns Current rate limit stats or null if no data
   */
  getStats(npcId: string): Promise<{
    lastTradeTime: number;
    dailyCount: number;
    date: string;
  } | null>;
}

// =============================================================================
// IN-MEMORY PROVIDER (Default)
// =============================================================================

/**
 * In-memory rate limit provider for single-instance deployments.
 *
 * **Limitations:**
 * - State is lost on server restart (all cooldowns/counts reset)
 * - Not suitable for horizontal scaling (each instance has own state)
 * - Suitable for cron jobs protected by distributed lock (single executor)
 */
class InMemoryNpcTradeRateLimitProvider implements NpcTradeRateLimitProvider {
  /**
   * Tracks last trade timestamp per NPC.
   * Key: npcId, Value: timestamp (ms since epoch)
   */
  private lastTradeTime = new Map<string, number>();

  /**
   * Tracks daily trade count per NPC.
   * Key: npcId, Value: { date: ISO date string, count: number }
   */
  private dailyTradeCount = new Map<string, { date: string; count: number }>();

  async canTrade(
    npcId: string,
    config: NpcTradeRateLimitConfig,
  ): Promise<boolean> {
    const now = Date.now();

    // Check cooldown between trades
    const lastTrade = this.lastTradeTime.get(npcId) ?? 0;
    const cooldownMs = config.minMinutesBetweenTrades * 60 * 1000;

    if (now - lastTrade < cooldownMs) {
      return false;
    }

    // Check daily trade limit
    const today = getTodayDateString();
    const dailyData = this.dailyTradeCount.get(npcId);

    if (
      dailyData !== undefined &&
      dailyData.date === today &&
      dailyData.count >= config.maxTradesPerDay
    ) {
      return false;
    }

    return true;
  }

  async recordTrade(npcId: string): Promise<void> {
    const now = Date.now();
    this.lastTradeTime.set(npcId, now);

    const today = getTodayDateString();
    const dailyData = this.dailyTradeCount.get(npcId);

    if (dailyData !== undefined && dailyData.date === today) {
      dailyData.count++;
    } else {
      this.dailyTradeCount.set(npcId, { date: today, count: 1 });
    }
  }

  async resetForTesting(): Promise<void> {
    this.lastTradeTime.clear();
    this.dailyTradeCount.clear();
  }

  async getStats(npcId: string): Promise<{
    lastTradeTime: number;
    dailyCount: number;
    date: string;
  } | null> {
    const lastTrade = this.lastTradeTime.get(npcId);
    const dailyData = this.dailyTradeCount.get(npcId);

    if (!lastTrade && !dailyData) {
      return null;
    }

    const today = getTodayDateString();

    return {
      lastTradeTime: lastTrade ?? 0,
      dailyCount: dailyData && dailyData.date === today ? dailyData.count : 0,
      date: dailyData?.date ?? today,
    };
  }

  /**
   * Clean up stale entries to prevent unbounded memory growth.
   * Removes entries for NPCs who haven't traded in over 24 hours.
   *
   * @returns Number of entries cleaned up
   */
  cleanupStaleEntries(): number {
    const now = Date.now();
    const staleThresholdMs = 24 * 60 * 60 * 1000; // 24 hours
    let cleaned = 0;

    // Clean up lastTradeTime entries older than 24 hours
    for (const [npcId, timestamp] of this.lastTradeTime) {
      if (now - timestamp > staleThresholdMs) {
        this.lastTradeTime.delete(npcId);
        cleaned++;
      }
    }

    // Clean up dailyTradeCount entries from previous days
    const today = getTodayDateString();
    for (const [npcId, data] of this.dailyTradeCount) {
      if (data.date !== today) {
        this.dailyTradeCount.delete(npcId);
        // Only count if not already cleaned from lastTradeTime
        if (!this.lastTradeTime.has(npcId)) {
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      logger.debug(
        `Cleaned up ${cleaned} stale NPC trade rate limit entries`,
        { entriesRemaining: this.lastTradeTime.size },
        "NpcTradeRateLimiter",
      );
    }

    return cleaned;
  }

  /**
   * Get the current size of the rate limit maps (for monitoring).
   */
  getSize(): { lastTradeTime: number; dailyTradeCount: number } {
    return {
      lastTradeTime: this.lastTradeTime.size,
      dailyTradeCount: this.dailyTradeCount.size,
    };
  }
}

// =============================================================================
// PROVIDER MANAGEMENT
// =============================================================================

let provider: NpcTradeRateLimitProvider =
  new InMemoryNpcTradeRateLimitProvider();

/**
 * Set a custom rate limit provider.
 *
 * Use this to inject a distributed implementation (e.g., Redis-based)
 * for multi-instance/serverless deployments.
 *
 * @param next - The new provider to use
 */
export function setNpcTradeRateLimitProvider(
  next: NpcTradeRateLimitProvider,
): void {
  provider = next;
}

/**
 * Get the current provider (for testing purposes).
 */
export function getNpcTradeRateLimitProvider(): NpcTradeRateLimitProvider {
  return provider;
}

/**
 * Reset to the default in-memory provider (for testing purposes).
 */
export function resetNpcTradeRateLimitProvider(): void {
  provider = new InMemoryNpcTradeRateLimitProvider();
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * NPC Trade Rate Limiter
 *
 * Static class providing rate limiting for NPC trades.
 * Uses pluggable provider for extensibility.
 */
export class NpcTradeRateLimiter {
  /**
   * Check if an NPC is allowed to trade based on cooldown and daily limits.
   *
   * Uses configuration from NPC_TRADING_CONFIG:
   * - `minMinutesBetweenTrades`: Cooldown between trades
   * - `maxTradesPerDay`: Daily trade cap
   *
   * @param npcId - The NPC's actor ID
   * @returns true if the NPC can trade, false if rate limited
   */
  static async canTrade(npcId: string): Promise<boolean> {
    const config: NpcTradeRateLimitConfig = {
      maxTradesPerDay: getMaxTradesPerDay(),
      minMinutesBetweenTrades: getMinMinutesBetweenTrades(),
    };

    return provider.canTrade(npcId, config);
  }

  /**
   * Record that an NPC has made a trade.
   * Call this after a successful trade execution.
   *
   * @param npcId - The NPC's actor ID
   */
  static async recordTrade(npcId: string): Promise<void> {
    return provider.recordTrade(npcId);
  }

  /**
   * Reset all rate limiting state.
   * Primarily used for testing scenarios.
   */
  static async resetForTesting(): Promise<void> {
    return provider.resetForTesting();
  }

  /**
   * Get current rate limit stats for an NPC.
   *
   * @param npcId - The NPC's actor ID
   * @returns Stats or null if no data
   */
  static async getStats(npcId: string): Promise<{
    lastTradeTime: number;
    dailyCount: number;
    date: string;
  } | null> {
    return provider.getStats(npcId);
  }

  /**
   * Clean up stale entries from the in-memory provider.
   * No-op if using a custom (distributed) provider.
   *
   * @returns Number of entries cleaned up, or 0 if not applicable
   */
  static cleanupStaleEntries(): number {
    if (provider instanceof InMemoryNpcTradeRateLimitProvider) {
      return provider.cleanupStaleEntries();
    }
    return 0;
  }

  /**
   * Get provider size stats (for monitoring).
   * Returns null if using a custom (distributed) provider.
   */
  static getProviderStats(): {
    lastTradeTime: number;
    dailyTradeCount: number;
  } | null {
    if (provider instanceof InMemoryNpcTradeRateLimitProvider) {
      return provider.getSize();
    }
    return null;
  }
}
