import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../types/runtime.js";
import {
	RuntimeModelDispatch,
	type RuntimeModelDispatchHost,
} from "../model-dispatch.ts";
import {
	DEFAULT_CONTEXT_WINDOW_TOKENS,
	DEFAULT_INPUT_RESERVE_TOKENS,
} from "../model-input-budget.ts";

const dispatcher = new RuntimeModelDispatch(
	{ getSetting: () => "registered-model" } as unknown as IAgentRuntime,
	{} as RuntimeModelDispatchHost,
);
const metadata = {
	displayModel: "registered-model",
	contextWindowTokens: 64_000,
	maxOutputTokens: 24_000,
};

describe("per-call model budget identity", () => {
	it.each([undefined, "registered-model", " registered-model "])(
		"retains registration limits for matching selection %s",
		(model) => {
			expect(
				dispatcher.buildFinalModelInputBudget(
					{ model, prompt: "complete" },
					metadata,
				),
			).toMatchObject({
				contextWindowTokens: 64_000,
				reserveTokens: 24_000,
			});
		},
	);
	it("does not attribute another model's window or output limit to an override", () => {
		const params = {
			model: "other-model",
			messages: [{ role: "user", content: "Original complete input" }],
		};
		const before = structuredClone(params);
		expect(
			dispatcher.buildFinalModelInputBudget(params, metadata),
		).toMatchObject({
			contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
			reserveTokens: DEFAULT_INPUT_RESERVE_TOKENS,
		});
		expect(params).toEqual(before);
	});
	it("retains an explicit caller output reserve even with unknown override capacity", () => {
		expect(
			dispatcher.buildFinalModelInputBudget(
				{ model: "other-model", maxTokens: 30_000 },
				metadata,
			),
		).toMatchObject({
			contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
			reserveTokens: 30_000,
		});
	});
	it("requires a resolved model identity before reusing capacity for an override", () => {
		expect(
			dispatcher.buildFinalModelInputBudget(
				{ model: "registered-model" },
				{ contextWindowTokens: 64_000, maxOutputTokens: 24_000 },
			),
		).toMatchObject({
			contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
			reserveTokens: DEFAULT_INPUT_RESERVE_TOKENS,
		});
		expect(
			dispatcher.buildFinalModelInputBudget(
				{ model: "registered-model" },
				{
					...metadata,
					displayModel: undefined,
					displayModelSetting: "SLOT_MODEL",
				},
			),
		).toMatchObject({
			contextWindowTokens: 64_000,
			reserveTokens: 24_000,
		});
	});
});
