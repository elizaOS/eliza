/** Real SQL task metadata and virtual existing core clock; no model calls. */
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { TaskService } from "../src/services/task";
import { ServiceType } from "../src/types/service";

const T = 1_800_000_000_000;
const latch = () => {
	let resolve!: () => void;
	return {
		promise: new Promise<void>((r) => {
			resolve = r;
		}),
		resolve: () => resolve(),
	};
};
it("atomic requests keep earliest deadline and increasing revision under either ordering", async () => {
	const f = await createTestRuntime({ characterName: "AtomicWake" });
	try {
		for (const order of [
			[T + 2000, T + 1000],
			[T + 1000, T + 2000],
		]) {
			const id = await f.runtime.createTask({
				name: "WAKE",
				tags: ["queue", "repeat"],
				metadata: { updatedAt: T, updateInterval: 60000 },
			});
			await Promise.all(
				order.map((requestAt) =>
					f.runtime.patchTaskMetadata(id, { wake: { requestAt } }),
				),
			);
			expect((await f.runtime.getTask(id))?.metadata).toMatchObject({
				wakeAt: T + 1000,
				wakeRevision: 2,
			});
			await f.runtime.patchTaskMetadata(id, { wake: { consumeRevision: 1 } });
			expect((await f.runtime.getTask(id))?.metadata?.wakeAt).toBe(T + 1000);
			await f.runtime.patchTaskMetadata(id, {
				wake: { consumeRevision: 2, requestAt: T + 3000 },
			});
			expect((await f.runtime.getTask(id))?.metadata).toMatchObject({
				wakeAt: T + 3000,
				wakeRevision: 3,
			});
		}
	} finally {
		await f.cleanup();
	}
});
for (const requestTime of [T + 1000, T + 500])
	it(`completion keeps concurrent wake ${requestTime - T}ms including equal deadline`, async () => {
		const f = await createTestRuntime({ characterName: "WakeRace" });
		let now = T;
		const entered = latch(),
			finish = latch();
		let runs = 0;
		try {
			f.runtime.registerTaskWorker({
				name: "WAKE_RACE",
				execute: async () => {
					runs++;
					if (runs === 1) {
						entered.resolve();
						await finish.promise;
					}
					return { nextInterval: 60000 };
				},
			});
			const id = await f.runtime.createTask({
				name: "WAKE_RACE",
				tags: ["queue", "repeat"],
				metadata: { updatedAt: T, updateInterval: 60000 },
			});
			await f.runtime.patchTaskMetadata(id, { wake: { requestAt: T + 1000 } });
			const service = new TaskService(f.runtime, {
				now: () => now,
				setTimeout: () => {
					throw Error("No new clock");
				},
				clearTimeout: () => {},
			});
			now = T + 1000;
			const run = service.runTick(
				await f.runtime.getTasks({
					tags: ["queue"],
					agentIds: [f.runtime.agentId],
				}),
			);
			await entered.promise;
			await f.runtime.patchTaskMetadata(id, {
				wake: { requestAt: requestTime },
			});
			finish.resolve();
			await run;
			expect((await f.runtime.getTask(id))?.metadata).toMatchObject({
				wakeAt: requestTime,
				wakeRevision: 2,
			});
			now++;
			await service.runTick(
				await f.runtime.getTasks({
					tags: ["queue"],
					agentIds: [f.runtime.agentId],
				}),
			);
			expect(runs).toBe(2);
			expect((await f.runtime.getTask(id))?.metadata?.wakeAt).toBeUndefined();
		} finally {
			finish.resolve();
			await f.cleanup();
		}
	});
