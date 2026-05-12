/**
 * Distributed locking service for preventing concurrent operations.
 *
 * Uses Redis to coordinate locks across multiple serverless instances.
 */

import { v4 as uuidv4 } from "uuid";
import { cache } from "@/lib/cache/client";
import { logger } from "@/lib/utils/logger";

/**
 * Lock object with release and extend methods.
 */
export interface Lock {
  lockId: string;
  roomId: string;
  expiresAt: Date;
  release: () => Promise<void>;
  extend: (ms: number) => Promise<void>;
}

/**
 * Service for managing distributed locks using Redis.
 */
export class DistributedLockService {
  private static instance: DistributedLockService;
  private constructor() {}

  public static getInstance(): DistributedLockService {
    if (!DistributedLockService.instance) {
      DistributedLockService.instance = new DistributedLockService();
    }
    return DistributedLockService.instance;
  }

  /**
   * Acquire a lock for a room with retry logic for concurrent requests
   * @param roomId - Room to lock
   * @param ttl - Lock TTL in milliseconds (default: 90000ms = 90s)
   * PERFORMANCE FIX: Increased from 30s to 90s to accommodate long-running LLM calls
   * @param options - Retry options
   * @returns Lock object if acquired, null if failed after all retries
   */
  async acquireRoomLockWithRetry(
    roomId: string,
    ttl: number = 90000,
    options: {
      maxRetries?: number;
      initialDelayMs?: number;
      maxDelayMs?: number;
    } = {},
  ): Promise<Lock | null> {
    const { maxRetries = 10, initialDelayMs = 100, maxDelayMs = 2000 } = options;

    let attempt = 0;
    let delayMs = initialDelayMs;

    while (attempt <= maxRetries) {
      const lock = await this.acquireRoomLock(roomId, ttl);

      if (lock) {
        if (attempt > 0) {
          logger.info(`[Distributed Locks] Acquired lock for ${roomId} after ${attempt} retries`);
        }
        return lock;
      }

      if (attempt < maxRetries) {
        logger.debug(
          `[Distributed Locks] Lock acquisition attempt ${attempt + 1}/${maxRetries + 1} failed for ${roomId}, retrying in ${delayMs}ms`,
        );

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        // Exponential backoff with jitter
        delayMs = Math.min(maxDelayMs, delayMs * 2 + Math.random() * 100);
      }

      attempt++;
    }

    logger.warn(
      `[Distributed Locks] Failed to acquire lock for ${roomId} after ${maxRetries + 1} attempts`,
    );
    return null;
  }

  /**
   * Acquire a lock for a room to prevent concurrent message processing
   * @param roomId - Room to lock
   * @param ttl - Lock TTL in milliseconds (default: 90000ms = 90s)
   * PERFORMANCE FIX: Increased from 30s to 90s to accommodate long-running LLM calls
   * @returns Lock object if acquired, null if already locked
   */
  async acquireRoomLock(roomId: string, ttl: number = 90000): Promise<Lock | null> {
    if (!cache.isAvailable()) {
      logger.warn("[Distributed Locks] Service disabled, skipping lock acquisition");
      return this.createDummyLock(roomId, ttl);
    }

    const lockId = uuidv4();
    const key = `agent:room:${roomId}:lock`;

    // Try to acquire lock using SET NX (set if not exists) with expiry
    const acquired = await cache.setIfNotExists(key, lockId, ttl);

    if (!acquired) {
      logger.debug(`[Distributed Locks] Failed to acquire lock for ${roomId} - already locked`);
      return null;
    }

    logger.debug(`[Distributed Locks] Acquired lock ${lockId} for ${roomId} (TTL: ${ttl}ms)`);

    return {
      lockId,
      roomId,
      expiresAt: new Date(Date.now() + ttl),
      release: async () => {
        await this.releaseRoomLock(roomId, lockId);
      },
      extend: async (ms) => {
        await this.extendLock(roomId, lockId, ms);
      },
    };
  }

