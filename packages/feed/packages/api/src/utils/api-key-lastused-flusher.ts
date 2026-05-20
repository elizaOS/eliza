/**
 * API Key lastUsedAt Write-Back Cache Flusher
 *
 * WHY: Batches Redis updates and flushes to database periodically.
 * This reduces database load by 90%+ compared to individual writes.
 *
 * Flush Strategy:
 * - Time-based: Flush every 30 seconds
 * - Size-based: Flush when 100+ updates pending
 * - Startup: Flush all pending on server start
 *
 * Performance Impact:
 * - Before: 1,830 individual UPDATE queries (115,885 seconds total)
 * - After: ~18 batch UPDATE queries (estimated 1,000-2,000 seconds total)
 *
 * Multi-instance: flush is guarded by a Redis `SET NX` lock so only one worker drains
 * the shared queue/hash at a time (TTL recovers if a process dies while holding the lock).
 */

import { randomBytes } from 'node:crypto';

import { asSystem, eq, userApiKeys } from '@feed/db';
import { logger } from '@feed/shared';
import { getRedisClient, isRedisAvailable } from '../redis';

/**
 * Redis keys for write-back cache.
 *
 * WHY separate structures:
 * - Hash: O(1) lookup for latest timestamp per key (handles multiple updates before flush)
 * - Sorted Set: Natural ordering for batching oldest updates first
 */
const REDIS_KEY_LAST_USED_UPDATES = 'api-key:last-used:updates'; // Hash: keyId → timestamp
const REDIS_KEY_LAST_USED_QUEUE = 'api-key:last-used:queue'; // Sorted Set: score=timestamp, member=keyId
/** Cross-process flush mutex (SET NX); TTL bounds stuck-lock if a worker dies mid-flush */
const REDIS_KEY_FLUSH_LOCK = 'api-key:last-used:flush-lock';
const FLUSH_LOCK_TTL_SEC = 120;

/** Safe release: only delete lock if value matches our token (ioredis: eval script, numKeys, key, arg) */
const RELEASE_FLUSH_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

// Flush configuration
/**
 * Flush interval in milliseconds.
 *
 * WHY 30 seconds: Balances update freshness (acceptable delay for lastUsedAt) with database load.
 * Lower = more frequent flushes (higher DB load), Higher = longer delay (lower DB load).
 */
const FLUSH_INTERVAL_MS = 30 * 1000; // 30 seconds

/**
 * Maximum number of updates to flush in a single batch.
 *
 * WHY 100: Balances transaction size with flush frequency. Higher = fewer transactions but larger,
 * Lower = more transactions but smaller. 100 is a good balance for most workloads.
 */
const FLUSH_BATCH_SIZE = 100; // Flush up to 100 updates at once

/**
 * Queue size threshold to trigger early flush.
 *
 * WHY match FLUSH_BATCH_SIZE: Ensures consistent batching behavior. When queue reaches this size,
 * we flush immediately instead of waiting for time-based flush.
 */
const FLUSH_SIZE_THRESHOLD = 100; // Flush when 100+ updates pending

/**
 * Flush interval timer.
 *
 * WHY null initially: Set when flusher starts, cleared when stopped. Null check prevents
 * multiple flushers from starting.
 */
let flushInterval: NodeJS.Timeout | null = null;

// Metrics tracking
/**
 * WHY track metrics: Enables monitoring of flush health, success rate, and total throughput.
 * Useful for detecting issues and tuning flush parameters.
 */
let flushSuccessCount = 0;
let flushFailureCount = 0;
let totalUpdatesFlushed = 0;
const globalFlusherState = globalThis as typeof globalThis & {
  __feedApiKeyFlusherSignalsRegistered?: boolean;
};

/**
 * Flush pending lastUsedAt updates from Redis to database.
 *
 * WHY: Batches multiple updates into single database query, reducing load.
 *
 * Process:
 * 1. Get oldest N entries from sorted set (ordered by timestamp)
 * 2. Read corresponding timestamps from hash
 * 3. Batch UPDATE query to database (single query with CASE statement)
 * 4. Remove processed entries from Redis
 *
 * @param maxEntries - Maximum number of entries to flush (default: FLUSH_BATCH_SIZE)
 * @returns Number of entries flushed
 */
