/**
 * Regression tests for counterexamples of quint/TaskService.qnt and
 * quint/TaskScheduler.qnt. Real TaskService, real scheduler daemon, real PGlite.
 */
import {
	PGliteClientManager,
	PgliteDatabaseAdapter,
} from "@elizaos/plugin-sql";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { TaskService } from "../src/services/task";
import {
	getTaskSchedulerAdapter,
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

it("stop drains daemon preflight before runtime storage closes", async () => {
	const f = await createTestRuntime({ characterName: "TaskPreflightDrain" });
	const entered = latch(),
		release = latch();
	const service = new TaskService(f.runtime);
	let runs = 0;
	try {
		f.runtime.registerTaskWorker({
			name: "DRAIN_PREFLIGHT",
			shouldRun: async () => {
				entered.resolve();
				await release.promise;
				expect(await f.runtime.getTasks({ tags: ["queue"] })).toHaveLength(1);
				return true;
			},
			execute: async () => {
				runs++;
			},
		});
		await f.runtime.createTask({
			name: "DRAIN_PREFLIGHT",
			tags: ["queue"],
			metadata: {},
		});
		const tick = service.runTick(await f.runtime.getTasks({ tags: ["queue"] }));
		await entered.promise;
		let stopped = false;
		const stopping = service.stop().then(() => {
			stopped = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(stopped).toBe(false);
		release.resolve();
		await Promise.all([tick, stopping]);
		expect(runs).toBe(0);
		expect(await f.runtime.getTasks({ tags: ["queue"] })).toHaveLength(1);
	} finally {
		release.resolve();
		await service.stop();
		await f.cleanup();
	}
});

it("stop drains an admitted by-id read and refuses its late worker", async () => {
	const f = await createTestRuntime({ characterName: "TaskByIdDrain" });
	const entered = latch(),
		release = latch();
	const service = new TaskService(f.runtime);
	let runs = 0;
	try {
		f.runtime.registerTaskWorker({
			name: "DRAIN_READ",
			execute: async () => {
				runs++;
			},
		});
		const id = await f.runtime.createTask({
			name: "DRAIN_READ",
			tags: ["queue"],
			metadata: {},
		});
		const getTask = f.runtime.getTask.bind(f.runtime);
		vi.spyOn(f.runtime, "getTask").mockImplementationOnce(async (taskId) => {
			entered.resolve();
			await release.promise;
			return getTask(taskId);
		});
		const execution = service.executeTaskById(id);
		const outcome = execution.then(
			() => undefined,
			(error: unknown) => error,
		);
		await entered.promise;
		let stopped = false;
		const stopping = service.stop().then(() => {
			stopped = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(stopped).toBe(false);
		release.resolve();
		await stopping;
		expect(await outcome).toMatchObject({ code: "TASK_SERVICE_STOPPED" });
		expect(runs).toBe(0);
		await expect(service.executeTaskById(id)).rejects.toMatchObject({
			code: "TASK_SERVICE_STOPPED",
		});
		expect(await f.runtime.getTask(id)).not.toBeNull();
	} finally {
		release.resolve();
		vi.restoreAllMocks();
		await service.stop();
		await f.cleanup();
	}
});

it("stop drains every overlapping nonblocking owner and blocks an exclusive replacement", async () => {
	const f = await createTestRuntime({ characterName: "TaskOwnerDrain" });
	const entered = [latch(), latch()] as const,
		release = [latch(), latch()] as const;
	const service = new TaskService(f.runtime);
	let runs = 0;
	try {
		f.runtime.registerTaskWorker({
			name: "DRAIN_OVERLAP",
			execute: async () => {
				const index = runs++;
				entered[index]?.resolve();
				await release[index]?.promise;
				return { preserveTask: true };
			},
		});
		const id = await f.runtime.createTask({
			name: "DRAIN_OVERLAP",
			tags: ["queue", "repeat"],
			metadata: { blocking: false, updateInterval: 60000 },
		});
		const first = service.executeTaskById(id);
		await entered[0].promise;
		const second = service.executeTaskById(id);
		await entered[1].promise;
		release[0].resolve();
		await first;
		expect((await service.getTaskStatus(id)).executing).toBe(true);
		await f.runtime.updateTask(id, {
			metadata: { blocking: true, updateInterval: 60000 },
		});
		await service.executeTaskById(id);
		expect(runs).toBe(2);
		let stopped = false;
		const stopping = service.stop().then(() => {
			stopped = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(stopped).toBe(false);
		release[1].resolve();
		await Promise.all([second, stopping]);
		expect((await service.getTaskStatus(id)).executing).toBe(false);
	} finally {
		for (const held of release) held.resolve();
		await service.stop();
		await f.cleanup();
	}
});

it("retirement refuses immediate resume before it changes stored pause state", async () => {
	const f = await createTestRuntime({ characterName: "TaskResumeRetired" });
	const service = new TaskService(f.runtime);
	try {
		const id = await f.runtime.createTask({
			name: "RETIRED_RESUME",
			tags: ["queue"],
			metadata: { paused: true },
		});
		await service.stop();
		await expect(service.resumeTask(id, true)).rejects.toMatchObject({
			code: "TASK_SERVICE_STOPPED",
		});
		expect((await f.runtime.getTask(id))?.metadata?.paused).toBe(true);
		await service.runDueTasks();
		await service.runTick(await f.runtime.getTasks({ tags: ["queue"] }));
	} finally {
		await service.stop();
		await f.cleanup();
	}
});

it("service stop drains a shared query before its runtime storage closes", async () => {
	const f = await createTestRuntime({ characterName: "SchedulerQueryDrain" });
	const entered = latch(),
		release = latch();
	const service = new TaskService(f.runtime);
	let runs = 0,
		queryFinished = false;
	try {
		f.runtime.registerTaskWorker({
			name: "QUERY_DRAIN",
			execute: async () => {
				runs++;
			},
		});
		await f.runtime.createTask({
			name: "QUERY_DRAIN",
			tags: ["queue"],
			metadata: {},
		});
		const getTasks = f.runtime.adapter.getTasks.bind(f.runtime.adapter);
		vi.spyOn(f.runtime.adapter, "getTasks").mockImplementationOnce(
			async (params) => {
				entered.resolve();
				await release.promise;
				const rows = await getTasks(params);
				queryFinished = true;
				return rows;
			},
		);
		startTaskScheduler(f.runtime.adapter);
		service.startTimer();
		await entered.promise;
		let stopped = false;
		const stopping = service.stop().then(() => {
			stopped = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(stopped).toBe(false);
		release.resolve();
		await stopping;
		expect(queryFinished).toBe(true);
		expect(runs).toBe(0);
	} finally {
		release.resolve();
		await service.stop();
		await stopTaskScheduler();
		vi.restoreAllMocks();
		await f.cleanup();
	}
});

it("scheduler stop drains its detached query while a replacement registration runs", async () => {
	const f = await createTestRuntime({
		characterName: "SchedulerRestartQueryDrain",
	});
	const entered = latch(),
		release = latch();
	const service = new TaskService(f.runtime);
	const replacement = new TaskService(f.runtime);
	let runs = 0;
	try {
		f.runtime.registerTaskWorker({
			name: "RESTART_QUERY",
			execute: async () => {
				runs++;
			},
		});
		const id = await f.runtime.createTask({
			name: "RESTART_QUERY",
			tags: ["queue"],
			metadata: {},
		});
		const getTasks = f.runtime.adapter.getTasks.bind(f.runtime.adapter);
		vi.spyOn(f.runtime.adapter, "getTasks").mockImplementationOnce(
			async (params) => {
				entered.resolve();
				await release.promise;
				await getTasks(params);
				throw new Error("Detached query connection reset");
			},
		);
		startTaskScheduler(f.runtime.adapter);
		service.startTimer();
		await entered.promise;
		let drained = false;
		const draining = Promise.resolve(stopTaskScheduler()).then(() => {
			drained = true;
		});
		startTaskScheduler(f.runtime.adapter);
		replacement.startTimer();
		const retired = service.stop();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(drained).toBe(false);
		await expect.poll(() => runs, { timeout: 10000 }).toBe(1);
		release.resolve();
		await Promise.all([draining, retired]);
		expect(await f.runtime.getTask(id)).toBeNull();
		expect(runs).toBe(1);
	} finally {
		release.resolve();
		await Promise.all([service.stop(), replacement.stop()]);
		await stopTaskScheduler();
		vi.restoreAllMocks();
		await f.cleanup();
	}
});

it("runtime close drains its detached adapter query outside the dirty snapshot", async () => {
	const owner = await createTestRuntime({
		characterName: "SchedulerAdapterOwner",
	});
	const consumer = await createTestRuntime({
		characterName: "SchedulerAdapterConsumer",
	});
	const entered = latch(),
		release = latch();
	const service = new TaskService(consumer.runtime);
	let runs = 0,
		closes = 0,
		queryFinished = false;
	let closing: Promise<void> | undefined;
	try {
		consumer.runtime.registerTaskWorker({
			name: "ADAPTER_REPLACEMENT",
			execute: async () => {
				runs++;
			},
		});
		await consumer.runtime.createTask({
			name: "ADAPTER_REPLACEMENT",
			tags: ["queue"],
			metadata: {},
		});
		const getTasks = owner.runtime.adapter.getTasks.bind(owner.runtime.adapter);
		vi.spyOn(owner.runtime.adapter, "getTasks").mockImplementationOnce(
			async (params) => {
				expect(params.agentIds).toEqual([consumer.runtime.agentId]);
				entered.resolve();
				await release.promise;
				const rows = await getTasks(params);
				queryFinished = true;
				return rows;
			},
		);
		const close = owner.runtime.adapter.close.bind(owner.runtime.adapter);
		vi.spyOn(owner.runtime.adapter, "close").mockImplementation(async () => {
			closes++;
			await close();
		});
		startTaskScheduler(owner.runtime.adapter);
		service.startTimer();
		await entered.promise;
		const oldDrain = stopTaskScheduler();
		startTaskScheduler(consumer.runtime.adapter);
		service.startTimer();
		await owner.runtime.stop();
		closing = owner.runtime.close();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(closes).toBe(0);
		await expect.poll(() => runs, { timeout: 10000 }).toBe(1);
		release.resolve();
		await Promise.all([closing, oldDrain]);
		expect(queryFinished).toBe(true);
		expect(closes).toBe(1);
		expect(getTaskSchedulerAdapter()).toBe(consumer.runtime.adapter);
	} finally {
		release.resolve();
		await closing;
		await service.stop();
		await stopTaskScheduler();
		vi.restoreAllMocks();
		await Promise.all([owner.cleanup(), consumer.cleanup()]);
	}
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

it("rechecks a peer registration after another agent awaits inside a shared batch", async () => {
	const manager = new PGliteClientManager({ dataDir: "memory://" });
	const create = (characterName: string) =>
		createTestRuntime({
			characterName,
			configureRuntime: async (runtime) => {
				const adapter = new PgliteDatabaseAdapter(runtime.agentId, manager);
				await adapter.initialize();
				runtime.registerDatabaseAdapter(adapter);
			},
		});
	const first = await create("Shared batch first agent");
	const entered = latch(),
		release = latch();
	let second: Awaited<ReturnType<typeof createTestRuntime>> | undefined;
	const services = [new TaskService(first.runtime)];
	const workerCalls: string[] = [];
	try {
		second = await create("Shared batch second agent");
		services.push(new TaskService(second.runtime));
		const runtimes = [first.runtime, second.runtime];
		expect(first.runtime.agentId).not.toBe(second.runtime.agentId);
		const ids = await Promise.all(
			runtimes.map(async (runtime) => {
				runtime.registerTaskWorker({
					name: "SHARED_BATCH_OWNERSHIP",
					execute: async () => {
						workerCalls.push(runtime.agentId);
						if (workerCalls.length === 1) {
							entered.resolve();
							await release.promise;
						}
					},
				});
				return runtime.createTask({
					name: "SHARED_BATCH_OWNERSHIP",
					tags: ["queue"],
					metadata: { blocking: true },
				});
			}),
		);
		const queries = vi.spyOn(first.runtime.adapter, "getTasks");
		const oldDispatches = services.map((service) =>
			vi.spyOn(service, "runTick"),
		);
		startTaskScheduler(first.runtime.adapter);
		for (const service of services) service.startTimer();
		await entered.promise;
		expect(queries).toHaveBeenCalledTimes(1);
		expect(new Set(queries.mock.calls[0][0].agentIds)).toEqual(
			new Set(runtimes.map((runtime) => runtime.agentId)),
		);
		// The database owns row order. The held worker identifies the first
		// dispatch, so the test changes whichever registration is still queued.
		const peer = workerCalls[0] === first.runtime.agentId ? 1 : 0;
		const oldPeer = services[peer];
		const replacement = new TaskService(runtimes[peer]);
		services.push(replacement);
		const queriesAtDispatch: number[] = [];
		const runTick = replacement.runTick.bind(replacement);
		vi.spyOn(replacement, "runTick").mockImplementation(async (tasks) => {
			queriesAtDispatch.push(queries.mock.calls.length);
			await runTick(tasks);
		});
		replacement.startTimer();
		await oldPeer.stop();
		expect(oldDispatches[peer]).not.toHaveBeenCalled();
		expect(queriesAtDispatch).toEqual([]);
		release.resolve();
		await expect
			.poll(
				async () =>
					Promise.all(runtimes.map((runtime, i) => runtime.getTask(ids[i]))),
				{ timeout: 10_000 },
			)
			.toEqual([null, null]);
		expect(oldDispatches[peer]).not.toHaveBeenCalled();
		expect(queriesAtDispatch).toHaveLength(1);
		expect(queriesAtDispatch[0]).toBeGreaterThan(1);
		expect(workerCalls).toEqual([
			runtimes[1 - peer].agentId,
			runtimes[peer].agentId,
		]);
	} finally {
		release.resolve();
		await Promise.all(services.map((service) => service.stop()));
		await stopTaskScheduler();
		vi.restoreAllMocks();
		await Promise.all([first.cleanup(), second?.cleanup()]);
	}
}, 120_000);