  /**
   * Release a lock for a room
   * @param roomId - Room to unlock
   * @param lockId - Lock ID to verify ownership
   * @returns true if released, false if not owned or doesn't exist
   */
  async releaseRoomLock(roomId: string, lockId: string): Promise<boolean> {
    if (!cache.isAvailable()) {
      return true;
    }

    const key = `agent:room:${roomId}:lock`;

    // Only release if we own the lock (check lockId matches)
    const currentLockId = await cache.get<string>(key);

    if (currentLockId !== lockId) {
      logger.warn(
        `[Distributed Locks] Cannot release lock ${lockId} for ${roomId} - not owned or expired`,
      );
      return false;
    }

    await cache.del(key);
    logger.debug(`[Distributed Locks] Released lock ${lockId} for ${roomId}`);
    return true;
  }

  /**
   * Extend the TTL of an existing lock
   * @param roomId - Room with lock
   * @param lockId - Lock ID to verify ownership
   * @param ms - Additional milliseconds to extend
   * @returns true if extended, false if not owned or doesn't exist
   */
  async extendLock(roomId: string, lockId: string, ms: number): Promise<boolean> {
    if (!cache.isAvailable()) {
      return true;
    }

    const key = `agent:room:${roomId}:lock`;

    // Verify ownership
    const currentLockId = await cache.get<string>(key);

    if (currentLockId !== lockId) {
      logger.warn(
        `[Distributed Locks] Cannot extend lock ${lockId} for ${roomId} - not owned or expired`,
      );
      return false;
    }

    // Get current TTL
    const ttl = await cache.pttl(key);
    if (!ttl || ttl <= 0) {
      logger.warn(
        `[Distributed Locks] Cannot extend lock ${lockId} for ${roomId} - already expired`,
      );
      return false;
    }

    // Set new TTL (current + extension)
    const newTtl = ttl + ms;
    await cache.pexpire(key, newTtl);

    logger.debug(
      `[Distributed Locks] Extended lock ${lockId} for ${roomId} by ${ms}ms (new TTL: ${newTtl}ms)`,
    );
    return true;
  }

  /**
   * Check if a room is currently locked
   * @param roomId - Room to check
   * @returns true if locked, false otherwise
   */
  async isLocked(roomId: string): Promise<boolean> {
    if (!cache.isAvailable()) {
      return false;
    }

    const key = `agent:room:${roomId}:lock`;

    const lockId = await cache.get<string>(key);
    return lockId !== null;
  }

  /**
   * Get information about a lock
   * @param roomId - Room to check
   * @returns Lock info or null if not locked
   */
  async getLockInfo(roomId: string): Promise<{ lockId: string; ttl: number } | null> {
    if (!cache.isAvailable()) {
      return null;
    }

    const key = `agent:room:${roomId}:lock`;

    const lockId = await cache.get<string>(key);
    if (!lockId) {
      return null;
    }

    const ttl = await cache.pttl(key);
    if (ttl === null) return null;
    return { lockId, ttl };
  }

  /**
   * Force release a lock (admin/cleanup use only)
   * @param roomId - Room to unlock
   * @returns true if released, false on error
   */
  async forceRelease(roomId: string): Promise<boolean> {
    if (!cache.isAvailable()) {
      return true;
    }

    const key = `agent:room:${roomId}:lock`;

    await cache.del(key);
    logger.info(`[Distributed Locks] Force released lock for ${roomId}`);
    return true;
  }

  /**
   * Create a dummy lock when service is disabled (for compatibility)
   */
  private createDummyLock(roomId: string, ttl: number): Lock {
    const lockId = uuidv4();
    return {
      lockId,
      roomId,
      expiresAt: new Date(Date.now() + ttl),
      release: async () => {},
      extend: async () => {},
    };
  }

  public isEnabled(): boolean {
    return cache.isAvailable();
  }
}

// Export singleton instance
export const distributedLocks = DistributedLockService.getInstance();