it("virtual core ticks honor absolute deadline, restart, passed-during-work deadline and base idle cadence", async () => {
	const f = await createTestRuntime({ characterName: "WakeClock" });
	let now = T,
		runs = 0;
	try {
		f.runtime.registerTaskWorker({
			name: "WAKE_CLOCK",
			execute: async () => {
				runs++;
				if (runs === 1) {
					now += 3000;
					return { nextInterval: 60000, nextWakeAt: T + 2000 };
				}
				return { nextInterval: 60000 };
			},
		});
		const id = await f.runtime.createTask({
			name: "WAKE_CLOCK",
			tags: ["queue", "repeat"],
			metadata: { updatedAt: T, updateInterval: 60000 },
		});
		await f.runtime.patchTaskMetadata(id, { wake: { requestAt: T + 1000 } });
		const clock = {
			now: () => now,
			setTimeout: () => {
				throw Error("No new clock");
			},
			clearTimeout: () => {},
		};
		let service = new TaskService(f.runtime, clock);
		const tick = () => service.runDueTasks();
		now = T + 999;
		await tick();
		expect(runs).toBe(0);
		service = new TaskService(f.runtime, clock);
		now = T + 1000;
		await tick();
		expect(runs).toBe(1);
		expect((await f.runtime.getTask(id))?.metadata?.wakeAt).toBe(T + 2000);
		await tick();
		expect(runs).toBe(2);
		for (let i = 0; i < 59; i++) {
			now += 1000;
			await tick();
		}
		expect(runs).toBe(2);
		now += 1000;
		await tick();
		expect(runs).toBe(3);
		expect((await f.runtime.getTask(id))?.metadata?.wakeAt).toBeUndefined();
	} finally {
		await f.cleanup();
	}
});
it("failure backoff and operator pause remain stronger than an overdue wake", async () => {
	const f = await createTestRuntime({ characterName: "WakeFailure" });
	let now = T,
		runs = 0;
	try {
		f.runtime.registerTaskWorker({
			name: "WAKE_FAIL",
			execute: async () => {
				runs++;
				if (runs === 1) throw Error("controlled");
				return { nextInterval: 60000 };
			},
		});
		const id = await f.runtime.createTask({
			name: "WAKE_FAIL",
			tags: ["queue", "repeat"],
			metadata: { updatedAt: T, updateInterval: 60000 },
		});
		await f.runtime.patchTaskMetadata(id, { wake: { requestAt: T + 1000 } });
		const service = new TaskService(f.runtime, {
			now: () => now,
			setTimeout: () => {
				throw Error("No new clock");
			},
			clearTimeout: () => {},
		});
		now = T + 1000;
		await expect(service.runDueTasks()).rejects.toThrow();
		now++;
		await service.runDueTasks();
		expect(runs).toBe(1);
		const task = await f.runtime.getTask(id);
		now =
			Number(task?.metadata?.updatedAt) +
			Number(task?.metadata?.updateInterval);
		await f.runtime.patchTaskMetadata(id, { set: { paused: true } });
		await service.runDueTasks();
		expect(runs).toBe(1);
		await f.runtime.patchTaskMetadata(id, { set: { paused: false } });
		await service.runDueTasks();
		expect(runs).toBe(2);
		expect((await f.runtime.getTask(id))?.metadata?.wakeAt).toBeUndefined();
	} finally {
		await f.cleanup();
	}
});
it("stale whole metadata replacement preserves wake; unsupported adapters refuse extension and invalid writes fail", async () => {
	const f = await createTestRuntime({ characterName: "WakeCompatibility" });
	try {
		const id = await f.runtime.createTask({
			name: "WAKE",
			tags: ["queue", "repeat"],
			metadata: { updatedAt: T, updateInterval: 60000 },
		});
		const stale = await f.runtime.getTask(id);
		await f.runtime.patchTaskMetadata(id, { wake: { requestAt: T + 1000 } });
		await f.runtime.updateTask(id, {
			metadata: { ...stale?.metadata, paused: true },
		});
		expect((await f.runtime.getTask(id))?.metadata).toMatchObject({
			wakeAt: T + 1000,
			wakeRevision: 1,
			paused: true,
		});
		await expect(
			f.runtime.patchTaskMetadata(id, { wake: { requestAt: NaN } }),
		).rejects.toThrow();
		await expect(
			f.runtime.patchTaskMetadata(id, { set: { wakeAt: T } }),
		).rejects.toThrow();
		Object.defineProperty(f.runtime.adapter, "supportsAtomicTaskWake", {
			value: false,
			configurable: true,
		});
		expect(
			await f.runtime.patchTaskMetadata(id, { wake: { requestAt: T } }),
		).toBe("unsupported");
		expect((await f.runtime.getTask(id))?.metadata?.wakeRevision).toBe(1);
	} finally {
		await f.cleanup();
	}
});

