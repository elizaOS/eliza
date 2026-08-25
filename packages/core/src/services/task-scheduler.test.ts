/**
 * Unit coverage for the shared task-scheduler tick loop under fake timers:
 * non-overlapping slow ticks, error resilience when getTasks rejects,
 * dirty-agent re-arm/quiet semantics, and unregister-during-tick behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger";
import type { IDatabaseAdapter } from "../types/database";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { Task } from "../types/task";
import {
	markTaskSchedulerDirty,
	registerTaskSchedulerRuntime,
	startTaskScheduler,
	stopTaskScheduler,
	unregisterTaskSchedulerRuntime,
} from "./task-scheduler.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

function makeRuntime(reportError = vi.fn()): IAgentRuntime {
	return { agentId: AGENT_ID, reportError } as unknown as IAgentRuntime;
}

/**
 * Drive a single scheduler tick: advance the fake timer to fire the interval,
 * then let the rejected/resolved tick promise settle on the microtask queue.
 */
async function runOneTick(): Promise<void> {
	await vi.advanceTimersByTimeAsync(1000);
}

describe("task-scheduler", () => {
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		stopTaskScheduler();
		errorSpy.mockRestore();
		vi.useRealTimers();
	});

	it("logs the error and keeps ticking when getTasks rejects", async () => {
		const failure = new Error("db outage");
		let getTasksCalls = 0;
		const adapter = {
			getTasks: vi.fn(async () => {
				getTasksCalls += 1;
				throw failure;
			}),
		} as unknown as IDatabaseAdapter;

		startTaskScheduler(adapter);
		const taskService = { runTick: vi.fn(async () => undefined) };
		registerTaskSchedulerRuntime(makeRuntime(), taskService);

		await runOneTick();

		// The rejection is surfaced through the structured logger, not swallowed.
		expect(errorSpy).toHaveBeenCalledTimes(1);
		const [context, message] = errorSpy.mock.calls[0];
		expect(context).toMatchObject({
			err: { code: "TASK_SCHEDULER_QUERY_FAILED", cause: failure },
		});
		expect(message).toContain("tick failed");

		// Scheduling continues: a fresh dirty agent on the next tick still queries.
		expect(getTasksCalls).toBe(1);
		registerTaskSchedulerRuntime(makeRuntime(), taskService);
		await runOneTick();
		expect(getTasksCalls).toBe(2);
		expect(errorSpy).toHaveBeenCalledTimes(2);
	});

	it("does not start another shared tick while a slow tick is active", async () => {
		let releaseFirstQuery: ((tasks: Task[]) => void) | undefined;
		const firstQuery = new Promise<Task[]>((resolve) => {
			releaseFirstQuery = resolve;
		});
		const getTasks = vi
			.fn<() => Promise<Task[]>>()
			.mockReturnValueOnce(firstQuery)
			.mockResolvedValue([]);

		startTaskScheduler({ getTasks } as unknown as IDatabaseAdapter);
		registerTaskSchedulerRuntime(makeRuntime(), {
			runTick: vi.fn(async () => undefined),
		});

		await runOneTick();
		expect(getTasks).toHaveBeenCalledTimes(1);

		// A second interval fires before the first query settles. It must not
		// snapshot or dispatch the same dirty-agent batch concurrently.
		await runOneTick();
		expect(getTasks).toHaveBeenCalledTimes(1);

		releaseFirstQuery?.([]);
		await vi.advanceTimersByTimeAsync(0);
		markTaskSchedulerDirty(AGENT_ID);
		await runOneTick();
		expect(getTasks).toHaveBeenCalledTimes(2);
	});

	it("rejects an old query result after the scheduler is restarted", async () => {
		let releaseOldQuery: ((tasks: Task[]) => void) | undefined;
		const oldQuery = new Promise<Task[]>((resolve) => {
			releaseOldQuery = resolve;
		});
		const oldGetTasks = vi.fn(() => oldQuery);
		const oldRunTick = vi.fn(async () => undefined);

		startTaskScheduler({
			getTasks: oldGetTasks,
		} as unknown as IDatabaseAdapter);
		registerTaskSchedulerRuntime(makeRuntime(), { runTick: oldRunTick });
		await runOneTick();
		expect(oldGetTasks).toHaveBeenCalledTimes(1);

		stopTaskScheduler();

		const newGetTasks = vi.fn(async () => [] as Task[]);
		const newRunTick = vi.fn(async () => undefined);
		startTaskScheduler({
			getTasks: newGetTasks,
		} as unknown as IDatabaseAdapter);
		registerTaskSchedulerRuntime(makeRuntime(), { runTick: newRunTick });

		// The unresolved old query must not block the restarted generation.
		await runOneTick();
		expect(newGetTasks).toHaveBeenCalledTimes(1);

		releaseOldQuery?.([{ id: "old", agentId: AGENT_ID } as Task]);
		await vi.advanceTimersByTimeAsync(0);

		expect(oldRunTick).not.toHaveBeenCalled();
		expect(newRunTick).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				err: expect.objectContaining({
					code: "TASK_SCHEDULER_STALE_GENERATION",
				}),
			}),
			"[TaskScheduler] tick failed",
		);
	});

	it("re-queries registered agents when a live adapter is replaced", async () => {
		let releaseOldQuery: ((tasks: Task[]) => void) | undefined;
		const oldQuery = new Promise<Task[]>((resolve) => {
			releaseOldQuery = resolve;
		});
		const oldGetTasks = vi.fn(() => oldQuery);
		const runTick = vi.fn(async () => undefined);

		startTaskScheduler({
			getTasks: oldGetTasks,
		} as unknown as IDatabaseAdapter);
		registerTaskSchedulerRuntime(makeRuntime(), { runTick });
		await runOneTick();

		const newGetTasks = vi.fn(async () => [] as Task[]);
		startTaskScheduler({
			getTasks: newGetTasks,
		} as unknown as IDatabaseAdapter);
		await runOneTick();
		expect(newGetTasks).toHaveBeenCalledTimes(1);

		releaseOldQuery?.([{ id: "old", agentId: AGENT_ID } as Task]);
		await vi.advanceTimersByTimeAsync(0);
		expect(runTick).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				err: expect.objectContaining({
					code: "TASK_SCHEDULER_STALE_GENERATION",
				}),
			}),
			"[TaskScheduler] tick failed",
		);
	});

	it("rejects query rows for a replaced registration with the same agent id", async () => {
		let releaseQuery: ((tasks: Task[]) => void) | undefined;
		const pendingQuery = new Promise<Task[]>((resolve) => {
			releaseQuery = resolve;
		});
		const getTasks = vi
			.fn<() => Promise<Task[]>>()
			.mockReturnValueOnce(pendingQuery)
			.mockResolvedValue([]);

		startTaskScheduler({ getTasks } as unknown as IDatabaseAdapter);
		const oldRunTick = vi.fn(async () => undefined);
		registerTaskSchedulerRuntime(makeRuntime(), { runTick: oldRunTick });
		await runOneTick();

		unregisterTaskSchedulerRuntime(AGENT_ID);
		const replacementRunTick = vi.fn(async () => undefined);
		registerTaskSchedulerRuntime(makeRuntime(), {
			runTick: replacementRunTick,
		});
		releaseQuery?.([{ id: "old", agentId: AGENT_ID } as Task]);
		await vi.advanceTimersByTimeAsync(0);

		expect(oldRunTick).not.toHaveBeenCalled();
		expect(replacementRunTick).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				err: expect.objectContaining({
					code: "TASK_SCHEDULER_REGISTRATION_CHANGED",
				}),
			}),
			"[TaskScheduler] rejected tasks for a stale registration",
		);

		// The replacement registration remains dirty and is queried normally.
		await runOneTick();
		expect(getTasks).toHaveBeenCalledTimes(2);
	});

	it("re-arms a still-registered agent after a transient getTasks rejection (no re-register)", async () => {
		let getTasksCalls = 0;
		const adapter = {
			getTasks: vi.fn(async () => {
				getTasksCalls += 1;
				if (getTasksCalls === 1) throw new Error("db outage");
				return [] as Task[];
			}),
		} as unknown as IDatabaseAdapter;

		startTaskScheduler(adapter);
		registerTaskSchedulerRuntime(makeRuntime(), {
			runTick: vi.fn(async () => undefined),
		});

		await runOneTick();
		expect(getTasksCalls).toBe(1);

		// No re-register: a transient rejection must re-arm the still-registered
		// agent so the next tick queries again. Without the re-arm the agent is
		// drained on the failing tick and stays silent forever (getTasksCalls stuck at 1).
		await runOneTick();
		expect(getTasksCalls).toBe(2);
	});

	it("keeps re-querying while an agent's queue is non-empty and goes quiet when it empties", async () => {
		const task = { id: "t1", agentId: AGENT_ID } as unknown as Task;
		const queues: Task[][] = [[task], [task], []];
		const getTasks = vi.fn(async () => queues.shift() ?? []);
		startTaskScheduler({ getTasks } as unknown as IDatabaseAdapter);
		const runTick = vi.fn(async () => undefined);
		registerTaskSchedulerRuntime(makeRuntime(), { runTick });

		// Tick 1: initial registration marked the agent dirty.
		await runOneTick();
		expect(getTasks).toHaveBeenCalledTimes(1);
		expect(runTick).toHaveBeenCalledTimes(1);

		// Tick 2: nothing called markTaskSchedulerDirty, but the queue was
		// non-empty — repeat tasks become due purely by time passing, so the
		// scheduler must re-query on its own.
		await runOneTick();
		expect(getTasks).toHaveBeenCalledTimes(2);
		expect(runTick).toHaveBeenCalledTimes(2);

		// Tick 3: queue drains to empty — the agent goes quiet after this query.
		await runOneTick();
		expect(getTasks).toHaveBeenCalledTimes(3);
		expect(runTick).toHaveBeenCalledTimes(2);

		// Tick 4: quiet — no query until something marks the agent dirty again.
		await runOneTick();
		expect(getTasks).toHaveBeenCalledTimes(3);

		// markTaskSchedulerDirty (runtime.createTask path) wakes the agent up.
		markTaskSchedulerDirty(AGENT_ID);
		await runOneTick();
		expect(getTasks).toHaveBeenCalledTimes(4);
	});

	it("does not re-arm an agent that unregistered during its own runTick", async () => {
		const task = { id: "t1", agentId: AGENT_ID } as unknown as Task;
		const getTasks = vi.fn(async () => [task]);
		startTaskScheduler({ getTasks } as unknown as IDatabaseAdapter);
		const runTick = vi.fn(async () => {
			// Simulates TaskService.stop() racing the shared tick.
			unregisterTaskSchedulerRuntime(AGENT_ID);
		});
		registerTaskSchedulerRuntime(makeRuntime(), { runTick });

		await runOneTick();
		expect(runTick).toHaveBeenCalledTimes(1);

		await runOneTick();
		expect(getTasks).toHaveBeenCalledTimes(1);
		expect(runTick).toHaveBeenCalledTimes(1);
	});

	it("reports and rejects adapter rows outside the queried tenant scope", async () => {
		const reportError = vi.fn();
		const rogue = {
			id: "rogue",
			agentId: "00000000-0000-0000-0000-0000000000ff" as UUID,
		} as Task;
		const getTasks = vi.fn(async () => [rogue]);
		startTaskScheduler({ getTasks } as unknown as IDatabaseAdapter);
		const runTick = vi.fn(async () => undefined);
		registerTaskSchedulerRuntime(makeRuntime(reportError), { runTick });

		await runOneTick();

		expect(runTick).not.toHaveBeenCalled();
		expect(reportError).toHaveBeenCalledWith(
			"TaskScheduler.scope",
			expect.objectContaining({ code: "TASK_SCHEDULER_SCOPE_VIOLATION" }),
			{ agentId: AGENT_ID },
		);
	});

	it("reports runTick failures through the owning runtime", async () => {
		const reportError = vi.fn();
		const task = { id: "t1", agentId: AGENT_ID } as unknown as Task;
		startTaskScheduler({
			getTasks: vi.fn(async () => [task]),
		} as unknown as IDatabaseAdapter);
		const failure = new Error("tick exploded");
		registerTaskSchedulerRuntime(makeRuntime(reportError), {
			runTick: vi.fn(async () => {
				throw failure;
			}),
		});

		await runOneTick();
		expect(reportError).toHaveBeenCalledWith("TaskScheduler.runTick", failure, {
			agentId: AGENT_ID,
		});
	});

	it("does not log when getTasks succeeds", async () => {
		const task = { id: "t1", agentId: AGENT_ID } as unknown as Task;
		const adapter = {
			getTasks: vi.fn(async () => [task]),
		} as unknown as IDatabaseAdapter;

		startTaskScheduler(adapter);
		const runTick = vi.fn(async () => undefined);
		registerTaskSchedulerRuntime(makeRuntime(), { runTick });

		await runOneTick();

		expect(runTick).toHaveBeenCalledTimes(1);
		expect(runTick).toHaveBeenCalledWith([task]);
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
