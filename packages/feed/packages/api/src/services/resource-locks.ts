/**
 * Resource-Level Locks
 *
 * @description Higher-level locking helpers for game resources.
 * Provides question-level and market-level locks to prevent race conditions
 * between cron jobs (game-tick, markets-tick, npc-tick) operating on the same resources.
 *
 * Uses DistributedLockService under the hood with resource-specific lock IDs.
 */

import { randomBytes } from "node:crypto";
import { logger } from "@feed/shared";
import { DistributedLockService } from "./distributed-lock-service";

/**
 * Execute a function with a question-level lock.
 * Prevents duplicate resolution attempts from game-tick and markets-tick.
 *
 * @param questionNumber - Question number to lock
 * @param fn - Function to execute while holding the lock
 * @param options - Optional lock configuration
 * @returns Result of the function, or throws if lock cannot be acquired
 *
 * @example
 * ```typescript
 * await withQuestionLock(42, async () => {
 *   await resolveQuestionPayouts(42);
 * });
 * ```
 */
export async function withQuestionLock<T>(
  questionNumber: number,
  fn: () => Promise<T>,
  options: { durationMs?: number; skipIfLocked: true },
): Promise<T | undefined>;
export async function withQuestionLock<T>(
  questionNumber: number,
  fn: () => Promise<T>,
  options?: { durationMs?: number; skipIfLocked?: false },
): Promise<T>;
export async function withQuestionLock<T>(
  questionNumber: number,
  fn: () => Promise<T>,
  options?: { durationMs?: number; skipIfLocked?: boolean },
): Promise<T | undefined> {
  const lockId = `question-resolve-${questionNumber}`;
  const durationMs = options?.durationMs ?? 60_000; // Default 60s
  const processId = `ql-${Date.now()}-${randomBytes(4).toString("hex")}`;

  const acquired = await DistributedLockService.acquireLock({
    lockId,
    durationMs,
    operation: `resolve-question-${questionNumber}`,
    processId,
  });

  if (!acquired) {
    if (options?.skipIfLocked) {
      logger.info(
        `Question ${questionNumber} resolution already in progress, skipping`,
        { lockId },
        "ResourceLocks",
      );
      return undefined;
    }
    throw new Error(
      `Question ${questionNumber} resolution already in progress (locked)`,
    );
  }

  try {
    return await fn();
  } finally {
    await DistributedLockService.releaseLock(lockId, processId);
  }
}

/**
 * Execute a function with a market-level lock.
 * Prevents concurrent price updates from multiple cron jobs.
 *
 * @param marketId - Market ID to lock
 * @param fn - Function to execute while holding the lock
 * @param options - Optional lock configuration
 * @returns Result of the function, or throws if lock cannot be acquired
 *
 * @example
 * ```typescript
 * await withMarketLock('market-123', async () => {
 *   await updateMarketPrice(marketId, newPrice);
 * });
 * ```
 */
export async function withMarketLock<T>(
  marketId: string,
  fn: () => Promise<T>,
  options: { durationMs?: number; skipIfLocked: true },
): Promise<T | undefined>;
export async function withMarketLock<T>(
  marketId: string,
  fn: () => Promise<T>,
  options?: { durationMs?: number; skipIfLocked?: false },
): Promise<T>;
export async function withMarketLock<T>(
  marketId: string,
  fn: () => Promise<T>,
  options?: { durationMs?: number; skipIfLocked?: boolean },
): Promise<T | undefined> {
  const lockId = `market-update-${marketId}`;
  const durationMs = options?.durationMs ?? 30_000; // Default 30s
  const processId = `ml-${Date.now()}-${randomBytes(4).toString("hex")}`;

  const acquired = await DistributedLockService.acquireLock({
    lockId,
    durationMs,
    operation: `update-market-${marketId}`,
    processId,
  });

  if (!acquired) {
    if (options?.skipIfLocked) {
      logger.info(
        `Market ${marketId} update already in progress, skipping`,
        { lockId },
        "ResourceLocks",
      );
      return undefined;
    }
    throw new Error(`Market ${marketId} update already in progress (locked)`);
  }

  try {
    return await fn();
  } finally {
    await DistributedLockService.releaseLock(lockId, processId);
  }
}

/**
 * Execute a function with an NPC-level lock.
 * Prevents concurrent trading decisions for the same NPC.
 *
 * @param npcId - NPC actor ID to lock
 * @param fn - Function to execute while holding the lock
 * @param options - Optional lock configuration
 * @returns Result of the function, or throws if lock cannot be acquired
 */
export async function withNPCLock<T>(
  npcId: string,
  fn: () => Promise<T>,
  options: { durationMs?: number; skipIfLocked: true },
): Promise<T | undefined>;
export async function withNPCLock<T>(
  npcId: string,
  fn: () => Promise<T>,
  options?: { durationMs?: number; skipIfLocked?: false },
): Promise<T>;
export async function withNPCLock<T>(
  npcId: string,
  fn: () => Promise<T>,
  options?: { durationMs?: number; skipIfLocked?: boolean },
): Promise<T | undefined> {
  const lockId = `npc-trade-${npcId}`;
  const durationMs = options?.durationMs ?? 120_000; // Default 2 min for LLM calls
  const processId = `npc-${Date.now()}-${randomBytes(4).toString("hex")}`;

  const acquired = await DistributedLockService.acquireLock({
    lockId,
    durationMs,
    operation: `npc-trade-${npcId}`,
    processId,
  });

  if (!acquired) {
    if (options?.skipIfLocked) {
      logger.info(
        `NPC ${npcId} trade already in progress, skipping`,
        { lockId },
        "ResourceLocks",
      );
      return undefined;
    }
    throw new Error(`NPC ${npcId} trade already in progress (locked)`);
  }

  try {
    return await fn();
  } finally {
    await DistributedLockService.releaseLock(lockId, processId);
  }
}

/**
 * Check if a question resolution is currently locked.
 * Useful for checking before attempting resolution.
 *
 * **TOCTOU Warning**: This function has an inherent time-of-check to time-of-use
 * race condition. It attempts a short-duration acquire via DistributedLockService.acquireLock
 * (using lockId `question-resolve-${questionNumber}` and processId `'check-only'`) and
 * immediately releases with DistributedLockService.releaseLock. Another process may
 * acquire the lock between this check and subsequent use. For correctness when
 * performing critical operations, callers should use withQuestionLock to perform
 * an actual acquire rather than relying on this check-only function.
 *
 * @param questionNumber - Question number to check
 * @returns True if the question is currently locked
 */
export async function isQuestionLocked(
  questionNumber: number,
): Promise<boolean> {
  const lockId = `question-resolve-${questionNumber}`;
  // Try to acquire with short duration (100ms) - will fail if locked
  const acquired = await DistributedLockService.acquireLock({
    lockId,
    durationMs: 100, // Very short duration
    operation: `check-lock-${questionNumber}`,
    processId: "check-only",
  });

  if (acquired) {
    // Release immediately - we were just checking
    await DistributedLockService.releaseLock(lockId, "check-only");
    return false;
  }
  return true;
}