it("worker mutation cannot acknowledge a concurrent revision it did not start with", async () => {
	const f = await createTestRuntime({ characterName: "WakeMutation" });
	let now = T;
	try {
		let id: Awaited<ReturnType<typeof f.runtime.createTask>>;
		f.runtime.registerTaskWorker({
			name: "MUTATE_WAKE",
			execute: async (_runtime, _options, task) => {
				await f.runtime.patchTaskMetadata(id, {
					wake: { requestAt: T + 1000 },
				});
				task.metadata = { ...task.metadata, wakeRevision: 2 };
				return { nextInterval: 60000 };
			},
		});
		id = await f.runtime.createTask({
			name: "MUTATE_WAKE",
			tags: ["queue", "repeat"],
			metadata: { updatedAt: T, updateInterval: 60000 },
		});
		await f.runtime.patchTaskMetadata(id, { wake: { requestAt: T + 1000 } });
		const service = new TaskService(f.runtime, {
			now: () => now,
			setTimeout: () => {
				throw Error("No new clock");
			},
			clearTimeout: () => {},
		});
		now = T + 1000;
		await service.runDueTasks();
		expect((await f.runtime.getTask(id))?.metadata).toMatchObject({
			wakeAt: T + 1000,
			wakeRevision: 2,
		});
	} finally {
		await f.cleanup();
	}
});

/** One-timer virtual clock; `fire()` jumps to the armed time and runs it. */
const virtualTimer = (start: number) => {
	let pending: { at: number; callback: () => Promise<void> } | null = null;
	let id = 0;
	const state = {
		now: start,
		armedAt: (): number | null => pending?.at ?? null,
		fire: async () => {
			const timer = pending;
			if (!timer) throw Error("No timer armed");
			pending = null;
			state.now = Math.max(state.now, timer.at);
			await timer.callback();
		},
		clock: {
			now: () => state.now,
			setTimeout: (callback: () => Promise<void>, delayMs: number) => {
				pending = { at: state.now + delayMs, callback };
				return ++id;
			},
			clearTimeout: (handle: unknown) => {
				if (handle === id) pending = null;
			},
		},
	};
	return state;
};

/** Route the runtime's task writes (markDirty) to `service`. */
const useTaskService = async (
	f: Awaited<ReturnType<typeof createTestRuntime>>,
	service: TaskService,
) => {
	await f.runtime.getService<TaskService>(ServiceType.TASK)?.stop();
	f.runtime.services.set(ServiceType.TASK, [service]);
	Object.defineProperty(f.runtime, "serverless", {
		value: false,
		configurable: true,
	});
};

it("local timer sleeps until the earliest due task and task writes wake it", async () => {
	const f = await createTestRuntime({ characterName: "WakePoll" });
	const timer = virtualTimer(T);
	const service = new TaskService(f.runtime, timer.clock);
	let runs = 0;
	try {
		await useTaskService(f, service);
		f.runtime.registerTaskWorker({
			name: "POLL_WAKE",
			execute: async () => {
				runs++;
				return { nextInterval: 60000 };
			},
		});
		const id = await f.runtime.createTask({
			name: "POLL_WAKE",
			tags: ["queue", "repeat"],
			metadata: { updatedAt: T, updateInterval: 60000 },
		});
		const getTasks = vi.spyOn(f.runtime, "getTasks");
		service.startTimer();
		expect(timer.armedAt()).toBe(T + 1000);
		await timer.fire();
		expect(runs).toBe(0);
		// Next tick is the task's due time, not one second later.
		expect(timer.armedAt()).toBe(T + 60000);

		// A committed wake is a task write: the timer wakes within one second.
		await f.runtime.patchTaskMetadata(id, { wake: { requestAt: T + 5000 } });
		expect(timer.armedAt()).toBe(T + 2000);
		await timer.fire();
		expect(timer.armedAt()).toBe(T + 5000);
		await timer.fire();
		expect(runs).toBe(1);
		// The run wrote updatedAt; one check later the timer sleeps a full interval.
		expect(timer.armedAt()).toBe(T + 6000);
		await timer.fire();
		expect(timer.armedAt()).toBe(T + 65000);
		// Four queries in 65 simulated seconds; the fixed 1 s poll made 65.
		expect(getTasks).toHaveBeenCalledTimes(4);
	} finally {
		await service.stop();
		await f.cleanup();
	}
});