async function flushPendingUpdates(
  maxEntries: number = FLUSH_BATCH_SIZE
): Promise<number> {
  const redisClient = getRedisClient();
  if (!redisClient || !isRedisAvailable()) {
    logger.debug(
      'Redis not available, skipping flush',
      undefined,
      'ApiKeyFlusher'
    );
    return 0;
  }

  const lockToken = randomBytes(16).toString('hex');
  let lockAcquired: string | null = null;
  try {
    lockAcquired = await redisClient.set(
      REDIS_KEY_FLUSH_LOCK,
      lockToken,
      'EX',
      FLUSH_LOCK_TTL_SEC,
      'NX'
    );
  } catch (error) {
    logger.debug(
      'Redis unavailable while acquiring API key flush lock, skipping',
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'ApiKeyFlusher'
    );
    return 0;
  }

  if (lockAcquired !== 'OK') {
    logger.debug(
      'Flush lock held (another instance or overlapping flush), skipping',
      undefined,
      'ApiKeyFlusher'
    );
    return 0;
  }

  try {
    // Get oldest N entries from sorted set (ordered by timestamp)
    // WHY: Process oldest updates first to minimize delay.
    const queueEntries = await redisClient.zrange(
      REDIS_KEY_LAST_USED_QUEUE,
      0,
      maxEntries - 1,
      'WITHSCORES'
    );

    if (queueEntries.length === 0) {
      return 0;
    }

    // Parse entries: [keyId1, timestamp1, keyId2, timestamp2, ...]
    // WHY: ZRANGE WITHSCORES returns alternating [member, score, member, score, ...]
    const keyIds: string[] = [];
    for (let i = 0; i < queueEntries.length; i += 2) {
      keyIds.push(queueEntries[i] as string);
    }

    // Read corresponding timestamps from hash
    // WHY: Hash has the latest timestamp for each key. If a key was updated multiple times
    // before flush, we only need the latest timestamp (not the queue score which is first update time).
    const timestamps = await redisClient.hmget(
      REDIS_KEY_LAST_USED_UPDATES,
      ...keyIds
    );

    // Build array of updates with valid timestamps
    // WHY filter nulls: If hash entry is missing (shouldn't happen, but handle gracefully),
    // skip that key. Queue entry will be cleaned up below.
    const updates: Array<{ keyId: string; timestamp: string }> = [];
    for (let i = 0; i < keyIds.length; i++) {
      const timestamp = timestamps[i];
      if (timestamp) {
        updates.push({ keyId: keyIds[i]!, timestamp });
      }
    }

    if (updates.length === 0) {
      // Clean up queue entries even if hash is empty (stale entries)
      // WHY: Prevents queue from growing with stale entries. If hash is empty but queue has
      // entries, they're orphaned and should be removed.
      await redisClient.zrem(REDIS_KEY_LAST_USED_QUEUE, ...keyIds);
      return 0;
    }

    // Execute individual UPDATE statements within a single transaction.
    // WHY: Transaction groups N updates into one commit, reducing connection overhead vs N separate
    // auto-committed queries. Not a single SQL statement, but still provides significant DB load reduction.
    await asSystem(async (dbClient) => {
      await dbClient.transaction(async (tx) => {
        // Execute all updates within single transaction
        // WHY: Transaction ensures atomicity and reduces per-query commit overhead.
        for (const update of updates) {
          await tx
            .update(userApiKeys)
            .set({ lastUsedAt: new Date(update.timestamp) })
            .where(eq(userApiKeys.id, update.keyId));
        }
      });
    });

    // Remove processed entries from Redis
    // WHY: Clean up after successful flush to prevent reprocessing. Only runs if DB transaction
    // succeeded (inside try block). If DB fails, entries remain in Redis for retry on next flush.
    // WHY pipeline: Atomic removal from both structures ensures consistency.
    try {
      const pipeline = redisClient.pipeline();
      pipeline.hdel(REDIS_KEY_LAST_USED_UPDATES, ...keyIds);
      pipeline.zrem(REDIS_KEY_LAST_USED_QUEUE, ...keyIds);
      const pipelineResults = await pipeline.exec();
      if (pipelineResults === null) {
        logger.warn(
          'Redis pipeline.exec() returned null during lastUsed flush cleanup (connection issue?)',
          { keyCount: keyIds.length },
          'ApiKeyFlusher'
        );
      } else {
        for (let i = 0; i < pipelineResults.length; i++) {
          const entry = pipelineResults[i];
          if (!entry) continue;
          const [cmdErr] = entry;
          if (cmdErr) {
            logger.warn(
              'Redis pipeline command failed during lastUsed flush cleanup',
              {
                index: i,
                error:
                  cmdErr instanceof Error ? cmdErr.message : String(cmdErr),
              },
              'ApiKeyFlusher'
            );
          }
        }
      }
    } catch (redisError) {
      // Safe to continue: entries remain in Redis and will be reprocessed on next flush.
      // Updates are idempotent (SET lastUsedAt = timestamp), so reprocessing is harmless.
      logger.warn(
        'Failed to clean up Redis after successful DB flush — entries will be reprocessed',
        { error: redisError, keyCount: keyIds.length },
        'ApiKeyFlusher'
      );
    }
    // If cleanup failed partially, entries may remain in Redis and will be reprocessed.
    // DB updates are idempotent for lastUsedAt.

    totalUpdatesFlushed += updates.length;
    flushSuccessCount++;

    logger.info(
      `Flushed ${updates.length} lastUsedAt updates to database`,
      { count: updates.length },
      'ApiKeyFlusher'
    );

    return updates.length;
  } catch (error) {
    flushFailureCount++;
    logger.error(
      'Failed to flush lastUsedAt updates',
      { error },
      'ApiKeyFlusher'
    );
    return 0;
  } finally {
    try {
      await redisClient.eval(
        RELEASE_FLUSH_LOCK_LUA,
        1,
        REDIS_KEY_FLUSH_LOCK,
        lockToken
      );
    } catch (releaseErr) {
      logger.warn(
        'Failed to release API key flush lock (will expire by TTL)',
        {
          error:
            releaseErr instanceof Error
              ? releaseErr.message
              : String(releaseErr),
        },
        'ApiKeyFlusher'
      );
    }
  }
}

