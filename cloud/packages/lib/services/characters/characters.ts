/**
 * Service for managing user characters (CRUD operations).
 *
 * PERFORMANCE: Character data is cached in Redis for fast runtime access.
 */

import type { Agent } from "@elizaos/core";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import {
  type NewUserCharacter,
  type UserCharacter,
  userCharactersRepository,
} from "@/db/repositories";
import { agentsRepository } from "@/db/repositories/agents/agents";
import { elizaRoomCharactersTable, userCharacters, users } from "@/db/schemas";
import { memoryTable, participantTable, roomTable } from "@/db/schemas/eliza";
import { cache } from "@/lib/cache/client";
import { InMemoryLRUCache } from "@/lib/cache/in-memory-lru-cache";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import type { ElizaCharacter } from "@/lib/types/eliza-character";
import {
  generateUniqueUsername,
  generateUsernameFromName,
  RESERVED_USERNAMES,
  validateUsername,
} from "@/lib/utils/agent-username";
import { logger } from "@/lib/utils/logger";
import { usersService } from "../users";

// Cache key for character data (longer TTL since characters rarely change)
const characterCacheKey = (id: string) => `character:data:${id}`;
const CHARACTER_CACHE_TTL = CacheTTL.agent.characterData; // 1 hour

/**
 * PERF: In-memory cache for character data (60s TTL).
 * Characters rarely change during active sessions. This eliminates the Redis
 * round-trip (~5ms) for repeated lookups within the same serverless instance.
 */
const inMemoryCharCache = new InMemoryLRUCache<UserCharacter>(100, 60_000);

/**
 * Service for character CRUD operations.
 */
export class CharactersService {
  /**
   * Get character by ID with caching.
   * PERFORMANCE: 3-layer cache: in-memory (~0ms) > Redis (~5ms) > DB (~50ms)
   */
  async getById(id: string): Promise<UserCharacter | undefined> {
    // PERF: Check in-memory cache first (eliminates Redis round-trip)
    const inMemoryHit = inMemoryCharCache.get(id);
    if (inMemoryHit) {
      logger.debug(`[Characters] ⚡ In-memory cache HIT: ${id}`);
      return structuredClone(inMemoryHit);
    }

    const cacheKey = characterCacheKey(id);

    // Try Redis cache
    const cached = await cache.get<UserCharacter>(cacheKey);
    if (cached) {
      logger.debug(`[Characters] ⚡ Redis cache HIT: ${id}`);
      inMemoryCharCache.set(id, cached);
      return structuredClone(cached);
    }

    // Fetch from database
    const character = await userCharactersRepository.findById(id);

    // Cache for future requests (Redis: 1 hour, in-memory: 60s)
    if (character) {
      await cache.set(cacheKey, character, CHARACTER_CACHE_TTL);
      inMemoryCharCache.set(id, character);
      logger.debug(`[Characters] Cache MISS, cached: ${id}`);
      return structuredClone(character);
    }

    return character;
  }

  /**
   * Invalidate character cache (call after updates)
   * CRITICAL: This now also invalidates the in-memory runtime cache
   */
  async invalidateCache(id: string): Promise<void> {
    inMemoryCharCache.delete(id);
    // Import dynamically to avoid circular dependency
    const { invalidateCharacterCache } = await import("@/lib/cache/character-cache");

    await Promise.all([
      // Invalidate the simple character cache key
      cache.del(characterCacheKey(id)),
      // CRITICAL: Invalidate ALL character-related caches including runtime
      // This ensures MCP, knowledge, web search changes take effect immediately
      invalidateCharacterCache(id),
    ]);

    logger.info(`[Characters] Cache invalidated for character: ${id}`);
  }

  async getByIdForUser(characterId: string, userId: string): Promise<UserCharacter | null> {
    const character = await userCharactersRepository.findById(characterId);

    if (!character || character.user_id !== userId) {
      return null;
    }

    return character;
  }

