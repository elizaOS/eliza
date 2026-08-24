/**
 * Unit coverage for the `model-input-budget` surface the sibling suites do
 * not touch: the standalone `estimateTokensFromChars` / `estimateModelInputTokens`
 * estimators, `withModelInputBudgetProviderOptions`, the deprecated constant
 * aliases, and `buildModelInputBudget` argument-normalization edges (fractional,
 * zero, negative, and NaN windows/reserves plus the dispatch-threshold clamp).
 * Pure deterministic assertions over the real module — no mocks, no live model.
 */
import { describe, expect, it } from "vitest";
import type { ChatMessage, PromptSegment } from "../../types/model";
import {
	buildModelInputBudget,
	DEFAULT_COMPACTION_RESERVE_TOKENS,
	DEFAULT_CONTENT_PROJECTION_AGGREGATE_TOKENS,
	DEFAULT_CONTENT_PROJECTION_PER_RESULT_TOKENS,
	DEFAULT_CONTEXT_WINDOW_TOKENS,
	DEFAULT_INPUT_RESERVE_TOKENS,
	estimateModelInputTokens,
	estimateTokensFromChars,
	withModelInputBudgetProviderOptions,
} from "../model-input-budget";

function userMessageOfChars(chars: number): ChatMessage {
	return {
		role: "user",
		content: "x".repeat(Math.max(0, chars)),
	};
}

describe("estimateTokensFromChars", () => {
	it("rounds chars / 3.5 up to whole tokens", () => {
		expect(estimateTokensFromChars(0)).toBe(0);
		expect(estimateTokensFromChars(3)).toBe(1);
		expect(estimateTokensFromChars(4)).toBe(2);
		expect(estimateTokensFromChars(7)).toBe(2);
		expect(estimateTokensFromChars(35)).toBe(10);
		expect(estimateTokensFromChars(36)).toBe(11);
	});
});

describe("estimateModelInputTokens", () => {
	it("measures message content only, in chars, under the heuristic mode", () => {
		const tokens = estimateModelInputTokens({
			messages: [userMessageOfChars(7)],
		});
		expect(tokens).toBe(2);
	});

	it("ignores promptSegments while messages are non-empty", () => {
		const segments: PromptSegment[] = [
			{ content: "y".repeat(70_000), stable: false },
		];
		expect(
			estimateModelInputTokens({
				messages: [userMessageOfChars(7)],
				promptSegments: segments,
			}),
		).toBe(2);
	});

	it("counts promptSegments once messages are empty", () => {
		const segments: PromptSegment[] = [{ content: "abcdefg", stable: false }];
		expect(
			estimateModelInputTokens({
				messages: [],
				promptSegments: segments,
			}),
		).toBe(2);
	});

	it("counts every tool as its complete serialized JSON", () => {
		const tool = { name: "t", description: "abcd" };
		const withoutTools = estimateModelInputTokens({
			messages: [],
		});
		const withTools = estimateModelInputTokens({
			messages: [],
			tools: [tool],
		});
		expect(withoutTools).toBe(0);
		expect(withTools).toBe(
			estimateTokensFromChars(JSON.stringify([tool]).length),
		);
	});

	it("sums every additional request field, treating nullish values as empty", () => {
		const tokens = estimateModelInputTokens({
			system: "abcd",
			prompt: "ab",
			input: null,
			responseSchema: undefined,
			prefill: "ef",
		});
		expect(tokens).toBe(estimateTokensFromChars("abcd".length + 2 + 2));
	});

	it("serializes non-string additional fields as JSON", () => {
		const schema = { canary: "abcd" };
		const tokens = estimateModelInputTokens({
			system: schema,
		});
		expect(tokens).toBe(estimateTokensFromChars(JSON.stringify(schema).length));
	});

	it("measures only a defined completeRequest when the key is present", () => {
		expect(
			estimateModelInputTokens({
				completeRequest: "abcdefg",
				messages: [userMessageOfChars(70_000)],
				system: "zzzzzz",
			}),
		).toBe(2);

		expect(
			estimateModelInputTokens({
				completeRequest: { canary: "abcd" },
			}),
		).toBe(estimateTokensFromChars(JSON.stringify({ canary: "abcd" }).length));
	});

	it("rejects an explicitly undefined completeRequest instead of measuring empty", () => {
		expect(() =>
			estimateModelInputTokens({
				completeRequest: undefined,
				messages: [userMessageOfChars(70_000)],
			}),
		).toThrow(
			expect.objectContaining({
				code: "MODEL_INPUT_COMPLETE_REQUEST_MISSING",
			}),
		);
	});

	it("switches between per-message chars and whole-request UTF-8 bytes by mode", () => {
		const messages: ChatMessage[] = [{ role: "user", content: "漢字" }];

		expect(estimateModelInputTokens({ messages })).toBe(
			estimateTokensFromChars("漢字".length),
		);

		expect(
			estimateModelInputTokens({
				messages,
				estimationMode: "utf8-upper-bound",
			}),
		).toBe(new TextEncoder().encode(JSON.stringify(messages)).byteLength);

		const segments: PromptSegment[] = [{ content: "漢字", stable: true }];
		expect(
			estimateModelInputTokens({
				promptSegments: segments,
				estimationMode: "utf8-upper-bound",
			}),
		).toBe(new TextEncoder().encode(JSON.stringify(segments)).byteLength);
	});
});

