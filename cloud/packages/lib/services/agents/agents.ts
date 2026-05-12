/**
 * Agent Runtime Service
 *
 * This service deals ONLY with runtime agents (agents table - elizaOS framework).
 *
 * Domain: Agents (agents table - DO NOT MODIFY, elizaOS framework)
 * - Runtime agent information
 * - Room/message operations
 * - Agent-to-room communication
 *
 * What this service DOES NOT do:
 * - Character management (use charactersService)
 * - Deployment operations (use deploymentsService)
 * - Character discovery (use characterDeploymentDiscoveryService)
 *
 * Key Distinction:
 * - Agent = Running instance from elizaOS (agents table)
 * - Character = User-created definition (user_characters table)
 * - When you deploy a character, it becomes an agent
 */

import { ContentType, type Media } from "@elizaos/core";
import { memoriesRepository, participantsRepository } from "@/db/repositories";
import { type AgentInfo, agentsRepository } from "@/db/repositories/agents";
import { agentStateCache, type RoomContext } from "@/lib/cache/agent-state-cache";
import { cache as cacheClient } from "@/lib/cache/client";
import { distributedLocks } from "@/lib/cache/distributed-locks";
import { CacheTTL } from "@/lib/cache/keys";
import { AgentMode } from "@/lib/eliza/agent-mode-types";
import { createMessageHandler } from "@/lib/eliza/message-handler";
import { runtimeFactory } from "@/lib/eliza/runtime-factory";
import { userContextService } from "@/lib/eliza/user-context";
import { charactersService } from "@/lib/services/characters/characters";
import { logger } from "@/lib/utils/logger";
import { roomsService } from "./rooms";

// Cache key helper for agent info
const agentInfoCacheKey = (agentId: string) => `agent:info:${agentId}`;
const DEFAULT_AGENT_ID = "b850bc30-45f8-0041-a00a-83df46d8555d";
const DEFAULT_AGENT_AVATAR_URL =
  "https://raw.githubusercontent.com/elizaOS/eliza-avatars/refs/heads/master/Eliza/portrait.png";

// Re-export AgentInfo type
export type { AgentInfo };

/**
 * Input for sending a message to an agent.
 */
export interface SendMessageInput {
  roomId: string;
  entityId: string;
  message: string;
  organizationId: string;
  streaming?: boolean;
  attachments?: Attachment[];
  /** Optional character/agent ID to use a specific agent instead of the default */
  characterId?: string;
}

/**
 * Message attachment structure.
 */
export interface Attachment {
  type: "image" | "file";
  url: string;
  filename?: string;
  mimeType?: string;
}

/**
 * Response from an agent.
 */
export interface AgentResponse {
  messageId: string;
  content: string;
  roomId: string;
  timestamp: Date;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    model: string;
  };
  streaming?: {
    sseUrl: string;
  };
}

class AgentsService {
  // ============================================
  // Agent Info Operations (Pure DB, no runtime)
  // ============================================

  /**
   * Get agent by ID
   * Returns agent info without spinning up runtime
   * Cached for 5 minutes to reduce database load
   */
  async getById(agentId: string): Promise<AgentInfo | null> {
    const cacheKey = agentInfoCacheKey(agentId);

    // Try cache first
    const cached = await cacheClient.get<AgentInfo>(cacheKey);
    if (cached) {
      return cached;
    }

    // Fetch from database
    const agent = await agentsRepository.findById(agentId);

    // Cache for 5 minutes
    if (agent) {
      await cacheClient.set(cacheKey, agent, CacheTTL.agent.info);
    }

    return agent;
  }

  /**
   * Invalidate agent cache after updates
   */
  async invalidateCache(agentId: string): Promise<void> {
    await cacheClient.del(agentInfoCacheKey(agentId));
  }

