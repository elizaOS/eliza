/**
 * Agent state cache for Eliza agent runtime data.
 */

import type { Memory, UUID } from "@elizaos/core";
import type { ElizaCharacter } from "@/lib/types/eliza-character";
import { logger } from "@/lib/utils/logger";
import { cache as cacheClient } from "./client";
import { CacheKeys, CacheTTL } from "./keys";

/**
 * Serializable message format for caching.
 */
export interface SerializableMessage {
  id: string;
  entityId: string;
  agentId: string;
  roomId: string;
  content: {
    text?: string;
    action?: string;
    source?: string;
  };
  createdAt: number;
}

/**
 * Room context with messages and participants.
 */
export interface RoomContext {
  roomId: string;
  messages: Memory[];
  participants: string[];
  metadata: Record<string, unknown>;
  lastActivity: Date;
}

interface SerializableRoomContext {
  roomId: string;
  messages: SerializableMessage[];
  participants: string[];
  metadata: Record<string, unknown>;
  lastActivity: string;
}

/**
 * User session data for agent interactions.
 */
export interface UserSession {
  entityId: string;
  preferences: Record<string, unknown>;
  activeRooms: string[];
  lastActivity: Date;
}

/**
 * Statistics for an agent deployment.
 */
export interface AgentStats {
  agentId: string;
  messageCount: number;
  roomCount: number;
  lastActiveAt: Date | null;
  uptime: number;
  status: "deployed" | "stopped" | "draft";
}

/**
 * Cache manager for agent state including room contexts, character data, and user sessions.
 */
export class AgentStateCache {
  /**
   * Get cached room context for agent conversations
   * @param roomId - Room/conversation ID
   * @returns Cached context or null if not found
   */
  async getRoomContext(roomId: string): Promise<RoomContext | null> {
    const key = CacheKeys.agent.roomContext(roomId);

    // Cache client now handles JSON.parse internally
    const cached = await cacheClient.get<SerializableRoomContext>(key);
    if (!cached) return null;

    const serialized = cached;

    // Convert back to RoomContext with Memory objects
    const context: RoomContext = {
      roomId: serialized.roomId,
      messages: serialized.messages.map(
        (msg) =>
          ({
            id: msg.id as UUID,
            entityId: msg.entityId as UUID,
            agentId: msg.agentId as UUID,
            roomId: msg.roomId as UUID,
            content: msg.content,
            createdAt: msg.createdAt,
          }) as Memory,
      ),
      participants: serialized.participants,
      metadata: serialized.metadata,
      lastActivity: new Date(serialized.lastActivity),
    };

    return context;
  }

  /**
   * Cache room context for fast retrieval
   * @param roomId - Room/conversation ID
   * @param context - Room context data
   */
  async setRoomContext(roomId: string, context: RoomContext): Promise<void> {
    const key = CacheKeys.agent.roomContext(roomId);

    // Convert Memory objects to serializable format
    const serializable: SerializableRoomContext = {
      roomId: context.roomId,
      messages: context.messages.map((msg) => ({
        id: msg.id?.toString() || "",
        entityId: msg.entityId?.toString() || "",
        agentId: msg.agentId?.toString() || "",
        roomId: msg.roomId?.toString() || "",
        content: (() => {
          if (typeof msg.content === "object" && msg.content !== null) {
            const content = msg.content as {
              text?: string;
              action?: string;
              source?: string;
            };
            return {
              text: typeof content.text === "string" ? content.text : String(msg.content),
              action: typeof content.action === "string" ? content.action : undefined,
              source: typeof content.source === "string" ? content.source : undefined,
            };
          }
          return {
            text: String(msg.content),
            action: undefined,
            source: undefined,
          };
        })(),
        createdAt: msg.createdAt || Date.now(),
      })),
      participants: context.participants,
      metadata: context.metadata,
      lastActivity: context.lastActivity.toISOString(),
    };

    // Cache client now handles JSON.stringify internally
    await cacheClient.set(key, serializable, CacheTTL.agent.roomContext);
    logger.debug(`[Agent State Cache] Cached room context for ${roomId}`);
  }

  /**
   * Invalidate room context cache
   * @param roomId - Room to invalidate
   */
  async invalidateRoomContext(roomId: string): Promise<void> {
    const key = CacheKeys.agent.roomContext(roomId);

    await cacheClient.del(key);
    logger.debug(`[Agent State Cache] Invalidated room context for ${roomId}`);
  }

  /**
   * Get cached character data (expensive to load from DB)
   * @param agentId - Agent/character ID
   * @returns Cached character or null if not found
   */
  async getCharacterData(agentId: string): Promise<ElizaCharacter | null> {
    const key = CacheKeys.agent.characterData(agentId);

    const cached = await cacheClient.get<ElizaCharacter>(key);
    if (!cached) return null;

    return cached;
  }

  /**
   * Cache character data for fast retrieval
   * @param agentId - Agent/character ID
   * @param character - Character data
   */
  async setCharacterData(agentId: string, character: ElizaCharacter): Promise<void> {
    const key = CacheKeys.agent.characterData(agentId);

    await cacheClient.set(key, character, CacheTTL.agent.characterData);
    logger.debug(`[Agent State Cache] Cached character data for ${agentId}`);
  }

  /**
   * Invalidate character data cache
   * @param agentId - Agent to invalidate
   */
  async invalidateCharacterData(agentId: string): Promise<void> {
    const key = CacheKeys.agent.characterData(agentId);

    await cacheClient.del(key);
    logger.debug(`[Agent State Cache] Invalidated character data for ${agentId}`);
  }

