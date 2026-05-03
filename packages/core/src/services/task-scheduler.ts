/**
 * Per-daemon task scheduler: one timer, one getTasks(agentIds) per tick, dispatch to registered runtimes.
 *
 * WHY: With N runtimes, N local timers would do N getTasks() every second. This module batches: one
 * getTasks(agentIds) for all dirty agents, then group by task.agentId and call runTick(tasks) per runtime.
 * Opt-in: host calls startTaskScheduler(adapter); TaskService registers when daemon is present.
 */

import type { IDatabaseAdapter } from "../types/database";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { Task } from "../types/task";

/** Minimal type so we don't import TaskService. WHY: avoids circular dependency (task.ts imports this module). */
interface TaskServiceLike {
	runTick(tasks: Task[]): Promise<void>;
}

// Module state (not exported). WHY: single shared timer and registry for the process.
const registry = new Map<
	string,
	{ runtime: IAgentRuntime; taskService: TaskServiceLike }
>();
/** Agent IDs that need a tick (registered or markTaskSchedulerDirty). Cleared each tick. WHY: only query for agents that care. */
const dirtyAgents = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;
let adapter: IDatabaseAdapter | null = null;

const TICK_INTERVAL_MS = 1000;

/**
 * One tick: fetch queue tasks for all dirty agents in one call, group by agentId, runTick per runtime.
 * WHY single getTasks(agentIds): one DB round-trip for many agents instead of N round-trips.
 */
async function tick(): Promise<void> {
	const snapshot = Array.from(dirtyAgents);
	dirtyAgents.clear();
	if (snapshot.length === 0) return;

	const adp = adapter;
	if (!adp) return;

	const agentIds = snapshot as UUID[];
	const allTasks = await adp.getTasks({
		tags: ["queue"],
		agentIds,
	});

	// Group by task.agentId so each runtime only receives its own tasks. WHY: runTick expects one agent's tasks.
	const byAgent = new Map<string, Task[]>();
	for (const task of allTasks) {
		const aid = task.agentId != null ? String(task.agentId) : "";
		if (!aid) continue;
		const list = byAgent.get(aid) ?? [];
		list.push(task);
		byAgent.set(aid, list);
	}

	for (const [agentIdKey, tasks] of byAgent) {
		const entry = registry.get(agentIdKey);
		if (!entry) continue;
		try {
			await entry.taskService.runTick(tasks);
		} catch (_) {
			// WHY: one agent's runTick failure must not break other agents' ticks; errors are logged inside runTick/executeTask.
		}
	}
}

/** WHY: host provides the adapter so the scheduler can call getTasks without going through a specific runtime. */
export function startTaskScheduler(adapterInstance: IDatabaseAdapter): void {
	adapter = adapterInstance;
	if (timer) return;
	timer = setInterval(() => {
		tick().catch(() => {});
	}, TICK_INTERVAL_MS) as ReturnType<typeof setInterval>;
}

export function stopTaskScheduler(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	registry.clear();
	dirtyAgents.clear();
	adapter = null;
}

/** Called by TaskService.startTimer() when getTaskSchedulerAdapter() != null. WHY: runtime opts into shared tick instead of local timer. */
export function registerTaskSchedulerRuntime(
	runtime: IAgentRuntime,
	taskService: TaskServiceLike,
): void {
	const agentIdKey = String(runtime.agentId);
	registry.set(agentIdKey, { runtime, taskService });
	dirtyAgents.add(agentIdKey);
}

/** Called by TaskService.stop(). WHY: daemon must not call runTick after runtime has stopped. */
export function unregisterTaskSchedulerRuntime(agentId: UUID): void {
	registry.delete(String(agentId));
}

/** Called by TaskService.markDirty() when daemon is present. WHY: next tick will include this agent in the batched getTasks. */
export function markTaskSchedulerDirty(agentId: UUID): void {
	dirtyAgents.add(String(agentId));
}

/** TaskService uses this to decide: register with daemon vs start local timer. */
export function getTaskSchedulerAdapter(): IDatabaseAdapter | null {
	return adapter;
}
