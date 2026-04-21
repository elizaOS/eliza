import { describe, expect, it, vi } from "vitest";
import { TaskService } from "../services/task";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { Task, TaskMetadata, TaskWorker } from "../types/task";

function createRuntime(task: Task) {
	const tasks = new Map<string, Task>([[String(task.id), task]]);
	const workers = new Map<string, Pick<TaskWorker, "execute">>();

	const runtime = {
		agentId: "agent-1" as UUID,
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		getTasks: vi.fn(async () => Array.from(tasks.values())),
		getTask: vi.fn(async (id: UUID) => tasks.get(String(id)) ?? null),
		updateTask: vi.fn(async (id: UUID, update: Partial<Task>) => {
			const existing = tasks.get(String(id));
			if (!existing) return;
			tasks.set(String(id), {
				...existing,
				...update,
				id,
			});
		}),
		deleteTask: vi.fn(async (id: UUID) => {
			tasks.delete(String(id));
		}),
		getTaskWorker: vi.fn((name: string) => workers.get(name)),
	} as unknown as IAgentRuntime;

	return {
		runtime,
		tasks,
		registerWorker(name: string, execute: TaskWorker["execute"]) {
			workers.set(name, { execute });
		},
	};
}

describe("TaskService", () => {
	it("preserves metadata written by a repeat worker during execution", async () => {
		const taskId = "task-1" as UUID;
		const task: Task = {
			id: taskId,
			name: "PROACTIVE_AGENT",
			description: "proactive worker",
			agentId: "agent-1" as UUID,
			tags: ["queue", "repeat"],
			metadata: {
				updateInterval: 0,
				baseInterval: 60_000,
				blocking: true,
			} as TaskMetadata,
		};
		const { runtime, tasks, registerWorker } = createRuntime(task);
		registerWorker(
			"PROACTIVE_AGENT",
			vi.fn(async (rt: IAgentRuntime) => {
				await rt.updateTask(taskId, {
					metadata: {
						...(tasks.get(String(taskId))?.metadata as TaskMetadata),
						firedActionsLog: {
							date: "2026-04-19",
							gnFiredAt: 1234,
							nudgedOccurrenceIds: [],
							nudgedCalendarEventIds: [],
							checkedGoalIds: [],
						},
					},
				});
				return { nextInterval: 120_000 };
			}),
		);

		const service = new TaskService(runtime);
		await service.runDueTasks();

		const updated = tasks.get(String(taskId));
		expect(updated?.metadata).toEqual(
			expect.objectContaining({
				updateInterval: 120_000,
				baseInterval: 60_000,
				firedActionsLog: expect.objectContaining({
					gnFiredAt: 1234,
				}),
			}),
		);
	});
});
