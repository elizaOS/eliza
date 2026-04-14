import { describe, expect, it, vi } from "vitest";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import { TaskDrain } from "../utils/batch-queue/task-drain";

describe("TaskDrain", () => {
	it("creates task when none exists", async () => {
		const createTask = vi.fn().mockResolvedValue("task-id-1" as UUID);
		const getTasksByName = vi.fn().mockResolvedValue([]);
		const registerTaskWorker = vi.fn();
		const runtime = {
			agentId: "agent-1",
			getTasksByName,
			createTask,
			registerTaskWorker,
		} as unknown as IAgentRuntime;

		const drain = new TaskDrain(
			{
				taskName: "TEST_DRAIN",
				intervalMs: 500,
				onDrain: async () => {},
			},
			500,
		);
		await drain.start(runtime);

		expect(registerTaskWorker).toHaveBeenCalledWith(
			expect.objectContaining({ name: "TEST_DRAIN" }),
		);
		expect(createTask).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "TEST_DRAIN",
				tags: ["queue", "repeat"],
				metadata: expect.objectContaining({
					updateInterval: 500,
					maxFailures: -1,
				}),
			}),
		);
		expect(drain.id).toBe("task-id-1");
	});

	it("skipRegisterWorker does not register worker", async () => {
		const createTask = vi.fn().mockResolvedValue("t2" as UUID);
		const getTasksByName = vi.fn().mockResolvedValue([]);
		const registerTaskWorker = vi.fn();
		const runtime = {
			agentId: "agent-1",
			getTasksByName,
			createTask,
			registerTaskWorker,
		} as unknown as IAgentRuntime;

		const drain = new TaskDrain({
			taskName: "BATCHER_DRAIN",
			intervalMs: 1000,
			taskMetadata: { affinityKey: "room:x" },
			skipRegisterWorker: true,
		});
		await drain.start(runtime);

		expect(registerTaskWorker).not.toHaveBeenCalled();
		expect(createTask).toHaveBeenCalled();
	});

	it("reconciles interval when matching repeat task already exists", async () => {
		const existing = {
			id: "existing-uuid",
			agentId: "agent-1",
			tags: ["queue", "repeat"],
			metadata: {
				affinityKey: "room:a",
				updateInterval: 5000,
				baseInterval: 5000,
			},
		};
		const getTasksByName = vi.fn().mockResolvedValue([existing]);
		const getTask = vi.fn().mockResolvedValue(existing);
		const updateTask = vi.fn().mockResolvedValue(undefined);
		const createTask = vi.fn();
		const registerTaskWorker = vi.fn();
		const runtime = {
			agentId: "agent-1",
			getTasksByName,
			createTask,
			getTask,
			updateTask,
			registerTaskWorker,
		} as unknown as IAgentRuntime;

		const drain = new TaskDrain(
			{
				taskName: "BATCHER_DRAIN",
				intervalMs: 250,
				taskMetadata: { affinityKey: "room:a" },
				skipRegisterWorker: true,
			},
			250,
		);
		await drain.start(runtime);

		expect(createTask).not.toHaveBeenCalled();
		expect(getTask).toHaveBeenCalledWith("existing-uuid");
		expect(updateTask).toHaveBeenCalledWith(
			"existing-uuid",
			expect.objectContaining({
				metadata: expect.objectContaining({
					updateInterval: 250,
					baseInterval: 250,
				}),
			}),
		);
	});
});
