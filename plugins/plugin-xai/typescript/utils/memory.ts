import {
  ChannelType,
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";

// WorldOwnership type for world metadata
type WorldOwnership = { ownerId: string };

import type { Post as ClientPost } from "../client";

export interface XContextOptions {
  post?: ClientPost;
  userId: string;
  username: string;
  name?: string;
  conversationId?: string;
}

export interface XContextResult {
  worldId: UUID;
  roomId: UUID;
  entityId: UUID;
}

export async function ensureXContext(
  runtime: IAgentRuntime,
  options: XContextOptions
): Promise<XContextResult> {
  const { userId, username, name = username, conversationId = userId } = options;

  const worldId = createUniqueUuid(runtime, userId);
  const roomId = createUniqueUuid(runtime, conversationId);
  const entityId = createUniqueUuid(runtime, userId);

  try {
    await runtime.ensureWorldExists({
      id: worldId,
      name: `${username}'s X`,
      agentId: runtime.agentId,
      messageServerId: createUniqueUuid(runtime, `server-${userId}`),
      metadata: {
        ownership: { ownerId: userId } as unknown as WorldOwnership,
        extra: {
          x: {
            username: username,
            id: userId,
          },
        },
      },
    });

    await runtime.ensureRoomExists({
      id: roomId,
      name: `X conversation ${conversationId}`,
      source: "x",
      type: ChannelType.FEED,
      channelId: conversationId,
      messageServerId: createUniqueUuid(runtime, `server-${userId}`),
      worldId: worldId,
    });

    await runtime.ensureConnection({
      entityId,
      roomId,
      userName: username,
      name: name,
      source: "x",
      type: ChannelType.FEED,
      worldId: worldId,
    });

    return {
      worldId,
      roomId,
      entityId,
    };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Failed to ensure X context:", err.message);
    throw new Error(`Failed to create X context for user ${username}: ${err.message}`);
  }
}

export async function createMemorySafe(
  runtime: IAgentRuntime,
  memory: Memory,
  tableName: string = "messages",
  maxRetries: number = 3
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await runtime.createMemory(memory, tableName);
      return;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn(
        `Failed to create memory (attempt ${attempt + 1}/${maxRetries}):`,
        lastError.message
      );

      if (lastError.message?.includes("duplicate") || lastError.message?.includes("constraint")) {
        logger.debug("Memory already exists, skipping");
        return;
      }

      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
      }
    }
  }

  logger.error(
    { error: lastError?.message },
    `Failed to create memory after ${maxRetries} attempts`
  );
  throw lastError;
}

export async function isPostProcessed(runtime: IAgentRuntime, postId: string): Promise<boolean> {
  try {
    const memoryId = createUniqueUuid(runtime, postId);
    const memory = await runtime.getMemoryById(memoryId);
    return !!memory;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug(`Error checking if post ${postId} is processed:`, err.message);
    return false;
  }
}

export async function getRecentPosts(
  runtime: IAgentRuntime,
  username: string,
  _count: number = 10
): Promise<string[]> {
  try {
    const cacheKey = `x/${username}/recentPosts`;
    const cached = await runtime.getCache<string[]>(cacheKey);

    if (cached && Array.isArray(cached)) {
      return cached;
    }

    return [];
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug("Error getting recent posts from cache:", err.message);
    return [];
  }
}

export async function addToRecentPosts(
  runtime: IAgentRuntime,
  username: string,
  postText: string,
  maxRecent: number = 10
): Promise<void> {
  try {
    const cacheKey = `x/${username}/recentPosts`;
    const recent = await getRecentPosts(runtime, username, maxRecent);

    recent.unshift(postText);
    const trimmed = recent.slice(0, maxRecent);

    await runtime.setCache(cacheKey, trimmed);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug("Error updating recent posts cache:", err.message);
  }
}

export async function isDuplicatePost(
  runtime: IAgentRuntime,
  username: string,
  postText: string,
  _similarityThreshold: number = 0.9
): Promise<boolean> {
  try {
    const recentPosts = await getRecentPosts(runtime, username);

    if (recentPosts.includes(postText)) {
      return true;
    }

    const normalizedNew = postText.toLowerCase().trim();
    for (const recent of recentPosts) {
      const normalizedRecent = recent.toLowerCase().trim();

      if (normalizedNew === normalizedRecent) {
        return true;
      }

      if (normalizedNew.includes(normalizedRecent) || normalizedRecent.includes(normalizedNew)) {
        return true;
      }
    }

    return false;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug("Error checking for duplicate posts:", err.message);
    return false;
  }
}