  /**
   * Get multiple agents by IDs
   */
  async getByIds(agentIds: string[]): Promise<AgentInfo[]> {
    if (agentIds.length === 0) return [];
    return await agentsRepository.findByIds(agentIds);
  }

  /**
   * Check if agent exists
   */
  async exists(agentId: string): Promise<boolean> {
    return await agentsRepository.exists(agentId);
  }

  /**
   * Ensure the default Eliza agent exists in the database.
   * This is the built-in Eliza character that's always available.
   */
  async ensureDefaultAgentExists(): Promise<void> {
    // Check if default agent already exists
    const exists = await agentsRepository.exists(DEFAULT_AGENT_ID);
    if (exists) {
      logger.debug(`[Agents Service] Default Eliza agent already exists`);
      return;
    }

    const created = await agentsRepository.create({
      id: DEFAULT_AGENT_ID as `${string}-${string}-${string}-${string}-${string}`,
      name: "Eliza",
      bio: ["Default Eliza Cloud chat agent"],
      system: "You are Eliza, the default Eliza Cloud chat agent.",
      settings: { avatarUrl: DEFAULT_AGENT_AVATAR_URL },
      enabled: true,
    });

    if (created) {
      logger.info(`[Agents Service] Created default Eliza agent ${DEFAULT_AGENT_ID}`);
    } else {
      logger.debug(`[Agents Service] Default Eliza agent already exists (race condition)`);
    }
  }

  /**
   * Ensure agent exists in database, creating from character if needed.
   *
   * @param characterId - Character ID to ensure exists as an agent
   * @returns The agent ID that was ensured to exist
   */
  async ensureAgentExists(characterId: string): Promise<string> {
    // Check if agent already exists
    const exists = await agentsRepository.exists(characterId);
    if (exists) {
      logger.debug(`[Agents Service] Agent ${characterId} already exists`);
      return characterId;
    }

    // Load character data to create agent
    const character = await charactersService.getById(characterId);

    if (!character) {
      throw new Error(`Character ${characterId} not found`);
    }

    // Extract character data
    const characterData = character.character_data as Record<string, unknown> | undefined;

    // Create agent from character
    const created = await agentsRepository.create({
      id: characterId as `${string}-${string}-${string}-${string}-${string}`,
      name: character.name,
      bio: characterData?.bio as string | string[] | undefined as string[] | undefined,
      settings: {
        ...(character.avatar_url ? { avatarUrl: character.avatar_url } : {}),
        ...(characterData?.settings as Record<string, unknown> | undefined),
      },
      enabled: true,
    });

    if (!created) {
      // Agent was created by another process (race condition), that's fine
      logger.debug(`[Agents Service] Agent ${characterId} already exists (race condition)`);
    } else {
      logger.info(`[Agents Service] Created agent ${characterId} from character ${character.name}`);
    }

    return characterId;
  }

  /**
   * Get agent display info (id, name, avatarUrl)
   * Useful for UI without loading full agent data
   */
  async getDisplayInfo(agentId: string): Promise<{
    id: string;
    name: string;
    avatarUrl?: string;
  } | null> {
    return await agentsRepository.getDisplayInfo(agentId);
  }

  /**
   * Get agent name
   */
  async getName(agentId: string): Promise<string | null> {
    const agent = await this.getById(agentId);
    return agent?.name || null;
  }

  /**
   * Get agent avatar URL
   */
  async getAvatarUrl(agentId: string): Promise<string | undefined> {
    return await agentsRepository.getAvatarUrl(agentId);
  }

  // ============================================
  // Room/Message Operations (Uses runtime - for MCP)
  // ============================================

