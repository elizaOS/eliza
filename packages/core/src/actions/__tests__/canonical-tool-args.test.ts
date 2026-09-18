import { describe, expect, it, vi } from "vitest";
import {
	executePlannedToolCall,
	type PlannedToolCall,
} from "../../runtime/execute-planned-tool-call";
import type { Action, IAgentRuntime, Memory } from "../../types";

function makeAction(overrides: Partial<Action>): Action {
	return {
		name: "TEST_ENUM_ACTION",
		description: "Single-enum-parameter test action",
		validate: async () => true,
		handler: async () => ({ success: true }),
		parameters: [
			{
				name: "mode",
				description: "Operating mode",
				required: true,
				schema: {
					type: "string",
					enumValues: ["accept", "decline", "snooze"],
				},
			},
		],
		...overrides,
	};
}

function makeMessage(): Memory {
	return {
		id: "msg-1",
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "test" },
	} as Memory;
}

function makeRuntime(actions: Action[]): IAgentRuntime {
	return {
		actions,
		agentId: "agent-1",
		getService: vi.fn(() => undefined),
		getRoom: vi.fn(async () => null),
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

describe("canonical tool argument boundary", () => {
	it.each(["accept", "decline", "snooze"])(
		"executes the declared enum value %s unchanged",
		async (mode) => {
			const handler = vi.fn<Action["handler"]>(async () => ({ success: true }));
			const result = await executePlannedToolCall(
				makeRuntime([makeAction({ handler })]),
				{ message: makeMessage() },
				{ name: "TEST_ENUM_ACTION", params: { mode } },
			);
			expect(result.success).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
			expect(handler.mock.calls[0]?.[3]?.parameters).toEqual({ mode });
		},
	);

	it.each([
		{ params: { parameters: "accept" } },
		{ params: { parameters: { mode: "accept" } } },
		{ params: { mode: "accept", thought: "approve" } },
		{ params: { mode: "invalid" } },
		{ params: "accept" },
		{ params: '{"mode":"accept"}' },
		{ params: null },
		{ params: ["accept"] },
		{ args: { mode: "accept" } },
		{ arguments: '{"mode":"accept"}' },
		{ params: { mode: "accept" }, args: { mode: "decline" } },
	])(
		"rejects malformed or legacy arguments before effects: %j",
		async (input) => {
			const handler = vi.fn<Action["handler"]>(async () => ({ success: true }));
			const result = await executePlannedToolCall(
				makeRuntime([makeAction({ handler })]),
				{ message: makeMessage() },
				{ name: "TEST_ENUM_ACTION", ...input } as unknown as PlannedToolCall,
			);
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
			expect(handler).not.toHaveBeenCalled();
		},
	);

	it("does not silently rename a model-provided alias", async () => {
		const handler = vi.fn<Action["handler"]>(async () => ({ success: true }));
		const action = makeAction({ handler });
		action.parameters![0].aliases = ["operation"];
		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{ name: action.name, params: { operation: "accept" } },
		);
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("Unexpected argument 'operation'");
		expect(handler).not.toHaveBeenCalled();
	});
});
