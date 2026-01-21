/**
 * User-level Rate Limiting Utility
 *
 * Implements a sliding window rate limiter with per-user tracking.
 * Uses Redis for distributed rate limiting in production (serverless-compatible).
 * Falls back to in-memory storage when Redis is unavailable.
 */

import { randomUUID } from "node:crypto";
import { logger } from "@polyagent/shared";
import { getRedisClient, isRedisAvailable } from "../redis/client";

interface RateLimitRecord {
  count: number;
  windowStart: number;
  recentActions: number[]; // Timestamps of recent actions for sliding window
}

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  actionType: string;
}

// In-memory fallback store for when Redis is unavailable
// This is NOT suitable for production serverless environments
const memoryFallbackStore = new Map<string, RateLimitRecord>();

/**
 * Predefined rate limit configurations for different actions
 */
export const RATE_LIMIT_CONFIGS = {
  // Content creation
  CREATE_POST: { maxRequests: 3, windowMs: 60000, actionType: "create_post" }, // 3 posts per minute
  CREATE_COMMENT: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: "create_comment",
  }, // 10 comments per minute

  // Interactions
  LIKE_POST: { maxRequests: 20, windowMs: 60000, actionType: "like_post" }, // 20 likes per minute
  LIKE_COMMENT: {
    maxRequests: 20,
    windowMs: 60000,
    actionType: "like_comment",
  }, // 20 likes per minute
  SHARE_POST: { maxRequests: 5, windowMs: 60000, actionType: "share_post" }, // 5 shares per minute

  // Social actions
  FOLLOW_USER: { maxRequests: 10, windowMs: 60000, actionType: "follow_user" }, // 10 follows per minute
  UNFOLLOW_USER: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: "unfollow_user",
  }, // 10 unfollows per minute

  // Messages
  SEND_MESSAGE: {
    maxRequests: 20,
    windowMs: 60000,
    actionType: "send_message",
  }, // 20 messages per minute
  TYPING_INDICATOR: {
    maxRequests: 60,
    windowMs: 60000,
    actionType: "typing_indicator",
  }, // 60 typing indicators per minute (1 per second max)

  // Uploads
  UPLOAD_IMAGE: { maxRequests: 5, windowMs: 60000, actionType: "upload_image" }, // 5 uploads per minute

  // Feedback
  SUBMIT_FEEDBACK: {
    maxRequests: 5,
    windowMs: 60000,
    actionType: "submit_feedback",
  }, // 5 feedback submissions per minute

  // Profile updates
  UPDATE_PROFILE: {
    maxRequests: 5,
    windowMs: 60000,
    actionType: "update_profile",
  }, // 5 updates per minute

  // Agent actions
  GENERATE_AGENT_PROFILE: {
    maxRequests: 5,
    windowMs: 60000,
    actionType: "generate_agent_profile",
  }, // 5 generations per minute
  GENERATE_AGENT_FIELD: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: "generate_agent_field",
  }, // 10 field generations per minute

  // Market actions
  OPEN_POSITION: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: "open_position",
  }, // 10 positions per minute
  CLOSE_POSITION: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: "close_position",
  }, // 10 positions per minute
  BUY_PREDICTION: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: "buy_prediction",
  }, // 10 buys per minute
  SELL_PREDICTION: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: "sell_prediction",
  }, // 10 sells per minute

  // Admin actions (more generous limits)
  ADMIN_ACTION: {
    maxRequests: 100,
    windowMs: 60000,
    actionType: "admin_action",
  }, // 100 admin actions per minute

  // Admin stats queries (expensive operations, stricter limits)
  ADMIN_STATS: {
    maxRequests: 30,
    windowMs: 60000,
    actionType: "admin_stats",
  }, // 30 stats queries per minute (expensive database operations)

  // Public endpoints (IP-based rate limiting)
  PUBLIC_BALANCE_FETCH: {
    maxRequests: 60,
    windowMs: 60000,
    actionType: "public_balance_fetch",
  }, // 60 balance fetches per minute per IP (prevent enumeration)

  // Anonymous/unknown IP requests get stricter limits to prevent abuse
  // when IP detection fails (e.g., certain proxies, spoofed headers)
  PUBLIC_BALANCE_FETCH_ANONYMOUS: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: "public_balance_fetch_anonymous",
  }, // 10 fetches per minute for anonymous bucket (shared, stricter)

  // NFT image proxy (GitHub API protection)
  PUBLIC_NFT_IMAGE: {
    maxRequests: 60,
    windowMs: 60000,
    actionType: "public_nft_image",
  }, // 60 image fetches per minute per IP

  // Anonymous NFT image requests (stricter)
  PUBLIC_NFT_IMAGE_ANONYMOUS: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: "public_nft_image_anonymous",
  }, // 10 fetches per minute for anonymous bucket

  // External agent endpoints
  EXTERNAL_AGENT_DISCOVER: {
    maxRequests: 60,
    windowMs: 60000,
    actionType: "external_agent_discover",
  }, // 60 discovery requests per minute (default, can be overridden by agent's discoveryRateLimit)
  EXTERNAL_AGENT_REGISTER: {
    maxRequests: 5,
    windowMs: 3600000,
    actionType: "external_agent_register",
  }, // 5 registrations per hour per user

  // Default fallback
  DEFAULT: { maxRequests: 30, windowMs: 60000, actionType: "default" }, // 30 requests per minute
} as const;

