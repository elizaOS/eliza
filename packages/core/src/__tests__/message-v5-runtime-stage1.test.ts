import { describe, expect, it, vi } from "vitest";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

function useModelCalls(runtime: IAgentRuntime): unknown[][] {
	return (runtime.useModel as unknown as { mock: { calls: unknown[][] } }).mock
		.calls;
}

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		roomId: "00000000-0000-0000-0000-000000000004" as UUID,
		content: {
			text: "Can you check my calendar?",
			source: "test",
		},
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: {
			availableContexts: "general, calendar",
		},
		data: {},
		text: "Recent conversation summary",
	};
}

function makeRuntime(responses: unknown[]): IAgentRuntime {
	const queue = [...responses];
	return {
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		character: {
			name: "Test Agent",
			system: "You are concise.",
		},
		actions: [],
		providers: [],
		useModel: vi.fn(async () => {
			if (queue.length === 0) {
				throw new Error("Unexpected useModel call");
			}
			return queue.shift();
		}),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

describe("runV5MessageRuntimeStage1", () => {
	it("returns a simple no-context reply without calling the planner", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				action: "RESPOND",
				simple: true,
				contexts: [],
				thought: "Direct answer.",
				reply: "Hello.",
			}),
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("direct_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(useModelCalls(runtime)[0]?.[0]).toBe(ModelType.RESPONSE_HANDLER);
		if (result.kind === "direct_reply") {
			expect(result.result.responseContent?.text).toBe("Hello.");
			expect(result.result.mode).toBe("simple");
		}
	});

	it("runs planning when contexts are selected even when simple is true", async () => {
		const runtime = makeRuntime([
			JSON.stringify({
				action: "RESPOND",
				simple: true,
				contexts: ["calendar"],
				thought: "Calendar context is needed.",
				reply: "I can check.",
			}),
			JSON.stringify({
				thought: "No tool needed in this fixture.",
				toolCalls: [],
				messageToUser: "Your calendar is clear.",
			}),
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result.kind).toBe("planned_reply");
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		expect(useModelCalls(runtime)[0]?.[0]).toBe(ModelType.RESPONSE_HANDLER);
		expect(useModelCalls(runtime)[1]?.[0]).toBe(ModelType.ACTION_PLANNER);
		expect(useModelCalls(runtime)[1]?.[2]).toBeUndefined();
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toBe(
				"Your calendar is clear.",
			);
		}
	});

	it.each([
		"IGNORE",
		"STOP",
	] as const)("stops immediately for %s", async (action) => {
		const runtime = makeRuntime([
			JSON.stringify({
				action,
				simple: false,
				contexts: [],
				thought: "Terminal decision.",
			}),
		]);

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(result).toMatchObject({
			kind: "terminal",
			action,
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});
});
