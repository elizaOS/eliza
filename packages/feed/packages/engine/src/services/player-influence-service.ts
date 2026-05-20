/**
 * Player Influence Service
 *
 * Handles light player influence on the narrative:
 * - Player mentions of NPCs boost response probability
 * - Large player trades add to NPC memory
 *
 * Uses an in-memory LRU cache for mention tracking. This cache is local to each
 * process instance, which is acceptable since mention boost is a soft preference.
 */

import { db, eq, organizations } from "@feed/db";
import { logger } from "@feed/shared";
import { formatError } from "../utils/error-utils";
import { npcMemoryService } from "./npc-memory-service";
import { StaticDataRegistry } from "./static-data-registry";

/**
 * Threshold for a "significant" trade (in game currency)
 */
const SIGNIFICANT_TRADE_THRESHOLD = 1000;

/**
 * Threshold for a "large" trade that warrants special mention
 */
const LARGE_TRADE_THRESHOLD = 5000;

/**
 * How long a mention stays "recent" (in seconds for Redis TTL)
 */
const MENTION_RECENCY_SECONDS = 30 * 60; // 30 minutes

/**
 * Maximum number of mentions to track in memory fallback (LRU cache bound)
 */
const MAX_MENTION_CACHE_SIZE = 1000;

/**
 * LRU Cache for recent mentions with bounded size.
 * When max size is reached, oldest entries are evicted.
 */
class LRUMentionCache {
  private cache = new Map<string, Date>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  set(actorId: string, timestamp: Date): void {
    // Delete first to reset position for LRU
    if (this.cache.has(actorId)) {
      this.cache.delete(actorId);
    }

    // Evict oldest entries if at max size
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }

    this.cache.set(actorId, timestamp);
  }

  get(actorId: string): Date | undefined {
    const value = this.cache.get(actorId);
    if (value) {
      // Move to end for LRU (most recently accessed)
      this.cache.delete(actorId);
      this.cache.set(actorId, value);
    }
    return value;
  }

  delete(actorId: string): boolean {
    return this.cache.delete(actorId);
  }

  entries(): IterableIterator<[string, Date]> {
    return this.cache.entries();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * In-memory fallback cache (used when Redis is unavailable)
 *
 * NOTE: This cache is local to each process instance. In multi-process or
 * serverless deployments, each instance maintains its own separate cache.
 * This means:
 * - wasMentionedRecentlySync/wasMentionedRecently are only reliable within a single process
 * - getRecentlyMentionedActorIds returns mentions from the local instance only
 * - For true cross-instance mention tracking, Redis-backed storage would be needed
 *
 * This is intentional for simplicity and performance. The mention boost is a
 * soft preference, not a critical feature, so local-only semantics are acceptable.
 */
const memoryFallbackCache = new LRUMentionCache(MAX_MENTION_CACHE_SIZE);

/**
 * Record a player mention in the in-memory cache.
 * Exported for testing purposes.
 */
export async function recordMention(
  actorId: string,
  timestamp: Date,
): Promise<void> {
  // Always update local fallback cache for wasMentionedRecentlySync to work
  // This ensures sync checks work even when Redis is the primary store
  memoryFallbackCache.set(actorId, timestamp);

  // NOTE: This engine package intentionally does not depend on @feed/api (Redis cache).
  // Mention tracking uses the in-memory fallback only. The mention boost is a soft preference,
  // so local-only semantics are acceptable.
}

/**
 * Get the last mention timestamp for an actor
 */
async function getMentionTimestamp(actorId: string): Promise<Date | null> {
  // Check in-memory fallback (could have been set before Redis connected or if Redis failed)
  const memoryValue = memoryFallbackCache.get(actorId);
  return memoryValue ?? null;
}

/**
 * Remove a mention from the cache
 */
async function removeMention(actorId: string): Promise<void> {
  memoryFallbackCache.delete(actorId);
}

/**
 * Handle a player mentioning an NPC in a post or comment
 */
export async function handlePlayerMention(
  playerId: string,
  mentionedActorId: string,
  postId: string,
): Promise<void> {
  try {
    // Use a single timestamp for both operations to ensure consistency
    const now = new Date();

    // 1. Record the mention in cache for probability boost (Redis with fallback)
    await recordMention(mentionedActorId, now);

    // 2. Add to NPC's memory
    await npcMemoryService.addMemory(mentionedActorId, {
      type: "mentioned_by",
      timestamp: now.toISOString(),
      summary: `Was mentioned by a player in a post`,
      actorIds: [playerId],
      sentiment: 0.1, // Slight positive (attention is good)
    });

    logger.info(
      `Player ${playerId} mentioned NPC ${mentionedActorId}`,
      { playerId, mentionedActorId, postId },
      "PlayerInfluence",
    );
  } catch (error) {
    logger.error(
      `Failed to handle player mention`,
      {
        playerId,
        mentionedActorId,
        error: formatError(error),
      },
      "PlayerInfluence",
    );
  }
}

/**
 * Check if an actor was mentioned recently (for probability boost)
 */
export async function wasMentionedRecently(actorId: string): Promise<boolean> {
  const lastMention = await getMentionTimestamp(actorId);
  if (!lastMention) return false;

  const now = new Date();
  const isRecent =
    now.getTime() - lastMention.getTime() < MENTION_RECENCY_SECONDS * 1000;

  // Clean up old entries
  if (!isRecent) {
    await removeMention(actorId);
  }

  return isRecent;
}

/**
 * Synchronous check for recently mentioned (uses in-memory cache only)
 * Use this when async is not possible (e.g., in probability calculations)
 */
export function wasMentionedRecentlySync(actorId: string): boolean {
  const lastMention = memoryFallbackCache.get(actorId);
  if (!lastMention) return false;

  const now = new Date();
  const isRecent =
    now.getTime() - lastMention.getTime() < MENTION_RECENCY_SECONDS * 1000;

  // Clean up old entries
  if (!isRecent) {
    memoryFallbackCache.delete(actorId);
  }

  return isRecent;
}

/**
 * Get all recently mentioned actor IDs
 */
export async function getRecentlyMentionedActorIds(): Promise<string[]> {
  const now = new Date();
  const recentIds: string[] = [];

  // In-memory cache
  // Collect IDs to delete separately to avoid modifying Map during iteration
  const idsToDelete: string[] = [];
  for (const [actorId, lastMention] of memoryFallbackCache.entries()) {
    if (
      now.getTime() - lastMention.getTime() <
      MENTION_RECENCY_SECONDS * 1000
    ) {
      recentIds.push(actorId);
    } else {
      idsToDelete.push(actorId);
    }
  }

  // Clean up old entries after iteration
  for (const id of idsToDelete) {
    memoryFallbackCache.delete(id);
  }

  return recentIds;
}

/**
 * Handle a significant player trade
 * Uses batch memory updates to avoid N+1 query pattern
 */
export async function handlePlayerTrade(
  playerId: string,
  stockTicker: string,
  side: "long" | "short",
  size: number,
): Promise<void> {
  // Only process significant trades
  if (size < SIGNIFICANT_TRADE_THRESHOLD) {
    return;
  }

  try {
    // Find NPCs affiliated with this stock's organization
    const relevantNpcs = await getNpcsAffiliatedWith(stockTicker);

    if (relevantNpcs.length === 0) {
      return;
    }

    // Use batch method to add memory to all NPCs at once
    // This reduces N+1 queries by fetching all states in one query
    const successCount = await npcMemoryService.addMemoryBatch(relevantNpcs, {
      type: "witnessed_event",
      timestamp: new Date().toISOString(),
      summary: `A player took a ${size >= LARGE_TRADE_THRESHOLD ? "large " : ""}${side} position on ${stockTicker}`,
      actorIds: [playerId],
      sentiment: side === "long" ? 0.1 : -0.1,
    });

    logger.info(
      `Player trade recorded for ${successCount}/${relevantNpcs.length} NPCs`,
      {
        playerId,
        stockTicker,
        side,
        size,
        affectedNpcs: relevantNpcs.length,
        successCount,
      },
      "PlayerInfluence",
    );
  } catch (error) {
    logger.error(
      `Failed to handle player trade`,
      {
        playerId,
        stockTicker,
        error: formatError(error),
      },
      "PlayerInfluence",
    );
  }
}

/**
 * Get NPC IDs affiliated with a stock ticker's organization.
 * Uses StaticDataRegistry to find actors whose affiliations include the organization.
 *
 * Note: Returns empty array if StaticDataRegistry is not yet initialized,
 * which can happen during early startup. This is intentional - player influence
 * is a non-critical enhancement and should not block or fail.
 */
async function getNpcsAffiliatedWith(stockTicker: string): Promise<string[]> {
  // Check if StaticDataRegistry is initialized
  // getAllActors() returns empty array if not initialized
  const allActors = StaticDataRegistry.getAllActors();
  if (allActors.length === 0) {
    logger.debug(
      "StaticDataRegistry not yet initialized, skipping NPC affiliation lookup",
      { stockTicker },
      "PlayerInfluence",
    );
    return [];
  }

  // Get the organization for this ticker
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.ticker, stockTicker))
    .limit(1);

  if (!org) {
    return [];
  }

  // Find actors affiliated with this organization using static data
  const affiliatedActorIds = allActors
    .filter((actor) => actor.affiliations.includes(org.id))
    .map((actor) => actor.id);

  return affiliatedActorIds;
}

