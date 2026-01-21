/**
 * Agent Lock Service
 *
 * Per-agent distributed locks to prevent concurrent agent tick execution.
 * Each agent gets its own lock to prevent double-ticking or stacking ticks.
 *
 * @remarks
 * Features:
 * - Per-agent locking (independent locks for each agent)
 * - Database-based locking (works across multiple servers)
 * - Automatic stale lock recovery (10 minutes expiry)
 * - Simple acquire/release pattern
 * - No external dependencies (uses Drizzle)
 * - Serverless-safe (uses timestamp + random bytes instead of process.pid)
 *
 * @example
 * ```typescript
 * if (!await acquireAgentLock(agentId)) {
 *   return; // Skip this agent, still running from previous tick
 * }
 *
 * try {
 *   await runAgentTick(agentId);
 * } finally {
 *   await releaseAgentLock(agentId, processId);
 * }
 * ```
 *
 * @packageDocumentation
 */

import { randomBytes } from "node:crypto";
import { DistributedLockService } from "@polyagent/api";

/**
 * Lock duration for agent tick operations.
 *
 * @remarks
 * - Default: 10 minutes (600,000ms)
 * - Configurable via AGENT_LOCK_DURATION_MS environment variable
 * - If an agent tick fails mid-execution without releasing the lock,
 *   the lock automatically expires after this duration
 * - This prevents stuck agents from blocking subsequent ticks indefinitely
 * - Set below function timeout (13.3 minutes) to ensure proper recovery
 */
const LOCK_DURATION_MS =
  Number(process.env.AGENT_LOCK_DURATION_MS) || 10 * 60 * 1000; // 10 minutes

function getAgentLockId(agentId: string): string {
  return `agent-tick-${agentId}`;
}

export async function acquireAgentLock(
  agentId: string,
  processId?: string,
): Promise<boolean> {
  const lockHolder =
    processId || `serverless-${Date.now()}-${randomBytes(8).toString("hex")}`;
  const lockId = getAgentLockId(agentId);

  return DistributedLockService.acquireLock({
    lockId,
    durationMs: LOCK_DURATION_MS,
    operation: "agent-tick",
    processId: lockHolder,
  });
}

export async function releaseAgentLock(
  agentId: string,
  processId?: string,
): Promise<void> {
  const lockId = getAgentLockId(agentId);
  return DistributedLockService.releaseLock(lockId, processId);
}

export async function checkAgentLock(agentId: string) {
  const lockId = getAgentLockId(agentId);
  return DistributedLockService.checkLock(lockId);
}
