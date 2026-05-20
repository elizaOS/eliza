/**
 * Rate Limiting Module
 *
 * User-level rate limiting and duplicate content detection utilities.
 *
 * NOTE:
 * The engine package intentionally does not depend on `@babylon/api`. Historically,
 * these utilities were provided by `@babylon/api` and re-exported from
 * `@babylon/engine` for convenience. That creates circular dependencies in the
 * monorepo, so the engine now provides a framework-agnostic, in-memory default
 * implementation, plus an optional injection point for API/runtime overrides.
 */

import { logger } from '@babylon/shared';
import { createHash } from 'crypto';

// =============================================================================
// Duplicate detection (in-memory)
// =============================================================================

type DuplicateRecord = {
  contentHash: string;
  timestamp: number;
};

type DuplicateConfig = {
  windowMs: number;
  actionType: string;
};

export const DUPLICATE_DETECTION_CONFIGS = {
  POST: {
    windowMs: 5 * 60 * 1000, // 5 minutes
    actionType: 'post',
  },
  COMMENT: {
    windowMs: 2 * 60 * 1000, // 2 minutes
    actionType: 'comment',
  },
  MESSAGE: {
    windowMs: 1 * 60 * 1000, // 1 minute
    actionType: 'message',
  },
} as const;

const duplicateStore = new Map<string, DuplicateRecord[]>();

function hashContent(content: string): string {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}

export function checkDuplicate(
  userId: string,
  content: string,
  config: DuplicateConfig
): { isDuplicate: boolean; lastPostedAt?: Date } {
  const key = `${userId}:${config.actionType}`;
  const contentHash = hashContent(content);
  const now = Date.now();

  let records = duplicateStore.get(key);
  if (!records) {
    records = [];
    duplicateStore.set(key, records);
  }

  const windowStart = now - config.windowMs;
  const recentRecords = records.filter(
    (record) => record.timestamp > windowStart
  );
  duplicateStore.set(key, recentRecords);

  const duplicate = recentRecords.find(
    (record) => record.contentHash === contentHash
  );

  if (duplicate) {
    logger.warn(
      'Duplicate content detected',
      {
        userId,
        actionType: config.actionType,
        contentHash,
        lastPostedAt: new Date(duplicate.timestamp).toISOString(),
      },
      'DuplicateDetector'
    );

    return {
      isDuplicate: true,
      lastPostedAt: new Date(duplicate.timestamp),
    };
  }

  recentRecords.push({ contentHash, timestamp: now });

  logger.debug(
    'Content uniqueness check passed',
    { userId, actionType: config.actionType, contentHash },
    'DuplicateDetector'
  );

  return { isDuplicate: false };
}

export function clearDuplicates(userId: string, actionType: string): void {
  duplicateStore.delete(`${userId}:${actionType}`);
  logger.info(
    'Duplicate records cleared',
    { userId, actionType },
    'DuplicateDetector'
  );
}

export function clearAllDuplicates(): void {
  duplicateStore.clear();
  logger.info('All duplicate records cleared', {}, 'DuplicateDetector');
}

export function cleanupDuplicates(): void {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 minutes (longer than any window)

  let cleanedCount = 0;

  for (const [key, records] of duplicateStore.entries()) {
    const validRecords = records.filter(
      (record) => now - record.timestamp < maxAge
    );
    if (validRecords.length === 0) {
      duplicateStore.delete(key);
      cleanedCount++;
      continue;
    }
    if (validRecords.length !== records.length) {
      duplicateStore.set(key, validRecords);
    }
  }

  if (cleanedCount > 0) {
    logger.info(
      'Cleaned up old duplicate records',
      { cleanedCount, totalRemaining: duplicateStore.size },
      'DuplicateDetector'
    );
  }
}

export function getDuplicateStats(): {
  totalUsers: number;
  totalRecords: number;
  recordsByType: Record<string, number>;
} {
  const recordsByType: Record<string, number> = {};
  let totalRecords = 0;

  for (const [key, records] of duplicateStore.entries()) {
    const actionType = key.split(':')[1] ?? 'unknown';
    totalRecords += records.length;
    recordsByType[actionType] =
      (recordsByType[actionType] ?? 0) + records.length;
  }

  return {
    totalUsers: duplicateStore.size,
    totalRecords,
    recordsByType,
  };
}

// Best-effort periodic cleanup (no-op in environments without setInterval)
if (typeof setInterval !== 'undefined' && process.env.NODE_ENV !== 'test') {
  setInterval(cleanupDuplicates, 5 * 60 * 1000);
}

