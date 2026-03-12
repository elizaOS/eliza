# Task Scheduler: Cross-Runtime Architecture

This document describes how the task system schedules and runs queue tasks across three deployment modes: **local timer**, **per-daemon shared scheduler**, and **serverless**. It includes design rationale (WHY) for each choice.

## Overview

The **task system** is the single place for *when* scheduled work runs. Only tasks with tag `queue` are polled by the scheduler; other tasks (approval, follow-up, etc.) are stored and executed only when explicitly triggered (e.g. choice action or `executeTaskById`).

**Why one scheduler:** Recurring work (batcher drains, cron-like use) shares the same DB, same pause/resume, same visibility (`getTaskStatus`, `nextRunAt`, `lastError`). Retry and backoff live in one place to avoid infinite retry storms.

**Why this document:** The scheduler can run in three ways depending on how the host is deployed. Understanding the modes and the `getTasks(agentIds)` contract avoids bugs and makes serverless/daemon integration straightforward.

---

## Three Scheduling Modes

| Mode | When it applies | Who drives ticks | DB queries per tick |
|------|----------------|------------------|----------------------|
| **Local timer** | Default: no daemon, not serverless | TaskService `setInterval` | 1 per runtime |
| **Daemon** | Host called `startTaskScheduler(adapter)` | Shared module timer | **1 for all registered runtimes** |
| **Serverless** | `runtime.serverless === true` | Host calls `taskService.runDueTasks()` | On each `runDueTasks()` call |

**Why three modes:** Single-process apps keep a simple local timer. Multi-process or multi-agent daemons need one shared timer and one batched `getTasks(agentIds)` to avoid N queries per second. Serverless has no long-lived process, so the host (cron or request handler) must explicitly run due tasks.

---

## Mode 1: Local Timer (default)

- **When:** No daemon adapter is set (`getTaskSchedulerAdapter()` returns `null`) and `runtime.serverless` is not `true`.
- **Behavior:** Each TaskService starts its own `setInterval(..., TICK_INTERVAL)`. Every tick it calls `checkTasks()`: if `tasksDirty`, it fetches queue tasks for this agent and calls `runTick(tasks)`.
- **Why:** Zero configuration; works out of the box for single-agent or small deployments. The `tasksDirty` flag avoids redundant `getTasks` when nothing changed (e.g. no `createTask`/`updateTask`/`deleteTask` since last tick).

---

## Mode 2: Per-Daemon Shared Scheduler

- **When:** The host (e.g. daemon or main process) calls `startTaskScheduler(databaseAdapter)` before starting agent runtimes. TaskService then sees `getTaskSchedulerAdapter() != null` and **registers** with the scheduler instead of starting a local timer.
- **Behavior:**
  - One module-level timer runs every `TICK_INTERVAL_MS` (e.g. 1000 ms).
  - Each tick, the scheduler collects **dirty agent IDs** (agents that registered or had `markTaskSchedulerDirty(agentId)` called), then calls `adapter.getTasks({ tags: ["queue"], agentIds })` **once**.
  - Results are grouped by `task.agentId`; each registered runtime’s `TaskService.runTick(tasks)` is invoked with only that agent’s tasks.
- **Why one query:** With many agents, N runtimes would otherwise do N `getTasks` every second. Batching by `agentIds` in a single query reduces DB load and keeps scheduling logic in one place.
- **Why dirty set:** Only agents that need a tick (newly registered or notified via `markDirty()` → `markTaskSchedulerDirty()`) are included. **Why we still tick when dirty is empty:** The first tick after registration uses the snapshot of dirty agents; if none, the tick no-ops. So we only query when there is at least one dirty agent.
- **Exports (from `@elizaos/core` Node build):** `startTaskScheduler`, `stopTaskScheduler`, `getTaskSchedulerAdapter`, `registerTaskSchedulerRuntime`, `unregisterTaskSchedulerRuntime`, `markTaskSchedulerDirty`.

**Usage (host):**

```ts
import { startTaskScheduler, stopTaskScheduler } from "@elizaos/core";
import { someDatabaseAdapter } from "./db";

startTaskScheduler(someDatabaseAdapter);
// … create runtimes, run agents …
// On shutdown:
stopTaskScheduler();
```

TaskService automatically registers on start and unregisters on stop when the daemon is present.

---

## Mode 3: Serverless

- **When:** Runtime is constructed with `{ serverless: true }` (or equivalent). No long-lived process; no timer.
- **Behavior:** TaskService does **not** start a local timer and does **not** register with the daemon. The host must call `taskService.runDueTasks()` from a cron job or on each request to run due queue tasks once.
- **Why:** In serverless, the process may not live between invocations. A timer would be useless or harmful. Explicit `runDueTasks()` gives the host full control over when and how often tasks run (e.g. once per request, or on a fixed cron schedule).
- **API:** `runtime.getService(ServiceType.TASK)` then `(service as TaskService).runDueTasks()`. This performs one `getTasks({ tags: ["queue"], agentIds: [runtime.agentId] })` and then `runTick(tasks)`.

**Note:** In serverless mode, `markDirty()` has no effect on when tasks run (there is no tick loop). It is safe to call but does not change behavior; the next `runDueTasks()` will query the DB anyway.

---

## getTasks(agentIds) Contract

All task queries that are used for scheduling or multi-tenant filtering use the batch API:

```ts
getTasks(params: {
  roomId?: UUID;
  tags?: string[];
  entityId?: UUID;
  agentIds: UUID[];   // required
  limit?: number;
  offset?: number;
}): Promise<Task[]>;
```

