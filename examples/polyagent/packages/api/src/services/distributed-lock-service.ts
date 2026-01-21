/**
 * Distributed Lock Service
 *
 * @description Generic distributed lock implementation using Drizzle.
 * Prevents race conditions across multiple servers/processes.
 * Supports automatic stale lock recovery.
 */

import { randomBytes } from "node:crypto";
import { and, db, eq, generationLocks, lte } from "@polyagent/db";
import { logger } from "@polyagent/shared";

export interface LockOptions {
  lockId: string;
  durationMs: number;
  operation: string;
  processId?: string;
}

export class DistributedLockService {
  /**
   * Acquire a distributed lock
   *
   * @description Uses atomic conditional UPDATE with RETURNING to prevent TOCTOU
   * race conditions. First attempts to update an existing expired lock, then falls
   * back to INSERT if no lock exists. This pattern is safe against concurrent
   * acquisition attempts from multiple processes.
   *
   * @param {LockOptions} options - Lock acquisition options
   * @param {string} options.lockId - Unique lock identifier
   * @param {number} options.durationMs - Lock duration in milliseconds
   * @param {string} options.operation - Operation name for logging
   * @param {string} [options.processId] - Optional process identifier (auto-generated if not provided)
   * @returns {Promise<boolean>} True if lock was acquired, false otherwise
   */
  static async acquireLock(options: LockOptions): Promise<boolean> {
    const { lockId, durationMs, operation, processId } = options;
    const now = new Date();
    const expiry = new Date(now.getTime() + durationMs);

    // Generate serverless-safe unique ID if not provided
    const lockHolder =
      processId || `serverless-${Date.now()}-${randomBytes(8).toString("hex")}`;

    // First, try to atomically update an existing expired lock
    // This is TOCTOU-safe: only succeeds if lock is expired at update time
    // Note: expiresAt is notNull per schema, so we only check lte()
    const updateResult = await db
      .update(generationLocks)
      .set({
        lockedBy: lockHolder,
        lockedAt: now,
        expiresAt: expiry,
        operation,
      })
      .where(
        and(
          eq(generationLocks.id, lockId),
          lte(generationLocks.expiresAt, now),
        ),
      )
      .returning({ id: generationLocks.id });

    if (updateResult.length > 0) {
      logger.info(
        `Lock ${lockId} acquired (recovered stale)`,
        {
          lockId,
          lockHolder,
          expiresAt: expiry.toISOString(),
        },
        "DistributedLockService",
      );
      return true;
    }

    // Check if lock exists and is still valid
    const [existingLock] = await db
      .select()
      .from(generationLocks)
      .where(eq(generationLocks.id, lockId))
      .limit(1);

    if (existingLock) {
      // Lock exists and is not expired (otherwise update would have succeeded)
      const ageMinutes = Math.round(
        (now.getTime() - existingLock.lockedAt.getTime()) / 1000 / 60,
      );
      logger.info(
        `Lock ${lockId} held by ${existingLock.lockedBy} - skipping`,
        {
          lockId,
          holder: existingLock.lockedBy,
          ageMinutes,
          expiresIn: Math.round(
            (existingLock.expiresAt.getTime() - now.getTime()) / 1000,
          ),
        },
        "DistributedLockService",
      );
      return false;
    }

    // No lock exists - try to create it
    // Use onConflictDoNothing to handle race with another insert
    const insertResult = await db
      .insert(generationLocks)
      .values({
        id: lockId,
        lockedBy: lockHolder,
        lockedAt: now,
        expiresAt: expiry,
        operation,
      })
      .onConflictDoNothing()
      .returning({ id: generationLocks.id });

    if (insertResult.length > 0) {
      logger.info(
        `Lock ${lockId} acquired (created)`,
        {
          lockId,
          lockHolder,
          expiresAt: expiry.toISOString(),
        },
        "DistributedLockService",
      );
      return true;
    }

    // Another process won the race between our check and insert
    logger.info(
      `Lock ${lockId} lost race to another process`,
      { lockId },
      "DistributedLockService",
    );
    return false;
  }

  /**
   * Release a distributed lock
   *
   * @description Releases a lock only if it's held by the specified process ID.
   * This prevents accidental release of locks held by other processes. Process ID
   * is required for safe lock release in distributed environments.
   *
   * @param {string} lockId - Lock identifier to release
   * @param {string} [processId] - Process ID that holds the lock (required for safe release)
   * @returns {Promise<void>}
   */
  static async releaseLock(lockId: string, processId?: string): Promise<void> {
    if (!processId) {
      // Process ID is required for safe lock release to prevent releasing locks held by other processes
      logger.warn(
        `releaseLock called without processId for ${lockId} - unsafe release prevented`,
        undefined,
        "DistributedLockService",
      );
      return;
    }

    // Atomic delete with ownership check - prevents TOCTOU race condition
    // Only deletes if we still own the lock at delete time
    const deleteResult = await db
      .delete(generationLocks)
      .where(
        and(
          eq(generationLocks.id, lockId),
          eq(generationLocks.lockedBy, processId),
        ),
      )
      .returning({ id: generationLocks.id });

    if (deleteResult.length > 0) {
      logger.info(
        `Lock ${lockId} released`,
        { lockId, lockHolder: processId },
        "DistributedLockService",
      );
    } else {
      // Lock either doesn't exist, expired and was taken by another process, or we don't own it
      logger.info(
        `Lock ${lockId} not released - not held by this process or already released`,
        { lockId, processId },
        "DistributedLockService",
      );
    }
  }

  /**
   * Check if a lock is currently held
   *
   * @description Queries the database to check if a lock exists and is still valid
   * (not expired). Returns the lock information if held, null otherwise.
   *
   * @param {string} lockId - Lock identifier to check
   * @returns {Promise<object | null>} Lock information if held and valid, null otherwise
   */
  static async checkLock(lockId: string) {
    const [lock] = await db
      .select()
      .from(generationLocks)
      .where(eq(generationLocks.id, lockId))
      .limit(1);

    if (!lock) return null;

    const now = new Date();
    if (lock.expiresAt < now) {
      return null; // Expired
    }

    return lock;
  }
}
