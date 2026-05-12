/**
 * Memory cache for Eliza agent memories and conversation contexts.
 */

import type { Memory, UUID } from "@elizaos/core";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { logger } from "@/lib/utils/logger";

/**
 * Cached room context with messages and participants.
 */
export interface MemoryRoomContext {
  roomId: string;
  messages: Memory[];
  participants: UUID[];
  metadata: Record<string, unknown>;
  depth: number;
  timestamp: Date;
}

/**
 * Cached conversation context with message history and metadata.
 */
export interface ConversationContext {
  conversationId: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    tokens?: number;
    cost?: number;
    createdAt: Date;
  }>;
  totalTokens: number;
  totalCost: number;
  metadata: Record<string, unknown>;
}

/**
 * Search result for memory queries.
 */
export interface SearchResult {
  /** The matching memory. */
  memory: Memory;
  /** Relevance score. */
  score: number;
  /** Optional context memories. */
  context?: Memory[];
}

/**
 * Cache manager for Eliza agent memories and conversation contexts.
 */
export class MemoryCache {
  /**
   * Caches a single memory.
   *
   * @param key - Cache key.
   * @param memory - Memory to cache.
   * @param ttl - Time to live in seconds.
   */
  async cacheMemory(key: string, memory: Memory, ttl: number): Promise<void> {
    await cache.set(key, memory, ttl);
    logger.debug(`[Memory Cache] Cached memory: ${key}`);
  }

  /**
   * Gets a cached memory.
   *
   * @param key - Cache key.
   * @returns Cached memory or null if not found.
   */
  async getMemory(key: string): Promise<Memory | null> {
    const memory = await cache.get<Memory>(key);
    if (memory) {
      logger.debug(`[Memory Cache] HIT: ${key}`);
    } else {
      logger.debug(`[Memory Cache] MISS: ${key}`);
    }
    return memory;
  }

  /**
   * Invalidates all caches for a specific memory.
   *
   * @param memoryId - Memory ID to invalidate.
   */
  async invalidateMemory(memoryId: string): Promise<void> {
    const pattern = `memory:*:${memoryId}:*`;
    await cache.delPattern(pattern);
    logger.debug(`[Memory Cache] Invalidated memory pattern: ${pattern}`);
  }

  /**
   * Caches room context with messages and participants.
   *
   * @param roomId - Room ID.
   * @param organizationId - Organization ID (prevents key collisions).
   * @param context - Room context to cache.
   * @param ttl - Time to live in seconds.
   */
  async cacheRoomContext(
    roomId: string,
    organizationId: string,
    context: MemoryRoomContext,
    ttl: number,
  ): Promise<void> {
    const key = `memory:${organizationId}:room:${roomId}:context:${context.depth}:v1`;
    await cache.set(
      key,
      {
        ...context,
        timestamp: context.timestamp.toISOString(),
      },
      ttl,
    );
    logger.debug(`[Memory Cache] Cached room context: ${key}`);
  }

  /**
   * Gets cached room context.
   *
   * @param roomId - Room ID.
   * @param organizationId - Organization ID.
   * @returns Cached room context or null if not found.
   */
  async getRoomContext(roomId: string, organizationId: string): Promise<MemoryRoomContext | null> {
    const keys = await this.getRoomContextKeys(roomId, organizationId);
    for (const key of keys) {
      const cached = await cache.get<MemoryRoomContext & { timestamp: string }>(key);
      if (cached) {
        logger.debug(`[Memory Cache] Room context HIT: ${key}`);
        return {
          ...cached,
          timestamp: new Date(cached.timestamp),
        };
      }
    }
    logger.debug(`[Memory Cache] Room context MISS: ${roomId}`);
    return null;
  }

  /**
   * Invalidates all caches for a room.
   *
   * @param roomId - Room ID.
   * @param organizationId - Organization ID.
   */
  async invalidateRoom(roomId: string, organizationId: string): Promise<void> {
    const pattern = `memory:${organizationId}:room:${roomId}:*`;
    await cache.delPattern(pattern);
    logger.debug(`[Memory Cache] Invalidated room pattern: ${pattern}`);
  }

