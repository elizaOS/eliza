import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/model";
import {
	buildModelInputBudget,
	DEFAULT_COMPACTION_RESERVE_TOKENS,
	DEFAULT_CONTEXT_WINDOW_TOKENS,
	MODEL_WINDOW_RESERVE_FRACTION,
} from "../model-input-budget";

/**
 * Test-only helper that returns a single user message whose content fills
 * out to a known *character* count. The estimator uses `ceil(chars / 3.5)`
 * so we can target a specific estimated-token output by sizing the string.
 */
function userMessageOfChars(chars: number): ChatMessage {
	return {
		role: "user",
		content: "x".repeat(Math.max(0, chars)),
	};
}

describe("buildModelInputBudget", () => {
	describe("backwards compatibility (no modelName)", () => {
		it("uses the explicit window + reserve when both are passed", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				contextWindowTokens: 200_000,
				reserveTokens: 5_000,
			});
			expect(budget.contextWindowTokens).toBe(200_000);
			expect(budget.reserveTokens).toBe(5_000);
			expect(budget.compactionThresholdTokens).toBe(195_000);
			expect(budget.resolvedModelKey).toBeNull();
		});

		it("falls back to the default window when none provided", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
			});
			expect(budget.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
			expect(budget.reserveTokens).toBe(DEFAULT_COMPACTION_RESERVE_TOKENS);
		});

		it("preserves the legacy default reserve (10k) when no modelName provided", () => {
			// This is the back-compat guarantee — callers that don't opt into
			// the per-model lookup must see exactly the pre-PR threshold.
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
			});
			expect(budget.reserveTokens).toBe(10_000);
			expect(budget.compactionThresholdTokens).toBe(118_000);
		});

		it("treats reserveTokens=0 as a valid explicit override", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				contextWindowTokens: 100_000,
				reserveTokens: 0,
			});
			expect(budget.reserveTokens).toBe(0);
			expect(budget.compactionThresholdTokens).toBe(100_000);
		});

		it("flags shouldCompact when estimate is at-or-above threshold", () => {
			// 800_000 chars → 800_000/3.5 ≈ 228_572 estimated tokens → above
			// the 118k default threshold.
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(800_000)],
			});
			expect(budget.shouldCompact).toBe(true);
		});

		it("leaves shouldCompact off when estimate is below threshold", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
			});
			expect(budget.shouldCompact).toBe(false);
		});
	});

	describe("per-model lookup (modelName passed)", () => {
		it("resolves Cerebras gpt-oss-120b to its 131k window", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				modelName: "gpt-oss-120b",
			});
			expect(budget.contextWindowTokens).toBe(131_000);
			expect(budget.resolvedModelKey).toBe("gpt-oss-120b");
		});

		it("resolves Cerebras llama3.1-8b to its 32k window", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				modelName: "llama3.1-8b",
			});
			expect(budget.contextWindowTokens).toBe(32_000);
			expect(budget.resolvedModelKey).toBe("llama3.1-8b");
		});

		it("resolves Claude family to 200k via prefix match (versioned id)", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				modelName: "claude-haiku-4-5-20251001",
			});
			expect(budget.contextWindowTokens).toBe(200_000);
			expect(budget.resolvedModelKey).toBe("claude-haiku-4-5");
		});

		it("scales reserve to 20% of window when lookup hits and reserve unset", () => {
			// 131_000 * 0.20 = 26_200, which beats the 10k floor.
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				modelName: "gpt-oss-120b",
			});
			expect(budget.reserveTokens).toBe(26_200);
			expect(budget.compactionThresholdTokens).toBe(131_000 - 26_200);
		});

		it("keeps the 10k floor for tiny-window models (32k * 0.20 = 6.4k → 10k)", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				modelName: "llama3.1-8b",
			});
			expect(budget.reserveTokens).toBe(DEFAULT_COMPACTION_RESERVE_TOKENS);
			expect(budget.compactionThresholdTokens).toBe(32_000 - 10_000);
		});

		it("scales reserve to 40k for Claude (200k * 0.20)", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				modelName: "claude-opus-4-7",
			});
			expect(budget.reserveTokens).toBe(40_000);
			expect(budget.compactionThresholdTokens).toBe(200_000 - 40_000);
		});

		it("respects an explicit reserveTokens override even when modelName resolves", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				modelName: "gpt-oss-120b",
				reserveTokens: 5_000,
			});
			expect(budget.reserveTokens).toBe(5_000);
			expect(budget.compactionThresholdTokens).toBe(131_000 - 5_000);
			// Lookup still recorded for observability.
			expect(budget.resolvedModelKey).toBe("gpt-oss-120b");
		});

		it("lookup wins over an explicit contextWindowTokens (model is authoritative)", () => {
			// A caller carrying the legacy 128k default on ChainingLoopConfig
			// AND setting modelName should get the per-model ceiling, not 128k.
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				modelName: "gpt-oss-120b",
				contextWindowTokens: 128_000,
			});
			expect(budget.contextWindowTokens).toBe(131_000);
			expect(budget.resolvedModelKey).toBe("gpt-oss-120b");
		});

		it("falls through to explicit window when modelName has no lookup entry", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				modelName: "some-unknown-model-99",
				contextWindowTokens: 50_000,
			});
			expect(budget.contextWindowTokens).toBe(50_000);
			expect(budget.resolvedModelKey).toBeNull();
		});

		it("keeps legacy 10k reserve when lookup misses and reserve unset", () => {
			// Lookup miss → derived reserve is undefined → legacy default applies.
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				modelName: "some-unknown-model-99",
			});
			expect(budget.reserveTokens).toBe(DEFAULT_COMPACTION_RESERVE_TOKENS);
		});
	});

	describe("MODEL_WINDOW_RESERVE_FRACTION constant", () => {
		it("is exposed as 0.20 for callers that need to mirror the calc", () => {
			expect(MODEL_WINDOW_RESERVE_FRACTION).toBe(0.2);
		});
	});

	describe("estimateInputTokens accuracy preserved", () => {
		it("uses messages over promptSegments when messages are present", () => {
			// Estimator should ignore promptSegments when messages are non-empty
			// (legacy behavior — segments are the alternate Tier 1 path).
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(70)],
				promptSegments: [{ content: "y".repeat(70_000) }],
			});
			// 70 chars / 3.5 = 20 tokens. Nowhere near the 118k threshold.
			expect(budget.estimatedInputTokens).toBeLessThan(50);
			expect(budget.shouldCompact).toBe(false);
		});

		it("counts tool definitions toward the estimate", () => {
			const baseTools = [
				{ name: "X", description: "a".repeat(1000) },
				{ name: "Y", description: "b".repeat(1000) },
			] as Array<{ name: string; description: string }>;
			const noTools = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
			});
			const withTools = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				// biome-ignore lint/suspicious/noExplicitAny: minimal shape for estimator test
				tools: baseTools as any,
			});
			expect(withTools.estimatedInputTokens).toBeGreaterThan(
				noTools.estimatedInputTokens,
			);
		});
	});
});
