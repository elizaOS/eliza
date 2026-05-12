import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	executePlannedToolCall,
	expandEnumShortForm,
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
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

describe("Wave 2-D enum short-form completion", () => {
	beforeEach(() => {
		process.env.ELIZA_SHORT_FORM_ENUMS = "1";
	});
	afterEach(() => {
		delete process.env.ELIZA_SHORT_FORM_ENUMS;
	});

	it("expands { parameters: '<enum>' } into the canonical shape", () => {
		const action = makeAction({});
		const expanded = expandEnumShortForm(action, {
			parameters: "accept",
		});
		// The legacy `parameters` key is dropped after expansion so strict
		// validation doesn't reject it as an unknown field.
		expect(expanded).toEqual({ mode: "accept" });
	});

	it("leaves canonical shape untouched", () => {
		const action = makeAction({});
		const expanded = expandEnumShortForm(action, { mode: "decline" });
		expect(expanded).toEqual({ mode: "decline" });
	});

	it("does nothing when the flag is unset", () => {
		delete process.env.ELIZA_SHORT_FORM_ENUMS;
		const action = makeAction({});
		const expanded = expandEnumShortForm(action, {
			parameters: "accept",
		});
		expect(expanded).toEqual({ parameters: "accept" });
	});

	it("does nothing when the action has multiple parameters", () => {
		const action = makeAction({
			parameters: [
				{
					name: "mode",
					description: "mode",
					required: true,
					schema: { type: "string", enumValues: ["a", "b"] },
				},
				{
					name: "note",
					description: "note",
					required: false,
					schema: { type: "string" },
				},
			],
		});
		const expanded = expandEnumShortForm(action, { parameters: "a" });
		expect(expanded).toEqual({ parameters: "a" });
	});

	it("does nothing when the value isn't a valid enum entry", () => {
		const action = makeAction({});
		const expanded = expandEnumShortForm(action, { parameters: "bogus" });
		expect(expanded).toEqual({ parameters: "bogus" });
	});

	it("expanded short-form passes validation and reaches the handler", async () => {
		const handler = vi.fn(async () => ({ success: true, text: "ok" }));
		const action = makeAction({ handler });
		const runtime = makeRuntime([action]);

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{ name: "TEST_ENUM_ACTION", params: { parameters: "snooze" } },
		);

		expect(result.success).toBe(true);
		expect(handler).toHaveBeenCalledOnce();
		// HandlerOptions.parameters must contain the expanded shape — the
		// dispatcher needs to see `mode` to satisfy strict validation.
		const handlerCall = handler.mock.calls[0];
		const handlerOptions = handlerCall?.[3] as
			| { parameters?: Record<string, unknown> }
			| undefined;
		expect(handlerOptions?.parameters?.mode).toBe("snooze");
	});

	it("strict validation still rejects non-enum values after expansion", async () => {
		const handler = vi.fn();
		const action = makeAction({ handler });
		const runtime = makeRuntime([action]);

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{ name: "TEST_ENUM_ACTION", params: { mode: "bogus_value" } },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("not one of");
		expect(handler).not.toHaveBeenCalled();
	});
});
