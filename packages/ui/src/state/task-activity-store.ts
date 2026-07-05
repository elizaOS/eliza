/**
 * Live, stream-driven store of orchestrator task activity for the inline chat
 * pipeline. Subscribes ONCE to the `pty-session-event` WebSocket feed (the same
 * stream the sidebar rail reads), narrows each raw event through the typed
 * `toSwarmActivity` boundary, and regroups the flat stream into the
 * task -> sub-agent -> step tree the inline `[TASK]` card renders.
 *
 * This is what lets the thread drop the old 5s poll: a task card selects its
 * own subtree via `useTaskActivity(taskId)` (a `useSyncExternalStore` read) and
 * re-renders only when that task's events arrive. Ordering is by the event
 * `seq` the coordinator stamps — the wire is not arrival-ordered — so a burst of
 * out-of-order tool/message chunks still lands in the right sequence.
 *
 * The store is a process-global singleton: many task cards + the workflow/todo
 * widgets share one WS subscription, ref-counted so the socket handler is bound
 * only while something is mounted.
 */

import {
  type SwarmActivityPlanEntry,
  type SwarmActivityStatus,
  type SwarmActivityTool,
  type SwarmEvent,
  toSwarmActivity,
} from "@elizaos/core";
import { useSyncExternalStore } from "react";
import { client } from "../api/client";

/** Cap on retained tool steps per sub-agent — a long task must not grow unbounded. */
const MAX_STEPS_PER_AGENT = 60;

export interface TaskActivityStep {
  /** Stable id: the tool call id, or `seq` when the adapter omits one. */
  id: string;
  seq: number;
  tool: SwarmActivityTool;
  timestamp: number;
}

export interface SubagentActivity {
  sessionId: string;
  parentSessionId?: string;
  status: SwarmActivityStatus;
  label?: string;
  /** Latest streamed assistant text (the sub-agent's "current" line). */
  currentText?: string;
  /** Latest streamed reasoning chunk. */
  currentReasoning?: string;
  steps: TaskActivityStep[];
  plan?: SwarmActivityPlanEntry[];
  updatedAt: number;
  firstSeq: number;
}

export interface TaskActivity {
  taskId: string;
  subagents: SubagentActivity[];
  plan: SwarmActivityPlanEntry[];
  lastSeq: number;
  updatedAt: number;
}

// Shared frozen sentinel returned before a task's first event. The nested arrays
// are plain empties: the snapshot is replaced wholesale on every change (never
// mutated in place), so they are read-only by construction, not by `freeze`.
const EMPTY_TASK: TaskActivity = Object.freeze({
  taskId: "",
  subagents: [] as SubagentActivity[],
  plan: [] as SwarmActivityPlanEntry[],
  lastSeq: 0,
  updatedAt: 0,
});

interface TaskEntry {
  /** Frozen snapshot handed to `useSyncExternalStore`; replaced on every change. */
  snapshot: TaskActivity;
  /** Mutable working copy the reducer edits before it re-freezes a snapshot. */
  subagents: Map<string, SubagentActivity>;
  plan: SwarmActivityPlanEntry[];
  lastSeq: number;
  listeners: Set<() => void>;
}

const tasks = new Map<string, TaskEntry>();
let wsUnsub: (() => void) | null = null;
let refCount = 0;

function statusFromLifecycle(
  event: string,
  prev: SwarmActivityStatus,
): SwarmActivityStatus {
  // A streamed message/tool keeps a sub-agent "running"; only a lifecycle event
  // moves it to a terminal/idle/waiting state. `ready` after work means idle,
  // but `ready` as the very first event is the initial idle state too.
  switch (event) {
    case "task_complete":
      return "success";
    case "error":
      return "failure";
    case "blocked":
    case "login_required":
      return "waiting";
    case "stopped":
      return prev === "running" ? "success" : "idle";
    case "ready":
      return prev === "idle" ? "idle" : prev;
    default:
      return prev;
  }
}

function ensureEntry(taskId: string): TaskEntry {
  let entry = tasks.get(taskId);
  if (!entry) {
    entry = {
      snapshot: { ...EMPTY_TASK, taskId },
      subagents: new Map(),
      plan: [],
      lastSeq: 0,
      listeners: new Set(),
    };
    tasks.set(taskId, entry);
  }
  return entry;
}

function refreezeSnapshot(entry: TaskEntry, at: number): void {
  const subagents = [...entry.subagents.values()].sort(
    (a, b) => a.firstSeq - b.firstSeq,
  );
  entry.snapshot = {
    taskId: entry.snapshot.taskId,
    subagents,
    plan: entry.plan,
    lastSeq: entry.lastSeq,
    updatedAt: at,
  };
  for (const listener of entry.listeners) listener();
}

