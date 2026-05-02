/**
 * Character Deployment Discovery Service
 *
 * This service discovers CHARACTERS (user_characters table) with their deployment status.
 * It's NOT about discovering agents - it's about finding characters and checking if they're deployed.
 *
 * Domain Model:
 * - Characters (user_characters) = User-created definitions
 * - Containers (containers) = Deployment infrastructure
 * - Agents (agents) = Running instances (created by elizaOS when container starts)
 *
 * Key Insight: This service operates at the CHARACTER level, not the agent level.
 * It answers questions like "which characters are deployed?" not "which agents exist?"
 */

import { createHash } from "node:crypto";
import type { UserCharacter } from "@/db/repositories";
import { memoriesRepository } from "@/db/repositories";
import { roomsRepository } from "@/db/repositories/agents";
import { type AgentStats, agentStateCache } from "@/lib/cache/agent-state-cache";
import { logger } from "@/lib/utils/logger";
import { charactersService } from "../characters/characters";
import { containersService } from "../containers";

// Re-export AgentStats for convenience
export type { AgentStats };

/**
 * Filters for character discovery.
 */
export interface CharacterDiscoveryFilters {
  deployed?: boolean;
  template?: boolean;
  owned?: boolean;
}

/**
 * Discovered character with deployment information
 *
 * Note: This represents a CHARACTER (from user_characters table), not an Agent.
 * The "status" field indicates if the character has been deployed as an agent.
 */
export interface DiscoveredCharacterInfo {
  // Character identity
  id: string;
  name: string;
  bio: string[];
  plugins: string[];
  avatarUrl?: string;
  isTemplate?: boolean;
  ownerId?: string;

  // Deployment status
  status: "deployed" | "draft" | "stopped";
  deploymentUrl?: string;

  // Runtime statistics (only available when deployed)
  messageCount?: number;
  lastActiveAt?: Date | null;
}

/**
 * Result of listing characters with discovery information.
 */
export interface CharacterListResult {
  characters: DiscoveredCharacterInfo[];
  total: number;
  cached: boolean;
}

export class CharacterDeploymentDiscoveryService {
  /**
   * List all characters with their deployment status
   * @param organizationId - Organization ID
   * @param userId - User ID (for owned filter)
   * @param filters - Optional filters
   * @param includeStats - Include runtime statistics (only for deployed characters)
   * @returns List of characters with deployment info
   */
  async listCharacters(
    organizationId: string,
    userId: string,
    filters?: CharacterDiscoveryFilters,
    includeStats: boolean = false,
  ): Promise<CharacterListResult> {
    // Create filter hash for caching
    const filterHash = this.hashFilters(filters || {});

    // Check cache first
    const cached = await agentStateCache.getAgentList<DiscoveredCharacterInfo>(
      organizationId,
      filterHash,
    );
    if (cached) {
      logger.debug(`[Character Discovery] Cache hit for org ${organizationId}`);
      return {
        characters: cached as DiscoveredCharacterInfo[],
        total: cached.length,
        cached: true,
      };
    }

    logger.debug(`[Character Discovery] Cache miss, fetching for org ${organizationId}`);

    // Fetch characters and containers in parallel
    const [characters, containers] = await Promise.all([
      this.fetchCharacters(organizationId, userId, filters),
      this.fetchContainers(organizationId),
    ]);

    // Build character info with deployment status
    const characterInfos = await Promise.all(
      characters.map((char) => this.buildCharacterInfo(char, containers, includeStats)),
    );

    // Filter by deployment status if requested
    let filteredCharacters = characterInfos;
    if (filters?.deployed !== undefined) {
      filteredCharacters = characterInfos.filter((c) =>
        filters.deployed ? c.status === "deployed" : c.status !== "deployed",
      );
    }

    // Cache the result
    await agentStateCache.setAgentList(organizationId, filterHash, filteredCharacters);

    return {
      characters: filteredCharacters,
      total: filteredCharacters.length,
      cached: false,
    };
  }

  /**
   * Fetch characters based on filters
   */
  private async fetchCharacters(
    organizationId: string,
    userId: string,
    filters?: CharacterDiscoveryFilters,
  ): Promise<UserCharacter[]> {
    if (filters?.template) {
      // Fetch templates
      return await charactersService.listTemplates();
    }

    if (filters?.owned) {
      // Fetch user's own characters
      return await charactersService.listByUser(userId);
    }

    // Fetch all organization characters (including templates)
    const [orgChars, templates] = await Promise.all([
      charactersService.listByOrganization(organizationId),
      charactersService.listTemplates(),
    ]);

    return [...orgChars, ...templates];
  }

  /**
   * Fetch active containers for deployment status
   */
  private async fetchContainers(organizationId: string) {
    return await containersService.listByOrganization(organizationId);
  }

