/**
 * Redis Client - Generic interface for any Redis server
 *
 * @description Provides a Redis client that works with any Redis server
 * using the standard Redis protocol via ioredis.
 *
 * Configuration:
 * - In development mode: Automatically connects to redis://localhost:6380 (Docker Compose)
 * - Set REDIS_URL environment variable to connect to any Redis server
 * - Works with local Redis: redis://localhost:6379
 * - Works with Upstash: redis://default:token@hostname:port
 * - Works with any Redis-compatible server
 *
 * Falls back gracefully if Redis is not configured.
 */

import { logger } from "@polyagent/shared";
import type IORedis from "ioredis";

// Type for ioredis instance
export type RedisInstance = IORedis;

// Redis client state
let redisClient: RedisInstance | null = null;
let isInitialized = false;
let isClosing = false;
const isBuildTime = process.env.NEXT_PHASE === "phase-production-build";
const isTestEnv = process.env.NODE_ENV === "test";
const isDev = process.env.NODE_ENV === "development";

// Default Redis URL for local development (Docker Compose uses port 6380)
const DEFAULT_DEV_REDIS_URL = "redis://localhost:6380";

/**
 * Initialize Redis client
 *
 * @description Initializes the Redis client using REDIS_URL environment variable.
 * This is called lazily to avoid bundling ioredis in edge runtime.
 */
async function initializeRedis(): Promise<void> {
  if (isInitialized || isBuildTime || isTestEnv) {
    return;
  }
  isInitialized = true;

  // Use REDIS_URL from env, or default to local Docker Redis in development
  const redisUrl =
    process.env.REDIS_URL || (isDev ? DEFAULT_DEV_REDIS_URL : undefined);
  if (!redisUrl) {
    logger.info(
      "Redis not configured - caching will use in-memory fallback",
      undefined,
      "Redis",
    );
    logger.info(
      "Set REDIS_URL to connect (e.g., redis://localhost:6379)",
      undefined,
      "Redis",
    );
    return;
  }

  if (!process.env.REDIS_URL && isDev) {
    logger.info(
      `Using default Redis URL for development: ${DEFAULT_DEV_REDIS_URL}`,
      undefined,
      "Redis",
    );
  }

  // Check if we're in a Node.js environment (not edge runtime)
  if (typeof process === "undefined" || typeof process.cwd !== "function") {
    logger.warn(
      "Redis not available in edge runtime - use in-memory fallback or serverless Redis",
      undefined,
      "Redis",
    );
    return;
  }

  // Dynamic import to prevent bundling in edge runtime
  const IORedisModule = await import("ioredis");
  const IORedisClass = IORedisModule.default;

  redisClient = new IORedisClass(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) {
        return null;
      }
      return Math.min(times * 100, 2000);
    },
    lazyConnect: true,
  });

  await redisClient.connect();
  logger.info("Redis client connected", undefined, "Redis");
}

// Skip initialization during build time and test
if (isBuildTime || isTestEnv) {
  logger.info(
    isTestEnv
      ? "Test environment detected - skipping Redis initialization"
      : "Build time detected - skipping Redis initialization",
    undefined,
    "Redis",
  );
} else {
  // Always attempt initialization - the function handles missing config gracefully
  void initializeRedis();
}

/**
 * Get the Redis client instance
 *
 * @description Returns the Redis client if available. May return null if
 * Redis is not configured or failed to initialize.
 *
 * @returns {RedisInstance | null} Redis client or null
 */
export function getRedis(): RedisInstance | null {
  return redisClient;
}

// Export for backwards compatibility
export const redis = redisClient;

/**
 * Check if Redis is available
 *
 * @description Determines if a Redis client has been successfully initialized
 * and is available for use. Returns false if Redis is not configured or failed
 * to initialize.
 *
 * @returns {boolean} True if Redis is available, false otherwise
 */
export function isRedisAvailable(): boolean {
  return redisClient !== null;
}

/**
 * Get the current Redis client (for dynamic access after initialization)
 *
 * @description Returns the current Redis client. Use this instead of the
 * exported `redis` constant when you need to access the client after
 * async initialization has completed.
 */
export function getRedisClient(): RedisInstance | null {
  return redisClient;
}

/**
 * Safely publish to Redis (no-op if not available)
 *
 * @description Publishes a message to a Redis list. Returns false if Redis
 * is not available. Automatically sets key expiration to 60 seconds.
 *
 * @param {string} channel - Redis key name
 * @param {string} message - Message to publish
 * @returns {Promise<boolean>} True if published successfully, false if Redis unavailable
 */
export async function safePublish(
  channel: string,
  message: string,
): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  await client.rpush(channel, message);
  await client.expire(channel, 60);
  return true;
}

/**
 * Safely poll Redis for messages (returns empty array if not available)
 *
 * @description Polls a Redis list for messages, removing them from the queue.
 * Returns empty array if Redis is not available or no messages found.
 *
 * @param {string} channel - Redis key name to poll
 * @param {number} count - Maximum number of messages to retrieve (default: 10)
 * @returns {Promise<string[]>} Array of messages, or empty array if none found/unavailable
 */
export async function safePoll(channel: string, count = 10): Promise<string[]> {
  const client = getRedisClient();
  if (!client) return [];

  const items: string[] = [];
  for (let i = 0; i < count; i++) {
    const item: string | null = await client.lpop(channel);
    if (item === null) break;
    items.push(item);
  }

  return items;
}

/**
 * Cleanup Redis connection on shutdown
 *
 * @description Gracefully closes the Redis connection. Safe to call multiple
 * times. Used during application shutdown to clean up resources.
 *
 * @returns {Promise<void>} Promise that resolves when connection is closed
 */
export async function closeRedis(): Promise<void> {
  if (isClosing) return;
  isClosing = true;

  const client = getRedisClient();
  if (client) {
    const status = client.status;
    if (status === "ready" || status === "connect") {
      await client.quit();
      logger.info("Redis connection closed", undefined, "Redis");
    }
  }
}

// Cleanup on process exit (only if not build time)
if (typeof process !== "undefined" && !isBuildTime) {
  process.on("SIGINT", () => {
    void closeRedis();
  });
  process.on("SIGTERM", () => {
    void closeRedis();
  });
}
