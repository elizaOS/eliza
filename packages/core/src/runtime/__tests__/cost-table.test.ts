import { describe, expect, it } from "vitest";
import {
	computeCallCostUsd,
	lookupModelPrice,
	MODEL_PRICES_USD_PER_M_TOKENS,
} from "../cost-table";

describe("cost-table", () => {
	describe("MODEL_PRICES_USD_PER_M_TOKENS", () => {
		it("includes the documented Cerebras gpt-oss family", () => {
			expect(MODEL_PRICES_USD_PER_M_TOKENS["gpt-oss-120b"]).toEqual({
				input: 0.5,
				output: 0.8,
				cacheRead: 0,
				cacheWrite: 0,
			});
			expect(MODEL_PRICES_USD_PER_M_TOKENS["gpt-oss-20b"]).toEqual({
				input: 0.1,
				output: 0.3,
				cacheRead: 0,
				cacheWrite: 0,
			});
		});

		it("includes the documented Anthropic Claude family", () => {
			expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-haiku-4-5"]).toEqual({
				input: 0.8,
				output: 4.0,
				cacheRead: 0.08,
				cacheWrite: 1.0,
			});
			expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-opus-4-7"]?.output).toBe(75);
		});

		it("includes the documented OpenAI gpt-5.5 family", () => {
			expect(MODEL_PRICES_USD_PER_M_TOKENS["gpt-5.5"]?.input).toBe(1.25);
			expect(MODEL_PRICES_USD_PER_M_TOKENS["gpt-5.5-mini"]?.input).toBe(0.25);
		});
	});

	describe("lookupModelPrice", () => {
		it("returns null for undefined or unknown models", () => {
			expect(lookupModelPrice(undefined)).toBeNull();
			expect(lookupModelPrice("unknown-model-99")).toBeNull();
		});

		it("returns exact match when available", () => {
			expect(lookupModelPrice("gpt-oss-120b")).toEqual(
				MODEL_PRICES_USD_PER_M_TOKENS["gpt-oss-120b"],
			);
		});

		it("falls back to longest matching family key (versioned ids)", () => {
			// Anthropic emits versioned ids like `claude-haiku-4-5-20251001`.
			expect(lookupModelPrice("claude-haiku-4-5-20251001")).toEqual(
				MODEL_PRICES_USD_PER_M_TOKENS["claude-haiku-4-5"],
			);
		});

		it("prefers the longest matching family key when multiple share a prefix", () => {
			expect(lookupModelPrice("gpt-5.5-mini-test")).toEqual(
				MODEL_PRICES_USD_PER_M_TOKENS["gpt-5.5-mini"],
			);
		});
	});

	describe("computeCallCostUsd", () => {
		it("returns 0 when usage is undefined", () => {
			expect(computeCallCostUsd("gpt-oss-120b", undefined)).toBe(0);
		});

		it("returns 0 when model is unknown (recorder must never crash on cost)", () => {
			expect(
				computeCallCostUsd("totally-fake-model", {
					promptTokens: 1000,
					completionTokens: 500,
					totalTokens: 1500,
				}),
			).toBe(0);
		});

		it("computes basic input/output cost for gpt-oss-120b", () => {
			// 1M input * $0.50/M = $0.50
			// 1M output * $0.80/M = $0.80
			const cost = computeCallCostUsd("gpt-oss-120b", {
				promptTokens: 1_000_000,
				completionTokens: 1_000_000,
				totalTokens: 2_000_000,
			});
			expect(cost).toBeCloseTo(1.3, 6);
		});

		it("applies cacheRead discount for claude-haiku-4-5", () => {
			// 1000 prompt tokens with 800 cache-read.
			// non-cached: 200 * $0.80/M  = $0.00016
			// cache-read: 800 * $0.08/M  = $0.000064
			// completion: 100 * $4.00/M  = $0.0004
			// total = $0.000624
			const cost = computeCallCostUsd("claude-haiku-4-5", {
				promptTokens: 1000,
				completionTokens: 100,
				cacheReadInputTokens: 800,
				totalTokens: 1100,
			});
			expect(cost).toBeCloseTo(0.000624, 9);
		});

		it("applies cacheWrite surcharge for Anthropic models", () => {
			// 100 cache-creation tokens at claude-haiku-4-5 cacheWrite=$1.00/M
			//   = 100 * $1.00/M = $0.0001
			// 100 non-cached input at $0.80/M = $0.00008
			// 0 completion
			const cost = computeCallCostUsd("claude-haiku-4-5", {
				promptTokens: 200,
				completionTokens: 0,
				cacheCreationInputTokens: 100,
				totalTokens: 200,
			});
			expect(cost).toBeCloseTo(0.00018, 9);
		});

		it("falls back to input rate when cacheRead is not set (Cerebras)", () => {
			// gpt-oss-120b cacheRead is 0, so cache-read tokens are billed at
			// input rate as the documented fallback.
			const cost = computeCallCostUsd("gpt-oss-120b", {
				promptTokens: 1_000_000,
				completionTokens: 0,
				cacheReadInputTokens: 1_000_000,
				totalTokens: 1_000_000,
			});
			// 1M cacheRead * $0.50/M = $0.50 (falls back to input rate)
			expect(cost).toBeCloseTo(0.5, 6);
		});
	});
});
