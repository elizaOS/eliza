/**
 * A2A Task Store Service
 *
 * Redis-backed persistent storage for A2A tasks.
 * Replaces the in-memory Map to work across serverless instances.
 *
 * Features:
 * - Redis persistence with TTL
 * - Automatic cleanup of expired tasks
 * - Organization-scoped task isolation
 */

import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core/edge";
import {
  buildRedisClient,
  type CompatibleRedis,
  isCloudflareWorkerRuntime,
} from "../cache/redis-factory";
import type { Task } from "../types/a2a";
import { logger } from "../utils/logger";
import { assertPersistentCloudStateConfigured } from "../utils/persistence-guard";

// ============================================================================
// Types
// ============================================================================

export interface TaskStoreEntry {
  task: Task;
  userId: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Configuration
// ============================================================================

const TASK_TTL_SECONDS = 3600; // 1 hour
const ENV_PREFIX = process.env.ENVIRONMENT || "local";
const TASK_KEY_PREFIX = `${ENV_PREFIX}:a2a:task:`;
const TASK_ORG_INDEX_PREFIX = "a2a:org:";
const TASK_LOCK_KEY_PREFIX = `${ENV_PREFIX}:a2a:task-lock:`;

// update() serializes each task's read-modify-write behind a SET-NX-PX lock so
// concurrent mutations (artifact/history appends, cancel) can't silently clobber
// each other last-writer-wins. This must work on the in-memory mock backend as
// well as real Redis (no `eval`/Lua CAS — see supportsRedisEval), and must not
// be an in-process mutex: this store's whole point is coordinating across
// serverless instances, where an in-process lock coordinates nothing.
const LOCK_TTL_MS = 5000;
// The retry window must outlive the lease it is waiting on. At 10 attempts the
// backoff sums to 1425ms worst case (~1.07s after jitter) — under a third of
// LOCK_TTL_MS — so a holder that legitimately took longer than that turned
// every concurrent mutator into a hard timeout on calls that succeed today.
// 40 attempts sums to 7425ms, which clears the 5s lease with margin.
const LOCK_MAX_ATTEMPTS = 40;
const LOCK_RETRY_BASE_MS = 15;
const LOCK_RETRY_MAX_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Redis Client
// ============================================================================

let cachedRedis: CompatibleRedis | null = null;
let loggedInit = false;

function getRedisClient(): CompatibleRedis {
  // On Workers the client is built PER CALL: a cached TCP socket belongs to
  // the request that opened it and every later request fails with "Cannot
  // perform I/O on behalf of a different request". Node keeps the persistent
  // connection.
  if (!isCloudflareWorkerRuntime() && cachedRedis) return cachedRedis;

  const client = buildRedisClient();
  if (!client) {
    assertPersistentCloudStateConfigured("A2A TaskStore", false);
    throw new Error(
      "[A2A TaskStore] Redis-backed shared storage is required; configure REDIS_URL or KV_* credentials before starting the service.",
    );
  }

  if (!loggedInit) {
    loggedInit = true;
    logger.info("[A2A TaskStore] ✓ Redis task store initialized");
  }
  if (!isCloudflareWorkerRuntime()) cachedRedis = client;
  return client;
}

// ============================================================================
// Task Store Service
// ============================================================================

class A2ATaskStoreService {
  /**
   * Get a task by ID
   */
  async get(taskId: string, organizationId: string): Promise<TaskStoreEntry | null> {
    const client = getRedisClient();
    const key = `${TASK_KEY_PREFIX}${taskId}`;
    const value = await client.get<string>(key);
    if (!value) return null;

    const entry: TaskStoreEntry = typeof value === "string" ? JSON.parse(value) : value;

    // Verify organization access
    if (entry.organizationId !== organizationId) {
      logger.warn("[A2A TaskStore] Task access denied - org mismatch", {
        taskId,
        requestedOrg: organizationId,
        actualOrg: entry.organizationId,
      });
      return null;
    }

    return entry;
  }

  /**
   * Store a task
   */
  async set(taskId: string, entry: TaskStoreEntry): Promise<void> {
    const client = getRedisClient();
    const key = `${TASK_KEY_PREFIX}${taskId}`;
    const orgIndexKey = `${TASK_ORG_INDEX_PREFIX}${entry.organizationId}`;
    const serialized = JSON.stringify(entry);

    // Store task with TTL
    await client.setex(key, TASK_TTL_SECONDS, serialized);

    // Add to organization's task index (for listing)
    await client.zadd(orgIndexKey, {
      score: Date.now(),
      member: taskId,
    });

    // Set TTL on org index
    await client.expire(orgIndexKey, TASK_TTL_SECONDS * 2);

    logger.debug("[A2A TaskStore] Task stored in Redis", { taskId });
  }

  /**
   * Acquire the per-task update lock, retrying with capped exponential
   * backoff on contention. Throws rather than letting a caller proceed
   * unlocked, since an unlocked read-modify-write is exactly the lost-update
   * bug this lock exists to close.
   */
  private async acquireUpdateLock(taskId: string): Promise<string> {
    const client = getRedisClient();
    const lockKey = `${TASK_LOCK_KEY_PREFIX}${taskId}`;
    const token = randomUUID();

    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
      const result = await client.set(lockKey, token, { nx: true, px: LOCK_TTL_MS });
      if (result === "OK") return token;

      const backoffMs = Math.min(LOCK_RETRY_BASE_MS * 2 ** attempt, LOCK_RETRY_MAX_MS);
      await sleep(backoffMs * (0.5 + Math.random() * 0.5));
    }

