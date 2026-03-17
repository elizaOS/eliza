import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	executeTriggerDispatch,
	registerTriggerDispatchWorker,
	TRIGGER_DISPATCH_TASK_NAME,
} from "../services/triggerWorker";
import {
	type IAgentRuntime,
	type Task,
	TRIGGER_SCHEMA_VERSION,
	type TriggerConfig,
	type UUID,
} from "../types";

function buildTrigger(overrides: Partial<TriggerConfig>): TriggerConfig {
	return {
		version: TRIGGER_SCHEMA_VERSION,
		triggerId: "00000000-0000-0000-0000-000000000999" as UUID,
		displayName: "Trigger",
		instructions: "Run autonomous task",
		triggerType: "interval",
		enabled: true,
		wakeMode: "inject_now",
		createdBy: "tester",
		runCount: 0,
		intervalMs: 120_000,
		...overrides,
	};
}

function buildTask(trigger: TriggerConfig): Task {
	return {
		id: "00000000-0000-0000-0000-000000000123" as UUID,
		name: TRIGGER_DISPATCH_TASK_NAME,
		description: "Trigger dispatch",
		tags: ["queue", "repeat", "trigger"],
		metadata: {
			updatedAt: Date.now(),
			updateInterval: 120_000,
			trigger,
			triggerRuns: [],
		},
	};
}

describe("triggerWorker", () => {
	let updateTask: ReturnType<typeof vi.fn>;
	let deleteTask: ReturnType<typeof vi.fn>;
	let injectInstruction: ReturnType<typeof vi.fn>;
	let runtime: IAgentRuntime;

	beforeEach(() => {
		updateTask = vi.fn(async () => undefined);
		deleteTask = vi.fn(async () => undefined);
		injectInstruction = vi.fn(async () => undefined);

		const runtimePartial: Partial<IAgentRuntime> = {
			agentId: "00000000-0000-0000-0000-000000000001" as UUID,
			getService: () =>
				({
					injectAutonomousInstruction: injectInstruction,
				}) as {
					injectAutonomousInstruction: (
						params: Record<string, string | UUID>,
					) => Promise<void>;
				},
			updateTask,
			deleteTask,
			logger: {
				info: vi.fn(),
				error: vi.fn(),
			} as IAgentRuntime["logger"],
			getTaskWorker: vi.fn(),
			registerTaskWorker: vi.fn(),
		};

		runtime = runtimePartial as IAgentRuntime;
	});

	test("dispatches interval trigger and persists run metadata", async () => {
		const trigger = buildTrigger({
			triggerType: "interval",
			intervalMs: 300_000,
		});
		const task = buildTask(trigger);

		await executeTriggerDispatch(runtime, task, {
			source: "scheduler",
		});

		expect(injectInstruction).toHaveBeenCalledTimes(1);
		expect(updateTask).toHaveBeenCalledTimes(1);

		const updateArgs = updateTask.mock.calls[0];
		const metadata = updateArgs[1].metadata as Task["metadata"];
		expect(metadata?.trigger?.runCount).toBe(1);
		expect(metadata?.trigger?.lastStatus).toBe("success");
		expect(Array.isArray(metadata?.triggerRuns)).toBe(true);
		expect(metadata?.triggerRuns?.length).toBe(1);
		expect(deleteTask).not.toHaveBeenCalled();
	});

	test("deletes once trigger after execution", async () => {
		const task = buildTask(
			buildTrigger({
				triggerType: "once",
				scheduledAtIso: new Date(Date.now() - 10_000).toISOString(),
			}),
		);

		await executeTriggerDispatch(runtime, task, {
			source: "scheduler",
		});

		expect(deleteTask).toHaveBeenCalledWith(task.id);
		expect(updateTask).not.toHaveBeenCalled();
	});

	test("skips disabled trigger unless forced", async () => {
		const task = buildTask(
			buildTrigger({
				enabled: false,
			}),
		);

		await executeTriggerDispatch(runtime, task, {
			source: "scheduler",
			force: false,
		});
		expect(injectInstruction).not.toHaveBeenCalled();

		await executeTriggerDispatch(runtime, task, {
			source: "manual",
			force: true,
		});
		expect(injectInstruction).toHaveBeenCalledTimes(1);
	});

	test("registers worker only once", () => {
		const getTaskWorker = vi
			.fn()
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce({
				name: TRIGGER_DISPATCH_TASK_NAME,
			});
		const registerTaskWorker = vi.fn();
		const runtimePartial: Partial<IAgentRuntime> = {
			getTaskWorker,
			registerTaskWorker,
		};

		registerTriggerDispatchWorker(runtimePartial as IAgentRuntime);
		registerTriggerDispatchWorker(runtimePartial as IAgentRuntime);

		expect(registerTaskWorker).toHaveBeenCalledTimes(1);
	});
});
