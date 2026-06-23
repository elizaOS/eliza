import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger";
import type { IDatabaseAdapter } from "../types/database";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { Task } from "../types/task";
import {
	registerTaskSchedulerRuntime,
	startTaskScheduler,
	stopTaskScheduler,
} from "./task-scheduler.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

function makeRuntime(): IAgentRuntime {
	return { agentId: AGENT_ID } as unknown as IAgentRuntime;
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
		expect(context).toMatchObject({ err: failure });
		expect(message).toContain("tick failed");

		// Scheduling continues: a fresh dirty agent on the next tick still queries.
		expect(getTasksCalls).toBe(1);
		registerTaskSchedulerRuntime(makeRuntime(), taskService);
		await runOneTick();
		expect(getTasksCalls).toBe(2);
		expect(errorSpy).toHaveBeenCalledTimes(2);
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
