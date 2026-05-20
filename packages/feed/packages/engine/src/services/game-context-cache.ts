/**
 * Game Context Cache
 *
 * @description Centralized caching for shared game context across cron jobs.
 * Provides consistent game state, world facts, and active events to prevent
 * duplicate database queries from game-tick, markets-tick, npc-tick, etc.
 *
 * Uses in-memory caching with appropriate TTLs. Each cache entry expires
 * after its TTL to ensure fresh data while reducing database load.
 *
 * **IMPORTANT: Per-Process Cache Limitation**
 * This cache is in-memory and per-process. It will NOT deduplicate queries
 * across multiple worker instances (e.g., multiple cron job containers or
 * serverless function invocations). Each process maintains its own independent
 * cache with its own TTL timers. If cross-instance deduplication is required,
 * consider migrating to a shared cache solution (e.g., Redis, Memcached) and
 * update callers to use the shared client.
 */

import {
  asc,
  db,
  desc,
  eq,
  games,
  gte,
  inArray,
  questions as questionsSchema,
  worldEvents,
} from '@babylon/db';
import { logger } from '@babylon/shared';

/**
 * Game state from database
 */
export interface GameState {
  id: string;
  isRunning: boolean;
  currentDay: number;
  startedAt: Date | null;
  updatedAt: Date;
}

/**
 * Active question with market metadata
 */
export interface ActiveQuestion {
  id: string;
  questionNumber: number;
  text: string;
  outcome: boolean;
  status: string;
  resolutionDate: Date | null;
  rank: number | null;
}

/**
 * Recent world event
 */
export interface RecentWorldEvent {
  id: string;
  eventType: string;
  description: string;
  dayNumber: number | null;
  timestamp: Date;
  relatedQuestion: number | null;
  pointsToward: string | null;
}

/**
 * Cache entry with expiration
 */
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * Cache TTLs in milliseconds
 */
const CACHE_TTLS = {
  GAME_STATE: 60_000, // 1 minute
  ACTIVE_QUESTIONS: 60_000, // 1 minute
  WORLD_EVENTS: 120_000, // 2 minutes
} as const;

/**
 * GameContextCache - Shared caching for cron jobs
 *
 * Centralizes frequently accessed game data with appropriate TTLs.
 * Prevents duplicate queries when multiple crons run simultaneously.
 */
export class GameContextCache {
  private static cache = new Map<string, CacheEntry<unknown>>();
  private static inFlight = new Map<string, Promise<unknown>>();

  /**
   * Get or fetch data from cache
   *
   * Uses an in-flight tracker to prevent cache stampede - when multiple
   * callers request the same key simultaneously, only one fetch executes.
   */
  private static async getOrFetch<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttlMs: number
  ): Promise<T> {
    const now = Date.now();
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;

    if (entry && entry.expiresAt > now) {
      logger.debug(
        `GameContextCache hit: ${key}`,
        undefined,
        'GameContextCache'
      );
      return entry.data;
    }

    // Check for in-flight request to prevent stampede
    const existingRequest = this.inFlight.get(key) as Promise<T> | undefined;
    if (existingRequest) {
      logger.debug(
        `GameContextCache awaiting in-flight: ${key}`,
        undefined,
        'GameContextCache'
      );
      return existingRequest;
    }

    logger.debug(
      `GameContextCache miss: ${key}`,
      undefined,
      'GameContextCache'
    );

    // Create and track the fetch promise
    const fetchPromise = (async (): Promise<T> => {
      const data = await fetchFn();
      this.cache.set(key, {
        data,
        expiresAt: Date.now() + ttlMs,
      });
      return data;
    })();

    this.inFlight.set(key, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Get the continuous game state
   *
   * @returns GameState or null if no game exists
   */
  static async getGameState(): Promise<GameState | null> {
    return this.getOrFetch(
      'game-state',
      async () => {
        const [game] = await db
          .select({
            id: games.id,
            isRunning: games.isRunning,
            currentDay: games.currentDay,
            startedAt: games.startedAt,
            updatedAt: games.updatedAt,
          })
          .from(games)
          .where(eq(games.isContinuous, true))
          .limit(1);

        return game ?? null;
      },
      CACHE_TTLS.GAME_STATE
    );
  }

  /**
   * Get active questions (not resolved, not pending)
   *
   * @returns Array of active questions
   */
  static async getActiveQuestions(): Promise<ActiveQuestion[]> {
    return this.getOrFetch(
      'active-questions',
      async () => {
        const results = await db
          .select({
            id: questionsSchema.id,
            questionNumber: questionsSchema.questionNumber,
            text: questionsSchema.text,
            outcome: questionsSchema.outcome,
            status: questionsSchema.status,
            resolutionDate: questionsSchema.resolutionDate,
            rank: questionsSchema.rank,
          })
          .from(questionsSchema)
          .where(inArray(questionsSchema.status, ['active', 'traded']))
          .orderBy(
            asc(questionsSchema.questionNumber),
            asc(questionsSchema.id)
          );

        return results;
      },
      CACHE_TTLS.ACTIVE_QUESTIONS
    );
  }

  /**
   * Get recent world events (last 3 days)
   *
   * @returns Array of recent world events, ordered by timestamp descending (newest first)
   */
  static async getRecentWorldEvents(): Promise<RecentWorldEvent[]> {
    return this.getOrFetch(
      'recent-world-events',
      async () => {
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

        const events = await db
          .select({
            id: worldEvents.id,
            eventType: worldEvents.eventType,
            description: worldEvents.description,
            dayNumber: worldEvents.dayNumber,
            timestamp: worldEvents.timestamp,
            relatedQuestion: worldEvents.relatedQuestion,
            pointsToward: worldEvents.pointsToward,
          })
          .from(worldEvents)
          .where(gte(worldEvents.timestamp, threeDaysAgo))
          .orderBy(desc(worldEvents.timestamp))
          .limit(100);

        return events;
      },
      CACHE_TTLS.WORLD_EVENTS
    );
  }

  /**
   * Invalidate a specific cache entry
   *
   * @param key - Cache key to invalidate
   */
  static invalidate(key: string): void {
    this.cache.delete(key);
    logger.debug(
      `GameContextCache invalidated: ${key}`,
      undefined,
      'GameContextCache'
    );
  }

  /**
   * Invalidate all cache entries
   */
  static invalidateAll(): void {
    this.cache.clear();
    logger.debug('GameContextCache cleared all', undefined, 'GameContextCache');
  }

  /**
   * Get cache stats for monitoring
   */
  static getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}
