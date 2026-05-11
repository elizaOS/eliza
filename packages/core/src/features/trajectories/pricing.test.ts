import { describe, expect, it, vi } from "vitest";
import {
	computeCallCostUsd,
	isLocalProvider,
	lookupModelPrice,
	MODEL_PRICES_USD_PER_M_TOKENS,
	PRICE_TABLE_ID,
} from "./pricing";

describe("PRICE_TABLE_ID", () => {
	it("is a non-empty versioned identifier", () => {
		expect(typeof PRICE_TABLE_ID).toBe("string");
		expect(PRICE_TABLE_ID.length).toBeGreaterThan(0);
		expect(PRICE_TABLE_ID).toMatch(/eliza-v\d+-\d{4}-\d{2}-\d{2}/);
	});
});

describe("MODEL_PRICES_USD_PER_M_TOKENS", () => {
	it("covers all required hosted providers", () => {
		// Anthropic — the three ship models from CLAUDE.md
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-opus-4-7"]?.provider).toBe(
			"anthropic",
		);
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-sonnet-4-6"]?.provider).toBe(
			"anthropic",
		);
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-haiku-4-5"]?.provider).toBe(
			"anthropic",
		);

		// OpenAI — the ship targets per CLAUDE.md
		expect(MODEL_PRICES_USD_PER_M_TOKENS["gpt-5.5"]?.provider).toBe("openai");
		expect(MODEL_PRICES_USD_PER_M_TOKENS["gpt-5.5-mini"]?.provider).toBe(
			"openai",
		);

		// Google / Groq / Cerebras / Eliza Cloud — every required hosted tier
		// in the W1-X1 spec ships at least one entry.
		const providers = new Set(
			Object.values(MODEL_PRICES_USD_PER_M_TOKENS).map((p) => p.provider),
		);
		expect(providers.has("google")).toBe(true);
		expect(providers.has("groq")).toBe(true);
		expect(providers.has("cerebras")).toBe(true);
		expect(providers.has("eliza-cloud")).toBe(true);
	});

	it("local providers carry a real zero rate (not a missing entry)", () => {
		expect(MODEL_PRICES_USD_PER_M_TOKENS["ollama"]).toEqual({
			provider: "ollama",
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(MODEL_PRICES_USD_PER_M_TOKENS["lm-studio"]?.input).toBe(0);
		expect(MODEL_PRICES_USD_PER_M_TOKENS["llama.cpp"]?.input).toBe(0);
	});

	it("preserves the documented Anthropic rate card", () => {
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-opus-4-7"]).toEqual({
			provider: "anthropic",
			input: 15.0,
			output: 75.0,
			cacheRead: 1.5,
			cacheWrite: 18.75,
		});
		expect(MODEL_PRICES_USD_PER_M_TOKENS["claude-haiku-4-5"]).toEqual({
			provider: "anthropic",
			input: 0.8,
			output: 4.0,
			cacheRead: 0.08,
			cacheWrite: 1.0,
		});
	});
});

describe("lookupModelPrice", () => {
	it("returns null for undefined or unknown models", () => {
		expect(lookupModelPrice(undefined)).toBeNull();
		expect(lookupModelPrice("totally-unknown-model")).toBeNull();
	});

	it("returns an exact match with the canonical key", () => {
		const result = lookupModelPrice("gpt-oss-120b");
		expect(result?.matchedKey).toBe("gpt-oss-120b");
		expect(result?.price.provider).toBe("cerebras");
	});

	it("falls back to the longest family key for versioned ids", () => {
		// Anthropic emits versioned ids like `claude-haiku-4-5-20251001`.
		const result = lookupModelPrice("claude-haiku-4-5-20251001");
		expect(result?.matchedKey).toBe("claude-haiku-4-5");
		expect(result?.price.provider).toBe("anthropic");
	});

	it("prefers the longest matching family key when prefixes overlap", () => {
		const result = lookupModelPrice("gpt-5.5-mini-experimental");
		expect(result?.matchedKey).toBe("gpt-5.5-mini");
	});
});

