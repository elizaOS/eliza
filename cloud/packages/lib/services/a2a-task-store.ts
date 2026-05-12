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

import { buildRedisClient, type CompatibleRedis } from "@/lib/cache/redis-factory";
import type { Task } from "@/lib/types/a2a";
import { logger } from "@/lib/utils/logger";
import { assertPersistentCloudStateConfigured } from "@/lib/utils/persistence-guard";

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

// ============================================================================
// Redis Client
// ============================================================================

let redis: CompatibleRedis | null = null;
let initialized = false;

function getRedisClient(): CompatibleRedis {
  if (initialized && redis) return redis;

  redis = buildRedisClient();
  if (!redis) {
    assertPersistentCloudStateConfigured("A2A TaskStore", false);
    throw new Error(
      "[A2A TaskStore] Redis-backed shared storage is required; configure REDIS_URL or KV_* credentials before starting the service.",
    );
  }

  logger.info("[A2A TaskStore] ✓ Redis task store initialized");
  initialized = true;
  return redis;
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
   * Update a task
   */
  async update(
    taskId: string,
    organizationId: string,
    updater: (entry: TaskStoreEntry) => TaskStoreEntry,
  ): Promise<TaskStoreEntry | null> {
    const existing = await this.get(taskId, organizationId);
    if (!existing) return null;

    const updated = updater({
      ...existing,
      updatedAt: new Date().toISOString(),
    });

    await this.set(taskId, updated);
    return updated;
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
    const taskIds = await client.zrange(orgIndexKey, -limit, -1);

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
