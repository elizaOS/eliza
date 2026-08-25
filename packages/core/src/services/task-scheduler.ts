/**
 * Per-daemon task scheduler: one timer, one getTasks(agentIds) per tick, dispatch to registered runtimes.
 *
 * WHY: With N runtimes, N local timers would do N getTasks() every second. This module batches: one
 * getTasks(agentIds) for all dirty agents, then group by task.agentId and call runTick(tasks) per runtime.
 * Opt-in: host calls startTaskScheduler(adapter); TaskService registers when daemon is present.
 */

import { ElizaError } from "../errors";
import { logger } from "../logger";
import type { IDatabaseAdapter } from "../types/database";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { Task } from "../types/task";

/** Minimal type so we don't import TaskService. WHY: avoids circular dependency (task.ts imports this module). */
interface TaskServiceLike {
	runTick(tasks: Task[]): Promise<void>;
}

interface SchedulerRegistration {
	runtime: IAgentRuntime;
	taskService: TaskServiceLike;
	registrationId: number;
}

// Module state (not exported). WHY: single shared timer and registry for the process.
const registry = new Map<string, SchedulerRegistration>();
/** Agent IDs that need a tick (registered or markTaskSchedulerDirty). Cleared each tick. WHY: only query for agents that care. */
const dirtyAgents = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;
let adapter: IDatabaseAdapter | null = null;
let activeTick: Promise<void> | null = null;
let schedulerGeneration = 0;
let nextRegistrationId = 0;

const TICK_INTERVAL_MS = 1000;

/**
 * One tick: fetch queue tasks for all dirty agents in one call, group by agentId, runTick per runtime.
 * WHY single getTasks(agentIds): one DB round-trip for many agents instead of N round-trips.
 */
function staleGenerationError(
	expectedGeneration: number,
	cause?: unknown,
): ElizaError {
	return new ElizaError("Task scheduler generation changed during a tick", {
		code: "TASK_SCHEDULER_STALE_GENERATION",
		context: {
			expectedGeneration,
			currentGeneration: schedulerGeneration,
		},
		cause,
		severity: "ephemeral",
	});
}

function currentRegistration(
	agentId: string,
	registrationId: number,
	generation: number,
): SchedulerRegistration | undefined {
	if (generation !== schedulerGeneration) return undefined;
	const entry = registry.get(agentId);
	return entry?.registrationId === registrationId ? entry : undefined;
}

async function tick(generation: number): Promise<void> {
	if (generation !== schedulerGeneration) {
		throw staleGenerationError(generation);
	}

	const snapshot = Array.from(dirtyAgents);
	const registrations = new Map<string, number>();
	for (const agentId of snapshot) {
		const entry = registry.get(agentId);
		if (entry) registrations.set(agentId, entry.registrationId);
	}
	dirtyAgents.clear();
	if (registrations.size === 0) return;

	const adp = adapter;
	if (!adp) return;

	const agentIds = Array.from(registrations.keys()) as UUID[];
	let allTasks: Task[];
	try {
		allTasks = await adp.getTasks({
			tags: ["queue"],
			agentIds,
		});
	} catch (cause) {
		if (generation !== schedulerGeneration) {
			throw staleGenerationError(generation, cause);
		}
		// error-policy:J1 The shared query boundary reports a typed failure to
		// every affected runtime and re-arms them.
		const error = new ElizaError("Shared task queue query failed", {
			code: "TASK_SCHEDULER_QUERY_FAILED",
			context: { agentIds },
			cause,
			severity: "ephemeral",
		});
		for (const [aid, registrationId] of registrations) {
			const entry = currentRegistration(aid, registrationId, generation);
			if (!entry) continue;
			dirtyAgents.add(aid);
			entry.runtime.reportError("TaskScheduler.query", error, { agentId: aid });
		}
		throw error;
	}
	if (generation !== schedulerGeneration) {
		throw staleGenerationError(generation);
	}

	// Group by task.agentId so each runtime only receives its own tasks. WHY: runTick expects one agent's tasks.
	const byAgent = new Map<string, Task[]>();
	const staleRegistrations = new Set<string>();
	for (const task of allTasks) {
		const aid = task.agentId != null ? String(task.agentId) : "";
		const registrationId = aid ? registrations.get(aid) : undefined;
		if (!aid || registrationId === undefined) {
			const error = new ElizaError(
				"Task scheduler adapter returned an out-of-scope task",
				{
					code: "TASK_SCHEDULER_SCOPE_VIOLATION",
					context: {
						taskId: task.id,
						returnedAgentId: aid || null,
						queriedAgentIds: agentIds,
					},
					severity: "fatal",
				},
			);
			for (const [queriedAgentId, queriedRegistrationId] of registrations) {
				currentRegistration(
					queriedAgentId,
					queriedRegistrationId,
					generation,
				)?.runtime.reportError("TaskScheduler.scope", error, {
					agentId: queriedAgentId,
				});
			}
			continue;
		}
		if (!currentRegistration(aid, registrationId, generation)) {
			if (!staleRegistrations.has(aid)) {
				staleRegistrations.add(aid);
				logger.error(
					{
						err: new ElizaError(
							"Task scheduler registration changed during a tick",
							{
								code: "TASK_SCHEDULER_REGISTRATION_CHANGED",
								context: { agentId: aid, registrationId },
								severity: "ephemeral",
							},
						),
					},
					"[TaskScheduler] rejected tasks for a stale registration",
				);
			}
			continue;
		}
		const list = byAgent.get(aid) ?? [];
		list.push(task);
		byAgent.set(aid, list);
	}

	for (const [agentIdKey, tasks] of byAgent) {
		const registrationId = registrations.get(agentIdKey);
		if (registrationId === undefined) continue;
		const entry = currentRegistration(agentIdKey, registrationId, generation);
		if (!entry) {
			logger.error(
				{
					err: new ElizaError(
						"Task scheduler registration changed before dispatch",
						{
							code: "TASK_SCHEDULER_REGISTRATION_CHANGED",
							context: { agentId: agentIdKey, registrationId },
							severity: "ephemeral",
						},
					),
				},
				"[TaskScheduler] rejected tasks for a stale registration",
			);
			continue;
		}
		try {
			await entry.taskService.runTick(tasks);
		} catch (error) {
			// error-policy:J7 Each runtime tick is isolated and its failure is
			// reported without suppressing other agents.
			entry.runtime.reportError("TaskScheduler.runTick", error, {
				agentId: agentIdKey,
			});
		}
		// Non-empty queue: keep the agent dirty so the next tick re-queries. WHY: repeat tasks and
		// not-yet-due one-shots become due purely by time passing, with no markTaskSchedulerDirty
		// call; only agents whose queue came back empty go quiet until marked dirty again.
		if (currentRegistration(agentIdKey, registrationId, generation)) {
			dirtyAgents.add(agentIdKey);
		}
	}
}