// Redis key prefix for rate limiting
const RATE_LIMIT_KEY_PREFIX = "ratelimit";

/**
 * Check if user has exceeded rate limit for a specific action.
 * Uses Redis for distributed rate limiting when available,
 * falls back to in-memory for development/local testing.
 *
 * Uses sliding window algorithm for accurate rate limiting.
 */
export async function checkRateLimitAsync(
  userId: string,
  config: RateLimitConfig,
): Promise<{ allowed: boolean; retryAfter?: number; remaining?: number }> {
  const redis = getRedisClient();

  // Use Redis if available for distributed rate limiting
  if (redis && isRedisAvailable()) {
    return checkRateLimitRedis(userId, config);
  }

  // Fall back to in-memory (not suitable for serverless production)
  logger.debug(
    "Using in-memory rate limiting fallback",
    { userId, actionType: config.actionType },
    "RateLimiter",
  );
  return checkRateLimitMemory(userId, config);
}

/**
 * Synchronous rate limit check using in-memory fallback.
 * Kept for backwards compatibility with existing code.
 * @deprecated Use checkRateLimitAsync for proper Redis-backed rate limiting
 */
export function checkRateLimit(
  userId: string,
  config: RateLimitConfig,
): { allowed: boolean; retryAfter?: number; remaining?: number } {
  // If Redis is available, we should be using the async version
  // Log a warning in production to encourage migration
  if (isRedisAvailable()) {
    logger.warn(
      "Using synchronous rate limit check with Redis available - consider using checkRateLimitAsync",
      { userId, actionType: config.actionType },
      "RateLimiter",
    );
  }
  return checkRateLimitMemory(userId, config);
}

/**
 * Redis-backed rate limiting using sorted sets for sliding window.
 * Each action is stored with its timestamp as score, allowing efficient
 * window-based counting and cleanup.
 */
