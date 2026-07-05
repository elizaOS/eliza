/**
 * Priority-FIFO admission ordering for the orchestrator's session-cap queue.
 *
 * When a task spawn meets the ACP worker cap, `OrchestratorTaskService` parks it
 * here instead of hard-failing: the task keeps `open` status and carries the
 * `AdmissionRecord` below in `task.metadata.admission`. This module owns only
 * the pure ordering math — band mapping, starvation-guard aging, and the depth
 * cap — so the ordering is unit-testable in isolation from the store, the ACP
 * transport, and wall-clock time (every function takes `now` explicitly).
 *
 * Ordering: priority bands (urgent > high > normal > low), FIFO within a band by
 * enqueue time, taskId as the final deterministic tiebreak. A queued task's
 * effective band is promoted one step per `agingMs` it has waited, so a
 * low-priority task can never starve behind a steady stream of higher-priority
 * arrivals (starvation guard #1).
 */

import type { OrchestratorTaskPriority } from "./orchestrator-task-types.js";

/** Persisted on `task.metadata.admission` while a task waits for a worker slot.
 * `spawnOpts` is the serializable subset of the original spawn request replayed
 * verbatim when the task is dispatched, so the parked spawn is identical to the
 * one the cap rejected. */
export interface AdmissionRecord {
  state: "queued";
  enqueuedAt: string;
  priorityAtEnqueue: OrchestratorTaskPriority;
  spawnOpts: SerializableSpawnOpts;
}

/** The JSON-safe slice of SpawnAgentForTaskOptions the queue persists and
 * replays. Excludes `nestingDepth` (a live-only recursion counter) — a parked
 * top-level spawn always re-dispatches at depth 0. */
export interface SerializableSpawnOpts {
  framework?: string;
  model?: string;
  workdir?: string;
  repo?: string;
  label?: string;
  task?: string;
  approvalPreset?: string;
  providerSource?: string;
}

const PRIORITY_BANDS: Record<OrchestratorTaskPriority, number> = {
  urgent: 3,
  high: 2,
  normal: 1,
  low: 0,
};

export function priorityBand(priority: OrchestratorTaskPriority): number {
  return PRIORITY_BANDS[priority] ?? PRIORITY_BANDS.normal;
}

/** The band a queued entry competes in right now: its enqueue-time band plus one
 * promotion step per whole `agingMs` it has waited. A non-positive `agingMs`
 * disables aging (band stays fixed). */
export function effectiveBand(
  entry: QueueEntry,
  now: number,
  agingMs: number,
): number {
  const base = priorityBand(entry.priorityAtEnqueue);
  if (agingMs <= 0) return base;
  const waitMs = Math.max(0, now - Date.parse(entry.enqueuedAt));
  return base + Math.floor(waitMs / agingMs);
}

/** The in-memory shape the queue orders. Mirrors the durable AdmissionRecord's
 * ordering-relevant fields plus the taskId key. */
export interface QueueEntry {
  taskId: string;
  enqueuedAt: string;
  priorityAtEnqueue: OrchestratorTaskPriority;
}

/**
 * Total order over parked entries at instant `now`: higher effective band first,
 * then earlier enqueue time, then taskId. Returns a NEW sorted array (does not
 * mutate the input) so callers can hold a stable snapshot for a drain pass.
 */
export function orderQueue(
  entries: readonly QueueEntry[],
  now: number,
  agingMs: number,
): QueueEntry[] {
  return [...entries].sort((a, b) => {
    const bandDelta =
      effectiveBand(b, now, agingMs) - effectiveBand(a, now, agingMs);
    if (bandDelta !== 0) return bandDelta;
    const timeDelta = Date.parse(a.enqueuedAt) - Date.parse(b.enqueuedAt);
    if (timeDelta !== 0) return timeDelta;
    return a.taskId.localeCompare(b.taskId);
  });
}
