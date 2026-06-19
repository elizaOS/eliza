/**
 * Event Cache Service
 *
 * Redis-backed cache for fast event lookup during NPC ticks.
 * Uses sorted sets for time-ordered and priority-ordered access.
 *
 * Design:
 * - events:recent - sorted set with timestamp as score
 * - events:priority - sorted set with priority score (severity × recency)
 * - events:by-org:{orgId} - events affecting specific org
 * - event:data:{eventId} - full event data as JSON
 * - TTL: 24 hours (events older than this rarely need reactions)
 */

import { logger } from "@feed/shared";
import { getRedisClient } from "../redis/client";

const RECENT_EVENTS_KEY = "events:recent";
const PRIORITY_EVENTS_KEY = "events:priority";
const ORG_EVENTS_PREFIX = "events:by-org:";
const EVENT_DATA_PREFIX = "event:data:";
const EVENT_TTL_SECONDS = 86400; // 24 hours

export interface CachedEvent {
  id: string;
  eventType: string;
  description: string;
  actors: string[];
  affectedOrgIds: string[];
  severity: number;
  timestamp: number;
  pointsToward: "YES" | "NO" | null;
}

/**
 * Calculate priority score for an event.
 * Higher score = higher priority.
 * Formula: (severity × 1000) + recencyBonus
 */
function calculatePriorityScore(severity: number, timestamp: number): number {
  const now = Date.now();
  const hoursAgo = (now - timestamp) / (1000 * 60 * 60);
  const recencyBonus = Math.max(0, 1000 - hoursAgo * 50); // Decays over 20 hours
  return severity * 1000 + recencyBonus;
}