    throw new ElizaError(`[A2A TaskStore] Timed out acquiring update lock for task ${taskId}`, {
      code: "A2A_TASK_STORE_LOCK_TIMEOUT",
      context: { taskId, attempts: LOCK_MAX_ATTEMPTS },
    });
  }

  /**
   * Release the lock only if it's still ours. A GET-then-DEL isn't atomic,
   * but the only case it can release the wrong lock is a token collision
   * (cryptographically negligible with randomUUID) — if our TTL already
   * expired and another instance re-acquired with a different token, the
   * GET returns their token and this correctly no-ops instead of deleting it.
   */
  private async releaseUpdateLock(taskId: string, token: string): Promise<void> {
    const client = getRedisClient();
    const lockKey = `${TASK_LOCK_KEY_PREFIX}${taskId}`;

    try {
      const current = await client.get(lockKey);
      if (current === token) {
        await client.del(lockKey);
      }
    } catch (error) {
      // error-policy:J6 best-effort teardown: the lock still expires via its
      // own PX TTL, so a failed release degrades to a short contention delay
      // for the next writer rather than a correctness issue.
      logger.warn("[A2A TaskStore] Update lock release failed", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update a task
   */
  async update(
    taskId: string,
    organizationId: string,
    updater: (entry: TaskStoreEntry) => TaskStoreEntry,
  ): Promise<TaskStoreEntry | null> {
    const lockToken = await this.acquireUpdateLock(taskId);
    try {
      const existing = await this.get(taskId, organizationId);
      if (!existing) return null;

      const updated = updater({
        ...existing,
        updatedAt: new Date().toISOString(),
      });

      await this.set(taskId, updated);
      return updated;
    } finally {
      await this.releaseUpdateLock(taskId, lockToken);
    }
  }

  /**
   * Delete a task
   */
  async delete(taskId: string, organizationId: string): Promise<boolean> {
    const client = getRedisClient();
    const key = `${TASK_KEY_PREFIX}${taskId}`;

    // Verify ownership first
    const existing = await this.get(taskId, organizationId);
    if (!existing) return false;

    await client.del(key);

    // Remove from org index
    const orgIndexKey = `${TASK_ORG_INDEX_PREFIX}${organizationId}`;
    await client.zrem(orgIndexKey, taskId);

    logger.debug("[A2A TaskStore] Task deleted from Redis", { taskId });

    return true;
  }

  /**
   * List tasks for an organization
   */
  async listByOrganization(organizationId: string, limit = 50): Promise<TaskStoreEntry[]> {
    const client = getRedisClient();
    const orgIndexKey = `${TASK_ORG_INDEX_PREFIX}${organizationId}`;

    // Get recent task IDs from sorted set
    const taskIds = (await client.zrange(orgIndexKey, -limit, -1)) as string[];

    if (!taskIds.length) return [];

    // Fetch all tasks
    const keys = taskIds.map((id) => `${TASK_KEY_PREFIX}${id}`);
    const values = (await (client.mget as (...args: string[]) => Promise<Array<string | null>>)(
      ...keys,
    )) as Array<string | null>;

    const entries: TaskStoreEntry[] = [];
    for (const value of values) {
      if (value) {
        const entry: TaskStoreEntry = typeof value === "string" ? JSON.parse(value) : value;
        entries.push(entry);
      }
    }

    return entries.reverse(); // Most recent first
  }

  /**
   * Update task state
   */
  async updateTaskState(
    taskId: string,
    organizationId: string,
    state: Task["status"]["state"],
    message?: Task["status"]["message"],
  ): Promise<Task | null> {
    const result = await this.update(taskId, organizationId, (entry) => ({
      ...entry,
      task: {
        ...entry.task,
        status: {
          state,
          message,
          timestamp: new Date().toISOString(),
        },
      },
    }));

    return result?.task ?? null;
  }

  /**
   * Add artifact to task
   */
  async addArtifact(
    taskId: string,
    organizationId: string,
    artifact: Task["artifacts"] extends (infer A)[] | undefined ? A : never,
  ): Promise<Task | null> {
    const result = await this.update(taskId, organizationId, (entry) => ({
      ...entry,
      task: {
        ...entry.task,
        artifacts: [...(entry.task.artifacts || []), artifact],
      },
    }));

    return result?.task ?? null;
  }

  /**
   * Add message to task history
   */
  async addMessageToHistory(
    taskId: string,
    organizationId: string,
    message: Task["history"] extends (infer M)[] | undefined ? M : never,
  ): Promise<void> {
    await this.update(taskId, organizationId, (entry) => ({
      ...entry,
      task: {
        ...entry.task,
        history: [...(entry.task.history || []), message],
      },
    }));
  }

  /**
   * Check if Redis is available
   */
  isRedisAvailable(): boolean {
    try {
      getRedisClient();
      return true;
    } catch {
      return false;
    }
  }
}

export const a2aTaskStoreService = new A2ATaskStoreService();