async function checkRateLimitRedis(
  userId: string,
  config: RateLimitConfig,
): Promise<{ allowed: boolean; retryAfter?: number; remaining?: number }> {
  const redis = getRedisClient();
  if (!redis) {
    return checkRateLimitMemory(userId, config);
  }

  const key = `${RATE_LIMIT_KEY_PREFIX}:${config.actionType}:${userId}`;
  const now = Date.now();
  const windowStart = now - config.windowMs;

  try {
    // Atomic Lua script for sliding window rate limiting
    // Performs cleanup, check, and add in a single atomic operation
    const luaScript = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local windowStart = tonumber(ARGV[2])
      local maxRequests = tonumber(ARGV[3])
      local windowMs = tonumber(ARGV[4])
      local member = ARGV[5]
      
      -- Remove expired entries (outside current window)
      redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)
      
      -- Count remaining entries in the window
      local count = redis.call('ZCARD', key)
      
      -- Check if limit exceeded
      if count >= maxRequests then
        -- Get oldest entry for retry-after calculation
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        local oldestTimestamp = now
        if oldest and #oldest >= 2 then
          oldestTimestamp = tonumber(oldest[2])
        end
        return {0, oldestTimestamp, count}
      end
      
      -- Add new entry and set expiration atomically
      redis.call('ZADD', key, now, member)
      redis.call('EXPIRE', key, math.ceil(windowMs / 1000) + 10)
      
      return {1, 0, count + 1}
    `;

    // Use full UUID to avoid collisions under high request volume
    const uniqueId = randomUUID();
    const member = `${now}-${userId}-${uniqueId}`;

    const result = (await redis.eval(
      luaScript,
      1,
      key,
      now.toString(),
      windowStart.toString(),
      config.maxRequests.toString(),
      config.windowMs.toString(),
      member,
    )) as [number, number, number];

    if (!result || !Array.isArray(result) || result.length < 3) {
      logger.warn(
        "Redis Lua script returned unexpected result",
        { userId, actionType: config.actionType, result },
        "RateLimiter",
      );
      return checkRateLimitMemory(userId, config);
    }

    const [allowed, oldestTimestamp, count] = result;

    if (allowed === 0) {
      // Rate limit exceeded
      const retryAfter = Math.ceil(
        (oldestTimestamp + config.windowMs - now) / 1000,
      );

      logger.warn(
        "Rate limit exceeded (Redis)",
        {
          userId,
          actionType: config.actionType,
          count,
          maxRequests: config.maxRequests,
          retryAfter,
        },
        "RateLimiter",
      );

      return {
        allowed: false,
        retryAfter: Math.max(1, retryAfter),
        remaining: 0,
      };
    }

    const remaining = config.maxRequests - count;

    logger.debug(
      "Rate limit check passed (Redis)",
      {
        userId,
        actionType: config.actionType,
        count,
        maxRequests: config.maxRequests,
        remaining,
      },
      "RateLimiter",
    );

    return {
      allowed: true,
      remaining: Math.max(0, remaining),
    };
  } catch (error) {
    logger.error(
      "Redis rate limit check failed, falling back to memory",
      {
        error: error instanceof Error ? error.message : String(error),
        userId,
        actionType: config.actionType,
      },
      "RateLimiter",
    );
    return checkRateLimitMemory(userId, config);
  }
}

/**
 * In-memory rate limiting fallback.
 * Not suitable for serverless production (each instance has separate memory).
 */
function checkRateLimitMemory(
  userId: string,
  config: RateLimitConfig,
): { allowed: boolean; retryAfter?: number; remaining?: number } {
  const key = `${userId}:${config.actionType}`;
  const now = Date.now();

  // Get or create rate limit record
  let record = memoryFallbackStore.get(key);

  if (!record) {
    record = {
      count: 0,
      windowStart: now,
      recentActions: [],
    };
    memoryFallbackStore.set(key, record);
  }

  // Remove actions outside the current window (sliding window)
  const windowStart = now - config.windowMs;
  record.recentActions = record.recentActions.filter(
    (timestamp) => timestamp > windowStart,
  );

  // Check if user has exceeded the limit
  if (record.recentActions.length >= config.maxRequests) {
    const oldestAction = record.recentActions[0];
    const retryAfter = oldestAction
      ? Math.ceil((oldestAction + config.windowMs - now) / 1000)
      : Math.ceil(config.windowMs / 1000);

    logger.warn(
      "Rate limit exceeded (memory)",
      {
        userId,
        actionType: config.actionType,
        attempts: record.recentActions.length,
        maxRequests: config.maxRequests,
        retryAfter,
      },
      "RateLimiter",
    );

    return {
      allowed: false,
      retryAfter,
      remaining: 0,
    };
  }

  // Record this action
  record.recentActions.push(now);
  record.count = record.recentActions.length;
  record.windowStart = now;

  const remaining = config.maxRequests - record.recentActions.length;

  logger.debug(
    "Rate limit check passed (memory)",
    {
      userId,
      actionType: config.actionType,
      count: record.recentActions.length,
      maxRequests: config.maxRequests,
      remaining,
    },
    "RateLimiter",
  );

  return {
    allowed: true,
    remaining,
  };
}

/**
 * Reset rate limit for a specific user and action
 * Useful for testing or manual intervention
 */
export async function resetRateLimit(
  userId: string,
  actionType: string,
): Promise<void> {
  // Clear from Redis if available
  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    const key = `${RATE_LIMIT_KEY_PREFIX}:${actionType}:${userId}`;
    await redis.del(key);
  }

  // Also clear from memory fallback
  const memoryKey = `${userId}:${actionType}`;
  memoryFallbackStore.delete(memoryKey);

  logger.info("Rate limit reset", { userId, actionType }, "RateLimiter");
}

/** Maximum iterations for SCAN loop to prevent infinite loops */
const MAX_SCAN_ITERATIONS = 1000;

/**
 * Clear all rate limit records
 * Useful for testing
 */
export async function clearAllRateLimits(): Promise<void> {
  // Clear from Redis if available
  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    try {
      // Use SCAN to find and delete all rate limit keys
      let cursor = "0";
      let iterations = 0;
      do {
        iterations++;
        if (iterations > MAX_SCAN_ITERATIONS) {
          logger.warn(
            "clearAllRateLimits: MAX_SCAN_ITERATIONS reached, breaking out of loop",
            {
              maxIterations: MAX_SCAN_ITERATIONS,
              keyPrefix: RATE_LIMIT_KEY_PREFIX,
            },
            "RateLimiter",
          );
          break;
        }

        const [newCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          `${RATE_LIMIT_KEY_PREFIX}:*`,
          "COUNT",
          100,
        );
        cursor = newCursor;
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } while (cursor !== "0");
    } catch (error) {
      logger.error(
        "Failed to clear Redis rate limits",
        { error: error instanceof Error ? error.message : String(error) },
        "RateLimiter",
      );
    }
  }

  // Clear memory fallback
  memoryFallbackStore.clear();
  logger.info("All rate limits cleared", {}, "RateLimiter");
}

/**
 * Get current rate limit status for a user and action
 */
export async function getRateLimitStatus(
  userId: string,
  config: RateLimitConfig,
): Promise<{ count: number; remaining: number; resetAt: Date }> {
  const redis = getRedisClient();
  const now = Date.now();

  // Use Redis if available
  if (redis && isRedisAvailable()) {
    const key = `${RATE_LIMIT_KEY_PREFIX}:${config.actionType}:${userId}`;
    const windowStart = now - config.windowMs;

    try {
      // Use read-only operations to get status without mutating the sorted set
      // Count entries within the current window
      const count = await redis.zcount(key, windowStart, "+inf");
      // Get the oldest entry's timestamp for reset calculation
      const oldestEntries = await redis.zrangebyscore(
        key,
        windowStart,
        "+inf",
        "WITHSCORES",
        "LIMIT",
        0,
        1,
      );
      // Only read oldestEntries[1] if at least 2 elements exist (entry + score)
      const oldestTimestamp =
        oldestEntries.length >= 2
          ? Number.parseInt(oldestEntries[1]!, 10)
          : now;

      return {
        count,
        remaining: Math.max(0, config.maxRequests - count),
        resetAt: new Date(oldestTimestamp + config.windowMs),
      };
    } catch (e) {
      // Log the Redis failure before falling back to memory
      logger.error(
        "Redis rate limiter failed, falling back to in-memory",
        {
          error: e instanceof Error ? e.message : String(e),
          userId,
          actionType: config.actionType,
        },
        "RateLimiter",
      );
    }
  }

  // Memory fallback
  const memoryKey = `${userId}:${config.actionType}`;
  const record = memoryFallbackStore.get(memoryKey);

  if (!record) {
    return {
      count: 0,
      remaining: config.maxRequests,
      resetAt: new Date(now + config.windowMs),
    };
  }

  // Remove expired actions
  const windowStart = now - config.windowMs;
  const validActions = record.recentActions.filter(
    (timestamp) => timestamp > windowStart,
  );

  const oldestAction = validActions[0] || now;

  return {
    count: validActions.length,
    remaining: Math.max(0, config.maxRequests - validActions.length),
    resetAt: new Date(oldestAction + config.windowMs),
  };
}

/**
 * Cleanup old rate limit records from memory fallback.
 * Redis handles this automatically via key expiration.
 * Call periodically to prevent memory leaks when using fallback.
 */
export function cleanupMemoryRateLimits(): void {
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes

  let cleanedCount = 0;

  for (const [key, record] of memoryFallbackStore.entries()) {
    // Remove records where all actions are older than maxAge
    const hasRecentActions = record.recentActions.some(
      (timestamp) => now - timestamp < maxAge,
    );

    if (!hasRecentActions) {
      memoryFallbackStore.delete(key);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    logger.info(
      "Cleaned up old rate limit records (memory)",
      {
        cleanedCount,
        totalRemaining: memoryFallbackStore.size,
      },
      "RateLimiter",
    );
  }
}

// Memory cleanup interval management for opt-in cleanup
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Start the memory cleanup interval.
 * Call this from runtime bootstrap to enable automatic cleanup.
 * Returns true if started, false if already running.
 */
export function startMemoryCleanup(): boolean {
  if (cleanupIntervalId !== null) {
    return false; // Already running
  }
  if (typeof setInterval === "undefined") {
    return false; // Environment doesn't support setInterval
  }
  cleanupIntervalId = setInterval(cleanupMemoryRateLimits, 5 * 60 * 1000);
  return true;
}

/**
 * Stop the memory cleanup interval.
 * Useful for tests or graceful shutdown.
 * Returns true if stopped, false if not running.
 */
export function stopMemoryCleanup(): boolean {
  if (cleanupIntervalId === null) {
    return false; // Not running
  }
  clearInterval(cleanupIntervalId);
  cleanupIntervalId = null;
  return true;
}

// Auto-start cleanup only in production (not during tests)
if (typeof setInterval !== "undefined" && process.env.NODE_ENV !== "test") {
  const autoStarted = startMemoryCleanup();
  if (!autoStarted) {
    logger.debug(
      "Memory cleanup auto-start failed (already running or setInterval unavailable)",
      { nodeEnv: process.env.NODE_ENV },
      "RateLimiter",
    );
  }
}