// =============================================================================
// Rate limiting (in-memory default + injectable provider)
// =============================================================================

type RateLimitRecord = {
  count: number;
  windowStart: number;
  recentActions: number[];
};

export type RateLimitConfig = {
  maxRequests: number;
  windowMs: number;
  actionType: string;
};

export type UserRateLimitResult = {
  allowed: boolean;
  retryAfter?: number;
  remaining?: number;
};

export const RATE_LIMIT_CONFIGS = {
  // Content creation
  CREATE_POST: { maxRequests: 3, windowMs: 60000, actionType: 'create_post' },
  CREATE_COMMENT: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: 'create_comment',
  },

  // Interactions
  LIKE_POST: { maxRequests: 20, windowMs: 60000, actionType: 'like_post' },
  LIKE_COMMENT: {
    maxRequests: 20,
    windowMs: 60000,
    actionType: 'like_comment',
  },
  SHARE_POST: { maxRequests: 5, windowMs: 60000, actionType: 'share_post' },

  // Social actions
  FOLLOW_USER: { maxRequests: 10, windowMs: 60000, actionType: 'follow_user' },
  UNFOLLOW_USER: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: 'unfollow_user',
  },

  // Messages
  SEND_MESSAGE: {
    maxRequests: 20,
    windowMs: 60000,
    actionType: 'send_message',
  },

  // Uploads
  UPLOAD_IMAGE: { maxRequests: 5, windowMs: 60000, actionType: 'upload_image' },

  // Feedback
  SUBMIT_FEEDBACK: {
    maxRequests: 5,
    windowMs: 60000,
    actionType: 'submit_feedback',
  },

  // Profile updates
  UPDATE_PROFILE: {
    maxRequests: 5,
    windowMs: 60000,
    actionType: 'update_profile',
  },

  // Agent actions
  GENERATE_AGENT_PROFILE: {
    maxRequests: 5,
    windowMs: 60000,
    actionType: 'generate_agent_profile',
  },
  GENERATE_AGENT_FIELD: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: 'generate_agent_field',
  },
  GENERATE_AGENT_AVATAR: {
    maxRequests: 8,
    windowMs: 60000,
    actionType: 'generate_agent_avatar',
  },

  // Market actions
  OPEN_POSITION: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: 'open_position',
  },
  CLOSE_POSITION: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: 'close_position',
  },
  BUY_PREDICTION: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: 'buy_prediction',
  },
  SELL_PREDICTION: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: 'sell_prediction',
  },

  // Admin actions
  ADMIN_ACTION: {
    maxRequests: 100,
    windowMs: 60000,
    actionType: 'admin_action',
  },
  ADMIN_STATS: { maxRequests: 30, windowMs: 60000, actionType: 'admin_stats' },

  // Public endpoints
  PUBLIC_BALANCE_FETCH: {
    maxRequests: 60,
    windowMs: 60000,
    actionType: 'public_balance_fetch',
  },
  PUBLIC_BALANCE_FETCH_ANONYMOUS: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: 'public_balance_fetch_anonymous',
  },
  PUBLIC_NFT_IMAGE: {
    maxRequests: 60,
    windowMs: 60000,
    actionType: 'public_nft_image',
  },
  PUBLIC_NFT_IMAGE_ANONYMOUS: {
    maxRequests: 10,
    windowMs: 60000,
    actionType: 'public_nft_image_anonymous',
  },

  // Default fallback
  DEFAULT: { maxRequests: 30, windowMs: 60000, actionType: 'default' },
} as const;

export interface RateLimitProvider {
  checkRateLimitAsync(
    userId: string,
    config: RateLimitConfig
  ): Promise<UserRateLimitResult>;
  checkRateLimit(userId: string, config: RateLimitConfig): UserRateLimitResult;
  resetRateLimit(userId: string, actionType: string): Promise<void>;
  clearAllRateLimits(): Promise<void>;
  getRateLimitStatus(
    userId: string,
    config: RateLimitConfig
  ): Promise<{ count: number; remaining: number; resetAt: Date }>;
}

const memoryFallbackStore = new Map<string, RateLimitRecord>();

