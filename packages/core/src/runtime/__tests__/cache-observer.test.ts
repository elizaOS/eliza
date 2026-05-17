import { describe, expect, it } from "vitest";
import { hasCacheUsage, normalizeCacheUsage } from "../cache-observer";

describe("cache usage normalization", () => {
	it("normalizes Anthropic-style cache usage fields", () => {
		const observation = normalizeCacheUsage(
			{
				input_tokens: 100,
				output_tokens: 20,
				cache_read_input_tokens: 64,
				cache_creation_input_tokens: 32,
			},
			{ provider: "anthropic", model: "claude" },
		);

		expect(observation).toMatchObject({
			provider: "anthropic",
			model: "claude",
			inputTokens: 100,
			outputTokens: 20,
			cacheReadInputTokens: 64,
			cacheCreationInputTokens: 32,
			cachedInputTokens: 64,
		});
		expect(hasCacheUsage(observation)).toBe(true);
	});

	it("normalizes OpenAI-style cached token details", () => {
		const observation = normalizeCacheUsage({
			prompt_tokens: 200,
			completion_tokens: 25,
			total_tokens: 225,
			prompt_tokens_details: {
				cached_tokens: 128,
			},
		});

		expect(observation).toMatchObject({
			inputTokens: 200,
			outputTokens: 25,
			totalTokens: 225,
			cachedInputTokens: 128,
		});
		expect(hasCacheUsage(observation)).toBe(true);
	});

	it("normalizes AI SDK-style input token details", () => {
		const observation = normalizeCacheUsage({
			inputTokens: 300,
			inputTokenDetails: {
				cacheReadTokens: 144,
				cacheCreationTokens: 80,
			},
		});

		expect(observation).toMatchObject({
			inputTokens: 300,
			cacheReadInputTokens: 144,
			cacheCreationInputTokens: 80,
			cachedInputTokens: 144,
		});
		expect(hasCacheUsage(observation)).toBe(true);
	});
});
