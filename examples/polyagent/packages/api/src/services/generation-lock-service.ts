/**
 * Generation Lock Service
 *
 * @description Simple distributed lock to prevent concurrent tick generation.
 * Prevents race conditions when multiple cron jobs trigger simultaneously. Uses
 * database-based locking that works across multiple servers with automatic stale
 * lock recovery (15 minutes expiry).
 *
 * Features:
 * - Database-based locking (works across multiple servers)
 * - Automatic expiry (15 minutes for stale lock recovery)
 * - Simple acquire/release pattern
 * - No external dependencies (uses Drizzle)
 * - Serverless-safe (uses timestamp + random bytes instead of process.pid)
 *
 * Usage:
 * ```typescript
 * if (!await acquireGenerationLock(processId)) {
 *   return; // Skip this run, another process has the lock
 * }
 *
 * try {
 *   await generateContent();
 * } finally {
 *   await releaseGenerationLock(processId);
 * }
 * ```
 */

import { randomBytes } from "node:crypto";
import { DistributedLockService } from "./distributed-lock-service";

const LOCK_ID = "game-tick-lock";
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export async function acquireGenerationLock(
  processId?: string,
): Promise<boolean> {
  /**
   * If processId is not provided, we generate one here.
   *
   * In the original implementation, it generated one internally if missing.
   * To maintain compatibility with the interface, we handle it here.
   */
  const lockHolder =
    processId || `serverless-${Date.now()}-${randomBytes(8).toString("hex")}`;

  return DistributedLockService.acquireLock({
    lockId: LOCK_ID,
    durationMs: LOCK_DURATION_MS,
    operation: "game-tick",
    processId: lockHolder,
  });
}

export async function releaseGenerationLock(processId?: string): Promise<void> {
  return DistributedLockService.releaseLock(LOCK_ID, processId);
}

export async function checkGenerationLock() {
  return DistributedLockService.checkLock(LOCK_ID);
}