  async listByUser(
    userId: string,
    options?: {
      limit?: number;
      includeTemplates?: boolean;
      source?: "cloud";
    },
  ): Promise<UserCharacter[]> {
    const source = options?.source ?? "cloud";

    // If templates are requested, get them separately
    if (options?.includeTemplates) {
      const [userChars, templates] = await Promise.all([
        userCharactersRepository.listByUser(userId, source),
        userCharactersRepository.listTemplates(),
      ]);
      return [...userChars, ...templates];
    }

    return await userCharactersRepository.listByUser(userId, source);
  }

  async listByOrganization(
    organizationId: string,
    options?: { source?: "cloud" },
  ): Promise<UserCharacter[]> {
    const source = options?.source ?? "cloud";
    return await userCharactersRepository.listByOrganization(organizationId, source);
  }

  async listPublic(options?: {
    search?: string;
    category?: string;
    limit?: number;
    offset?: number;
  }): Promise<UserCharacter[]> {
    return await userCharactersRepository.listPublic(options);
  }

  async listTemplates(): Promise<UserCharacter[]> {
    return await userCharactersRepository.listTemplates();
  }

  /**
   * Generate a unique username for a character.
   * Uses the name to create a slug, then ensures uniqueness.
   */
  async generateUniqueUsername(name: string): Promise<string> {
    // Get all existing usernames
    const existingUsernames = await userCharactersRepository.getAllUsernames();

    // Add reserved usernames
    for (const reserved of RESERVED_USERNAMES) {
      existingUsernames.add(reserved);
    }

    // Generate base username from name
    const baseUsername = generateUsernameFromName(name);

    // Make it unique
    return generateUniqueUsername(baseUsername, existingUsernames);
  }

  /**
   * Validate a username for update.
   * Checks format and uniqueness (excluding the character's own username).
   */
  async validateUsernameForUpdate(
    username: string,
    characterId: string,
  ): Promise<{ valid: boolean; error?: string }> {
    // Validate format
    const validation = validateUsername(username);
    if (!validation.valid) {
      return { valid: false, error: validation.error };
    }

    // Check uniqueness (excluding own character)
    const existing = await userCharactersRepository.findByUsername(username);
    if (existing && existing.id !== characterId) {
      return { valid: false, error: "This username is already taken" };
    }

    return { valid: true };
  }

  /**
   * Get a character by username.
   */
  async getByUsername(username: string): Promise<UserCharacter | undefined> {
    return await userCharactersRepository.findByUsername(username);
  }

  async create(data: NewUserCharacter): Promise<UserCharacter> {
    // Generate username if not provided
    let username = data.username;
    if (!username) {
      username = await this.generateUniqueUsername(data.name);
      logger.info(`[Characters] Generated username: @${username} for "${data.name}"`);
    } else {
      // Validate provided username
      const validation = validateUsername(username);
      if (!validation.valid) {
        throw new Error(`Invalid username: ${validation.error}`);
      }

      // Use normalized (lowercased) username from validation
      username = validation.normalized!;

      // Check uniqueness
      const exists = await userCharactersRepository.usernameExists(username);
      if (exists) {
        throw new Error("Username is already taken");
      }
    }

    // Create the character in user_characters table with username
    const character = await userCharactersRepository.create({
      ...data,
      username,
    });

    // Also create the agent in the elizaOS agents table
    const agent: Partial<Agent> = {
      id: character.id as `${string}-${string}-${string}-${string}-${string}`,
      name: character.name,
      username: character.username ?? undefined,
      bio: character.bio as string[] | undefined,
      system: character.system ?? undefined,
      enabled: true,
      settings: character.settings as Record<
        string,
        string | number | boolean | Record<string, string | number | boolean>
      >,
    };

    await agentsRepository.create(agent);

    // Invalidate dashboard cache
    await cache.del(CacheKeys.org.dashboard(data.organization_id));

    return character;
  }

  async update(id: string, data: Partial<NewUserCharacter>): Promise<UserCharacter | undefined> {
    const updated = await userCharactersRepository.update(id, data);
    // Invalidate cache on update
    if (updated) {
      await this.invalidateCache(id);
    }
    return updated;
  }

