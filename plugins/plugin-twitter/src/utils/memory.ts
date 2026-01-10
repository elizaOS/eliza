import {
  type IAgentRuntime,
  type UUID,
  type Memory,
  ChannelType,
  createUniqueUuid,
  logger,
} from "@elizaos/core";
import type { Tweet as ClientTweet } from "../client";

/**
 * Options for ensuring Twitter context exists
 */
export interface TwitterContextOptions {
  tweet?: ClientTweet;
  userId: string;
  username: string;
  name?: string;
  conversationId?: string;
}

/**
 * Result of ensuring Twitter context
 */
export interface TwitterContextResult {
  worldId: UUID;
  roomId: UUID;
  entityId: UUID;
}

/**
 * Ensures that the world, room, and entity exist for a Twitter interaction
 * with proper error handling and retry logic
 */
export async function ensureTwitterContext(
  runtime: IAgentRuntime,
  options: TwitterContextOptions,
): Promise<TwitterContextResult> {
  const {
    userId,
    username,
    name = username,
    conversationId = userId,
  } = options;

  const worldId = createUniqueUuid(runtime, userId);
  const roomId = createUniqueUuid(runtime, conversationId);
  const entityId = createUniqueUuid(runtime, userId);

  try {
    // Ensure world exists
    await runtime.ensureWorldExists({
      id: worldId,
      name: `${username}'s Twitter`,
      agentId: runtime.agentId,
      serverId: userId,
      metadata: {
        ownership: { ownerId: userId },
        twitter: {
          username: username,
          id: userId,
        },
      },
    });

    // Ensure room exists
    await runtime.ensureRoomExists({
      id: roomId,
      name: `Twitter conversation ${conversationId}`,
      source: "twitter",
      type: ChannelType.FEED,
      channelId: conversationId,
      serverId: userId,
      worldId: worldId,
    });

    // Ensure entity/connection exists
    await runtime.ensureConnection({
      entityId,
      roomId,
      userName: username,
      name: name,
      source: "twitter",
      type: ChannelType.FEED,
      worldId: worldId,
    });

    return {
      worldId,
      roomId,
      entityId,
    };
  } catch (error) {
    logger.error("Failed to ensure Twitter context:", error);
    throw new Error(`Failed to create Twitter context for user ${username}: ${error.message}`);
  }
}

/**
 * Creates a memory with error handling and retry logic
 */
export async function createMemorySafe(
  runtime: IAgentRuntime,
  memory: Memory,
  tableName: string = "messages",
  maxRetries: number = 3,
): Promise<void> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await runtime.createMemory(memory, tableName);
      return; // Success
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn(`Failed to create memory (attempt ${attempt + 1}/${maxRetries}):`, error);
      
      // Don't retry on certain errors
      if (error.message?.includes("duplicate") || error.message?.includes("constraint")) {
        logger.debug("Memory already exists, skipping");
        return;
      }
      
      // Wait before retry with exponential backoff
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  }
  
  // All retries failed
  logger.error(`Failed to create memory after ${maxRetries} attempts:`, lastError);
  throw lastError;
}

/**
 * Checks if a tweet has already been processed
 */
export async function isTweetProcessed(
  runtime: IAgentRuntime,
  tweetId: string,
): Promise<boolean> {
  try {
    const memoryId = createUniqueUuid(runtime, tweetId);
    const memory = await runtime.getMemoryById(memoryId);
    return !!memory;
  } catch (error) {
    logger.debug(`Error checking if tweet ${tweetId} is processed:`, error);
    return false;
  }
}

/**
 * Gets recent tweets to check for duplicates
 */
export async function getRecentTweets(
  runtime: IAgentRuntime,
  username: string,
  count: number = 10,
): Promise<string[]> {
  try {
    const cacheKey = `twitter/${username}/recentTweets`;
    const cached = await runtime.getCache<string[]>(cacheKey);
    
    if (cached && Array.isArray(cached)) {
      return cached;
    }
    
    // If no cache, return empty array
    return [];
  } catch (error) {
    logger.debug("Error getting recent tweets from cache:", error);
    return [];
  }
}

/**
 * Adds a tweet to the recent tweets cache
 */
export async function addToRecentTweets(
  runtime: IAgentRuntime,
  username: string,
  tweetText: string,
  maxRecent: number = 10,
): Promise<void> {
  try {
    const cacheKey = `twitter/${username}/recentTweets`;
    const recent = await getRecentTweets(runtime, username, maxRecent);
    
    // Add new tweet to the beginning
    recent.unshift(tweetText);
    
    // Keep only the most recent tweets
    const trimmed = recent.slice(0, maxRecent);
    
    await runtime.setCache(cacheKey, trimmed);
  } catch (error) {
    logger.debug("Error updating recent tweets cache:", error);
  }
}

/**
 * Checks if a tweet text is a duplicate of recent tweets
 */
export async function isDuplicateTweet(
  runtime: IAgentRuntime,
  username: string,
  tweetText: string,
  similarityThreshold: number = 0.9,
): Promise<boolean> {
  try {
    const recentTweets = await getRecentTweets(runtime, username);
    
    // Exact match check
    if (recentTweets.includes(tweetText)) {
      return true;
    }
    
    // Similarity check (simple for now, could use embeddings later)
    const normalizedNew = tweetText.toLowerCase().trim();
    for (const recent of recentTweets) {
      const normalizedRecent = recent.toLowerCase().trim();
      
      // Check if tweets are very similar (e.g., only differ by punctuation)
      if (normalizedNew === normalizedRecent) {
        return true;
      }
      
      // Check if one is a substring of the other (common with truncation)
      if (normalizedNew.includes(normalizedRecent) || normalizedRecent.includes(normalizedNew)) {
        return true;
      }
    }
    
    return false;
  } catch (error) {
    logger.debug("Error checking for duplicate tweets:", error);
    return false;
  }
} 