  /**
   * Get cached user session state
   * @param entityId - User/entity ID
   * @returns Cached session or null if not found
   */
  async getUserSession(entityId: string): Promise<UserSession | null> {
    const key = CacheKeys.agent.userSession(entityId);

    const cached = await cacheClient.get<UserSession & { lastActivity: string }>(key);
    if (!cached) return null;

    const session: UserSession = {
      ...cached,
      lastActivity: new Date(cached.lastActivity),
    };
    return session;
  }

  /**
   * Cache user session state
   * @param entityId - User/entity ID
   * @param session - Session data
   */
  async setUserSession(entityId: string, session: UserSession): Promise<void> {
    const key = CacheKeys.agent.userSession(entityId);

    await cacheClient.set(key, session, CacheTTL.agent.userSession);
    logger.debug(`[Agent State Cache] Cached user session for ${entityId}`);
  }

  /**
   * Get cached agent statistics
   * @param agentId - Agent ID
   * @returns Cached stats or null if not found
   */
  async getAgentStats(agentId: string): Promise<AgentStats | null> {
    const key = CacheKeys.agent.agentStats(agentId);

    const cached = await cacheClient.get<AgentStats & { lastActiveAt: string | null }>(key);
    if (!cached) return null;

    try {
      // Check if cached data has the roomCount field (v2 schema)
      // If not, treat as cache miss so we refetch fresh data
      if (typeof cached.roomCount !== "number") {
        logger.debug(
          `[Agent State Cache] Stale cache data for ${agentId} (missing roomCount), treating as miss`,
        );
        // Invalidate the stale cache entry
        await cacheClient.del(key);
        return null;
      }

      const stats: AgentStats = {
        ...cached,
        lastActiveAt: cached.lastActiveAt ? new Date(cached.lastActiveAt) : null,
      };
      return stats;
    } catch (error) {
      logger.error(`[Agent State Cache] Error getting agent stats for ${agentId}:`, error);
      return null;
    }
  }

  /**
   * Cache agent statistics
   * @param agentId - Agent ID
   * @param stats - Statistics data
   */
  async setAgentStats(agentId: string, stats: AgentStats): Promise<void> {
    const key = CacheKeys.agent.agentStats(agentId);

    await cacheClient.set(key, stats, CacheTTL.agent.agentStats);
  }

  /**
   * Get cached agent statistics for multiple agents in a single batch operation
   * Uses Redis MGET for efficiency instead of sequential calls
   * @param agentIds - Array of agent IDs
   * @returns Map of agentId to stats (null values for cache misses)
   */
  async getAgentStatsBatch(agentIds: string[]): Promise<Map<string, AgentStats | null>> {
    const result = new Map<string, AgentStats | null>();
    if (agentIds.length === 0) return result;

    const keys = agentIds.map((id) => CacheKeys.agent.agentStats(id));
    const cachedValues = await cacheClient.mget<AgentStats & { lastActiveAt: string | null }>(keys);

    const staleKeys: string[] = [];

    for (let i = 0; i < agentIds.length; i++) {
      const agentId = agentIds[i];
      const cached = cachedValues[i];

      if (!cached) {
        result.set(agentId, null);
        continue;
      }

      // Validate cache schema (v2 has roomCount)
      if (typeof cached.roomCount !== "number") {
        logger.debug(
          `[Agent State Cache] Stale cache data for ${agentId} (missing roomCount), treating as miss`,
        );
        staleKeys.push(keys[i]);
        result.set(agentId, null);
        continue;
      }

      const stats: AgentStats = {
        ...cached,
        lastActiveAt: cached.lastActiveAt ? new Date(cached.lastActiveAt) : null,
      };
      result.set(agentId, stats);
    }

    // Clean up stale cache entries in parallel
    if (staleKeys.length > 0) {
      await Promise.all(staleKeys.map((key) => cacheClient.del(key)));
    }

    return result;
  }

  /**
   * Get cached agent list
   * @param orgId - Organization ID
   * @param filterHash - Hash of filter parameters
   * @returns Cached agent list or null if not found
   */
  async getAgentList<TAgentListItem>(
    orgId: string,
    filterHash: string,
  ): Promise<TAgentListItem[] | null> {
    const key = CacheKeys.agent.agentList(orgId, filterHash);

    const cached = await cacheClient.get<TAgentListItem[]>(key);
    if (!cached) return null;

    return cached;
  }

  /**
   * Cache agent list
   * @param orgId - Organization ID
   * @param filterHash - Hash of filter parameters
   * @param agents - Agent list data
   */
  async setAgentList<TAgentListItem>(
    orgId: string,
    filterHash: string,
    agents: TAgentListItem[],
  ): Promise<void> {
    const key = CacheKeys.agent.agentList(orgId, filterHash);

    await cacheClient.set(key, agents, CacheTTL.agent.agentList);
    logger.debug(`[Agent State Cache] Cached agent list for ${orgId} (${agents.length} agents)`);
  }

  /**
   * Invalidate agent list cache for organization
   * @param orgId - Organization ID
   */
  async invalidateAgentList(orgId: string): Promise<void> {
    // Need to invalidate all variations of filter hashes
    // In production, you might want to track filter hashes or use a pattern delete
    logger.debug(`[Agent State Cache] Invalidating agent lists for org ${orgId}`);
    // For now, we rely on TTL expiry
    // Could implement pattern matching delete if needed
  }
}

// Export singleton instance
export const agentStateCache = new AgentStateCache();