/**
 * Extract mentions from post content
 * Returns unique usernames in first-seen order
 * Ignores email-like patterns (e.g., user@example.com)
 */
export function extractMentions(content: string): string[] {
  // Match @username patterns only when preceded by start of string or whitespace
  // This prevents matching the domain part of email addresses
  const mentionPattern = /(?:^|[\s])@([a-zA-Z0-9_-]+)/g;
  const matches = content.matchAll(mentionPattern);
  const seen = new Set<string>();
  const mentions: string[] = [];

  for (const match of matches) {
    if (match[1] && !seen.has(match[1])) {
      seen.add(match[1]);
      mentions.push(match[1]);
    }
  }

  return mentions;
}

/**
 * Player Influence Service class
 */
export class PlayerInfluenceService {
  async handleMention(
    playerId: string,
    mentionedActorId: string,
    postId: string,
  ): Promise<void> {
    return handlePlayerMention(playerId, mentionedActorId, postId);
  }

  async handleTrade(
    playerId: string,
    stockTicker: string,
    side: "long" | "short",
    size: number,
  ): Promise<void> {
    return handlePlayerTrade(playerId, stockTicker, side, size);
  }

  /**
   * Record a mention in the in-memory cache.
   * Use this for testing or when you only need to record the mention
   * without adding to NPC memory.
   */
  async recordMention(actorId: string, timestamp: Date): Promise<void> {
    return recordMention(actorId, timestamp);
  }

  async wasMentionedRecently(actorId: string): Promise<boolean> {
    return wasMentionedRecently(actorId);
  }

  wasMentionedRecentlySync(actorId: string): boolean {
    return wasMentionedRecentlySync(actorId);
  }

  async getRecentlyMentionedActorIds(): Promise<string[]> {
    return getRecentlyMentionedActorIds();
  }

  extractMentions(content: string): string[] {
    return extractMentions(content);
  }
}

// Singleton instance
export const playerInfluenceService = new PlayerInfluenceService();
