/**
 * Debug Trace Store
 *
 * In-memory storage for debug traces with LRU eviction.
 * Provides retrieval by runId and access to the most recent trace.
 */

import type { UUID } from "@elizaos/core";
import type { DebugTrace } from "./types";

// ============================================================================
// Debug Trace Store
// ============================================================================

export class DebugTraceStore {
  private traces: Map<string, DebugTrace> = new Map();
  private order: string[] = [];
  private maxTraces: number;

  constructor(maxTraces: number = 100) {
    this.maxTraces = maxTraces;
  }

  /**
   * Store a trace. Evicts oldest if at capacity.
   */
  store(trace: DebugTrace): void {
    const runId = trace.runId;

    // If already exists, remove from order array (will be re-added at end)
    if (this.traces.has(runId)) {
      const idx = this.order.indexOf(runId);
      if (idx !== -1) {
        this.order.splice(idx, 1);
      }
    }

    // Evict oldest if at capacity
    while (this.traces.size >= this.maxTraces && this.order.length > 0) {
      const oldestId = this.order.shift();
      if (oldestId) {
        this.traces.delete(oldestId);
      }
    }

    // Store trace
    this.traces.set(runId, trace);
    this.order.push(runId);
  }

  /**
   * Get a trace by runId
   */
  get(runId: UUID): DebugTrace | undefined {
    return this.traces.get(runId);
  }

  /**
   * Get the most recently stored trace
   */
  getLatest(): DebugTrace | undefined {
    if (this.order.length === 0) {
      return undefined;
    }
    const latestId = this.order[this.order.length - 1];
    return this.traces.get(latestId);
  }

  /**
   * List all stored traces (oldest to newest)
   */
  list(): DebugTrace[] {
    return this.order.map((id) => this.traces.get(id)!).filter(Boolean);
  }

  /**
   * List traces by status
   */
  listByStatus(status: DebugTrace["status"]): DebugTrace[] {
    return this.list().filter((t) => t.status === status);
  }

  /**
   * List traces by agent mode
   */
  listByMode(mode: DebugTrace["agentMode"]): DebugTrace[] {
    return this.list().filter((t) => t.agentMode === mode);
  }

  /**
   * Clear all stored traces
   */
  clear(): void {
    this.traces.clear();
    this.order = [];
  }

  /**
   * Remove a specific trace
   */
  remove(runId: UUID): boolean {
    const existed = this.traces.delete(runId);
    if (existed) {
      const idx = this.order.indexOf(runId);
      if (idx !== -1) {
        this.order.splice(idx, 1);
      }
    }
    return existed;
  }

  /**
   * Get current store size
   */
  size(): number {
    return this.traces.size;
  }

  /**
   * Get store capacity
   */
  capacity(): number {
    return this.maxTraces;
  }

  /**
   * Get store stats
   */
  getStats(): {
    size: number;
    maxSize: number;
    oldestTimestamp?: number;
    newestTimestamp?: number;
    statusCounts: Record<string, number>;
    modeCounts: Record<string, number>;
  } {
    const traces = this.list();
    const statusCounts: Record<string, number> = {};
    const modeCounts: Record<string, number> = {};

    for (const trace of traces) {
      statusCounts[trace.status] = (statusCounts[trace.status] || 0) + 1;
      modeCounts[trace.agentMode] = (modeCounts[trace.agentMode] || 0) + 1;
    }

    return {
      size: this.traces.size,
      maxSize: this.maxTraces,
      oldestTimestamp: traces[0]?.startedAt,
      newestTimestamp: traces[traces.length - 1]?.startedAt,
      statusCounts,
      modeCounts,
    };
  }
}

// ============================================================================
// Global Singleton Instance
// ============================================================================

export const debugTraceStore = new DebugTraceStore();

// ============================================================================
// Convenience Functions
// ============================================================================

export function storeDebugTrace(trace: DebugTrace): void {
  debugTraceStore.store(trace);
}

export function getDebugTrace(runId: UUID): DebugTrace | undefined {
  return debugTraceStore.get(runId);
}

export function getLatestDebugTrace(): DebugTrace | undefined {
  return debugTraceStore.getLatest();
}

export function listDebugTraces(): DebugTrace[] {
  return debugTraceStore.list();
}

export function clearDebugTraces(): void {
  debugTraceStore.clear();
}

export function getDebugTraceStoreStats(): ReturnType<DebugTraceStore["getStats"]> {
  return debugTraceStore.getStats();
}
