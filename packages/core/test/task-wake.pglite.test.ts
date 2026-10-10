/** Real SQL task metadata and virtual existing core clock; no model calls. */
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { TaskService } from "../src/services/task";

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
				setInterval: () => {
					throw Error("No new clock");
				},
				clearInterval: () => {},
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
			setInterval: () => {
				throw Error("No new clock");
			},
			clearInterval: () => {},
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
			setInterval: () => {
				throw Error("No new clock");
			},
			clearInterval: () => {},
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
			setInterval: () => {
				throw Error("No new clock");
			},
			clearInterval: () => {},
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

it("existing local poll refreshes committed wake metadata without a second timer", async () => {
	const f = await createTestRuntime({ characterName: "WakePoll" });
	let now = T,
		runs = 0;
	let poll: () => Promise<void> = async () => {
		throw Error("Timer callback not registered");
	};
	let timers = 0;
	const service = new TaskService(f.runtime, {
		now: () => now,
		setInterval: (callback, interval) => {
			timers++;
			expect(interval).toBe(1000);
			poll = callback;
			return "clock";
		},
		clearInterval: () => {},
	});
	try {
		Object.defineProperty(f.runtime, "serverless", {
			value: false,
			configurable: true,
		});
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
		service.startTimer();
		await poll();
		expect(runs).toBe(0);
		await f.runtime.patchTaskMetadata(id, { wake: { requestAt: T + 1000 } });
		now = T + 999;
		await poll();
		expect(runs).toBe(0);
		now++;
		await poll();
		expect(runs).toBe(1);
		expect(timers).toBe(1);
	} finally {
		await service.stop();
		await f.cleanup();
	}
});