  async updateForUser(
    characterId: string,
    userId: string,
    updates: Partial<NewUserCharacter>,
  ): Promise<UserCharacter | null> {
    // Verify ownership
    const character = await this.getByIdForUser(characterId, userId);
    if (!character) {
      return null;
    }

    // If username is being updated, validate it
    // Normalize before comparison to prevent validation bypass with different casing
    // Handle null explicitly (allows clearing the username)
    if (updates.username !== undefined) {
      if (updates.username === null) {
        // Allow clearing username - no validation needed
        logger.info(`[Characters] Username cleared: @${character.username} → null`);
      } else {
        const normalizedUsername = updates.username.toLowerCase();
        if (normalizedUsername !== character.username) {
          const validation = await this.validateUsernameForUpdate(normalizedUsername, characterId);
          if (!validation.valid) {
            throw new Error(`Invalid username: ${validation.error}`);
          }
          updates.username = normalizedUsername;
          logger.info(
            `[Characters] Username updated: @${character.username} → @${updates.username}`,
          );
        } else {
          // Same username after normalization, ensure it's stored normalized
          updates.username = normalizedUsername;
        }
      }
    }

    const updated = await userCharactersRepository.update(characterId, updates);

    // CRITICAL: Invalidate cache after update (including runtime cache)
    // This ensures the next request creates a fresh runtime with updated config
    if (updated) {
      await this.invalidateCache(characterId);
    }

    return updated || null;
  }

  async delete(id: string): Promise<void> {
    const character = await this.getById(id);
    await userCharactersRepository.delete(id);
    if (character) {
      await Promise.all([
        cache.del(CacheKeys.org.dashboard(character.organization_id)),
        this.invalidateCache(id),
      ]);
    }
  }

  async deleteForUser(characterId: string, userId: string): Promise<boolean> {
    // Verify ownership
    const character = await this.getByIdForUser(characterId, userId);
    if (!character) {
      return false;
    }

    await userCharactersRepository.delete(characterId);

    // CRITICAL: Invalidate cache after delete (including runtime cache)
    await Promise.all([
      cache.del(CacheKeys.org.dashboard(character.organization_id)),
      this.invalidateCache(characterId),
    ]);

    return true;
  }

  /**
   * Convert database character to Eliza character format
   */
  toElizaCharacter(character: UserCharacter): ElizaCharacter {
    // Extract affiliate data from character_data if present
    const characterData = character.character_data as Record<string, unknown> | undefined;
    const affiliateData = characterData?.affiliate as
      | { vibe?: string; affiliateId?: string; [key: string]: unknown }
      | undefined;

    // Also extract lore data which contains full social media posts
    const loreData = characterData?.lore as string[] | undefined;

    // Merge affiliate data AND lore into settings so it's available in the runtime
    const settings = character.settings as
      | Record<string, string | boolean | number | Record<string, unknown>>
      | undefined;
    const mergedSettings = {
      ...settings,
      // Include avatarUrl in settings for provider/runtime access (camelCase for elizaOS compatibility)
      avatarUrl: character.avatar_url ?? undefined,
      ...(affiliateData || loreData
        ? {
            affiliateData: {
              ...affiliateData,
              lore: loreData,
            },
          }
        : {}),
    };

    return {
      id: character.id,
      name: character.name,
      username: character.username ?? undefined,
      system: character.system ?? undefined,
      bio: character.bio,
      messageExamples: (() => {
        const examples = character.message_examples;
        if (
          Array.isArray(examples) &&
          examples.every(
            (ex) =>
              Array.isArray(ex) &&
              ex.every(
                (msg) =>
                  typeof msg === "object" && msg !== null && "name" in msg && "content" in msg,
              ),
          )
        ) {
          return examples as ElizaCharacter["messageExamples"];
        }
        return undefined;
      })(),
      postExamples: character.post_examples as string[] | undefined,
      topics: character.topics as string[] | undefined,
      adjectives: character.adjectives as string[] | undefined,
      documents: character.knowledge as (string | { path: string; shared?: boolean })[] | undefined,
      plugins: character.plugins as string[] | undefined,
      settings: mergedSettings as
        | Record<string, string | number | boolean | Record<string, unknown>>
        | undefined,
      secrets: character.secrets as Record<string, string | number | boolean> | undefined,
      style: character.style as
        | {
            all?: string[];
            chat?: string[];
            post?: string[];
          }
        | undefined,
      avatarUrl: character.avatar_url ?? undefined,
      isPublic: character.is_public,
    };
  }