  /**
   * Build DiscoveredCharacterInfo from character and deployment data
   */
  private async buildCharacterInfo(
    character: UserCharacter,
    containers: Awaited<ReturnType<typeof containersService.listByOrganization>>,
    includeStats: boolean,
  ): Promise<DiscoveredCharacterInfo> {
    // Find deployment container by character_id FK
    const container = containers.find(
      (c) => c.character_id === character.id && c.status === "running",
    );

    // Determine deployment status
    let status: "deployed" | "draft" | "stopped" = "draft";
    if (container) {
      status = "deployed";
    } else {
      // Check if there's a stopped container
      const stoppedContainer = containers.find(
        (c) => c.character_id === character.id && c.status !== "running",
      );
      if (stoppedContainer) {
        status = "stopped";
      }
    }

    // Build base character info
    const characterInfo: DiscoveredCharacterInfo = {
      id: character.id,
      name: character.name,
      bio: Array.isArray(character.bio) ? character.bio : [character.bio || ""],
      plugins: character.plugins || [],
      status,
      isTemplate: character.is_template || false,
      ownerId: character.user_id,
      ...(container?.load_balancer_url && {
        deploymentUrl: container.load_balancer_url,
      }),
    };

    // Fetch runtime statistics if requested and deployed
    if (includeStats && status === "deployed") {
      const stats = await this.getCharacterStatistics(character.id);
      characterInfo.messageCount = stats.messageCount;
      characterInfo.lastActiveAt = stats.lastActiveAt;
    }

    return characterInfo;
  }

  /**
   * Get runtime statistics for a deployed character
   * Only works for deployed characters (characters with running containers)
   *
   * @param characterId - Character ID
   * @returns Character statistics
   */
  async getCharacterStatistics(characterId: string): Promise<AgentStats> {
    // Check cache first
    const cached = await agentStateCache.getAgentStats(characterId);
    if (cached) {
      return cached;
    }

    // Check if character is deployed by looking for a container
    const container = await containersService.getByCharacterId(characterId);

    // If no container exists, character is not deployed - return empty stats
    if (!container) {
      const emptyStats: AgentStats = {
        agentId: characterId,
        messageCount: 0,
        roomCount: 0,
        lastActiveAt: null,
        uptime: 0,
        status: "draft",
      };
      await agentStateCache.setAgentStats(characterId, emptyStats);
      return emptyStats;
    }

    // Determine deployment status
    const status: "deployed" | "stopped" | "draft" =
      container.status === "running" ? "deployed" : "stopped";

    // Character is deployed - fetch statistics from database directly

    // Get message count for this character's agent across all rooms
    const messageCount = await memoriesRepository.countMessagesByAgent(characterId);

    // Get room count
    const roomCount = await roomsRepository.countByAgentId(characterId);

    // Determine last active time from most recent message
    const lastActiveAt = await memoriesRepository.getLastMessageTime(characterId);

    // Calculate uptime (time since last deployment)
    let uptime = 0;
    if (container?.last_deployed_at && status === "deployed") {
      uptime = Date.now() - new Date(container.last_deployed_at).getTime();
    }

    const stats: AgentStats = {
      agentId: characterId,
      messageCount,
      roomCount,
      lastActiveAt,
      uptime,
      status,
    };

    // Cache the stats (5 minute TTL)
    await agentStateCache.setAgentStats(characterId, stats);

    return stats;
  }

  /**
   * Get character statistics for multiple characters in a single batch operation
   * Uses Redis MGET for efficient batch cache lookups
   * @param characterIds - Array of character IDs
   * @returns Map of character ID to stats
   */
  async getCharacterStatisticsBatch(characterIds: string[]): Promise<Map<string, AgentStats>> {
    const statsMap = new Map<string, AgentStats>();

    if (characterIds.length === 0) {
      return statsMap;
    }

    // PERFORMANCE FIX: Use batch MGET instead of sequential cache lookups
    const cachedStats = await agentStateCache.getAgentStatsBatch(characterIds);
    const uncachedIds: string[] = [];

    for (const [characterId, stats] of cachedStats) {
      if (stats) {
        statsMap.set(characterId, stats);
      } else {
        uncachedIds.push(characterId);
      }
    }

    // If all were cached, return early
    if (uncachedIds.length === 0) {
      return statsMap;
    }

    // Get containers for all uncached characters in one query
    const containers = await containersService.listByCharacterIds(uncachedIds);
    const containerMap = new Map(containers.map((c) => [c.character_id!, c]));

    // PERFORMANCE FIX: Process uncached characters in parallel
    const uncachedPromises = uncachedIds.map(async (characterId) => {
      const container = containerMap.get(characterId);

      // If no container, return empty stats
      if (!container) {
        const emptyStats: AgentStats = {
          agentId: characterId,
          messageCount: 0,
          roomCount: 0,
          lastActiveAt: null,
          uptime: 0,
          status: "draft",
        };
        await agentStateCache.setAgentStats(characterId, emptyStats);
        return { characterId, stats: emptyStats };
      }

      // For deployed characters, fetch individual stats
      const stats = await this.getCharacterStatistics(characterId);
      return { characterId, stats };
    });

    const results = await Promise.all(uncachedPromises);
    for (const { characterId, stats } of results) {
      statsMap.set(characterId, stats);
    }

    return statsMap;
  }

  /**
   * Invalidate character list cache for organization
   * Call this when characters or containers are created/updated/deleted
   */
  async invalidateCharacterListCache(organizationId: string): Promise<void> {
    await agentStateCache.invalidateAgentList(organizationId);
    logger.debug(
      `[Character Discovery] Invalidated character list cache for org ${organizationId}`,
    );
  }

  /**
   * Create a deterministic hash of filters for caching
   */
  private hashFilters(filters: CharacterDiscoveryFilters): string {
    const filterStr = JSON.stringify({
      deployed: filters.deployed ?? null,
      template: filters.template ?? null,
      owned: filters.owned ?? null,
    });
    return createHash("md5").update(filterStr).digest("hex").substring(0, 8);
  }
}

// Export singleton instance
export const characterDeploymentDiscoveryService = new CharacterDeploymentDiscoveryService();