  /**
   * Caches conversation context with message history.
   *
   * @param conversationId - Conversation ID.
   * @param context - Conversation context to cache.
   * @param ttl - Time to live in seconds.
   */
  async cacheConversationContext(
    conversationId: string,
    context: ConversationContext,
    ttl: number,
  ): Promise<void> {
    const key = `memory:conv:${conversationId}:context:v1`;
    await cache.set(
      key,
      {
        ...context,
        messages: context.messages.map((m) => ({
          ...m,
          createdAt: m.createdAt.toISOString(),
        })),
      },
      ttl,
    );
    logger.debug(`[Memory Cache] Cached conversation context: ${key}`);
  }

  /**
   * Gets cached conversation context.
   *
   * @param conversationId - Conversation ID.
   * @returns Cached conversation context or null if not found.
   */
  async getConversationContext(conversationId: string): Promise<ConversationContext | null> {
    const key = `memory:conv:${conversationId}:context:v1`;
    const cached = await cache.get<
      ConversationContext & {
        messages: Array<ConversationContext["messages"][0] & { createdAt: string }>;
      }
    >(key);
    if (cached) {
      logger.debug(`[Memory Cache] Conversation context HIT: ${key}`);
      return {
        ...cached,
        messages: cached.messages.map((m) => ({
          ...m,
          createdAt: new Date(m.createdAt),
        })),
      };
    }
    logger.debug(`[Memory Cache] Conversation context MISS: ${key}`);
    return null;
  }

  /**
   * Bulk caches multiple memories.
   *
   * @param memories - Map of cache keys to memories.
   */
  async cacheMemories(memories: Map<string, Memory>): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [key, memory] of memories) {
      promises.push(cache.set(key, memory, CacheTTL.memory.item));
    }
    await Promise.all(promises);
    logger.debug(`[Memory Cache] Bulk cached ${memories.size} memories`);
  }

  /**
   * Bulk gets multiple memories.
   *
   * @param keys - Array of cache keys.
   * @returns Map of cache keys to memories (only includes found memories).
   */
  async getMemories(keys: string[]): Promise<Map<string, Memory>> {
    const values = await cache.mget<Memory>(keys);
    const result = new Map<string, Memory>();

    values.forEach((value, index) => {
      if (value !== null) {
        result.set(keys[index], value);
      }
    });

    logger.debug(`[Memory Cache] Bulk retrieved ${result.size}/${keys.length} memories`);
    return result;
  }

  /**
   * Caches memory search results.
   *
   * @param queryHash - Hash of the search query.
   * @param results - Search results to cache.
   * @param ttl - Time to live in seconds.
   */
  async cacheSearchResults(queryHash: string, results: SearchResult[], ttl: number): Promise<void> {
    const key = `memory:search:${queryHash}:v1`;
    await cache.set(key, results, ttl);
    logger.debug(`[Memory Cache] Cached search results: ${key} (${results.length} results)`);
  }

  /**
   * Gets cached memory search results.
   *
   * @param queryHash - Hash of the search query.
   * @returns Cached search results or null if not found.
   */
  async getSearchResults(queryHash: string): Promise<SearchResult[] | null> {
    const key = `memory:search:${queryHash}:v1`;
    const results = await cache.get<SearchResult[]>(key);
    if (results) {
      logger.debug(`[Memory Cache] Search results HIT: ${key}`);
    } else {
      logger.debug(`[Memory Cache] Search results MISS: ${key}`);
    }
    return results;
  }

  /**
   * Invalidates all memory caches for an organization.
   *
   * @param orgId - Organization ID.
   */
  async invalidateOrganization(orgId: string): Promise<void> {
    const pattern = CacheKeys.memory.orgPattern(orgId);
    await cache.delPattern(pattern);
    logger.info(`[Memory Cache] Invalidated organization: ${orgId}`);
  }

  /**
   * Invalidates all caches for a conversation.
   *
   * @param conversationId - Conversation ID.
   */
  async invalidateConversation(conversationId: string): Promise<void> {
    const pattern = `memory:*:conv:${conversationId}:*`;
    await cache.delPattern(pattern);
    logger.debug(`[Memory Cache] Invalidated conversation pattern: ${pattern}`);
  }

  private async getRoomContextKeys(roomId: string, organizationId: string): Promise<string[]> {
    return [
      `memory:${organizationId}:room:${roomId}:context:20:v1`,
      `memory:${organizationId}:room:${roomId}:context:50:v1`,
      `memory:${organizationId}:room:${roomId}:context:100:v1`,
    ];
  }
}

export const memoryCache = new MemoryCache();
