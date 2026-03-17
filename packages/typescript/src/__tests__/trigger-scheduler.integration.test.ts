import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TaskService } from "../services/task";
import {
	registerTriggerDispatchWorker,
	TRIGGER_DISPATCH_TASK_NAME,
} from "../services/triggerWorker";
import {
	type IAgentRuntime,
	type Task,
	type TaskWorker,
	TRIGGER_SCHEMA_VERSION,
	type TriggerConfig,
	type UUID,
} from "../types";

function buildIntervalTrigger(
	overrides?: Partial<TriggerConfig>,
): TriggerConfig {
	return {
		version: TRIGGER_SCHEMA_VERSION,
		triggerId: "00000000-0000-0000-0000-000000000901" as UUID,
		displayName: "Scheduler trigger",
		instructions: "Run scheduled trigger task",
		triggerType: "interval",
		enabled: true,
		wakeMode: "inject_now",
		createdBy: "integration-test",
		runCount: 0,
		intervalMs: 60_000,
		...overrides,
	};
}

function buildTriggerTask(trigger: TriggerConfig): Task {
	return {
		id: "00000000-0000-0000-0000-000000000777" as UUID,
		name: TRIGGER_DISPATCH_TASK_NAME,
		description: "scheduler integration",
		tags: ["queue", "repeat", "trigger"],
		metadata: {
			// Make the first scheduler check execute immediately.
			updatedAt: 0,
			updateInterval: 1_000,
			trigger,
			triggerRuns: [],
		},
	};
}

describe("trigger scheduler integration", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-02-10T10:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("TaskService executes scheduled trigger worker end-to-end", async () => {
		let tasks: Task[] = [buildTriggerTask(buildIntervalTrigger())];
		const workers = new Map<string, TaskWorker>();
		const injectInstruction = vi.fn(
			async (_params: {
				instructions: string;
				source: "trigger_dispatch";
				triggerId: UUID;
				wakeMode: "inject_now" | "next_autonomy_cycle";
				triggerTaskId: UUID;
			}) => undefined,
		);

		const runtimePartial: Partial<IAgentRuntime> = {
			agentId: "00000000-0000-0000-0000-000000000001" as UUID,
			getService: (serviceName: string) => {
				if (serviceName !== "AUTONOMY") return null;
				return {
					injectAutonomousInstruction: injectInstruction,
				} as {
					injectAutonomousInstruction: (params: {
						instructions: string;
						source: "trigger_dispatch";
						triggerId: UUID;
						wakeMode: "inject_now" | "next_autonomy_cycle";
						triggerTaskId: UUID;
					}) => Promise<void>;
				};
			},
			getTaskWorker: (name: string) => workers.get(name),
			registerTaskWorker: (worker: TaskWorker) => {
				workers.set(worker.name, worker);
			},
			getTasks: async (params?: { tags?: string[] }) => {
				if (!params?.tags || params.tags.length === 0) return tasks;
				return tasks.filter((task) =>
					params.tags?.every((tag) => task.tags?.includes(tag)),
				);
			},
			updateTask: async (taskId: UUID, update: Partial<Task>) => {
				tasks = tasks.map((task) => {
					if (task.id !== taskId) return task;
					return {
						...task,
						...update,
						metadata: {
							...(task.metadata ?? {}),
							...(update.metadata ?? {}),
						},
					};
				});
			},
			deleteTask: async (taskId: UUID) => {
				tasks = tasks.filter((task) => task.id !== taskId);
			},
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			} as IAgentRuntime["logger"],
		};
		const runtime = runtimePartial as IAgentRuntime;

		registerTriggerDispatchWorker(runtime);
		const taskService = (await TaskService.start(runtime)) as TaskService;

		try {
			const taskScheduler = taskService as TaskService & {
				checkTasks: () => Promise<void>;
			};
			await taskScheduler.checkTasks();

			expect(injectInstruction).toHaveBeenCalledTimes(1);

			const currentTask = tasks[0];
			expect(currentTask).toBeDefined();
			const trigger = currentTask.metadata?.trigger;
			const runs = currentTask.metadata?.triggerRuns;
			expect(trigger?.runCount).toBe(1);
			expect(trigger?.lastStatus).toBe("success");
			expect(Array.isArray(runs)).toBe(true);
			expect(runs?.length).toBe(1);
		} finally {
			await taskService.stop();
		}
	});
});
