/** Real SQL task storage with a virtual timer; no model calls. */
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
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

it("a host wake during a timer tick does not run a due one-shot task twice", async () => {
	const f = await createTestRuntime({ characterName: "OneShotOverlap" });
	const entered = latch(),
		finish = latch();
	let runs = 0;
	let tickCallback: (() => Promise<void>) | undefined;
	const service = new TaskService(f.runtime, {
		now: () => Date.now(),
		setInterval: (callback) => {
			tickCallback = callback;
			return 1;
		},
		clearInterval: () => {},
	});
	try {
		f.runtime.registerTaskWorker({
			name: "SEND_REMINDER",
			execute: async () => {
				runs++;
				entered.resolve();
				await finish.promise;
				return undefined;
			},
		});
		const id = await f.runtime.createTask({
			name: "SEND_REMINDER",
			tags: ["queue"],
			metadata: {},
		});
		service.startTimer();
		if (!tickCallback) throw new Error("timer was not scheduled");

		const timerTick = tickCallback();
		await entered.promise;
		const wake = service.runDueTasks();
		finish.resolve();
		await Promise.all([timerTick, wake]);

		expect(runs).toBe(1);
		expect(await f.runtime.getTask(id)).toBeNull();
	} finally {
		finish.resolve();
		await service.stop();
		await f.cleanup();
	}
});

it("stopping an old service keeps its replacement's real queued tasks running", async () => {
	const f = await createTestRuntime({ characterName: "SchedulerReplacement" });
	const old = new TaskService(f.runtime);
	const replacement = new TaskService(f.runtime);
	let runs = 0;
	try {
		startTaskScheduler(f.runtime.adapter);
		old.startTimer();
		replacement.startTimer();
		await old.stop();
		f.runtime.registerTaskWorker({
			name: "REPLACEMENT_REMINDER",
			execute: async () => {
				runs++;
			},
		});
		const id = await f.runtime.createTask({
			name: "REPLACEMENT_REMINDER",
			tags: ["queue"],
			metadata: {},
		});
		await expect
			.poll(() => f.runtime.getTask(id), { timeout: 4_000 })
			.toBeNull();
		expect(runs).toBe(1);
		await replacement.stop();
		const stopped = await f.runtime.createTask({
			name: "REPLACEMENT_REMINDER",
			tags: ["queue"],
			metadata: {},
		});
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(runs).toBe(1);
		expect(await f.runtime.getTask(stopped)).not.toBeNull();
	} finally {
		await old.stop();
		await replacement.stop();
		stopTaskScheduler();
		await f.cleanup();
	}
});