function applyEvent(raw: SwarmEvent): void {
  const activity = toSwarmActivity(raw);
  if (!activity) return;
  const taskId = activity.taskId ?? raw.taskId ?? raw.sessionId;
  if (!taskId) return;
  const entry = ensureEntry(taskId);
  entry.snapshot = { ...entry.snapshot, taskId };

  const sessionId = activity.sessionId;
  const existing = entry.subagents.get(sessionId);
  const agent: SubagentActivity = existing ?? {
    sessionId,
    status: "running",
    steps: [],
    updatedAt: activity.timestamp,
    firstSeq: activity.seq,
  };
  if (activity.parentSessionId)
    agent.parentSessionId = activity.parentSessionId;
  agent.updatedAt = activity.timestamp;
  entry.lastSeq = Math.max(entry.lastSeq, activity.seq);

  switch (activity.kind) {
    case "message":
      agent.currentText = activity.text;
      break;
    case "reasoning":
      agent.currentReasoning = activity.text;
      break;
    case "plan":
      agent.plan = activity.entries;
      // The most-recently-updated plan is also the task-level checklist so a
      // single-agent task surfaces its todos at the card root.
      entry.plan = activity.entries;
      break;
    case "tool": {
      const stepId = activity.tool.id ?? `seq-${activity.seq}`;
      const step: TaskActivityStep = {
        id: stepId,
        seq: activity.seq,
        tool: activity.tool,
        timestamp: activity.timestamp,
      };
      const idx = agent.steps.findIndex((s) => s.id === stepId);
      if (idx >= 0) agent.steps[idx] = step;
      else agent.steps.push(step);
      if (agent.steps.length > MAX_STEPS_PER_AGENT) {
        agent.steps.splice(0, agent.steps.length - MAX_STEPS_PER_AGENT);
      }
      if (agent.status !== "waiting") agent.status = "running";
      break;
    }
    case "lifecycle":
      agent.status = statusFromLifecycle(activity.event, agent.status);
      if (activity.label) agent.label = activity.label;
      break;
  }

  entry.subagents.set(sessionId, agent);
  refreezeSnapshot(entry, activity.timestamp);
}

function bindWs(): void {
  if (wsUnsub) return;
  wsUnsub = client.onWsEvent(
    "pty-session-event",
    (data: Record<string, unknown>) => {
      // The server rewrites `{ type, ...rest }` so the event `type` arrives as
      // `eventType`; reconstruct the `SwarmEvent` shape the normalizer expects.
      const eventType =
        typeof data.eventType === "string"
          ? data.eventType
          : typeof data.type === "string"
            ? data.type
            : undefined;
      const sessionId =
        typeof data.sessionId === "string" ? data.sessionId : undefined;
      if (!eventType || !sessionId) return;
      applyEvent({
        type: eventType,
        sessionId,
        timestamp:
          typeof data.timestamp === "number" ? data.timestamp : Date.now(),
        data: data.data,
        ...(typeof data.seq === "number" ? { seq: data.seq } : {}),
        ...(typeof data.taskId === "string" ? { taskId: data.taskId } : {}),
        ...(typeof data.parentSessionId === "string"
          ? { parentSessionId: data.parentSessionId }
          : {}),
      });
    },
  );
}

function subscribeTask(taskId: string, listener: () => void): () => void {
  const entry = ensureEntry(taskId);
  entry.listeners.add(listener);
  refCount += 1;
  bindWs();
  return () => {
    entry.listeners.delete(listener);
    refCount -= 1;
    if (refCount <= 0 && wsUnsub) {
      wsUnsub();
      wsUnsub = null;
      refCount = 0;
    }
  };
}

/**
 * Live activity subtree for one task thread. Re-renders only when that task's
 * events arrive. Returns a frozen `TaskActivity` (empty until the first event).
 */
export function useTaskActivity(taskId: string): TaskActivity {
  return useSyncExternalStore(
    (listener) => subscribeTask(taskId, listener),
    () => tasks.get(taskId)?.snapshot ?? EMPTY_TASK,
    () => EMPTY_TASK,
  );
}

/** Test-only: feed a raw event and read the resulting snapshot without a socket. */
export const __taskActivityInternals = {
  applyEvent,
  // Binds the WS handler exactly as `useTaskActivity` does (ref-counted), so a
  // test can exercise the real `pty-session-event` reconstruction seam without
  // React / a DOM environment.
  subscribe: subscribeTask,
  getSnapshot: (taskId: string): TaskActivity =>
    tasks.get(taskId)?.snapshot ?? EMPTY_TASK,
  reset: (): void => {
    tasks.clear();
    if (wsUnsub) wsUnsub();
    wsUnsub = null;
    refCount = 0;
  },
};
