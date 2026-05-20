/**
 * Extended Task Store
 *
 * Extends the A2A SDK's InMemoryTaskStore to add tasks/list functionality
 * required for full A2A protocol compliance. Provides filtering, pagination,
 * and task history management.
 *
 * @public
 */

import type { Task } from "@a2a-js/sdk";
import { InMemoryTaskStore } from "@a2a-js/sdk/server";

/**
 * Parameters for listing tasks
 */
export interface ListTasksParams {
  contextId?: string;
  status?:
    | "submitted"
    | "working"
    | "input-required"
    | "auth-required"
    | "completed"
    | "failed"
    | "canceled"
    | "rejected";
  pageSize?: number;
  pageToken?: string;
  historyLength?: number;
  includeArtifacts?: boolean;
  lastUpdatedAfter?: number;
}

/**
 * Result of listing tasks
 */
export interface ListTasksResult {
  tasks: Task[];
  totalSize: number;
  pageSize: number;
  nextPageToken: string;
}

/**
 * Extended task store with list capability
 *
 * Provides task storage and retrieval with filtering, pagination, and
 * history management for A2A protocol compliance.
 */
export class ExtendedTaskStore extends InMemoryTaskStore {
  private tasks: Map<string, Task> = new Map();

  /**
   * Save task (override to track in our map)
   */
  async save(task: Task): Promise<void> {
    await super.save(task);
    this.tasks.set(task.id, task);
  }

  /**
   * Load task (override to use our map)
   */
  async load(taskId: string): Promise<Task | undefined> {
    return this.tasks.get(taskId) || (await super.load(taskId));
  }

  /**
   * List tasks with filtering and pagination
   */
  async list(params: ListTasksParams = {}): Promise<ListTasksResult> {
    let allTasks = Array.from(this.tasks.values());

    // Filter by contextId
    if (params.contextId) {
      allTasks = allTasks.filter((t) => t.contextId === params.contextId);
    }

    // Filter by status
    if (params.status) {
      allTasks = allTasks.filter((t) => t.status.state === params.status);
    }

    // Filter by lastUpdatedAfter
    if (params.lastUpdatedAfter) {
      allTasks = allTasks.filter((t) => {
        if (!t.status.timestamp) return false;
        const taskTime = new Date(t.status.timestamp).getTime();
        return taskTime >= params.lastUpdatedAfter!;
      });
    }

    // Sort by last update time (descending - most recent first)
    allTasks.sort((a, b) => {
      const aTime = a.status.timestamp
        ? new Date(a.status.timestamp).getTime()
        : 0;
      const bTime = b.status.timestamp
        ? new Date(b.status.timestamp).getTime()
        : 0;
      return bTime - aTime;
    });

    // Pagination with validated pageToken
    const pageSize = Math.min(params.pageSize || 10, 100); // Max 100 per page
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

    const startIdx = pageOffset;
    const endIdx = startIdx + pageSize;
    const paginatedTasks = allTasks.slice(startIdx, endIdx);

    // Process tasks (trim history, remove artifacts if needed)
    const processedTasks = paginatedTasks.map((task) => {
      const processed = { ...task };

      // Trim history if requested
      if (params.historyLength !== undefined && processed.history) {
        processed.history = processed.history.slice(-params.historyLength);
      }

      // Remove artifacts if not requested
      if (params.includeArtifacts === false) {
        delete processed.artifacts;
      }

      return processed;
    });

    // Calculate next page token
    const hasMore = allTasks.length > endIdx;
    const nextPageToken = hasMore ? String(endIdx) : "";

    return {
      tasks: processedTasks,
      totalSize: allTasks.length,
      pageSize,
      nextPageToken,
    };
  }

  /**
   * Get all tasks (for debugging/admin)
   */
  async getAllTasks(): Promise<Task[]> {
    return Array.from(this.tasks.values());
  }

  /**
   * Clear all tasks (for testing)
   */
  async clear(): Promise<void> {
    this.tasks.clear();
  }
}