  /**
   * Check if a character is claimable by an authenticated user.
   * A character is claimable if:
   * - It's owned by an anonymous user (affiliate-created)
   * - The owner has an affiliate email pattern
   * - The owner hasn't been converted to a real user yet
   */
  async isClaimableAffiliateCharacter(characterId: string): Promise<{
    claimable: boolean;
    ownerId?: string;
    reason?: string;
  }> {
    const character = await userCharactersRepository.findById(characterId);

    if (!character) {
      return { claimable: false, reason: "Character not found" };
    }

    // Get the owner user
    const owner = await usersService.getById(character.user_id);

    if (!owner) {
      return { claimable: false, reason: "Owner not found" };
    }

    // Check if owned by an affiliate anonymous user
    const isAffiliateUser = owner.email?.includes("@anonymous.elizacloud.ai") || false;
    const isAnonymous = owner.is_anonymous === true;

    if (isAffiliateUser && isAnonymous) {
      return {
        claimable: true,
        ownerId: owner.id,
        reason: "Affiliate character available for claiming",
      };
    }

    return {
      claimable: false,
      reason: "Character already owned by a real user",
    };
  }

  /**
   * Claim an affiliate character for an authenticated user.
   * Transfers ownership from the anonymous affiliate user to the authenticated user.
   * Also transfers room associations so the character appears in the user's library.
   */
  async claimAffiliateCharacter(
    characterId: string,
    userId: string,
    organizationId: string,
  ): Promise<{ success: boolean; message: string }> {
    // Verify character is claimable
    const claimCheck = await this.isClaimableAffiliateCharacter(characterId);

    if (!claimCheck.claimable) {
      logger.info(`[Characters] Character ${characterId} not claimable: ${claimCheck.reason}`);
      return { success: false, message: claimCheck.reason || "Not claimable" };
    }

    const previousOwnerId = claimCheck.ownerId;
    logger.info(`[Characters] 🎯 Claiming affiliate character ${characterId} for user ${userId}`, {
      previousOwnerId,
    });

    // Transfer character ownership
    const updated = await userCharactersRepository.update(characterId, {
      user_id: userId,
      organization_id: organizationId,
    });

    if (!updated) {
      return { success: false, message: "Failed to update character" };
    }

    // Transfer room associations from the previous owner to the new owner
    if (previousOwnerId) {
      const roomUpdateResult = await dbWrite
        .update(elizaRoomCharactersTable)
        .set({
          user_id: userId,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(elizaRoomCharactersTable.character_id, characterId),
            eq(elizaRoomCharactersTable.user_id, previousOwnerId),
          ),
        )
        .returning({ room_id: elizaRoomCharactersTable.room_id });

      if (roomUpdateResult.length > 0) {
        logger.info(`[Characters] Transferred ${roomUpdateResult.length} room association(s)`, {
          characterId,
          fromUserId: previousOwnerId,
          toUserId: userId,
        });
      }
    }

    logger.info(`[Characters] ✅ Successfully claimed character ${characterId}`, {
      characterName: updated.name,
      newOwnerId: userId,
      newOrgId: organizationId,
    });

    return {
      success: true,
      message: `Character "${updated.name}" has been added to your account`,
    };
  }

  // ============================================================================
  // Saved Agents Methods
  // ============================================================================