/** WHY: host provides the adapter so the scheduler can call getTasks without going through a specific runtime. */
export function startTaskScheduler(adapterInstance: IDatabaseAdapter): void {
	if (timer && adapter === adapterInstance) return;

	// Replacing a live adapter starts a new scheduler generation. The old query
	// may still settle, but its result cannot cross into this adapter/runtime set.
	schedulerGeneration += 1;
	adapter = adapterInstance;
	activeTick = null;
	if (timer) {
		for (const agentId of registry.keys()) dirtyAgents.add(agentId);
		return;
	}
	timer = setInterval(() => {
		if (activeTick) return;
		// error-policy:J1 The process timer is the outer scheduler boundary; per-agent
		// failures are reported inside tick, while adapter-level failure is logged here.
		const generation = schedulerGeneration;
		const tickPromise = tick(generation)
			.catch((err) => logger.error({ err }, "[TaskScheduler] tick failed"))
			.finally(() => {
				if (activeTick === tickPromise) activeTick = null;
			});
		activeTick = tickPromise;
	}, TICK_INTERVAL_MS) as ReturnType<typeof setInterval>;
}

export function stopTaskScheduler(): void {
	schedulerGeneration += 1;
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	registry.clear();
	dirtyAgents.clear();
	adapter = null;
	// An in-flight adapter call cannot be cancelled. Detach it so a restarted
	// generation is not blocked; its generation fence rejects its eventual result.
	activeTick = null;
}

/** Called by TaskService.startTimer() when getTaskSchedulerAdapter() != null. WHY: runtime opts into shared tick instead of local timer. */
export function registerTaskSchedulerRuntime(
	runtime: IAgentRuntime,
	taskService: TaskServiceLike,
): void {
	const agentIdKey = String(runtime.agentId);
	nextRegistrationId += 1;
	registry.set(agentIdKey, {
		runtime,
		taskService,
		registrationId: nextRegistrationId,
	});
	dirtyAgents.add(agentIdKey);
}

/** Called by TaskService.stop(). WHY: daemon must not call runTick after runtime has stopped. */
export function unregisterTaskSchedulerRuntime(agentId: UUID): void {
	const agentIdKey = String(agentId);
	registry.delete(agentIdKey);
	dirtyAgents.delete(agentIdKey);
}

/** Called by TaskService.markDirty() when daemon is present. WHY: next tick will include this agent in the batched getTasks. */
export function markTaskSchedulerDirty(agentId: UUID): void {
	dirtyAgents.add(String(agentId));
}

/** TaskService uses this to decide: register with daemon vs start local timer. */
export function getTaskSchedulerAdapter(): IDatabaseAdapter | null {
	return adapter;
}
