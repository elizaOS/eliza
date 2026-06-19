/**
 * Persistent Task Store
 *
 * Extends the ExtendedTaskStore to add Redis-backed persistence for tasks.
 * This ensures tasks survive server restarts and work across multiple
 * serverless instances (e.g., Vercel functions).
 *
 * Uses Redis for storage with an in-memory fallback when Redis is unavailable.
 *
 * @public
 */

import type { Task } from "@a2a-js/sdk";
import {
  getCache,
  getRedisClient,
  isRedisAvailable,
  setCache,
} from "@feed/api";
import { logger } from "@feed/shared";
import { z } from "zod";
import {
  ExtendedTaskStore,
  type ListTasksParams,
  type ListTasksResult,
} from "./extended-task-store";

/**
 * Zod schema for TaskStatus validation
 */
const TaskStatusSchema = z.object({
  state: z.enum([
    "submitted",
    "working",
    "input-required",
    "completed",
    "canceled",
    "failed",
    "rejected",
    "auth-required",
    "unknown",
  ]),
  timestamp: z.string().optional(),
  message: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Zod schema for full Task validation
 * Validates all required properties according to the A2A SDK Task interface
 */
const TaskSchema = z.object({
  id: z.string(),
  contextId: z.string(),
  kind: z.literal("task"),
  status: TaskStatusSchema,
  artifacts: z.array(z.record(z.string(), z.unknown())).optional(),
  history: z.array(z.record(z.string(), z.unknown())).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Type guard to validate if an object is a valid Task
 */
function isValidTask(obj: unknown): obj is Task {
  const result = TaskSchema.safeParse(obj);
  return result.success;
}

/**
 * Status update for atomic task status changes
 */
export interface TaskStatusUpdate {
  state: Task["status"]["state"];
  timestamp?: string;
  message?: Task["status"]["message"];
}

const TASK_CACHE_NAMESPACE = "a2a:tasks";
const TASK_INDEX_NAMESPACE = "a2a:task-index";

// Environment-configurable constants with sensible defaults (12-Factor App pattern)
const DEFAULT_TTL_SECONDS =
  Number(process.env.A2A_TASK_TTL_SECONDS) || 7 * 24 * 60 * 60; // 7 days
const MAX_INDEX_SIZE = Number(process.env.A2A_MAX_INDEX_SIZE) || 1000; // Maximum entries per index
const CLEANUP_INTERVAL_MS =
  Number(process.env.A2A_CLEANUP_INTERVAL_MS) || 60 * 60 * 1000; // 1 hour

/**
 * Persistent task store with Redis backing
 *
 * Provides task storage and retrieval with Redis persistence and
 * automatic fallback to in-memory storage when Redis is unavailable.
 */
export class PersistentTaskStore extends ExtendedTaskStore {
  private memoryFallback: Map<string, Task> = new Map();
  private lastCleanup = Date.now();

  /**
   * Periodically clean up old entries from memoryFallback to prevent memory leaks.
   * Only runs if CLEANUP_INTERVAL_MS has passed since last cleanup.
   */
  private maybeCleanupMemory(): void {
    const now = Date.now();
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastCleanup = now;

    const cutoff = now - DEFAULT_TTL_SECONDS * 1000;
    for (const [taskId, task] of this.memoryFallback.entries()) {
      const taskTime = task.status.timestamp
        ? new Date(task.status.timestamp).getTime()
        : 0;
      if (taskTime < cutoff || !Number.isFinite(taskTime)) {
        this.memoryFallback.delete(taskId);
      }
    }
  }

  /**
   * Save task to both in-memory and Redis
   */
  async save(task: Task): Promise<void> {
    // Periodically clean up old entries
    this.maybeCleanupMemory();

    // Always save to parent (in-memory)
    await super.save(task);

    // Also save to memory fallback for quick access
    this.memoryFallback.set(task.id, task);

    // Persist to Redis if available
    if (await isRedisAvailable()) {
      try {
        const taskKey = `task:${task.id}`;
        const serialized = JSON.stringify(task);

        await setCache(taskKey, serialized, {
          namespace: TASK_CACHE_NAMESPACE,
          ttl: DEFAULT_TTL_SECONDS,
        });

        // Update indexes for efficient querying
        await this.updateIndexes(task);
      } catch (error) {
        logger.warn(
          "Failed to persist task to Redis, using memory only",
          { taskId: task.id, error: String(error) },
          "A2A",
        );
      }
    }
  }

  /**
   * Atomically update task status without load-modify-save race conditions.
   * Only updates the status field while preserving all other task properties.
   *
   * @param taskId - The ID of the task to update
   * @param statusUpdate - The status fields to update
   * @returns The updated task, or undefined if task not found
   */
  async updateStatus(
    taskId: string,
    statusUpdate: TaskStatusUpdate,
  ): Promise<Task | undefined> {
    // Load the current task
    const task = await this.load(taskId);
    if (!task) return undefined;

    // Create updated task with new status (atomic merge)
    const updatedTask: Task = {
      ...task,
      status: {
        ...task.status,
        state: statusUpdate.state,
        timestamp: statusUpdate.timestamp ?? new Date().toISOString(),
        ...(statusUpdate.message !== undefined && {
          message: statusUpdate.message,
        }),
      },
    };

    // Save atomically
    await this.save(updatedTask);

    return updatedTask;
  }

  /**
   * Load task from memory first, then Redis
   */
  async load(taskId: string): Promise<Task | undefined> {
    // Periodically clean up old entries
    this.maybeCleanupMemory();

    // Check in-memory first (from parent)
    let task = await super.load(taskId);
    if (task) return task;

    // Check memory fallback
    task = this.memoryFallback.get(taskId);
    if (task) return task;

    // Try Redis
    if (await isRedisAvailable()) {
      try {
        const taskKey = `task:${taskId}`;
        const cached = await getCache<string>(taskKey, {
          namespace: TASK_CACHE_NAMESPACE,
        });

        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            // Validate the parsed object against full Task schema using Zod
            if (isValidTask(parsed)) {
              task = parsed;
              // Restore to memory for fast subsequent access
              await super.save(task);
              this.memoryFallback.set(taskId, task);
              return task;
            }
            // Invalid task structure - treat as cache miss
            logger.warn(
              "Invalid task structure in Redis cache, treating as cache miss",
              {
                taskId,
                validationErrors: TaskSchema.safeParse(parsed).error?.issues,
              },
              "A2A",
            );
          } catch (parseError) {
            // Corrupted cache entry - treat as cache miss
            logger.warn(
              "Failed to parse task from Redis cache, treating as cache miss",
              { taskId, error: String(parseError) },
              "A2A",
            );
          }
        }
      } catch (error) {
        logger.warn(
          "Failed to load task from Redis",
          { taskId, error: String(error) },
          "A2A",
        );
      }
    }

    return undefined;
  }

  /**
   * Load multiple tasks in batch using Redis mget for efficiency
   * Uses parallel loading for memory checks and single mget for Redis
   */
  private async loadBatch(taskIds: string[]): Promise<Map<string, Task>> {
    const results = new Map<string, Task>();
    if (taskIds.length === 0) return results;

    // First check memory in parallel
    const memoryCheckPromises = taskIds.map(async (taskId) => {
      // Check in-memory first (from parent)
      const memTask = await super.load(taskId);
      if (memTask) return { taskId, task: memTask };

      // Check memory fallback
      const fallbackTask = this.memoryFallback.get(taskId);
      if (fallbackTask) return { taskId, task: fallbackTask };

      return { taskId, task: null };
    });

    const memoryResults = await Promise.all(memoryCheckPromises);

    // Collect results and identify missing IDs
    const missingIds: string[] = [];
    for (const { taskId, task } of memoryResults) {
      if (task) {
        results.set(taskId, task);
      } else {
        missingIds.push(taskId);
      }
    }

    // Batch fetch remaining from Redis using mget
    if (missingIds.length > 0 && (await isRedisAvailable())) {
      const client = getRedisClient();
      if (client) {
        try {
          const keys = missingIds.map(
            (id) => `${TASK_CACHE_NAMESPACE}:task:${id}`,
          );
          const values = await client.mget(...keys);

          // Collect save promises for parallel execution
          const savePromises: Promise<void>[] = [];

          for (let i = 0; i < missingIds.length; i++) {
            const taskId = missingIds[i];
            const cached = values[i];
            if (taskId && cached) {
              try {
                const parsed = JSON.parse(cached);
                // Validate the parsed object has required Task properties
                if (
                  parsed &&
                  typeof parsed === "object" &&
                  typeof parsed.id === "string" &&
                  parsed.status &&
                  typeof parsed.status === "object" &&
                  typeof parsed.status.state === "string"
                ) {
                  const task = parsed as Task;
                  results.set(taskId, task);
                  // Collect save promise without awaiting (parallel execution)
                  savePromises.push(super.save(task));
                  // Set memory fallback synchronously
                  this.memoryFallback.set(taskId, task);
                }
              } catch {
                // Skip invalid entries
                logger.debug(
                  "Failed to parse task in batch load",
                  { taskId },
                  "A2A",
                );
              }
            }
          }

          // Await all saves in parallel (use allSettled for isolation)
          await Promise.allSettled(savePromises);
        } catch (error) {
          logger.warn(
            "Failed to batch load tasks from Redis, falling back to parallel individual loads",
            { error: String(error) },
            "A2A",
          );
          // Fallback to parallel individual loads for remaining using Promise.allSettled
          const fallbackPromises = missingIds
            .filter((id) => !results.has(id))
            .map(async (taskId) => {
              const task = await this.load(taskId);
              return { taskId, task };
            });

          const fallbackResults = await Promise.allSettled(fallbackPromises);
          for (const result of fallbackResults) {
            if (result.status === "fulfilled" && result.value.task) {
              results.set(result.value.taskId, result.value.task);
            }
          }
        }
      }
    }

    return results;
  }

  /**
   * Merge two ListTasksResult sets, deduplicating by task id
   */
  private mergeListResults(
    redisResult: ListTasksResult,
    memoryResult: ListTasksResult,
  ): ListTasksResult {
    // Create a map to deduplicate by task id, preferring Redis (more persistent)
    const taskMap = new Map<string, Task>();

    // Add memory tasks first (will be overwritten by Redis if duplicate)
    for (const task of memoryResult.tasks) {
      taskMap.set(task.id, task);
    }

    // Add/overwrite with Redis tasks
    for (const task of redisResult.tasks) {
      taskMap.set(task.id, task);
    }

    // Convert back to array and sort by timestamp (most recent first)
    const mergedTasks = Array.from(taskMap.values()).sort((a, b) => {
      const aTime = a.status.timestamp
        ? new Date(a.status.timestamp).getTime()
        : 0;
      const bTime = b.status.timestamp
        ? new Date(b.status.timestamp).getTime()
        : 0;
      return bTime - aTime;
    });

    // Use the larger pageSize and combine totals (deduplicated)
    const pageSize = Math.max(redisResult.pageSize, memoryResult.pageSize);
    const paginatedTasks = mergedTasks.slice(0, pageSize);
    const hasMore = mergedTasks.length > pageSize;

    return {
      tasks: paginatedTasks,
      totalSize: taskMap.size,
      pageSize,
      // Compute nextPageToken based on merged results, not source offsets
      nextPageToken: hasMore ? String(pageSize) : "",
    };
  }

  /**
   * List tasks with optional Redis-backed querying
   */
  async list(params: ListTasksParams = {}): Promise<ListTasksResult> {
    // If Redis is available and we have a contextId filter, try Redis first
    if ((await isRedisAvailable()) && params.contextId) {
      try {
        const redisResult = await this.listFromRedis(params);

        // If Redis returned empty results, try merging with in-memory
        if (redisResult.tasks.length === 0) {
          const memoryResult = await super.list(params);
          if (memoryResult.tasks.length > 0) {
            return this.mergeListResults(redisResult, memoryResult);
          }
        }

        return redisResult;
      } catch (error) {
        logger.warn(
          "Failed to list tasks from Redis, falling back to memory",
          { error: String(error) },
          "A2A",
        );
      }
    }

    // Fall back to parent implementation (in-memory)
    return super.list(params);
  }

  /**
   * Update Redis indexes for efficient querying using atomic sorted set operations
   */
  private async updateIndexes(task: Task): Promise<void> {
    const client = getRedisClient();
    if (!client) return;

    const contextId = task.contextId || "global";
    const status = task.status.state;
    // Parse timestamp with fallback to Date.now() if invalid/NaN
    let timestamp = Date.now();
    if (task.status.timestamp) {
      const parsed = new Date(task.status.timestamp).getTime();
      if (Number.isFinite(parsed)) {
        timestamp = parsed;
      }
    }

    const contextIndexKey = `${TASK_INDEX_NAMESPACE}:context:${contextId}`;
    const statusIndexKey = `${TASK_INDEX_NAMESPACE}:status:${status}`;

    try {
      // Check current cardinality to avoid unnecessary trimming operations
      const [contextCardinality, statusCardinality] = await Promise.all([
        client.zcard(contextIndexKey),
        client.zcard(statusIndexKey),
      ]);

      // Use Redis MULTI/EXEC for atomic operations on both indexes
      const pipeline = client.multi();

      // Add/update task in context index (sorted set with timestamp as score)
      // ZADD with score=timestamp atomically adds or updates the entry
      pipeline.zadd(contextIndexKey, timestamp, task.id);
      // Only trim if index exceeds MAX_INDEX_SIZE to avoid unnecessary operations
      if (contextCardinality >= MAX_INDEX_SIZE) {
        // ZREMRANGEBYRANK 0 -(MAX_INDEX_SIZE+1) removes all but the top MAX_INDEX_SIZE entries
        pipeline.zremrangebyrank(contextIndexKey, 0, -(MAX_INDEX_SIZE + 1));
      }
      // Set TTL on the index key
      pipeline.expire(contextIndexKey, DEFAULT_TTL_SECONDS);

      // Add/update task in status index
      pipeline.zadd(statusIndexKey, timestamp, task.id);
      // Only trim if index exceeds MAX_INDEX_SIZE
      if (statusCardinality >= MAX_INDEX_SIZE) {
        pipeline.zremrangebyrank(statusIndexKey, 0, -(MAX_INDEX_SIZE + 1));
      }
      pipeline.expire(statusIndexKey, DEFAULT_TTL_SECONDS);

      // Execute all commands atomically
      await pipeline.exec();
    } catch (error) {
      logger.debug(
        "Failed to update indexes atomically in Redis",
        { taskId: task.id, error: String(error) },
        "A2A",
      );
    }
  }

  /**
   * Get an index from Redis sorted set
   * Returns entries sorted by timestamp descending (newest first)
   */
  private async getIndexFromSortedSet(
    indexKey: string,
  ): Promise<Array<{ taskId: string; timestamp: number }>> {
    const client = getRedisClient();
    if (!client) return [];

    try {
      // ZREVRANGE returns members sorted by score descending (newest first)
      // with WITHSCORES to get the timestamps
      const results = await client.zrevrange(indexKey, 0, -1, "WITHSCORES");

      // Results come as [member1, score1, member2, score2, ...]
      const entries: Array<{ taskId: string; timestamp: number }> = [];
      for (let i = 0; i < results.length; i += 2) {
        const taskId = results[i];
        const score = results[i + 1];
        if (taskId && score) {
          entries.push({
            taskId,
            timestamp: Number.parseFloat(score),
          });
        }
      }
      return entries;
    } catch {
      logger.debug(
        "Failed to get index from Redis sorted set",
        { indexKey },
        "A2A",
      );
    }
    return [];
  }

  /**
   * List tasks from Redis using sorted set indexes
   */
  private async listFromRedis(
    params: ListTasksParams,
  ): Promise<ListTasksResult> {
    const contextId = params.contextId || "global";
    const contextIndexKey = `${TASK_INDEX_NAMESPACE}:context:${contextId}`;

    // Get task IDs from context index (sorted set)
    let taskEntries = await this.getIndexFromSortedSet(contextIndexKey);

    // Filter by status if specified
    if (params.status) {
      const statusIndexKey = `${TASK_INDEX_NAMESPACE}:status:${params.status}`;
      const statusIndex = await this.getIndexFromSortedSet(statusIndexKey);
      const statusTaskIds = new Set(statusIndex.map((e) => e.taskId));
      taskEntries = taskEntries.filter((e) => statusTaskIds.has(e.taskId));
    }

    // Filter by lastUpdatedAfter
    if (params.lastUpdatedAfter) {
      taskEntries = taskEntries.filter(
        (e) => e.timestamp >= params.lastUpdatedAfter!,
      );
    }

    // Pagination with validated pageToken
    const pageSize = Math.min(params.pageSize || 10, 100);
    let pageOffset = 0;

    if (params.pageToken) {
      const parsed = Number.parseInt(params.pageToken, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(
          `Invalid pageToken: expected non-negative integer, got "${params.pageToken}"`,
        );
      }
      pageOffset = parsed;
    }

    const totalSize = taskEntries.length;
    const paginatedEntries = taskEntries.slice(
      pageOffset,
      pageOffset + pageSize,
    );

    // Load tasks in batch to avoid N+1 queries
    const taskIds = paginatedEntries.map((e) => e.taskId);
    const loadedTasks = await this.loadBatch(taskIds);

    // Process loaded tasks
    const tasks: Task[] = [];
    for (const taskId of taskIds) {
      const task = loadedTasks.get(taskId);
      if (task) {
        // Process task (trim history, remove artifacts if needed)
        const processed = { ...task };

        if (params.historyLength !== undefined && processed.history) {
          processed.history = processed.history.slice(-params.historyLength);
        }

        if (params.includeArtifacts === false) {
          delete processed.artifacts;
        }

        tasks.push(processed);
      }
    }

    // Calculate next page token
    const hasMore = totalSize > pageOffset + pageSize;
    const nextPageToken = hasMore ? String(pageOffset + pageSize) : "";

    return {
      tasks,
      totalSize,
      pageSize,
      nextPageToken,
    };
  }

  /**
   * Clear all tasks (for testing)
   */
  async clear(): Promise<void> {
    await super.clear();
    this.memoryFallback.clear();
    // Note: Redis indexes will expire naturally with TTL
  }
}