it("creating a task wakes an idle timer and due tasks that cannot run retry each second", async () => {
	const f = await createTestRuntime({ characterName: "WakeCreate" });
	const timer = virtualTimer(T);
	const service = new TaskService(f.runtime, timer.clock);
	let runs = 0,
		ready = false;
	try {
		await useTaskService(f, service);
		f.runtime.registerTaskWorker({
			name: "ONE_SHOT",
			shouldRun: async () => ready,
			execute: async () => {
				runs++;
				return undefined;
			},
		});
		service.startTimer();
		await timer.fire();
		// Empty queue: no timer until a task write.
		expect(timer.armedAt()).toBeNull();

		const later = await f.runtime.createTask({
			name: "ONE_SHOT",
			tags: ["queue"],
			dueAt: T + 30000,
			metadata: {},
		});
		expect(timer.armedAt()).toBe(timer.now + 1000);
		await timer.fire();
		expect(timer.armedAt()).toBe(T + 30000);

		await f.runtime.createTask({
			name: "ONE_SHOT",
			tags: ["queue"],
			metadata: {},
		});
		expect(timer.armedAt()).toBe(timer.now + 1000);
		await timer.fire();
		// Due but held by shouldRun: the old one-second cadence.
		expect(runs).toBe(0);
		expect(timer.armedAt()).toBe(timer.now + 1000);
		ready = true;
		await timer.fire();
		expect(runs).toBe(1);
		await timer.fire();
		expect(timer.armedAt()).toBe(T + 30000);
		await timer.fire();
		expect(runs).toBe(2);
		expect(await f.runtime.getTask(later)).toBeNull();
	} finally {
		await service.stop();
		await f.cleanup();
	}
});

it("TASK_TICK_MAX_MS caps the sleep and an invalid value fails at start", async () => {
	const f = await createTestRuntime({ characterName: "WakeCap" });
	const timer = virtualTimer(T);
	const service = new TaskService(f.runtime, timer.clock);
	try {
		await useTaskService(f, service);
		f.runtime.registerTaskWorker({
			name: "HOURLY",
			execute: async () => undefined,
		});
		await f.runtime.createTask({
			name: "HOURLY",
			tags: ["queue", "repeat"],
			metadata: { updatedAt: T, updateInterval: 3_600_000 },
		});
		service.startTimer();
		await timer.fire();
		expect(timer.armedAt()).toBe(timer.now + 60000);

		f.runtime.setSetting("TASK_TICK_MAX_MS", "30000");
		service.startTimer();
		await timer.fire();
		expect(timer.armedAt()).toBe(timer.now + 30000);

		f.runtime.setSetting("TASK_TICK_MAX_MS", "10");
		expect(() => service.startTimer()).toThrow(
			expect.objectContaining({ code: "TASK_TICK_MAX_INVALID" }),
		);
	} finally {
		await service.stop();
		await f.cleanup();
	}
});

