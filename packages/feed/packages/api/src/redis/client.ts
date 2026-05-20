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

import { logger } from '@feed/shared';
import type IORedis from 'ioredis';

// Type for ioredis instance
export type RedisInstance = IORedis;

// Augment globalThis for development hot-reload persistence
declare global {
  // eslint-disable-next-line no-var
  var __redisClient: RedisInstance | null | undefined;
  // eslint-disable-next-line no-var
  var __redisInitPromise: Promise<void> | null | undefined;
  // eslint-disable-next-line no-var
  var __redisInitialized: boolean | undefined;
}

const isBuildTime = process.env.NEXT_PHASE === 'phase-production-build';
const isTestEnv = process.env.NODE_ENV === 'test';
const isDev = process.env.NODE_ENV === 'development';
const isRedisDisabled = process.env.FEED_DISABLE_REDIS === '1';

// Use globalThis to persist across hot reloads in development
// This prevents multiple Redis connections from being created
let redisClient: RedisInstance | null = isDev
  ? (globalThis.__redisClient ?? null)
  : null;
let isInitialized = isDev ? (globalThis.__redisInitialized ?? false) : false;
let initializationPromise: Promise<void> | null = isDev
  ? (globalThis.__redisInitPromise ?? null)
  : null;
let isClosing = false;

// Default Redis URL for local development (Docker Compose uses port 6380)
const DEFAULT_DEV_REDIS_URL = 'redis://localhost:6380';

// Sync state to globalThis in dev
function syncGlobalState() {
  if (isDev) {
    globalThis.__redisClient = redisClient;
    globalThis.__redisInitialized = isInitialized;
    globalThis.__redisInitPromise = initializationPromise;
  }
}

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
  syncGlobalState();

  if (isRedisDisabled) {
    logger.info(
      'Redis explicitly disabled via FEED_DISABLE_REDIS=1',
      undefined,
      'Redis'
    );
    return;
  }

  // Use REDIS_URL from env, or default to local Docker Redis in development
  const redisUrl =
    process.env.REDIS_URL || (isDev ? DEFAULT_DEV_REDIS_URL : undefined);
  if (!redisUrl) {
    logger.info(
      'Redis not configured - caching will use in-memory fallback',
      undefined,
      'Redis'
    );
    logger.info(
      'Set REDIS_URL to connect (e.g., redis://localhost:6379)',
      undefined,
      'Redis'
    );
    return;
  }

  if (!process.env.REDIS_URL && isDev) {
    logger.info(
      `Using default Redis URL for development: ${DEFAULT_DEV_REDIS_URL}`,
      undefined,
      'Redis'
    );
  }

  // Check if we're in a Node.js environment (not edge runtime)
  if (typeof process === 'undefined' || typeof process.cwd !== 'function') {
    logger.warn(
      'Redis not available in edge runtime - use in-memory fallback or serverless Redis',
      undefined,
      'Redis'
    );
    return;
  }

  // Dynamic import to prevent bundling in edge runtime
  const IORedisModule = await import('ioredis');
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
    // Keep connection alive for SSE streaming
    keepAlive: 10000,
    // Don't disconnect on idle - needed for long-running SSE connections
    enableReadyCheck: true,
  });

  redisClient.on('error', (error: Error) => {
    logger.warn('Redis client error', { error: error.message }, 'Redis');
  });

  try {
    await redisClient.connect();
    syncGlobalState();
    logger.info('Redis client connected', undefined, 'Redis');
  } catch (error) {
    logger.warn(
      'Redis unavailable; continuing with in-memory fallback',
      {
        redisUrl,
        error: error instanceof Error ? error.message : String(error),
      },
      'Redis'
    );
    try {
      redisClient.disconnect(false);
    } catch {
      // Ignore cleanup failures when the connection never became ready.
    }
    redisClient = null;
    syncGlobalState();
  }
}

// Skip initialization during build time and test
if (isBuildTime || isTestEnv) {
  logger.info(
    isTestEnv
      ? 'Test environment detected - skipping Redis initialization'
      : 'Build time detected - skipping Redis initialization',
    undefined,
    'Redis'
  );
} else if (!initializationPromise) {
  // Always attempt initialization - store the promise so callers can await it
  // Only create a new promise if one doesn't already exist (from globalThis)
  initializationPromise = initializeRedis().catch((error: unknown) => {
    logger.warn(
      'Redis initialization failed; continuing without Redis',
      { error: error instanceof Error ? error.message : String(error) },
      'Redis'
    );
    redisClient = null;
    syncGlobalState();
  });
  syncGlobalState();
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
 * Ensure Redis is ready for use
 *
 * @description Awaits Redis initialization and returns the client.
 * Use this in long-running processes like SSE that need guaranteed
 * Redis availability. Returns null if Redis is not configured or
 * failed to initialize.
 *
 * @returns {Promise<RedisInstance | null>} Redis client or null
 */
export async function ensureRedisReady(): Promise<RedisInstance | null> {
  // Wait for initialization if it's in progress
  if (initializationPromise) {
    await initializationPromise;
  }

  // Check if client is connected
  const client = redisClient;
  if (!client) {
    return null;
  }

  // Check connection status and reconnect if needed
  const status = client.status;
  if (status === 'ready') {
    return client;
  }

  if (status === 'connecting' || status === 'connect') {
    // Wait for connection to complete
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.off('ready', onReady);
        client.off('error', onError);
        reject(new Error('Redis connection timeout'));
      }, 5000);

      const onReady = () => {
        clearTimeout(timeout);
        client.off('error', onError);
        resolve();
      };

      const onError = (err: Error) => {
        clearTimeout(timeout);
        client.off('ready', onReady);
        reject(err);
      };

      client.once('ready', onReady);
      client.once('error', onError);
    });
    return client;
  }

  // If disconnected/closed, try to reconnect
  if (status === 'end' || status === 'close') {
    logger.info(
      'Redis client disconnected, attempting to reconnect',
      { status },
      'Redis'
    );
    try {
      await client.connect();
      return client;
    } catch (err) {
      logger.error(
        'Redis reconnection failed',
        { error: err instanceof Error ? err.message : String(err) },
        'Redis'
      );
      return null;
    }
  }

  return client;
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
  message: string
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
    if (status === 'ready' || status === 'connect') {
      await client.quit();
      logger.info('Redis connection closed', undefined, 'Redis');
    }
  }
}

// Cleanup on process exit (only if not build time)
if (typeof process !== 'undefined' && !isBuildTime) {
  process.on('SIGINT', () => {
    void closeRedis();
  });
  process.on('SIGTERM', () => {
    void closeRedis();
  });
}