  /**
   * Get all saved agents for a user.
   * Saved agents are public agents the user has interacted with but doesn't own.
   *
   * @param userId - The ID of the user to get saved agents for
   * @returns Array of saved agents with their details and last interaction time
   */
  async getSavedAgentsForUser(userId: string): Promise<
    Array<{
      id: string;
      name: string;
      username: string | null;
      avatar_url: string | null;
      bio: string | string[] | null;
      owner_id: string;
      owner_name: string | null;
      last_interaction_time: string;
    }>
  > {
    logger.debug("[Characters] Fetching saved agents for user:", { userId });

    // Query for distinct agents the user has chatted with
    // - entity_id = current user (messages from this user)
    // - user_id != current user (not owned by this user)
    // - is_public = true (only public agents)
    // Joins with users table to get owner's display name
    /**
     * Performance note: This query benefits from indexes on:
     * - memoryTable(entityId, agentId) - for the WHERE and JOIN
     * - userCharacters(id) - primary key, already indexed
     * - userCharacters(user_id, is_public) - for the WHERE conditions
     */
    const savedAgents = await dbRead
      .select({
        id: userCharacters.id,
        name: userCharacters.name,
        username: userCharacters.username,
        avatar_url: userCharacters.avatar_url,
        bio: userCharacters.bio,
        owner_id: userCharacters.user_id,
        owner_name: sql<string | null>`COALESCE(${users.name}, ${users.nickname})`.as("owner_name"),
        last_interaction_time: sql<string>`MAX(${memoryTable.createdAt})`.as(
          "last_interaction_time",
        ),
      })
      .from(memoryTable)
      .innerJoin(userCharacters, eq(memoryTable.agentId, userCharacters.id))
      .leftJoin(users, eq(userCharacters.user_id, users.id))
      .where(
        and(
          eq(memoryTable.entityId, userId),
          ne(userCharacters.user_id, userId),
          eq(userCharacters.is_public, true),
        ),
      )
      .groupBy(
        userCharacters.id,
        userCharacters.name,
        userCharacters.username,
        userCharacters.avatar_url,
        userCharacters.bio,
        userCharacters.user_id,
        users.name,
        users.nickname,
      )
      .orderBy(sql`MAX(${memoryTable.createdAt}) DESC`);

    logger.debug("[Characters] Found saved agents:", {
      userId,
      count: savedAgents.length,
    });

    return savedAgents;
  }