it("registering a missing worker wakes the timer and resumes an orphan-paused task", async () => {
	const f = await createTestRuntime({ characterName: "WakeWorker" });
	const timer = virtualTimer(T);
	const service = new TaskService(f.runtime, timer.clock);
	let runs = 0;
	try {
		await useTaskService(f, service);
		const id = await f.runtime.createTask({
			name: "LATE_WORKER",
			tags: ["queue", "repeat"],
			metadata: {
				updatedAt: T - 5000,
				updateInterval: 1000,
				paused: true,
				orphanedNoWorker: true,
			},
		});
		service.startTimer();
		await timer.fire();
		// Only a paused task: the timer sleeps to the cap.
		expect(timer.armedAt()).toBe(timer.now + 60000);

		f.runtime.registerTaskWorker({
			name: "LATE_WORKER",
			execute: async () => {
				runs++;
				return undefined;
			},
		});
		expect(timer.armedAt()).toBe(timer.now + 1000);
		await timer.fire();
		expect((await f.runtime.getTask(id))?.metadata?.paused).toBe(false);
		await timer.fire();
		expect(runs).toBe(1);
	} finally {
		await service.stop();
		await f.cleanup();
	}
});

it("a timer that fires during a running tick re-arms after it", async () => {
	const f = await createTestRuntime({ characterName: "WakeBusy" });
	const timer = virtualTimer(T);
	const service = new TaskService(f.runtime, timer.clock);
	try {
		await useTaskService(f, service);
		const gate = latch();
		const entered = latch();
		vi.spyOn(f.runtime, "getTasks").mockImplementationOnce(async () => {
			entered.resolve();
			await gate.promise;
			return [];
		});
		service.startTimer();
		const run = service.runDueTasks();
		await entered.promise;
		await timer.fire();
		expect(timer.armedAt()).toBeNull();
		gate.resolve();
		await run;
		await Promise.resolve();
		expect(timer.armedAt()).toBe(timer.now + 1000);
	} finally {
		await service.stop();
		await f.cleanup();
	}
});

it("a failed queue query retries in one second", async () => {
	const f = await createTestRuntime({ characterName: "WakeFail" });
	const timer = virtualTimer(T);
	const service = new TaskService(f.runtime, timer.clock);
	try {
		await useTaskService(f, service);
		const reportError = vi
			.spyOn(f.runtime, "reportError")
			.mockImplementation(() => undefined);
		vi.spyOn(f.runtime, "getTasks").mockRejectedValueOnce(Error("db busy"));
		service.startTimer();
		await timer.fire();
		expect(reportError).toHaveBeenCalledWith(
			"TaskService.timer",
			expect.objectContaining({ code: "TASK_QUERY_FAILED" }),
			expect.anything(),
		);
		expect(timer.armedAt()).toBe(timer.now + 1000);
	} finally {
		await service.stop();
		await f.cleanup();
	}
});

it("stop clears the timer and later task writes do not re-arm it", async () => {
	const f = await createTestRuntime({ characterName: "WakeStop" });
	const timer = virtualTimer(T);
	const service = new TaskService(f.runtime, timer.clock);
	try {
		await useTaskService(f, service);
		service.startTimer();
		expect(timer.armedAt()).toBe(T + 1000);
		await service.stop();
		expect(timer.armedAt()).toBeNull();
		await f.runtime.createTask({
			name: "AFTER_STOP",
			tags: ["queue"],
			metadata: {},
		});
		expect(timer.armedAt()).toBeNull();
	} finally {
		await f.cleanup();
	}
});

it("the old setInterval clock shape still drives the timer one shot at a time", async () => {
	const f = await createTestRuntime({ characterName: "WakeLegacy" });
	const timer = virtualTimer(T);
	const cleared: unknown[] = [];
	const service = new TaskService(f.runtime, {
		now: timer.clock.now,
		setInterval: timer.clock.setTimeout,
		clearInterval: (handle) => {
			cleared.push(handle);
			timer.clock.clearTimeout(handle);
		},
	});
	let runs = 0;
	try {
		await useTaskService(f, service);
		f.runtime.registerTaskWorker({
			name: "LEGACY",
			execute: async () => {
				runs++;
				return undefined;
			},
		});
		service.startTimer();
		await f.runtime.createTask({
			name: "LEGACY",
			tags: ["queue"],
			metadata: {},
		});
		await timer.fire();
		expect(runs).toBe(1);
		// The interval is cleared when it first fires.
		expect(cleared.length).toBeGreaterThan(0);
	} finally {
		await service.stop();
		await f.cleanup();
	}
});