  /**
   * Get or create a room for user-agent conversation
   * @param entityId - User entity ID
   * @param agentId - Agent ID (optional, uses org default)
   * @returns Room ID
   */
  async getOrCreateRoom(entityId: string, agentId: string): Promise<string> {
    // Use repository to check for existing rooms
    const existingRoomIds = await participantsRepository.findRoomsByEntityId(entityId);

    if (existingRoomIds && existingRoomIds.length > 0) {
      logger.debug(
        `[Agents Service] Found existing room ${existingRoomIds[0]} for entity ${entityId}`,
      );
      return existingRoomIds[0];
    }

    const room = await roomsService.createRoom({
      agentId,
      entityId,
      source: "chat",
      type: "DM",
      name: "New Chat",
    });

    logger.info(`[Agents Service] Created new room ${room.id} for entity ${entityId}`);
    return room.id;
  }

  /**
   * Send a message to agent and get response
   * NOTE: This uses runtime - only for MCP tool compatibility
   * For web chat, use the streaming endpoint directly
   */
  async sendMessage(input: SendMessageInput): Promise<AgentResponse> {
    const { roomId, message, streaming, attachments, characterId } = input;

    // Acquire distributed lock with retry
    const lock = await distributedLocks.acquireRoomLockWithRetry(roomId, 60000, {
      maxRetries: 10,
      initialDelayMs: 100,
      maxDelayMs: 2000,
    });

    if (!lock) {
      throw new Error("Room is currently processing another message. Maximum wait time exceeded.");
    }

    try {
      // Use specific character runtime if provided (e.g., from WhatsApp/SMS routing),
      // otherwise fall back to the default system runtime.
      const userContext = userContextService.createSystemContext(AgentMode.CHAT);
      if (characterId) {
        userContext.characterId = characterId;
      }
      const runtime = await runtimeFactory.createRuntimeForUser(userContext);

      const mediaAttachments: Media[] =
        attachments?.map((attachment) => ({
          id: crypto.randomUUID(),
          url: attachment.url,
          title: attachment.filename,
          contentType: attachment.type === "image" ? ContentType.IMAGE : ContentType.DOCUMENT,
        })) ?? [];
      const messageHandler = createMessageHandler(runtime, userContext);
      const { message: agentMessage } = await messageHandler.process({
        roomId,
        text: message,
        attachments: mediaAttachments,
        characterId,
      });

      await agentStateCache.invalidateRoomContext(roomId);

      return {
        messageId: agentMessage.id!,
        content: agentMessage.content.text as string,
        roomId,
        timestamp: new Date(agentMessage.createdAt || Date.now()),
        usage: {
          inputTokens: Math.ceil(message.length / 4),
          outputTokens: Math.ceil(((agentMessage.content.text as string) || "").length / 4),
          model: "eliza-agent",
        },
        ...(streaming && {
          streaming: {
            sseUrl: `${process.env.NEXT_PUBLIC_APP_URL}/api/mcp/stream?eventType=agent&resourceId=${roomId}`,
          },
        }),
      };
    } finally {
      await lock.release();
    }
  }

  /**
   * Get cached room context or fetch from database
   * PERFORMANCE: Uses Promise.all for parallel DB queries
   */
  async getRoomContext(roomId: string): Promise<RoomContext> {
    const cached = await agentStateCache.getRoomContext(roomId);
    if (cached) {
      logger.debug(`[Agents Service] Cache hit for room ${roomId}`);
      return cached;
    }

    logger.debug(`[Agents Service] Cache miss for room ${roomId}, fetching from DB`);

    // PERFORMANCE: Fetch messages and participants in parallel
    const [messages, participantIds] = await Promise.all([
      memoriesRepository.findMessages(roomId, { limit: 20 }),
      participantsRepository.getEntityIdsByRoomId(roomId),
    ]);

    const context: RoomContext = {
      roomId,
      messages,
      participants: participantIds,
      metadata: {},
      lastActivity: new Date(),
    };

    // Fire-and-forget cache set
    agentStateCache.setRoomContext(roomId, context).catch(() => {});

    return context;
  }
}

// Export singleton instance
export const agentsService = new AgentsService();

// Also export as agentService for backward compatibility with MCP route
export const agentService = agentsService;
