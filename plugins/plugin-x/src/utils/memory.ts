/**
 * Memory helpers shared by the autonomous loops: `createMemorySafe` (idempotent
 * write that tolerates duplicate-key races and retries transient failures),
 * `ensureTwitterContext` (rooms/entities for a tweet), `isTweetProcessed` /
 * `isDuplicateTweet` (dedupe already-handled or near-identical tweets), and
 * `buildTwitterMessageMetadata`. Keeps the connector from re-processing or
 * double-replying to the same tweet.
 */
import {
  ChannelType,
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Memory,
  type UUID,
  type World,
} from "@elizaos/core";
import type { Tweet as ClientTweet } from "../client";

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Options for ensuring Twitter context exists
 */
export interface TwitterContextOptions {
  tweet?: ClientTweet;
  accountId?: string;
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

type TwitterMetadataTweet = Pick<
  ClientTweet,
  "conversationId" | "id" | "name" | "userId" | "username"
>;

/**
 * Persists a Twitter world on both modern upsert runtimes and older production
 * runtimes where ensureWorldExists only creates missing rows.
 */
export async function reconcileTwitterWorld(
  runtime: IAgentRuntime,
  world: World,
): Promise<void> {
  await runtime.ensureWorldExists(world);
  await runtime.updateWorld(world);
}

/**
 * `createdAt` must be an already-validated epoch-milliseconds value: callers
 * normalize the raw tweet timestamp exactly once at their row boundary (and
 * skip the row when it is unusable), so this builder never re-normalizes and
 * can never emit an undefined timestamp (#18965).
 */
export function buildTwitterMessageMetadata(
  tweet: TwitterMetadataTweet,
  entityId: UUID,
  createdAt: number,
  accountId?: string,
): Memory["metadata"] {
  return {
    type: "message",
    source: "twitter",
    ...(accountId ? { accountId } : {}),
    provider: "twitter",
    timestamp: createdAt,
    entityName: tweet.name,
    entityUserName: tweet.username,
    fromBot: false,
    fromId: tweet.userId,
    sourceId: entityId,
    chatType: ChannelType.FEED,
    messageIdFull: tweet.id,
    accountId: accountId ?? "default",
    sender: {
      id: tweet.userId,
      name: tweet.name,
      username: tweet.username,
    },
    twitter: {
      ...(accountId ? { accountId } : {}),
      id: tweet.userId,
      userId: tweet.userId,
      username: tweet.username,
      userName: tweet.username,
      name: tweet.name,
      tweetId: tweet.id,
      conversationId: tweet.conversationId,
    },
  } satisfies Memory["metadata"];
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
    accountId,
  } = options;

  const worldId = createUniqueUuid(runtime, userId);
  const roomId = createUniqueUuid(runtime, conversationId);
  const entityId = createUniqueUuid(runtime, userId);

  try {
    // Ensure world exists
    await reconcileTwitterWorld(runtime, {
      id: worldId,
      name: `${username}'s Twitter`,
      agentId: runtime.agentId,
      metadata: {
        ownership: { ownerId: entityId },
        ...(accountId ? { accountId } : {}),
        twitter: {
          ...(accountId ? { accountId } : {}),
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
      userId,
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
    const message = errorDetail(error);
    logger.error("Failed to ensure Twitter context:", message);
    throw new Error(
      `Failed to create Twitter context for user ${username}: ${message}`,
    );
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
      logger.warn(
        `Failed to create memory (attempt ${attempt + 1}/${maxRetries}):`,
        errorDetail(error),
      );

      // Don't retry on certain errors
      const message = errorDetail(error);
      if (message.includes("duplicate") || message.includes("constraint")) {
        logger.debug("Memory already exists, skipping");
        return;
      }

      // Wait before retry with exponential backoff
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, 2 ** attempt * 1000),
        );
      }
    }
  }

  // All retries failed
  logger.error(
    `Failed to create memory after ${maxRetries} attempts: ${lastError?.message ?? String(lastError)}`,
  );
  throw lastError;
}

/**
 * Checks if a tweet has already been processed
 */
export async function isTweetProcessed(
  runtime: IAgentRuntime,
  tweetId: string,
): Promise<boolean> {
  const memoryId = createUniqueUuid(runtime, tweetId);
  const memory = await runtime.getMemoryById(memoryId);
  return !!memory;
}

/**
 * Gets recent tweets to check for duplicates
 */
export type TwitterCacheIdentity =
  | string
  | { accountId: string; profileId: string };

function recentTweetsCacheKey(identity: TwitterCacheIdentity): string {
  return typeof identity === "string"
    ? `twitter/${identity}/recentTweets`
    : `twitter/${encodeURIComponent(identity.accountId)}/${identity.profileId}/recentTweets`;
}

export async function getRecentTweets(
  runtime: IAgentRuntime,
  identity: TwitterCacheIdentity,
  _count: number = 10,
): Promise<string[]> {
  const cached = await runtime.getCache<string[]>(
    recentTweetsCacheKey(identity),
  );
  if (cached && Array.isArray(cached)) {
    return cached;
  }
  return [];
}

/**
 * Adds a tweet to the recent tweets cache
 */
export async function addToRecentTweets(
  runtime: IAgentRuntime,
  identity: TwitterCacheIdentity,
  tweetText: string,
  maxRecent: number = 10,
): Promise<void> {
  const cacheKey = recentTweetsCacheKey(identity);
  const recent = await getRecentTweets(runtime, identity, maxRecent);
  recent.unshift(tweetText);
  await runtime.setCache(cacheKey, recent.slice(0, maxRecent));
}

function normalizeTweetForDuplicateCheck(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}#@]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tweetTokenSimilarity(a: string, b: string): number {
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (aTokens.size === 0 && bTokens.size === 0) return 1;
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  const union = aTokens.size + bTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Checks if a tweet text is a duplicate of recent tweets
 */
export async function isDuplicateTweet(
  runtime: IAgentRuntime,
  identity: TwitterCacheIdentity,
  tweetText: string,
  similarityThreshold: number = 0.9,
): Promise<boolean> {
  const recentTweets = await getRecentTweets(runtime, identity);
  if (recentTweets.includes(tweetText)) {
    return true;
  }

  const normalizedNew = normalizeTweetForDuplicateCheck(tweetText);
  for (const recent of recentTweets) {
    const normalizedRecent = normalizeTweetForDuplicateCheck(recent);
    if (normalizedNew === normalizedRecent) {
      return true;
    }
    if (
      normalizedNew.includes(normalizedRecent) ||
      normalizedRecent.includes(normalizedNew)
    ) {
      return true;
    }
    if (
      tweetTokenSimilarity(normalizedNew, normalizedRecent) >=
      similarityThreshold
    ) {
      return true;
    }
  }
  return false;
}
