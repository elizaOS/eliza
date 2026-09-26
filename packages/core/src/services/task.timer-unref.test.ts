/**
 * The task tick loops are background optimizers: they must not keep a host
 * process alive. Every other runtime interval unrefs its handle
 * (`utils/deadline.ts`, `inference-priority-gate`, `memory-watchdog`,
 * `boot-telemetry`), so an embedded runtime (CLI command, one-shot job, test)
 * can exit once its own work is done. These cases pin both loops to that
 * contract through their real entry points.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IDatabaseAdapter } from "../types/database.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import { TaskService, type TaskServiceClock } from "./task.ts";
import { startTaskScheduler, stopTaskScheduler } from "./task-scheduler.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";

function stubRuntime(): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		serverless: false,
		reportError: vi.fn(),
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

afterEach(() => {
	stopTaskScheduler();
	vi.restoreAllMocks();
});

describe("task tick timers", () => {
	it("unrefs the TaskService tick handle it starts", () => {
		const unref = vi.fn();
		const clock: TaskServiceClock = {
			now: () => 0,
			setInterval: () => ({ unref }),
			clearInterval: () => undefined,
		};

		const service = new TaskService(stubRuntime(), clock);
		service.startTimer();

		expect(unref).toHaveBeenCalledTimes(1);
	});

	it("unrefs the shared task-scheduler process timer", () => {
		const unref = vi.fn();
		const setIntervalSpy = vi
			.spyOn(globalThis, "setInterval")
			.mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);

		startTaskScheduler({} as IDatabaseAdapter);

		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(unref).toHaveBeenCalledTimes(1);
	});
});