  /**
   * Get details for a specific saved agent.
   * Verifies user has access (has interacted with agent and doesn't own it).
   *
   * @param userId - The ID of the user
   * @param agentId - The ID of the agent to get details for
   * @returns Agent details with stats, or null if not found/no access
   */
  async getSavedAgentDetails(
    userId: string,
    agentId: string,
  ): Promise<{
    agent: {
      id: string;
      name: string;
      username: string | null;
      avatar_url: string | null;
      owner_id: string;
    };
    stats: {
      message_count: number;
      room_count: number;
    };
  } | null> {
    logger.debug("[Characters] Getting saved agent details:", {
      userId,
      agentId,
    });

    // Verify this is a saved agent (user doesn't own it and it's public)
    const agent = await dbRead.query.userCharacters.findFirst({
      where: and(
        eq(userCharacters.id, agentId),
        ne(userCharacters.user_id, userId),
        eq(userCharacters.is_public, true),
      ),
    });

    if (!agent) {
      return null;
    }

    // Get count of memories/messages the user has with this agent
    const messageResult = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(memoryTable)
      .where(and(eq(memoryTable.entityId, userId), eq(memoryTable.agentId, agentId)));
    const messageCount = messageResult[0]?.count ?? 0;

    // Get rooms count for this user+agent combination
    const roomResult = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(roomTable)
      .innerJoin(participantTable, eq(roomTable.id, participantTable.roomId))
      .where(and(eq(roomTable.agentId, agentId), eq(participantTable.entityId, userId)));
    const roomCount = roomResult[0]?.count ?? 0;

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        username: agent.username,
        avatar_url: agent.avatar_url,
        owner_id: agent.user_id,
      },
      stats: {
        message_count: Number(messageCount),
        room_count: Number(roomCount),
      },
    };
  }

  /**
   * Remove a saved agent from the user's list.
   * This permanently deletes:
   * - All conversation history (memories) between user and agent
   * - Room associations for user with this agent
   * - Empty rooms (rooms with no remaining participants)
   *
   * @param userId - The ID of the user
   * @param agentId - The ID of the agent to remove
   * @returns Result with success status and deletion stats, or error info
   */
  async removeSavedAgent(
    userId: string,
    agentId: string,
  ): Promise<
    | {
        success: true;
        deleted: {
          memories: number;
          participants: number;
          rooms: number;
        };
      }
    | { success: false; error: string }
  > {
    logger.info("[Characters] Removing saved agent:", { userId, agentId });

    // Verify this is a saved agent (not owned by user)
    const agent = await dbRead.query.userCharacters.findFirst({
      where: and(eq(userCharacters.id, agentId), ne(userCharacters.user_id, userId)),
    });

    if (!agent) {
      return { success: false, error: "Agent not found or you own this agent" };
    }

    // Find all rooms where this user is a participant with this agent
    const userRooms = await dbRead
      .select({ roomId: participantTable.roomId })
      .from(participantTable)
      .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
      .where(and(eq(participantTable.entityId, userId), eq(roomTable.agentId, agentId)));

    const roomIds = userRooms.map((r) => r.roomId);

    // Use transaction to ensure atomicity of all delete operations
    const { deletedMemories, deletedParticipants, deletedRooms } = await dbWrite.transaction(
      async (tx) => {
        let memoryCount = 0;
        let participantCount = 0;
        let roomCount = 0;

        if (roomIds.length > 0) {
          // Delete memories in these rooms for this user
          // Note: We only delete memories where entityId = user.id to preserve
          // the agent's memories and other users' data
          const memoryResult = await tx
            .delete(memoryTable)
            .where(and(eq(memoryTable.entityId, userId), inArray(memoryTable.roomId, roomIds)))
            .returning({ id: memoryTable.id });
          memoryCount = memoryResult.length;

          // Delete participant records for this user in these rooms
          const participantResult = await tx
            .delete(participantTable)
            .where(
              and(eq(participantTable.entityId, userId), inArray(participantTable.roomId, roomIds)),
            )
            .returning({ id: participantTable.id });
          participantCount = participantResult.length;

          // For DM rooms (1:1), check if we should delete the room entirely
          // Only delete rooms where no other participants remain
          // PERFORMANCE: Use batch query instead of N+1 individual queries
          const roomParticipantCounts = await tx
            .select({
              roomId: participantTable.roomId,
              count: sql<number>`count(*)`.as("count"),
            })
            .from(participantTable)
            .where(inArray(participantTable.roomId, roomIds))
            .groupBy(participantTable.roomId);

          // Create a map for quick lookup
          const participantCountMap = new Map(
            roomParticipantCounts.map((r) => [r.roomId, Number(r.count)]),
          );

          // Find rooms with no remaining participants (count = 0 or not in results)
          const emptyRoomIds = roomIds.filter(
            (roomId) => !participantCountMap.has(roomId) || participantCountMap.get(roomId) === 0,
          );

          // Delete all empty rooms in a single batch query
          if (emptyRoomIds.length > 0) {
            await tx.delete(roomTable).where(inArray(roomTable.id, emptyRoomIds));
            roomCount = emptyRoomIds.length;
          }
        }

        // Also delete any memories directly tied to this agent+user combination
        // that might be in other rooms (e.g., world rooms, etc.)
        const directMemoryResult = await tx
          .delete(memoryTable)
          .where(and(eq(memoryTable.entityId, userId), eq(memoryTable.agentId, agentId)))
          .returning({ id: memoryTable.id });
        memoryCount += directMemoryResult.length;

        return {
          deletedMemories: memoryCount,
          deletedParticipants: participantCount,
          deletedRooms: roomCount,
        };
      },
    );

    logger.info("[Characters] Removed saved agent:", {
      userId,
      agentId,
      deletedMemories,
      deletedParticipants,
      deletedRooms,
    });

    return {
      success: true,
      deleted: {
        memories: deletedMemories,
        participants: deletedParticipants,
        rooms: deletedRooms,
      },
    };
  }
}

// Export singleton instance
export const charactersService = new CharactersService();
