/** Complete-request estimates honor explicit provider metadata and preserve input. */
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ToolDefinition } from "../../types/model";
import {
	buildModelInputBudget,
	DEFAULT_CONTEXT_WINDOW_TOKENS,
	DEFAULT_INPUT_RESERVE_TOKENS,
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
			expect(budget.dispatchThresholdTokens).toBe(195_000);
			expect(budget.resolvedModelKey).toBeNull();
		});

		it("falls back to the default window when none provided", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
			});
			expect(budget.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
			expect(budget.reserveTokens).toBe(DEFAULT_INPUT_RESERVE_TOKENS);
		});

		it("preserves the legacy default reserve (10k) when no modelName provided", () => {
			// This is the back-compat guarantee — callers that don't opt into
			// the per-model lookup must see exactly the legacy threshold.
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
			});
			expect(budget.reserveTokens).toBe(10_000);
			expect(budget.dispatchThresholdTokens).toBe(118_000);
		});

		it("treats reserveTokens=0 as a valid explicit override", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				contextWindowTokens: 100_000,
				reserveTokens: 0,
			});
			expect(budget.reserveTokens).toBe(0);
			expect(budget.dispatchThresholdTokens).toBe(100_000);
		});

		it("keeps estimates diagnostic at or above the dispatch threshold", () => {
			// 800_000 chars → 800_000/3.5 ≈ 228_572 estimated tokens → above
			// the 118k default threshold.
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(800_000)],
			});
			expect(budget.shouldReject).toBe(false);
		});

		it("leaves shouldReject off when estimate is below threshold", () => {
			const budget = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
			});
			expect(budget.shouldReject).toBe(false);
		});
	});

	describe("explicit provider metadata", () => {
		it("honors explicit limits and the default-valued reserve even for known model names", () => {
			const budget = buildModelInputBudget({
				modelName: "gpt-oss-120b",
				contextWindowTokens: 200_000,
				reserveTokens: DEFAULT_INPUT_RESERVE_TOKENS,
			});
			expect(budget.contextWindowTokens).toBe(200_000);
			expect(budget.reserveTokens).toBe(DEFAULT_INPUT_RESERVE_TOKENS);
			expect(budget.resolvedModelKey).toBeNull();
		});
		it("does not infer provider limits from names or global catalog overrides", () => {
			vi.stubEnv("MODEL_CONTEXT_WINDOWS_JSON", "{invalid");
			try {
				for (const modelName of ["gpt-oss-120b", "unknown-model"]) {
					const budget = buildModelInputBudget({ modelName });
					expect(budget.contextWindowTokens).toBe(
						DEFAULT_CONTEXT_WINDOW_TOKENS,
					);
					expect(budget.shouldReject).toBe(false);
					expect(budget.shouldCompact).toBe(false);
				}
			} finally {
				vi.unstubAllEnvs();
			}
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
			expect(budget.shouldReject).toBe(false);
		});

		it("counts tool definitions toward the estimate", () => {
			const baseTools: ToolDefinition[] = [
				{ name: "X", description: "a".repeat(1000) },
				{ name: "Y", description: "b".repeat(1000) },
			];
			const noTools = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
			});
			const withTools = buildModelInputBudget({
				messages: [userMessageOfChars(100)],
				tools: baseTools,
			});
			expect(withTools.estimatedInputTokens).toBeGreaterThan(
				noTools.estimatedInputTokens,
			);
		});
	});

	describe("conservative final-wire estimation", () => {
		it("uses the complete UTF-8 byte length for multilingual and emoji input", () => {
			const content = "漢字🙂é";
			const budget = buildModelInputBudget({
				messages: [{ role: "user", content }],
				estimationMode: "utf8-upper-bound",
				contextWindowTokens: 100_000,
				reserveTokens: 0,
			});
			const serialized = JSON.stringify([{ role: "user", content }]);
			expect(budget.estimatedInputTokens).toBe(
				new TextEncoder().encode(serialized).byteLength,
			);
			expect(budget.estimationMode).toBe("utf8-upper-bound");
		});

		it("includes every supported final request field and tool JSON", () => {
			const base = buildModelInputBudget({
				messages: [{ role: "user", content: "message-canary" }],
				estimationMode: "utf8-upper-bound",
				contextWindowTokens: 100_000,
				reserveTokens: 0,
			});
			const complete = buildModelInputBudget({
				messages: [{ role: "user", content: "message-canary" }],
				tools: [
					{ name: "tool-canary", description: "tool-description-canary" },
				],
				system: "system-canary",
				prompt: "prompt-canary",
				input: "input-canary",
				responseSchema: { title: "schema-canary" },
				responseFormat: { type: "format-canary" },
				grammar: "grammar-canary",
				responseSkeleton: "skeleton-canary",
				prefill: "prefill-canary",
				estimationMode: "utf8-upper-bound",
				contextWindowTokens: 100_000,
				reserveTokens: 0,
			});
			expect(complete.estimatedInputTokens).toBeGreaterThan(
				base.estimatedInputTokens,
			);
		});

		it("rejects cyclic request data with a typed serialization error", () => {
			const cyclic: Record<string, unknown> = { value: "cycle-canary" };
			cyclic.self = cyclic;
			expect(() =>
				buildModelInputBudget({
					responseSchema: cyclic,
					estimationMode: "utf8-upper-bound",
				}),
			).toThrowError(
				expect.objectContaining({ code: "MODEL_INPUT_SERIALIZATION_FAILED" }),
			);
		});
	});
});