describe("buildModelInputBudget argument normalization", () => {
	it("floors fractional windows and reserves", () => {
		const budget = buildModelInputBudget({
			messages: [userMessageOfChars(10)],
			contextWindowTokens: 200_000.9,
			reserveTokens: 99.9,
		});
		expect(budget.contextWindowTokens).toBe(200_000);
		expect(budget.reserveTokens).toBe(99);
		expect(budget.dispatchThresholdTokens).toBe(199_901);
	});

	it("falls back to the default window for NaN and zero windows", () => {
		for (const contextWindowTokens of [Number.NaN, 0]) {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(10)],
				contextWindowTokens,
			});
			expect(budget.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
			expect(budget.reserveTokens).toBe(DEFAULT_INPUT_RESERVE_TOKENS);
		}
	});

	it("clamps a negative window up to a one-token ceiling", () => {
		const budget = buildModelInputBudget({
			messages: [userMessageOfChars(10)],
			contextWindowTokens: -5_000,
			reserveTokens: 0,
		});
		expect(budget.contextWindowTokens).toBe(1);
		expect(budget.reserveTokens).toBe(0);
		expect(budget.dispatchThresholdTokens).toBe(1);
	});

	it("clamps a negative reserve down to zero and honors it verbatim", () => {
		const budget = buildModelInputBudget({
			messages: [userMessageOfChars(10)],
			contextWindowTokens: 50_000,
			reserveTokens: -5,
		});
		expect(budget.reserveTokens).toBe(0);
		expect(budget.dispatchThresholdTokens).toBe(50_000);
	});

	it("keeps the dispatch threshold at a minimum of one token", () => {
		const budget = buildModelInputBudget({
			messages: [userMessageOfChars(10)],
			contextWindowTokens: 10,
			reserveTokens: 50,
		});
		expect(budget.dispatchThresholdTokens).toBe(1);
	});

	it("treats a NaN reserve as unset and falls back to the default reserve", () => {
		const budget = buildModelInputBudget({
			messages: [userMessageOfChars(10)],
			reserveTokens: Number.NaN,
		});
		expect(budget.reserveTokens).toBe(DEFAULT_INPUT_RESERVE_TOKENS);
		expect(budget.dispatchThresholdTokens).toBe(118_000);
	});

	it("echoes the estimation mode and derives the compatibility thresholds", () => {
		const heuristic = buildModelInputBudget({
			messages: [userMessageOfChars(10)],
		});
		expect(heuristic.estimationMode).toBe("heuristic");
		expect(heuristic.shouldReject).toBe(false);
		expect(heuristic.shouldCompact).toBe(false);
		expect(heuristic.compactionThresholdTokens).toBe(
			heuristic.dispatchThresholdTokens,
		);
		expect(heuristic.resolvedModelKey).toBeNull();
	});
});

describe("deprecated constant aliases", () => {
	it("keep their historical values for source compatibility", () => {
		expect(DEFAULT_COMPACTION_RESERVE_TOKENS).toBe(
			DEFAULT_INPUT_RESERVE_TOKENS,
		);
		expect(DEFAULT_CONTENT_PROJECTION_PER_RESULT_TOKENS).toBe(16_000);
		expect(DEFAULT_CONTENT_PROJECTION_AGGREGATE_TOKENS).toBe(64_000);
	});
});

describe("withModelInputBudgetProviderOptions", () => {
	it("creates the eliza carrier when provider options have none", () => {
		const budget = buildModelInputBudget({ prompt: "p" });
		const input = { custom: { mode: "exact" } };
		const output = withModelInputBudgetProviderOptions(input, budget);
		expect(output.eliza.modelInputBudget).toEqual(budget);
		expect(output.custom).toEqual({ mode: "exact" });
		expect(input).toEqual({ custom: { mode: "exact" } });
	});

	it("preserves sibling keys inside an existing eliza carrier", () => {
		const budget = buildModelInputBudget({ prompt: "p" });
		const output = withModelInputBudgetProviderOptions(
			{ eliza: { traceId: "t-1" }, other: 1 },
			budget,
		);
		expect(output.other).toBe(1);
		expect(output.eliza.traceId).toBe("t-1");
		expect(output.eliza.modelInputBudget).toEqual(budget);
	});

	it("replaces a stale modelInputBudget inside an existing eliza carrier", () => {
		const stale = buildModelInputBudget({ prompt: "stale" });
		const fresh = buildModelInputBudget({ prompt: "fresh" });
		const output = withModelInputBudgetProviderOptions(
			{ eliza: { modelInputBudget: stale } },
			fresh,
		);
		expect(output.eliza.modelInputBudget).toEqual(fresh);
	});

	it("replaces nullish and non-object eliza carriers with a fresh one", () => {
		const budget = buildModelInputBudget({ prompt: "p" });
		for (const eliza of [null, "carrier", 42]) {
			const output = withModelInputBudgetProviderOptions(
				{ eliza: eliza as unknown as Record<string, unknown> },
				budget,
			);
			expect(output.eliza.modelInputBudget).toEqual(budget);
			expect(Object.keys(output.eliza)).toEqual(["modelInputBudget"]);
		}
	});
});
