import { describe, expect, it, vi } from "vitest";
import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
} from "../../../types/index.ts";
import { choiceAction } from "./choice.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const ROOM_ID = "00000000-0000-0000-0000-000000000002";
const TASK_ID = "aabbccdd-1111-2222-3333-444455556666";

function createRuntime(executed: { options: unknown | null }): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		getTasks: vi.fn(async () => [
			{
				id: TASK_ID,
				name: "confirm-post",
				metadata: { options: [{ name: "post" }, { name: "cancel" }] },
			},
		]),
		getTaskWorker: vi.fn(() => ({
			name: "confirm-post",
			execute: vi.fn(async (_runtime: unknown, options: unknown) => {
				executed.options = options;
			}),
		})),
		deleteTask: vi.fn(async () => {}),
	} as IAgentRuntime;
}

function createMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000010",
		agentId: AGENT_ID,
		entityId: "00000000-0000-0000-0000-000000000003",
		roomId: ROOM_ID,
		content: { text: "post it", source: "discord" },
	} as Memory;
}

describe("CHOOSE_OPTION action", () => {
	it("accepts the full task UUID as taskId (parameter contract: short or full ID)", async () => {
		const executed = { options: null as unknown | null };
		const runtime = createRuntime(executed);

		const result = await choiceAction.handler?.(
			runtime,
			createMessage(),
			undefined,
			{
				parameters: { taskId: TASK_ID, selectedOption: "post" },
			} as HandlerOptions,
		);

		expect(result?.success).toBe(true);
		expect(result?.values?.selectedOption).toBe("post");
		expect(result?.values?.taskId).toBe(TASK_ID);
		expect(executed.options).toEqual({ option: "post" });
	});

	it("still accepts the 8-char short task id", async () => {
		const executed = { options: null as unknown | null };
		const runtime = createRuntime(executed);

		const result = await choiceAction.handler?.(
			runtime,
			createMessage(),
			undefined,
			{
				parameters: {
					taskId: TASK_ID.substring(0, 8),
					selectedOption: "post",
				},
			} as HandlerOptions,
		);

		expect(result?.success).toBe(true);
		expect(result?.values?.taskId).toBe(TASK_ID);
		expect(executed.options).toEqual({ option: "post" });
	});

	it("rejects an unknown task id", async () => {
		const executed = { options: null as unknown | null };
		const runtime = createRuntime(executed);

		const result = await choiceAction.handler?.(
			runtime,
			createMessage(),
			undefined,
			{
				parameters: {
					taskId: "99999999-9999-9999-9999-999999999999",
					selectedOption: "post",
				},
			} as HandlerOptions,
		);

		expect(result?.success).toBe(false);
		expect(result?.values?.error).toBe("TASK_NOT_FOUND");
		expect(executed.options).toBeNull();
	});
});
