import { afterEach, expect, test, vi } from "vitest";
import {
	registerScheduledProcessTask,
	stopTaskScheduler,
} from "./task-scheduler";

afterEach(() => {
	stopTaskScheduler();
	vi.useRealTimers();
});

test("owned jobs do not overlap and disposal aborts and drains the active run", async () => {
	vi.useFakeTimers();
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let signal: AbortSignal | undefined;
	const run = vi.fn(async (received: AbortSignal) => {
		signal = received;
		await pending;
	});
	const stop = registerScheduledProcessTask("fixture", run);
	try {
		expect(() => registerScheduledProcessTask("fixture", run)).toThrow(
			"already registered",
		);
		await vi.advanceTimersByTimeAsync(3000);
		expect(run).toHaveBeenCalledTimes(1);
		let drained = false;
		const closing = stop().then(() => {
			drained = true;
		});
		expect(signal?.aborted).toBe(true);
		await Promise.resolve();
		expect(drained).toBe(false);
		finish();
		await closing;
		await vi.advanceTimersByTimeAsync(2000);
		expect(run).toHaveBeenCalledTimes(1);
	} finally {
		finish();
		await stop();
	}
});

test("stopping the agent scheduler does not dispose another host's task", async () => {
	vi.useFakeTimers();
	const run = vi.fn(async () => {});
	const stop = registerScheduledProcessTask("fixture", run);
	try {
		stopTaskScheduler();
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).toHaveBeenCalledTimes(1);
	} finally {
		await stop();
	}
});