/**
 * Start the periodic flush service.
 *
 * WHY: Automatically flushes pending updates on schedule.
 * Also checks size threshold to flush early if many updates pending.
 */
export function startLastUsedFlusher(): void {
  if (flushInterval) {
    logger.warn('Flusher already started', undefined, 'ApiKeyFlusher');
    return;
  }

  logger.info(
    'Starting API key lastUsedAt flusher',
    undefined,
    'ApiKeyFlusher'
  );

  // Flush on startup
  // WHY: Handle any pending updates from previous server instance. If server restarted while
  // updates were in Redis, they would be lost without this. Fire-and-forget because startup
  // shouldn't block on flush (non-critical).
  flushPendingUpdates().catch((err) => {
    logger.error('Startup flush failed', { error: err }, 'ApiKeyFlusher');
  });

  // Periodic flush
  // WHY setInterval: Automatically flushes on schedule. Works in long-running processes (Next.js),
  // but may not work reliably in pure serverless (each invocation is new process). For pure
  // serverless, consider using cron endpoint instead.
  flushInterval = setInterval(() => {
    void (async () => {
      const redisClient = getRedisClient();
      if (!redisClient || !isRedisAvailable()) {
        // WHY return early: If Redis unavailable, skip flush. Updates will fall back to direct
        // DB writes via scheduleLastUsedUpdate() fallback mechanism.
        return;
      }

      // Check size threshold - flush early if many updates pending
      // WHY: Prevents queue from growing too large during bursts. If queue reaches threshold,
      // flush immediately instead of waiting for time-based flush.
      const queueSize = await redisClient.zcard(REDIS_KEY_LAST_USED_QUEUE);
      if (queueSize >= FLUSH_SIZE_THRESHOLD) {
        await flushPendingUpdates();
      } else {
        // Normal time-based flush
        // WHY: Regular periodic flush ensures updates don't sit too long, even during low activity.
        await flushPendingUpdates(FLUSH_BATCH_SIZE);
      }
    })().catch((error) => {
      logger.warn(
        'Scheduled API key flush skipped because Redis became unavailable',
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'ApiKeyFlusher'
      );
    });
  }, FLUSH_INTERVAL_MS);

  logger.info(
    `Flusher started: ${FLUSH_INTERVAL_MS}ms interval, ${FLUSH_BATCH_SIZE} batch size`,
    undefined,
    'ApiKeyFlusher'
  );
}

/**
 * Stop the periodic flush service.
 */
export function stopLastUsedFlusher(): void {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
    logger.info(
      'Stopped API key lastUsedAt flusher',
      undefined,
      'ApiKeyFlusher'
    );
  }
}

/**
 * Graceful shutdown: flush pending updates before exit.
 *
 * WHY: Ensures no updates are lost on server restart or shutdown.
 */
export async function shutdownLastUsedFlusher(): Promise<void> {
  stopLastUsedFlusher();

  // Flush any remaining updates
  const remaining = await flushPendingUpdates(1000); // Flush all remaining
  if (remaining > 0) {
    logger.info(
      `Flushed ${remaining} remaining updates on shutdown`,
      { count: remaining },
      'ApiKeyFlusher'
    );
  }
}

/**
 * Manually trigger a flush (useful for testing or graceful shutdown).
 */
export async function flushLastUsedUpdates(): Promise<number> {
  return flushPendingUpdates();
}

/**
 * Get flusher statistics for monitoring.
 */
export function getFlusherStats(): {
  successCount: number;
  failureCount: number;
  totalUpdatesFlushed: number;
} {
  return {
    successCount: flushSuccessCount,
    failureCount: flushFailureCount,
    totalUpdatesFlushed,
  };
}

// Register shutdown handlers
// WHY: Ensures no updates are lost on server restart or shutdown. Flushes any remaining
// updates in Redis before process exits. Only register if process exists (not in edge runtime).
// We avoid calling process.exit() here so framework-managed runtimes can shut down naturally.
if (
  typeof process !== 'undefined' &&
  !globalFlusherState.__feedApiKeyFlusherSignalsRegistered
) {
  globalFlusherState.__feedApiKeyFlusherSignalsRegistered = true;
  let shuttingDown = false;
  const handleShutdown = (signal: string) => {
    if (shuttingDown) return; // Prevent double-signal race
    shuttingDown = true;
    shutdownLastUsedFlusher().catch((err) => {
      logger.error(
        `Shutdown flush failed on ${signal}`,
        { error: err },
        'ApiKeyFlusher'
      );
    });
  };
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}