function checkRateLimitMemory(
  userId: string,
  config: RateLimitConfig
): UserRateLimitResult {
  const key = `${userId}:${config.actionType}`;
  const now = Date.now();

  let record = memoryFallbackStore.get(key);
  if (!record) {
    record = { count: 0, windowStart: now, recentActions: [] };
    memoryFallbackStore.set(key, record);
  }

  const windowStart = now - config.windowMs;
  record.recentActions = record.recentActions.filter(
    (timestamp) => timestamp > windowStart
  );

  if (record.recentActions.length >= config.maxRequests) {
    const oldestAction = record.recentActions[0];
    const retryAfter = oldestAction
      ? Math.ceil((oldestAction + config.windowMs - now) / 1000)
      : Math.ceil(config.windowMs / 1000);

    logger.warn(
      'Rate limit exceeded (memory)',
      {
        userId,
        actionType: config.actionType,
        attempts: record.recentActions.length,
        maxRequests: config.maxRequests,
        retryAfter,
      },
      'RateLimiter'
    );

    return { allowed: false, retryAfter, remaining: 0 };
  }

  record.recentActions.push(now);
  record.count = record.recentActions.length;
  record.windowStart = now;

  const remaining = config.maxRequests - record.recentActions.length;

  logger.debug(
    'Rate limit check passed (memory)',
    {
      userId,
      actionType: config.actionType,
      count: record.recentActions.length,
      maxRequests: config.maxRequests,
      remaining,
    },
    'RateLimiter'
  );

  return { allowed: true, remaining };
}

class InMemoryRateLimitProvider implements RateLimitProvider {
  async checkRateLimitAsync(
    userId: string,
    config: RateLimitConfig
  ): Promise<UserRateLimitResult> {
    return checkRateLimitMemory(userId, config);
  }

  checkRateLimit(userId: string, config: RateLimitConfig): UserRateLimitResult {
    return checkRateLimitMemory(userId, config);
  }

  async resetRateLimit(userId: string, actionType: string): Promise<void> {
    memoryFallbackStore.delete(`${userId}:${actionType}`);
    logger.info(
      'Rate limit reset (memory)',
      { userId, actionType },
      'RateLimiter'
    );
  }

  async clearAllRateLimits(): Promise<void> {
    memoryFallbackStore.clear();
    logger.info('All rate limits cleared (memory)', {}, 'RateLimiter');
  }

  async getRateLimitStatus(
    userId: string,
    config: RateLimitConfig
  ): Promise<{ count: number; remaining: number; resetAt: Date }> {
    const now = Date.now();
    const record = memoryFallbackStore.get(`${userId}:${config.actionType}`);

    if (!record) {
      return {
        count: 0,
        remaining: config.maxRequests,
        resetAt: new Date(now + config.windowMs),
      };
    }

    const windowStart = now - config.windowMs;
    const validActions = record.recentActions.filter(
      (timestamp) => timestamp > windowStart
    );
    const oldestAction = validActions[0] ?? now;

    return {
      count: validActions.length,
      remaining: Math.max(0, config.maxRequests - validActions.length),
      resetAt: new Date(oldestAction + config.windowMs),
    };
  }
}

let provider: RateLimitProvider = new InMemoryRateLimitProvider();

export function setRateLimitProvider(next: RateLimitProvider): void {
  provider = next;
}

export function checkRateLimit(
  userId: string,
  config: RateLimitConfig
): UserRateLimitResult {
  return provider.checkRateLimit(userId, config);
}

export function checkRateLimitAsync(
  userId: string,
  config: RateLimitConfig
): Promise<UserRateLimitResult> {
  return provider.checkRateLimitAsync(userId, config);
}

export function resetRateLimit(
  userId: string,
  actionType: string
): Promise<void> {
  return provider.resetRateLimit(userId, actionType);
}

export function clearAllRateLimits(): Promise<void> {
  return provider.clearAllRateLimits();
}

export function getRateLimitStatus(
  userId: string,
  config: RateLimitConfig
): Promise<{ count: number; remaining: number; resetAt: Date }> {
  return provider.getRateLimitStatus(userId, config);
}

export function cleanupMemoryRateLimits(): void {
  const now = Date.now();
  const maxAge = 5 * 60 * 1000;

  let cleanedCount = 0;

  for (const [key, record] of memoryFallbackStore.entries()) {
    const hasRecentActions = record.recentActions.some(
      (timestamp) => now - timestamp < maxAge
    );
    if (!hasRecentActions) {
      memoryFallbackStore.delete(key);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    logger.info(
      'Cleaned up old rate limit records (memory)',
      { cleanedCount, totalRemaining: memoryFallbackStore.size },
      'RateLimiter'
    );
  }
}
