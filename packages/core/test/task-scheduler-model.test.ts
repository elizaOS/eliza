/**
 * Regression tests for counterexamples of quint/TaskService.qnt and
 * quint/TaskScheduler.qnt. Real TaskService, real scheduler daemon, real PGlite.
 */
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { TaskService } from "../src/services/task";
import {
	startTaskScheduler,
	stopTaskScheduler,
} from "../src/services/task-scheduler";

const latch = () => {
	let resolve!: () => void;
	return {
		promise: new Promise<void>((r) => {
			resolve = r;
		}),
		resolve: () => resolve(),
	};
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
	stopTaskScheduler();
});

// TaskService.qnt OneShotAtMostOnce: runDueTasks() during a daemon runTick.
it("a host runDueTasks during a daemon tick does not run a one-shot twice", async () => {
	const f = await createTestRuntime({ characterName: "DaemonOneShot" });
	const entered = latch(),
		finish = latch();
	let runs = 0;
	const service = new TaskService(f.runtime);
	try {
		f.runtime.registerTaskWorker({
			name: "DAEMON_ONE_SHOT",
			execute: async () => {
				runs++;
				entered.resolve();
				await finish.promise;
				return undefined;
			},
		});
		startTaskScheduler(f.runtime.adapter);
		service.startTimer();
		const id = await f.runtime.createTask({
			name: "DAEMON_ONE_SHOT",
			tags: ["queue"],
			metadata: {},
		});
		await entered.promise;
		const wake = service.runDueTasks();
		await sleep(50);
		finish.resolve();
		await wake;
		await expect.poll(() => f.runtime.getTask(id)).toBeNull();
		expect(runs).toBe(1);
	} finally {
		finish.resolve();
		await service.stop();
		await f.cleanup();
	}
});

// TaskService.qnt OneShotAtMostOnce (Recheck): a stale snapshot of a one-shot
// that another run executed and deleted does not run it again.
it("a stale snapshot does not rerun a one-shot that already ran", async () => {
	const f = await createTestRuntime({ characterName: "StaleOneShot" });
	const held = latch(),
		release = latch();
	let runs = 0,
		checks = 0;
	const service = new TaskService(f.runtime);
	try {
		f.runtime.registerTaskWorker({
			name: "STALE_ONE_SHOT",
			shouldRun: async () => {
				if (checks++ === 0) {
					held.resolve();
					await release.promise;
				}
				return true;
			},
			execute: async () => {
				runs++;
				return undefined;
			},
		});
		const id = await f.runtime.createTask({
			name: "STALE_ONE_SHOT",
			tags: ["queue"],
			metadata: {},
		});
		const stale = service.runDueTasks();
		await held.promise;
		await service.executeTaskById(id);
		expect(await f.runtime.getTask(id)).toBeNull();
		release.resolve();
		await stale;
		expect(runs).toBe(1);
	} finally {
		release.resolve();
		await service.stop();
		await f.cleanup();
	}
});

// TaskService.qnt OneShotDeletedAfterRun: a failed re-read of a one-shot is a
// failure, not absence; the row stays and a later run executes it.
it("a failed one-shot re-read keeps the task for a later run", async () => {
	const f = await createTestRuntime({ characterName: "RecheckFails" });
	let runs = 0;
	const service = new TaskService(f.runtime);
	try {
		f.runtime.registerTaskWorker({
			name: "RECHECK_ONE_SHOT",
			execute: async () => {
				runs++;
				return undefined;
			},
		});
		const id = await f.runtime.createTask({
			name: "RECHECK_ONE_SHOT",
			tags: ["queue"],
			metadata: {},
		});
		vi.spyOn(f.runtime, "getTask").mockRejectedValueOnce(
			new Error("connection reset"),
		);
		await expect(service.runDueTasks()).rejects.toMatchObject({
			code: "TASK_TICK_FAILED",
		});
		expect(runs).toBe(0);
		expect(await f.runtime.getTask(id)).not.toBeNull();
		await service.runDueTasks();
		expect(runs).toBe(1);
		expect(await f.runtime.getTask(id)).toBeNull();
	} finally {
		vi.restoreAllMocks();
		await service.stop();
		await f.cleanup();
	}
});

// TaskService.qnt BlockingNoOverlap: executeTaskById during a timer tick.
it("executeTaskById does not overlap a blocking repeat task's tick run", async () => {
	const f = await createTestRuntime({ characterName: "BlockingById" });
	const entered = latch(),
		finish = latch();
	let running = 0,
		maxRunning = 0;
	let tickCallback: (() => Promise<void>) | undefined;
	const service = new TaskService(f.runtime, {
		now: () => Date.now(),
		setTimeout: (callback) => {
			tickCallback = callback;
			return 1;
		},
		clearTimeout: () => {},
	});
	try {
		f.runtime.registerTaskWorker({
			name: "BLOCKING_REPEAT",
			execute: async () => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				entered.resolve();
				await finish.promise;
				running--;
				return undefined;
			},
		});
		const id = await f.runtime.createTask({
			name: "BLOCKING_REPEAT",
			tags: ["queue", "repeat"],
			metadata: { updatedAt: Date.now() - 120_000, updateInterval: 60_000 },
		});
		service.startTimer();
		if (!tickCallback) throw new Error("timer was not scheduled");
		const timerTick = tickCallback();
		await entered.promise;
		const byId = service.executeTaskById(id);
		await sleep(50);
		finish.resolve();
		await Promise.all([timerTick, byId]);
		expect(maxRunning).toBe(1);
	} finally {
		finish.resolve();
		await service.stop();
		await f.cleanup();
	}
});

// TaskScheduler.qnt OneRunTickPerService: a restarted scheduler dispatches a
// second runTick while the detached tick's runTick still runs, so the old
// tick later runs a repeat task again from its stale snapshot.
it("a scheduler restart does not dispatch a second runTick to a busy service", async () => {
	const f = await createTestRuntime({ characterName: "SchedulerRestart" });
	const entered = latch(),
		finish = latch();
	const runs = new Map<string, number>();
	let first = true;
	const service = new TaskService(f.runtime);
	try {
		f.runtime.registerTaskWorker({
			name: "RESTART_REPEAT",
			execute: async (_runtime, _options, task) => {
				const id = String(task.id);
				runs.set(id, (runs.get(id) ?? 0) + 1);
				if (first) {
					first = false;
					entered.resolve();
					await finish.promise;
				}
				return undefined;
			},
		});
		const ids = [];
		for (let i = 0; i < 2; i++)
			ids.push(
				await f.runtime.createTask({
					name: "RESTART_REPEAT",
					tags: ["queue", "repeat"],
					metadata: {
						updatedAt: Date.now() - 1_200_000,
						updateInterval: 600_000,
					},
				}),
			);
		startTaskScheduler(f.runtime.adapter);
		service.startTimer();
		await entered.promise;
		// Host restarts the scheduler; the TaskService registers again.
		stopTaskScheduler();
		startTaskScheduler(f.runtime.adapter);
		service.startTimer();
		await sleep(1_500);
		finish.resolve();
		await sleep(2_500);
		expect(ids.map((id) => runs.get(id) ?? 0)).toEqual([1, 1]);
	} finally {
		finish.resolve();
		await service.stop();
		await f.cleanup();
	}
}, 20_000);