describe("computeCallCostUsd", () => {
	it("returns 0 when usage is undefined", () => {
		expect(computeCallCostUsd("claude-opus-4-7", undefined)).toBe(0);
	});

	it("returns 0 and warns when the model is unknown on a hosted provider", () => {
		const warn = vi.fn();
		const cost = computeCallCostUsd(
			"never-heard-of-this-model",
			{
				promptTokens: 1000,
				completionTokens: 500,
				totalTokens: 1500,
			},
			{ provider: "openai", logger: { warn } },
		);
		expect(cost).toBe(0);
		expect(warn).toHaveBeenCalledTimes(1);
		const [context, message] = warn.mock.calls[0] ?? [];
		expect(message).toContain("[pricing]");
		expect((context as Record<string, unknown>).priceTableId).toBe(
			PRICE_TABLE_ID,
		);
		expect((context as Record<string, unknown>).modelName).toBe(
			"never-heard-of-this-model",
		);
	});

	it("returns 0 with no warning when the provider is a local tier (Ollama)", () => {
		const warn = vi.fn();
		const cost = computeCallCostUsd(
			"qwen-2.5-14b-some-local-tag",
			{ promptTokens: 100000, completionTokens: 5000, totalTokens: 105000 },
			{ provider: "ollama", logger: { warn } },
		);
		expect(cost).toBe(0);
		expect(warn).not.toHaveBeenCalled();
	});

	it("returns 0 with no warning when the provider is LM Studio", () => {
		const warn = vi.fn();
		expect(
			computeCallCostUsd(
				"local-model",
				{ promptTokens: 100, completionTokens: 100, totalTokens: 200 },
				{ provider: "lm-studio", logger: { warn } },
			),
		).toBe(0);
		expect(warn).not.toHaveBeenCalled();
	});

	it("returns 0 with no warning when the provider is llama.cpp", () => {
		const warn = vi.fn();
		expect(
			computeCallCostUsd(
				"phi-4-q4",
				{ promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
				{ provider: "llama.cpp", logger: { warn } },
			),
		).toBe(0);
		expect(warn).not.toHaveBeenCalled();
	});

	it("does not warn when logger is omitted (no noise in hot paths)", () => {
		// Should not throw even when logger is undefined.
		expect(() =>
			computeCallCostUsd(
				"unknown-model",
				{ promptTokens: 100, completionTokens: 100, totalTokens: 200 },
				{ provider: "openai" },
			),
		).not.toThrow();
	});

	it("computes input+output for an Anthropic Opus call", () => {
		// 1k input + 1k output on claude-opus-4-7.
		// input  = 1000   * $15.00/M = $0.015
		// output = 1000   * $75.00/M = $0.075
		// total  = $0.09
		const cost = computeCallCostUsd("claude-opus-4-7", {
			promptTokens: 1000,
			completionTokens: 1000,
			totalTokens: 2000,
		});
		expect(cost).toBeCloseTo(0.09, 6);
	});

	it("applies cache-read discount and cache-write surcharge for Anthropic", () => {
		// claude-haiku-4-5: input $0.80, output $4.00, cacheRead $0.08,
		//                   cacheWrite $1.00 (per 1M).
		// 1000 prompt = 200 fresh + 700 cacheRead + 100 cacheWrite
		//   fresh:      200  * $0.80 / 1M  = $0.00016
		//   cacheRead:  700  * $0.08 / 1M  = $0.000056
		//   cacheWrite: 100  * $1.00 / 1M  = $0.0001
		//   completion:  50  * $4.00 / 1M  = $0.0002
		// total = $0.000516
		const cost = computeCallCostUsd("claude-haiku-4-5", {
			promptTokens: 1000,
			completionTokens: 50,
			cacheReadInputTokens: 700,
			cacheCreationInputTokens: 100,
			totalTokens: 1050,
		});
		expect(cost).toBeCloseTo(0.000516, 9);
	});

	it("falls back to the input rate when cacheRead is 0 (Cerebras gpt-oss)", () => {
		// gpt-oss-120b: cacheRead == 0 → bill at input rate.
		// 1M cacheRead * $0.50/M = $0.50
		const cost = computeCallCostUsd("gpt-oss-120b", {
			promptTokens: 1_000_000,
			completionTokens: 0,
			cacheReadInputTokens: 1_000_000,
			totalTokens: 1_000_000,
		});
		expect(cost).toBeCloseTo(0.5, 6);
	});

	it("computes a real cost for Google Gemini", () => {
		// gemini-2.5-flash: input $0.30, output $2.50.
		// 1M input * $0.30 = $0.30
		// 1M output * $2.50 = $2.50
		// total = $2.80
		const cost = computeCallCostUsd("gemini-2.5-flash", {
			promptTokens: 1_000_000,
			completionTokens: 1_000_000,
			totalTokens: 2_000_000,
		});
		expect(cost).toBeCloseTo(2.8, 4);
	});

	it("computes a real cost for Groq", () => {
		// llama-3.1-8b-instant: input $0.05, output $0.08.
		// 1M input = $0.05, 1M output = $0.08, total = $0.13.
		const cost = computeCallCostUsd("llama-3.1-8b-instant", {
			promptTokens: 1_000_000,
			completionTokens: 1_000_000,
			totalTokens: 2_000_000,
		});
		expect(cost).toBeCloseTo(0.13, 6);
	});

	it("computes a real cost for Eliza Cloud", () => {
		// eliza-cloud-sonnet: input $3.60, output $18.00.
		// 1M input = $3.60, 1M output = $18.00, total = $21.60.
		const cost = computeCallCostUsd("eliza-cloud-sonnet", {
			promptTokens: 1_000_000,
			completionTokens: 1_000_000,
			totalTokens: 2_000_000,
		});
		expect(cost).toBeCloseTo(21.6, 4);
	});

	it("clamps negative non-cached input to 0 (defensive math)", () => {
		// If cacheRead + cacheWrite > promptTokens, the non-cached portion
		// must not go negative.
		const cost = computeCallCostUsd("claude-haiku-4-5", {
			promptTokens: 100,
			completionTokens: 0,
			cacheReadInputTokens: 200,
			cacheCreationInputTokens: 0,
			totalTokens: 200,
		});
		// non-cached = 0, cacheRead = 200 * $0.08/M = $0.000016, completion = 0.
		expect(cost).toBeCloseTo(0.000016, 9);
		expect(cost).toBeGreaterThanOrEqual(0);
	});
});

describe("isLocalProvider", () => {
	it("identifies known local tiers", () => {
		expect(isLocalProvider("ollama")).toBe(true);
		expect(isLocalProvider("lm-studio")).toBe(true);
		expect(isLocalProvider("llama.cpp")).toBe(true);
		expect(isLocalProvider("local")).toBe(true);
	});

	it("rejects hosted providers", () => {
		expect(isLocalProvider("anthropic")).toBe(false);
		expect(isLocalProvider("openai")).toBe(false);
		expect(isLocalProvider("cerebras")).toBe(false);
		expect(isLocalProvider("groq")).toBe(false);
	});

	it("returns false for undefined or empty", () => {
		expect(isLocalProvider(undefined)).toBe(false);
		expect(isLocalProvider("")).toBe(false);
	});

	it("normalizes case and whitespace", () => {
		expect(isLocalProvider("  Ollama  ")).toBe(true);
		expect(isLocalProvider("LM-Studio")).toBe(true);
	});
});
