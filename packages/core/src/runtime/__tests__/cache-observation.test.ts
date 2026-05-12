import { describe, expect, it } from "vitest";
import {
	cacheHitRate,
	hasCacheUsage,
	normalizeCacheUsage,
	summarizeCacheUsage,
} from "../cache-observation";

describe("cache observation normalization", () => {
	it("normalizes OpenAI prompt_tokens_details.cached_tokens", () => {
		const observation = normalizeCacheUsage(
			{
				prompt_tokens: 2048,
				completion_tokens: 32,
				total_tokens: 2080,
				prompt_tokens_details: {
					cached_tokens: 1536,
				},
			},
			{ provider: "openai", model: "gpt-5.4" },
		);

		expect(observation).toMatchObject({
			provider: "openai",
			model: "gpt-5.4",
			inputTokens: 2048,
			outputTokens: 32,
			totalTokens: 2080,
			cacheReadInputTokens: 1536,
			cachedInputTokens: 1536,
		});
		expect(observation.cacheHitRate).toBe(0.75);
		expect(hasCacheUsage(observation)).toBe(true);
	});

	it("normalizes Anthropic cache read and creation fields", () => {
		const observation = normalizeCacheUsage({
			input_tokens: 1200,
			output_tokens: 100,
			cache_read_input_tokens: 800,
			cache_creation_input_tokens: 300,
		});

		expect(observation).toMatchObject({
			inputTokens: 1200,
			outputTokens: 100,
			cacheReadInputTokens: 800,
			cacheCreationInputTokens: 300,
			cachedInputTokens: 800,
		});
		expect(hasCacheUsage(observation)).toBe(true);
	});

	it("normalizes AI SDK inputTokenDetails cacheReadTokens", () => {
		const observation = normalizeCacheUsage({
			inputTokens: 900,
			outputTokens: 40,
			inputTokenDetails: {
				cacheReadTokens: 450,
				cacheCreationTokens: 200,
			},
		});

		expect(observation).toMatchObject({
			inputTokens: 900,
			outputTokens: 40,
			cacheReadInputTokens: 450,
			cacheCreationInputTokens: 200,
			cachedInputTokens: 450,
		});
	});

	it("normalizes AI SDK inputTokenDetails cachedInputTokens", () => {
		const observation = normalizeCacheUsage({
			inputTokens: 1000,
			inputTokenDetails: {
				cachedInputTokens: 640,
			},
		});

		expect(observation).toMatchObject({
			inputTokens: 1000,
			cacheReadInputTokens: 640,
			cachedInputTokens: 640,
		});
	});

	it("normalizes top-level cached_tokens used by OpenRouter-compatible providers", () => {
		const observation = normalizeCacheUsage(
			{
				prompt_tokens: 1000,
				cached_tokens: 256,
			},
			{ provider: "openrouter", model: "deepseek/deepseek-v4-pro" },
		);

		expect(observation).toMatchObject({
			provider: "openrouter",
			model: "deepseek/deepseek-v4-pro",
			inputTokens: 1000,
			cacheReadInputTokens: 256,
			cachedInputTokens: 256,
		});
	});

	it("normalizes nested response.usage payloads", () => {
		const observation = normalizeCacheUsage({
			id: "chatcmpl-test",
			usage: {
				prompt_tokens: 400,
				completion_tokens: 20,
				prompt_tokens_details: {
					cached_tokens: 128,
				},
			},
		});

		expect(observation).toMatchObject({
			inputTokens: 400,
			outputTokens: 20,
			cachedInputTokens: 128,
		});
	});

	it("summarizes cache hit rate across calls", () => {
		const summary = summarizeCacheUsage([
			normalizeCacheUsage({ inputTokens: 1000, cached_tokens: 0 }),
			normalizeCacheUsage({ inputTokens: 1000, cached_tokens: 800 }),
		]);

		expect(summary).toMatchObject({
			calls: 2,
			inputTokens: 2000,
			cachedInputTokens: 800,
			cacheHitRate: 0.4,
		});
		expect(cacheHitRate({ inputTokens: 1000, cachedInputTokens: 250 })).toBe(
			0.25,
		);
	});
});