export class EventCacheService {
  /**
   * Cache an event when it's created.
   * Called from NarrativeEventProcessor after inserting to DB.
   */
  async cacheEvent(event: CachedEvent): Promise<boolean> {
    const client = getRedisClient();
    if (!client) {
      logger.debug(
        "Redis unavailable, skipping event cache",
        {},
        "EventCacheService",
      );
      return false;
    }

    try {
      const pipeline = client.pipeline();

      // Store event data with TTL
      const dataKey = `${EVENT_DATA_PREFIX}${event.id}`;
      pipeline.set(dataKey, JSON.stringify(event), "EX", EVENT_TTL_SECONDS);

      // Add to recent events sorted set (score = timestamp)
      pipeline.zadd(RECENT_EVENTS_KEY, event.timestamp, event.id);
      pipeline.expire(RECENT_EVENTS_KEY, EVENT_TTL_SECONDS);

      // Add to priority queue (score = priority)
      const priority = calculatePriorityScore(event.severity, event.timestamp);
      pipeline.zadd(PRIORITY_EVENTS_KEY, priority, event.id);
      pipeline.expire(PRIORITY_EVENTS_KEY, EVENT_TTL_SECONDS);

      // Add to per-org indexes
      for (const orgId of event.affectedOrgIds) {
        const orgKey = `${ORG_EVENTS_PREFIX}${orgId}`;
        pipeline.zadd(orgKey, event.timestamp, event.id);
        pipeline.expire(orgKey, EVENT_TTL_SECONDS);
      }

      await pipeline.exec();

      logger.debug(
        "Cached event",
        {
          eventId: event.id,
          severity: event.severity,
          orgs: event.affectedOrgIds.length,
        },
        "EventCacheService",
      );
      return true;
    } catch (error) {
      logger.warn(
        "Failed to cache event",
        {
          eventId: event.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "EventCacheService",
      );
      return false;
    }
  }

  /**
   * Get high-priority events that need reactions.
   * Returns events sorted by priority (highest first).
   */
  async getHighPriorityEvents(limit: number = 10): Promise<CachedEvent[]> {
    const client = getRedisClient();
    if (!client) return [];

    try {
      // Get top N event IDs by priority score (descending)
      const eventIds = await client.zrevrange(
        PRIORITY_EVENTS_KEY,
        0,
        limit - 1,
      );
      if (eventIds.length === 0) return [];

      // Fetch event data
      const pipeline = client.pipeline();
      for (const id of eventIds) {
        pipeline.get(`${EVENT_DATA_PREFIX}${id}`);
      }
      const results = await pipeline.exec();

      const events: CachedEvent[] = [];
      for (const [err, data] of results ?? []) {
        if (!err && typeof data === "string") {
          try {
            events.push(JSON.parse(data) as CachedEvent);
          } catch {
            // Skip invalid JSON
          }
        }
      }

      return events;
    } catch (error) {
      logger.warn(
        "Failed to get priority events",
        { error: error instanceof Error ? error.message : String(error) },
        "EventCacheService",
      );
      return [];
    }
  }

  /**
   * Get recent events affecting a specific organization.
   */
  async getEventsForOrg(
    orgId: string,
    limit: number = 20,
  ): Promise<CachedEvent[]> {
    const client = getRedisClient();
    if (!client) return [];

    try {
      const orgKey = `${ORG_EVENTS_PREFIX}${orgId}`;
      const eventIds = await client.zrevrange(orgKey, 0, limit - 1);
      if (eventIds.length === 0) return [];

      const pipeline = client.pipeline();
      for (const id of eventIds) {
        pipeline.get(`${EVENT_DATA_PREFIX}${id}`);
      }
      const results = await pipeline.exec();

      const events: CachedEvent[] = [];
      for (const [err, data] of results ?? []) {
        if (!err && typeof data === "string") {
          try {
            events.push(JSON.parse(data) as CachedEvent);
          } catch {
            // Skip invalid JSON
          }
        }
      }

      return events;
    } catch (error) {
      logger.warn(
        "Failed to get org events",
        {
          orgId,
          error: error instanceof Error ? error.message : String(error),
        },
        "EventCacheService",
      );
      return [];
    }
  }

  /**
   * Get recent events within time window (for fallback/verification).
   */
  async getRecentEvents(
    lookbackHours: number = 12,
    limit: number = 50,
  ): Promise<CachedEvent[]> {
    const client = getRedisClient();
    if (!client) return [];

    try {
      const minScore = Date.now() - lookbackHours * 60 * 60 * 1000;
      const eventIds = await client.zrangebyscore(
        RECENT_EVENTS_KEY,
        minScore,
        "+inf",
        "LIMIT",
        0,
        limit,
      );

      if (eventIds.length === 0) return [];

      const pipeline = client.pipeline();
      for (const id of eventIds) {
        pipeline.get(`${EVENT_DATA_PREFIX}${id}`);
      }
      const results = await pipeline.exec();

      const events: CachedEvent[] = [];
      for (const [err, data] of results ?? []) {
        if (!err && typeof data === "string") {
          try {
            events.push(JSON.parse(data) as CachedEvent);
          } catch {
            // Skip invalid JSON
          }
        }
      }

      return events;
    } catch (error) {
      logger.warn(
        "Failed to get recent events",
        {
          lookbackHours,
          error: error instanceof Error ? error.message : String(error),
        },
        "EventCacheService",
      );
      return [];
    }
  }

  /**
   * Remove an event from priority queue after it's been addressed.
   * Called after sufficient NPCs have reacted.
   */
  async deprioritizeEvent(eventId: string): Promise<void> {
    const client = getRedisClient();
    if (!client) return;

    try {
      // Remove from priority queue but keep in recent events
      await client.zrem(PRIORITY_EVENTS_KEY, eventId);
      logger.debug("Deprioritized event", { eventId }, "EventCacheService");
    } catch (error) {
      logger.debug(
        "Failed to deprioritize event",
        {
          eventId,
          error: error instanceof Error ? error.message : String(error),
        },
        "EventCacheService",
      );
    }
  }

  /**
   * Clean up old events (run periodically).
   */
  async cleanup(): Promise<void> {
    const client = getRedisClient();
    if (!client) return;

    try {
      const cutoff = Date.now() - EVENT_TTL_SECONDS * 1000;
      await client.zremrangebyscore(RECENT_EVENTS_KEY, 0, cutoff);
      // Priority queue uses a different scale, but old entries will naturally
      // have low scores and can be cleaned up similarly
      logger.debug("Cleaned up old events", {}, "EventCacheService");
    } catch (error) {
      logger.debug(
        "Failed to cleanup events",
        { error: error instanceof Error ? error.message : String(error) },
        "EventCacheService",
      );
    }
  }

  /**
   * Get the number of events in the priority queue.
   */
  async getPriorityQueueSize(): Promise<number> {
    const client = getRedisClient();
    if (!client) return 0;

    try {
      return await client.zcard(PRIORITY_EVENTS_KEY);
    } catch {
      return 0;
    }
  }
}

export const eventCacheService = new EventCacheService();
