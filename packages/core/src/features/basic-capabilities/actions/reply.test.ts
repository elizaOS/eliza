import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "../../../index";
import { ModelType } from "../../../index";
import { replyAction } from "./reply";

function createRuntime(modelResponse: string): IAgentRuntime {
	return {
		agentId: "agent-id",
		character: { templates: {} },
		composeState: vi.fn(async () => ({ values: {}, data: {} }) as State),
		useModel: vi.fn(async (modelType: ModelType) => {
			expect(modelType).toBe(ModelType.TEXT_LARGE);
			return modelResponse;
		}),
	} as unknown as IAgentRuntime;
}

function createMessage(): Memory {
	return {
		id: "message-id",
		agentId: "agent-id",
		entityId: "user-id",
		roomId: "room-id",
		content: { text: "hello" },
	} as unknown as Memory;
}

describe("REPLY action", () => {
	it("falls back to planner text when the reply model returns empty structured text", async () => {
		const runtime = createRuntime("thought: empty\ntext:");
		const callback = vi.fn();

		const result = await replyAction.handler?.(
			runtime,
			createMessage(),
			undefined,
			undefined,
			callback,
			[
				{
					content: { text: "planner already had a reply" },
				} as Memory,
			],
		);

		expect(result?.text).toBe("planner already had a reply");
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ text: "planner already had a reply" }),
		);
	});

	it("falls back to non-structured raw model text", async () => {
		const runtime = createRuntime("plain reply");

		const result = await replyAction.handler?.(
			runtime,
			createMessage(),
			undefined,
		);

		expect(result?.text).toBe("plain reply");
	});
});
