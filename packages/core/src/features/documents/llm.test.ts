/**
 * Unit coverage for the documents LLM adapter, exercising real provider
 * dispatch, request shaping, retry, caching, and ordered batch semantics while
 * replacing only external model SDK and trajectory boundaries.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { embed as aiEmbed, generateText as aiGenerateText } from "ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { logger } from "../../logger";
import {
	logActiveTrajectoryLlmCall,
	withStandaloneTrajectory,
} from "../../trajectory-utils";
import type { IAgentRuntime } from "../../types";
import { ModelType } from "../../types";
import {
	generateText,
	generateTextEmbedding,
	generateTextEmbeddingsBatch,
} from "./llm.ts";

vi.mock("ai", () => ({
	embed: vi.fn(),
	generateText: vi.fn(),
}));

vi.mock("@ai-sdk/anthropic", () => ({
	createAnthropic: vi.fn(() =>
		vi.fn((modelName: string) => ({ provider: "anthropic", modelName })),
	),
}));

vi.mock("@ai-sdk/openai", () => ({
	createOpenAI: vi.fn(() => ({
		chat: vi.fn((modelName: string) => ({ provider: "openai", modelName })),
		embedding: vi.fn((modelName: string) => ({
			provider: "openai-embedding",
			modelName,
		})),
	})),
}));

vi.mock("@ai-sdk/google", () => ({
	google: Object.assign(
		vi.fn((modelName: string) => ({ provider: "google", modelName })),
		{
			textEmbeddingModel: vi.fn((modelName: string) => ({
				provider: "google-embedding",
				modelName,
			})),
		},
	),
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
	createOpenRouter: vi.fn(() => ({
		chat: vi.fn((modelName: string) => ({
			provider: "openrouter",
			modelName,
		})),
	})),
}));

vi.mock("../../logger", () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("../../trajectory-utils", () => ({
	logActiveTrajectoryLlmCall: vi.fn(),
	withStandaloneTrajectory: vi.fn(
		async (
			_runtime: IAgentRuntime,
			_metadata: unknown,
			invoke: () => Promise<unknown>,
		) => invoke(),
	),
}));

const aiEmbedMock = vi.mocked(aiEmbed);
const aiGenerateTextMock = vi.mocked(aiGenerateText);
const logActiveTrajectoryLlmCallMock = vi.mocked(logActiveTrajectoryLlmCall);
const withStandaloneTrajectoryMock = vi.mocked(withStandaloneTrajectory);

const generated = {
	text: "generated response",
	usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
	finishReason: "stop",
	response: { id: "response-id", modelId: "provider-model-id" },
};

interface RuntimeHarness {
	runtime: IAgentRuntime;
	getSetting: ReturnType<typeof vi.fn>;
	useModel: ReturnType<typeof vi.fn>;
	reportError: ReturnType<typeof vi.fn>;
}

function makeRuntime(
	settings: Record<string, string | number | boolean | undefined> = {},
): RuntimeHarness {
	const getSetting = vi.fn((key: string) => settings[key]);
	const useModel = vi.fn();
	const reportError = vi.fn();
	return {
		runtime: { getSetting, useModel, reportError } as unknown as IAgentRuntime,
		getSetting,
		useModel,
		reportError,
	};
}

function localEmbeddingRuntime(): RuntimeHarness {
	return makeRuntime({
		EMBEDDING_PROVIDER: "local",
		TEXT_EMBEDDING_MODEL: "local-embedding",
	});
}

function textRuntime(provider: string, modelName: string): RuntimeHarness {
	return makeRuntime({
		EMBEDDING_PROVIDER: "local",
		TEXT_EMBEDDING_MODEL: "local-embedding",
		TEXT_PROVIDER: provider,
		TEXT_MODEL: modelName,
		MAX_OUTPUT_TOKENS: 321,
	});
}

const originalGoogleApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

beforeEach(() => {
	vi.clearAllMocks();
	aiGenerateTextMock.mockResolvedValue(generated);
	aiEmbedMock.mockResolvedValue({
		embedding: [0.25, 0.75],
		usage: { tokens: 2 },
	});
});

afterEach(() => {
	vi.useRealTimers();
	if (originalGoogleApiKey === undefined) {
		delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
	} else {
		process.env.GOOGLE_GENERATIVE_AI_API_KEY = originalGoogleApiKey;
	}
});

describe("generateTextEmbedding", () => {
	test("uses the runtime's local embedding model and returns its vector", async () => {
		const { runtime, useModel } = localEmbeddingRuntime();
		useModel.mockResolvedValue([0.1, 0.2, 0.3]);

		await expect(generateTextEmbedding(runtime, "hello")).resolves.toEqual({
			embedding: [0.1, 0.2, 0.3],
		});
		expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_EMBEDDING, {
			text: "hello",
		});
	});

	test("rejects an invalid local embedding payload without fabricating a vector", async () => {
		const { runtime, useModel } = localEmbeddingRuntime();
		useModel.mockResolvedValue("not-an-embedding");

		await expect(generateTextEmbedding(runtime, "hello")).rejects.toThrow(
			"Local embedding model returned an invalid embedding payload",
		);
	});

	test.each([
		["text-embedding-3-small", 768],
		["legacy-embedding-model", undefined],
	] as const)(
		"passes dimensions only for supported OpenAI model %s",
		async (modelName, expectedDimensions) => {
			const { runtime } = makeRuntime({
				EMBEDDING_PROVIDER: "openai",
				TEXT_EMBEDDING_MODEL: modelName,
				EMBEDDING_DIMENSION: 768,
				OPENAI_API_KEY: "openai-key",
				OPENAI_BASE_URL: "https://openai.example/v1",
			});

			await expect(generateTextEmbedding(runtime, "embed me")).resolves.toEqual(
				{
					embedding: [0.25, 0.75],
				},
			);
			expect(createOpenAI).toHaveBeenCalledWith({
				apiKey: "openai-key",
				baseURL: "https://openai.example/v1",
			});
			expect(aiEmbedMock).toHaveBeenCalledWith({
				model: { provider: "openai-embedding", modelName },
				value: "embed me",
				...(expectedDimensions === undefined
					? {}
					: { dimensions: expectedDimensions }),
			});
		},
	);

	test("uses Google's embedding model and installs its configured API key", async () => {
		const { runtime } = makeRuntime({
			EMBEDDING_PROVIDER: "google",
			TEXT_EMBEDDING_MODEL: "text-embedding-004",
			GOOGLE_API_KEY: "google-key",
		});

		await expect(generateTextEmbedding(runtime, "embed me")).resolves.toEqual({
			embedding: [0.25, 0.75],
		});
		expect(google.textEmbeddingModel).toHaveBeenCalledWith(
			"text-embedding-004",
		);
		expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("google-key");
	});
});

describe("generateTextEmbeddingsBatch", () => {
	test("returns an empty result without invoking the model for an empty input", async () => {
		const { runtime, useModel } = localEmbeddingRuntime();

		await expect(generateTextEmbeddingsBatch(runtime, [])).resolves.toEqual([]);
		expect(useModel).not.toHaveBeenCalled();
	});

	test("preserves input order while reporting individual failures", async () => {
		const { runtime, useModel, reportError } = localEmbeddingRuntime();
		useModel.mockImplementation(
			async (_modelType: ModelType, input: { text: string }) => {
				if (input.text === "second") {
					throw new Error("embedding unavailable");
				}
				await new Promise((resolve) =>
					setTimeout(resolve, input.text === "first" ? 5 : 0),
				);
				return [input.text.length];
			},
		);

		const results = await generateTextEmbeddingsBatch(runtime, [
			"first",
			"second",
			"third",
		]);

		expect(results).toEqual([
			{ embedding: [5], success: true, index: 0 },
			{
				embedding: null,
				success: false,
				error: expect.objectContaining({ message: "embedding unavailable" }),
				index: 1,
			},
			{ embedding: [5], success: true, index: 2 },
		]);
		expect(reportError).toHaveBeenCalledWith(
			"DocumentsLlm.batchEmbeddingItem",
			expect.objectContaining({ message: "embedding unavailable" }),
			{ index: 1 },
		);
	});

	test("limits one batch to ten concurrent embedding calls", async () => {
		const { runtime, useModel } = localEmbeddingRuntime();
		let active = 0;
		let peak = 0;
		useModel.mockImplementation(async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 2));
			active--;
			return [1];
		});

		const results = await generateTextEmbeddingsBatch(
			runtime,
			Array.from({ length: 12 }, (_, index) => `item-${index}`),
		);

		expect(results).toHaveLength(12);
		expect(peak).toBe(10);
	});
});

describe("generateText", () => {
	test("rejects a missing model before opening a trajectory", async () => {
		const { runtime } = localEmbeddingRuntime();

		await expect(generateText(runtime, "prompt")).rejects.toThrow(
			"No model name configured for provider: undefined",
		);
		expect(withStandaloneTrajectoryMock).not.toHaveBeenCalled();
	});

	test("rejects an unsupported override provider and preserves provider context", async () => {
		const { runtime } = textRuntime("openai", "configured-model");

		await expect(
			generateText(runtime, "prompt", undefined, {
				provider: "unsupported" as "openai",
				modelName: "override-model",
			}),
		).rejects.toThrow("Unsupported text provider: unsupported");
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ error: expect.any(Error) }),
			"unsupported override-model error",
		);
	});

	test("dispatches OpenAI generation with override values and logs the response", async () => {
		const { runtime } = textRuntime("anthropic", "configured-model");

		await expect(
			generateText(runtime, "user prompt", "system prompt", {
				provider: "openai",
				modelName: "gpt-test",
				maxTokens: 99,
			}),
		).resolves.toEqual(generated);
		expect(aiGenerateTextMock).toHaveBeenCalledWith({
			model: { provider: "openai", modelName: "gpt-test" },
			prompt: "user prompt",
			system: "system prompt",
			temperature: 0.3,
			maxOutputTokens: 99,
		});
		expect(logActiveTrajectoryLlmCallMock).toHaveBeenCalledWith(
			runtime,
			expect.objectContaining({
				actionType: "documents.openai.generate_text",
				model: "gpt-test",
				modelVersion: "provider-model-id",
				response: "generated response",
				promptTokens: 7,
				completionTokens: 3,
			}),
		);
	});

	test("dispatches Google generation and forwards its configured key", async () => {
		const { runtime } = textRuntime("google", "gemini-test");
		vi.mocked(runtime.getSetting).mockImplementation((key: string) => {
			if (key === "GOOGLE_API_KEY") return "google-key";
			return {
				EMBEDDING_PROVIDER: "local",
				TEXT_EMBEDDING_MODEL: "local-embedding",
				TEXT_PROVIDER: "google",
				TEXT_MODEL: "gemini-test",
				MAX_OUTPUT_TOKENS: 321,
			}[key];
		});

		await expect(generateText(runtime, "prompt", "system")).resolves.toEqual(
			generated,
		);
		expect(google).toHaveBeenCalledWith("gemini-test");
		expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("google-key");
	});

	test("retries Anthropic rate limits and then returns the observed response", async () => {
		const { runtime } = textRuntime("anthropic", "claude-test");
		aiGenerateTextMock
			.mockRejectedValueOnce(
				Object.assign(new Error("rate limit"), { status: 429 }),
			)
			.mockResolvedValueOnce(generated);

		await expect(generateText(runtime, "prompt")).resolves.toEqual(generated);
		expect(createAnthropic).toHaveBeenCalled();
		expect(aiGenerateTextMock).toHaveBeenCalledTimes(2);
	});

	test("does not retry a non-rate-limit Anthropic failure", async () => {
		const { runtime } = textRuntime("anthropic", "claude-test");
		aiGenerateTextMock.mockRejectedValueOnce(new Error("provider offline"));

		await expect(generateText(runtime, "prompt")).rejects.toThrow(
			"provider offline",
		);
		expect(aiGenerateTextMock).toHaveBeenCalledTimes(1);
	});

	test("uses the standard OpenRouter request for models without cache support", async () => {
		const { runtime } = textRuntime("openrouter", "mistral-test");

		await expect(
			generateText(runtime, "prompt", "system", {
				cacheDocument: "cache me",
			}),
		).resolves.toEqual(generated);
		expect(createOpenRouter).toHaveBeenCalled();
		expect(aiGenerateTextMock).toHaveBeenCalledWith({
			model: { provider: "openrouter", modelName: "mistral-test" },
			prompt: "prompt",
			system: "system",
			temperature: 0.3,
			maxOutputTokens: 321,
			providerOptions: { openrouter: { usage: { include: true } } },
		});
	});

	test("builds Claude cache-control messages from an explicit document", async () => {
		const { runtime } = textRuntime("openrouter", "claude-3-test");

		await generateText(runtime, "question", "instructions", {
			cacheDocument: "long document",
		});

		expect(aiGenerateTextMock).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{
						role: "system",
						content: [
							{ type: "text", text: "instructions" },
							{
								type: "text",
								text: "long document",
								cache_control: { type: "ephemeral" },
							},
						],
					},
					{
						role: "user",
						content: [{ type: "text", text: "question" }],
					},
				],
			}),
		);
	});

	test("extracts an inline document for Claude caching and removes it from the question", async () => {
		const { runtime } = textRuntime("openrouter", "claude-test");

		await generateText(
			runtime,
			"<document>  cached context  </document>\n\nWhat changed?",
		);

		expect(aiGenerateTextMock).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Document for context:" },
							{
								type: "text",
								text: "cached context",
								cache_control: { type: "ephemeral" },
							},
							{ type: "text", text: "What changed?" },
						],
					},
				],
			}),
		);
	});

	test("builds Gemini cached text from system, document, and stripped prompt", async () => {
		const { runtime } = textRuntime("openrouter", "gemini-2.5-test");

		await generateText(
			runtime,
			"<document>reference</document>\nquestion",
			"instructions",
		);

		expect(aiGenerateTextMock).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "instructions\n\nreference\n\nquestion",
			}),
		);
	});

	test("honors disabled automatic contextual caching", async () => {
		const { runtime } = textRuntime("openrouter", "claude-test");
		const prompt = "<document>reference</document>\nquestion";

		await generateText(runtime, prompt, undefined, {
			autoCacheContextualRetrieval: false,
		});

		expect(aiGenerateTextMock).toHaveBeenCalledWith(
			expect.objectContaining({ prompt }),
		);
		expect(aiGenerateTextMock.mock.calls[0]?.[0]).not.toHaveProperty(
			"messages",
		);
	});
});