**Why `agentIds` is required (array, not optional `agentId`):**

1. **Multi-tenant safety:** Each runtime must only see its own tasks. The DB schema indexes by `agent_id`; filtering by `agentIds` keeps queries efficient and prevents one agent from seeing another’s tasks.
2. **Daemon batching:** The shared scheduler passes multiple agent IDs in one call and gets all their queue tasks; then it groups by `task.agentId` and dispatches to the right TaskService. A single `agentId` would force N separate calls for N agents.
3. **Explicit call-site contract:** Requiring `agentIds` (and using an array) forces every caller to pass a list (e.g. `[this.runtime.agentId]`). No implicit “current agent” that could be wrong in shared adapters.

**Empty `agentIds`:** Adapters return `[]` without querying. **Why:** Avoids expensive “all tasks” queries by mistake; daemon never passes an empty list because it only ticks when the dirty set is non-empty.

**Call sites:** All call sites (TaskService, approval, follow-up, choice, status, autonomy, etc.) pass `agentIds: [runtime.agentId]` or the batch list from the daemon. See audit in codebase for the full list.

---

## runTick(tasks) and runDueTasks()

- **`runTick(tasks: Task[]): Promise<void>`**  
  Validates and executes due tasks from a **given** list. It does **not** fetch tasks; the caller is responsible for that. Used by:
  - `checkTasks()` after fetching queue tasks (local or daemon).
  - Daemon: after one batched `getTasks(agentIds)`, grouped by agent, each group is passed to the corresponding `runTick(tasks)`.
  - `runDueTasks()`: fetches queue tasks for this agent, then calls `runTick(tasks)`.

**Why separate fetch and runTick:** So the daemon can do one fetch and then dispatch to many runtimes without each runtime doing its own fetch. TaskService stays agnostic of who provided the task list.

- **`runDueTasks(): Promise<void>`**  
  For serverless (or any pull-based use): runs one “tick” for this agent by fetching queue tasks and calling `runTick(tasks)`. **Why:** Single entry point for “run due tasks now” without starting a timer.

---

## Roadmap (done and possible next steps)

**Done:**

- **Phase 1:** `getTasks` takes required `agentIds` only; all adapters and call sites updated; empty `agentIds` returns `[]`.
- **Phase 2:** `runTick(tasks)` extracted from `checkTasks()`; procedural daemon module with one timer and batched `getTasks(agentIds)`.
- **Phase 3:** TaskService registers/unregisters with daemon; `markDirty()` notifies daemon; scheduler API exported from Node build.
- **Phase 4:** Serverless mode (`runtime.serverless`), no timer when serverless; `runDueTasks()` for host-driven execution.

**Possible future work:**

- **Logging in daemon tick:** Today, per-agent errors in `runTick` are swallowed in the daemon’s `catch`. Adding a small logger or error callback would help operations.
- **Optional “dirty” optimization for serverless:** If the host wanted to skip `runDueTasks()` when no task mutations happened, `markDirty()` could be wired to a flag read by `runDueTasks()`. Not required for correctness.
- **Metrics:** Expose tick count, tasks executed per tick, or latency per agent for observability in daemon mode.

---

## Summary

| Topic | Decision | Why |
|-------|----------|-----|
| Who runs the tick? | Local timer, daemon, or host (serverless) | Support single-process, multi-agent daemon, and serverless without a long-lived process. |
| getTasks filter | Required `agentIds: UUID[]` | Multi-tenant safety; daemon can batch one query for many agents. |
| runTick vs fetch | Caller fetches; runTick only runs | Daemon does one fetch, then dispatches to N runtimes. |
| runDueTasks() | One fetch + runTick for this agent | Serverless host can run due tasks on cron or per request. |
| markDirty in serverless | No-op for scheduling | No tick loop; next runDueTasks() will query anyway. |

For task metadata (dueAt, repeat, pause, backoff) and public API (`executeTaskById`, `pauseTask`, `resumeTask`, `getTaskStatus`), see the main task system docs and `packages/typescript/README.md` (§ Task system).

---

## Recurring intervals → queue tasks

Plugins that use `setInterval` for recurring work (e.g. polling, cleanup, reminders) can be converted to **queue tasks** so that:

- The same scheduler tick drives all recurring work (one `getTasks` per tick; no per-plugin timers).
- Schedules are DB-backed and visible via `getTaskStatus` / status action; tasks can be paused or resumed.
- Serverless and daemon modes work correctly (host calls `runDueTasks()` or daemon batches `getTasks(agentIds)`).

**Pattern:**

1. Register a task worker: `runtime.registerTaskWorker({ name: "PLUGIN_ACTION", execute, shouldRun? })`.
2. On service start: call `runtime.getTasksByName(taskName)`, filter by `task.agentId === runtime.agentId` (adapters may return tasks for all agents), and only `runtime.createTask(...)` if none exists. Store the task id for stop.
3. Create recurring task when missing: `tags: ["queue", "repeat"]`, `metadata: { updateInterval: ms, baseInterval: ms, updatedAt: Date.now() }`.
4. Remove the plugin’s `setInterval`; the scheduler tick runs the task when due.
5. On service stop: delete or pause the recurring task so it does not outlive the worker (avoids "No worker found for task type" after plugin unload).

**Reference:** Full inventory of `setInterval` usages and which to convert is in the plan *setInterval Inventory and Task-Conversion Strategy*. Batcher pattern: `packages/typescript/src/utils/prompt-batcher/batcher.ts` (`_ensureAffinityTask`).
