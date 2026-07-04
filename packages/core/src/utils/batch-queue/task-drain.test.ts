/**
 * TaskDrain startup reconciliation: dedupes persisted repeat tasks that share a
 * managed drain, reusing and re-intervalling one while deleting the rest instead
 * of creating a new task. Driven against a mock runtime backed by an in-memory
 * task list.
 */
import { describe, expect, test, vi } from "vitest";
import { createMockRuntime } from "../../testing/mock-runtime";
import type { Task } from "../../types/task";
import { TaskDrain } from "./task-drain";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function makeTask(
	id: string,
	metadata: Record<string, unknown>,
): Task & { id: string } {
	return {
		id,
		name: "BATCHER_DRAIN",
		tags: ["queue", "repeat"],
		agentId: AGENT_ID,
		worldId: AGENT_ID,
		metadata,
	} as unknown as Task & { id: string };
}

describe("TaskDrain", () => {
	test("dedupes persisted repeat tasks for the same managed drain", async () => {
		const tasks = [
			makeTask("00000000-0000-0000-0000-000000000011", {
				affinityKey: "autonomy",
				updateInterval: 1000,
				baseInterval: 1000,
			}),
			makeTask("00000000-0000-0000-0000-000000000012", {
				affinityKey: "autonomy",
				updateInterval: 1000,
				baseInterval: 1000,
			}),
			makeTask("00000000-0000-0000-0000-000000000013", {
				affinityKey: "default",
				updateInterval: 1000,
				baseInterval: 1000,
			}),
		];
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getTasksByName: async (name: string) =>
				tasks.filter((task) => task.name === name),
			getTask: async (id: string) =>
				tasks.find((task) => task.id === id) ?? null,
			updateTask: async (
				id: string,
				patch: { metadata?: Record<string, unknown> },
			) => {
				const task = tasks.find((item) => item.id === id);
				if (task) {
					task.metadata = {
						...(task.metadata ?? {}),
						...(patch.metadata ?? {}),
					};
				}
			},
			deleteTask: vi.fn(async (id: string) => {
				const index = tasks.findIndex((task) => task.id === id);
				if (index >= 0) tasks.splice(index, 1);
			}),
			createTask: vi.fn(async () => {
				throw new Error("should reuse an existing managed task");
			}),
		});

		const drain = new TaskDrain(
			{
				taskName: "BATCHER_DRAIN",
				intervalMs: 30_000,
				taskMetadata: { affinityKey: "autonomy" },
				skipRegisterWorker: true,
			},
			30_000,
		);

		await drain.start(runtime);

		expect(runtime.deleteTask).toHaveBeenCalledWith(
			"00000000-0000-0000-0000-000000000012",
		);
		expect(runtime.createTask).not.toHaveBeenCalled();
		expect(tasks.map((task) => task.id)).toEqual([
			"00000000-0000-0000-0000-000000000011",
			"00000000-0000-0000-0000-000000000013",
		]);
		expect(tasks[0]?.metadata).toMatchObject({
			affinityKey: "autonomy",
			updateInterval: 30_000,
			baseInterval: 30_000,
		});
	});
});
