import {
	generateText as aiGenerateText,
	type EmbeddingModel,
	embed,
	type ModelMessage,
} from "ai";
import { logger } from "../../logger";
import {
	logActiveTrajectoryLlmCall,
	withStandaloneTrajectory,
} from "../../trajectory-utils";
import { type IAgentRuntime, ModelType } from "../../types";
import { BatchProcessor } from "../../utils/batch-queue";

type AIModel = Parameters<typeof aiGenerateText>[0]["model"];
type AIEmbeddingModel = EmbeddingModel;

interface TextGenerationResult {
	text: string;
	usage: {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
	};
	finishReason?: string;
	response?: {
		id?: string;
		modelId?: string;
	};
}

import { validateModelConfig } from "./config";
import type { ModelConfig, TextGenerationOptions } from "./types";

function importAiProvider<T>(specifier: string): Promise<T> {
	return import(/* @vite-ignore */ specifier) as Promise<T>;
}

type CreateAnthropic = (settings: {
	apiKey: string;
	baseURL?: string;
}) => (modelName: string) => AIModel;

type CreateOpenAI = (settings: { apiKey: string; baseURL?: string }) => {
	chat: (modelName: string) => AIModel;
	embedding: (modelName: string) => AIEmbeddingModel;
};

type GoogleProvider = {
	(modelName: string): AIModel;
	textEmbeddingModel(modelName: string): AIEmbeddingModel;
};

type CreateOpenRouter = (settings: { apiKey: string; baseURL?: string }) => {
	chat: (modelName: string) => AIModel;
};

type LoggedTextGenerationOptions = {
	runtime: IAgentRuntime;
	modelName: string;
	systemPrompt: string;
	userPrompt: string;
	maxTokens: number;
	temperature: number;
	purpose: string;
	actionType: string;
	invoke: () => Promise<TextGenerationResult>;
};

function serializeMessages(messages: ModelMessage[]): string {
	return messages
		.map((message, index) => {
			const content = Array.isArray(message.content)
				? message.content
						.map((part) => {
							if (
								part &&
								typeof part === "object" &&
								"text" in part &&
								typeof part.text === "string"
							) {
								return part.text;
							}
							return "[non-text content]";
						})
						.join("\n")
				: String(message.content ?? "");
			return `message ${index + 1} (${message.role}):\n${content}`;
		})
		.join("\n\n");
}

async function generateLoggedText({
	runtime,
	modelName,
	systemPrompt,
	userPrompt,
	maxTokens,
	temperature,
	purpose,
	actionType,
	invoke,
}: LoggedTextGenerationOptions): Promise<TextGenerationResult> {
	const startedAt = Date.now();
	const result = await invoke();

	logActiveTrajectoryLlmCall?.(runtime, {
		model: modelName,
		modelVersion: result.response?.modelId,
		systemPrompt,
		userPrompt,
		response: result.text,
		temperature,
		maxTokens,
		purpose,
		actionType,
		latencyMs: Date.now() - startedAt,
		promptTokens: result.usage.inputTokens,
		completionTokens: result.usage.outputTokens,
	});

	return result;
}

export async function generateTextEmbedding(
	runtime: IAgentRuntime,
	text: string,
): Promise<{ embedding: number[] }> {
	const config = validateModelConfig(runtime);
	const dimensions = config.EMBEDDING_DIMENSION;

	try {
		if (config.EMBEDDING_PROVIDER === "local") {
			return await generateLocalEmbedding(runtime, text);
		} else if (config.EMBEDDING_PROVIDER === "openai") {
			return await generateOpenAIEmbedding(text, config, dimensions);
		} else if (config.EMBEDDING_PROVIDER === "google") {
			return await generateGoogleEmbedding(text, config);
		}

		throw new Error(
			`Unsupported embedding provider: ${config.EMBEDDING_PROVIDER}`,
		);
	} catch (error) {
		logger.error({ error }, `${config.EMBEDDING_PROVIDER} embedding error`);
		throw error;
	}
}

async function generateLocalEmbedding(
	runtime: IAgentRuntime,
	text: string,
): Promise<{ embedding: number[] }> {
	const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
		text,
	});

	if (!Array.isArray(embedding)) {
		throw new Error(
			"Local embedding model returned an invalid embedding payload",
		);
	}

	return { embedding };
}

export async function generateTextEmbeddingsBatch(
	runtime: IAgentRuntime,
	texts: string[],
	batchSize: number = 20,
): Promise<
	Array<{
		embedding: number[] | null;
		success: boolean;
		error?: unknown;
		index: number;
	}>
> {
	const results: Array<{
		embedding: number[] | null;
		success: boolean;
		error?: unknown;
		index: number;
	}> = [];

	for (let i = 0; i < texts.length; i += batchSize) {
		const batch = texts.slice(i, i + batchSize);
		const batchStartIndex = i;

		type BatchItem = { text: string; globalIndex: number; batchPos: number };
		const items: BatchItem[] = batch.map((text, batchIndex) => ({
			text,
			globalIndex: batchStartIndex + batchIndex,
			batchPos: batchIndex,
		}));
		const slot: Array<{
			embedding: number[] | null;
			success: boolean;
			error?: unknown;
			index: number;
		} | null> = batch.map(() => null);

		// Note: BatchProcessor is used here purely as a concurrency limiter (semaphore).
		// Errors are caught internally and written to `slot`, so retries and onExhausted are bypassed.
		const processor = new BatchProcessor<BatchItem>({
			maxParallel: 10,
			maxRetriesAfterFailure: 0,
			process: async (item) => {
				try {
					const result = await generateTextEmbedding(runtime, item.text);
					slot[item.batchPos] = {
						embedding: result.embedding,
						success: true,
						index: item.globalIndex,
					};
				} catch (error) {
					logger.error(
						{ error },
						`Embedding error for item ${item.globalIndex}`,
					);
					slot[item.batchPos] = {
						embedding: null,
						success: false,
						error,
						index: item.globalIndex,
					};
				}
			},
		});
		await processor.processBatch(items);
		for (let j = 0; j < slot.length; j++) {
			const row = slot[j];
			if (row) {
				results.push(row);
			}
		}

		if (i + batchSize < texts.length) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	return results;
}

async function generateOpenAIEmbedding(
	text: string,
	config: ModelConfig,
	dimensions: number,
): Promise<{ embedding: number[] }> {
	const { createOpenAI } = await importAiProvider<{
		createOpenAI: CreateOpenAI;
	}>("@ai-sdk/openai");
	const openai = createOpenAI({
		apiKey: config.OPENAI_API_KEY as string,
		baseURL: config.OPENAI_BASE_URL,
	});

	const modelInstance = openai.embedding(config.TEXT_EMBEDDING_MODEL);

	const embedOptions: {
		model: ReturnType<typeof openai.embedding>;
		value: string;
		dimensions?: number;
	} = {
		model: modelInstance,
		value: text,
	};

	if (
		dimensions &&
		["text-embedding-3-small", "text-embedding-3-large"].includes(
			config.TEXT_EMBEDDING_MODEL,
		)
	) {
		embedOptions.dimensions = dimensions;
	}

	const { embedding, usage } = await embed(embedOptions);

	const totalTokens = (usage as { totalTokens?: number })?.totalTokens;
	logger.debug(
		`OpenAI embedding ${config.TEXT_EMBEDDING_MODEL}${embedOptions.dimensions ? ` (${embedOptions.dimensions}D)` : ""}: ${totalTokens || 0} tokens`,
	);

	return { embedding };
}

async function generateGoogleEmbedding(
	text: string,
	config: ModelConfig,
): Promise<{ embedding: number[] }> {
	const { google: googleProvider } = await importAiProvider<{
		google: GoogleProvider;
	}>("@ai-sdk/google");
	if (config.GOOGLE_API_KEY) {
		process.env.GOOGLE_GENERATIVE_AI_API_KEY = config.GOOGLE_API_KEY;
	}

	const modelInstance = googleProvider.textEmbeddingModel(
		config.TEXT_EMBEDDING_MODEL,
	);

	const { embedding, usage } = await embed({
		model: modelInstance,
		value: text,
	});

	const totalTokens = (usage as { totalTokens?: number })?.totalTokens;
	logger.debug(
		`Google embedding ${config.TEXT_EMBEDDING_MODEL}: ${totalTokens || 0} tokens`,
	);

	return { embedding };
}

export async function generateText(
	runtime: IAgentRuntime,
	prompt: string,
	system?: string,
	overrideConfig?: TextGenerationOptions,
): Promise<TextGenerationResult> {
	const config = validateModelConfig(runtime);
	const provider = overrideConfig?.provider || config.TEXT_PROVIDER;
	const modelName = overrideConfig?.modelName || config.TEXT_MODEL;
	const maxTokens = overrideConfig?.maxTokens || config.MAX_OUTPUT_TOKENS;
	const autoCacheContextualRetrieval =
		overrideConfig?.autoCacheContextualRetrieval !== false;

	if (!modelName) {
		throw new Error(`No model name configured for provider: ${provider}`);
	}

	try {
		return await withStandaloneTrajectory(
			runtime,
			{
				source: "documents",
				metadata: {
					provider,
					model: modelName,
				},
			},
			async () => {
				switch (provider) {
					case "anthropic":
						return await generateAnthropicText(
							runtime,
							config,
							prompt,
							system,
							modelName,
							maxTokens,
						);
					case "openai":
						return await generateOpenAIText(
							runtime,
							config,
							prompt,
							system,
							modelName,
							maxTokens,
						);
					case "openrouter":
						return await generateOpenRouterText(
							runtime,
							config,
							prompt,
							system,
							modelName,
							maxTokens,
							overrideConfig?.cacheDocument,
							overrideConfig?.cacheOptions,
							autoCacheContextualRetrieval,
						);
					case "google":
						return await generateGoogleText(
							runtime,
							prompt,
							system,
							modelName,
							maxTokens,
							config,
						);
					default:
						throw new Error(`Unsupported text provider: ${provider}`);
				}
			},
		);
	} catch (error) {
		logger.error({ error }, `${provider} ${modelName} error`);
		throw error;
	}
}

async function generateAnthropicText(
	runtime: IAgentRuntime,
	config: ModelConfig,
	prompt: string,
	system: string | undefined,
	modelName: string,
	maxTokens: number,
): Promise<TextGenerationResult> {
	const { createAnthropic } = await importAiProvider<{
		createAnthropic: CreateAnthropic;
	}>("@ai-sdk/anthropic");
	const anthropic = createAnthropic({
		apiKey: config.ANTHROPIC_API_KEY as string,
		baseURL: config.ANTHROPIC_BASE_URL,
	});

	const modelInstance = anthropic(modelName);
	const maxRetries = 3;
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			return await generateLoggedText({
				runtime,
				modelName,
				systemPrompt: system ?? "",
				userPrompt: prompt,
				maxTokens,
				temperature: 0.3,
				purpose: "documents",
				actionType: "documents.anthropic.generate_text",
				invoke: () =>
					aiGenerateText({
						model: modelInstance,
						prompt: prompt,
						system: system,
						temperature: 0.3,
						maxOutputTokens: maxTokens,
					}),
			});
		} catch (error) {
			const errorObj = error as { status?: number; message?: string } | null;
			const isRateLimit =
				errorObj?.status === 429 ||
				errorObj?.message?.includes("rate limit") ||
				errorObj?.message?.includes("429");

			if (isRateLimit && attempt < maxRetries - 1) {
				const delay = 2 ** (attempt + 1) * 1000;
				await new Promise((resolve) => setTimeout(resolve, delay));
				continue;
			}

			throw error;
		}
	}

	throw new Error("Max retries exceeded for Anthropic text generation");
}

async function generateOpenAIText(
	runtime: IAgentRuntime,
	config: ModelConfig,
	prompt: string,
	system: string | undefined,
	modelName: string,
	maxTokens: number,
): Promise<TextGenerationResult> {
	const { createOpenAI } = await importAiProvider<{
		createOpenAI: CreateOpenAI;
	}>("@ai-sdk/openai");
	const openai = createOpenAI({
		apiKey: config.OPENAI_API_KEY as string,
		baseURL: config.OPENAI_BASE_URL,
	});

	const modelInstance = openai.chat(modelName);

	const result = await generateLoggedText({
		runtime,
		modelName,
		systemPrompt: system ?? "",
		userPrompt: prompt,
		maxTokens,
		temperature: 0.3,
		purpose: "documents",
		actionType: "documents.openai.generate_text",
		invoke: () =>
			aiGenerateText({
				model: modelInstance,
				prompt: prompt,
				system: system,
				temperature: 0.3,
				maxOutputTokens: maxTokens,
			}),
	});

	return result;
}

async function generateGoogleText(
	runtime: IAgentRuntime,
	prompt: string,
	system: string | undefined,
	modelName: string,
	maxTokens: number,
	config: ModelConfig,
): Promise<TextGenerationResult> {
	const { google: googleProvider } = await importAiProvider<{
		google: GoogleProvider;
	}>("@ai-sdk/google");
	if (config.GOOGLE_API_KEY) {
		process.env.GOOGLE_GENERATIVE_AI_API_KEY = config.GOOGLE_API_KEY;
	}

	const modelInstance = googleProvider(modelName);

	const result = await generateLoggedText({
		runtime,
		modelName,
		systemPrompt: system ?? "",
		userPrompt: prompt,
		maxTokens,
		temperature: 0.3,
		purpose: "documents",
		actionType: "documents.google.generate_text",
		invoke: () =>
			aiGenerateText({
				model: modelInstance,
				prompt: prompt,
				system: system,
				temperature: 0.3,
				maxOutputTokens: maxTokens,
			}),
	});

	return result;
}

async function generateOpenRouterText(
	runtime: IAgentRuntime,
	config: ModelConfig,
	prompt: string,
	system: string | undefined,
	modelName: string,
	maxTokens: number,
	cacheDocument?: string,
	_cacheOptions?: { type: "ephemeral" },
	autoCacheContextualRetrieval = true,
): Promise<TextGenerationResult> {
	const { createOpenRouter } = await importAiProvider<{
		createOpenRouter: CreateOpenRouter;
	}>("@openrouter/ai-sdk-provider");
	const openrouter = createOpenRouter({
		apiKey: config.OPENROUTER_API_KEY as string,
		baseURL: config.OPENROUTER_BASE_URL,
	});

	const modelInstance = openrouter.chat(modelName);

	const isClaudeModel = modelName.toLowerCase().includes("claude");
	const isGeminiModel = modelName.toLowerCase().includes("gemini");
	const isGemini25Model = modelName.toLowerCase().includes("gemini-2.5");
	const supportsCaching = isClaudeModel || isGeminiModel;

	let documentForCaching: string | undefined = cacheDocument;

	if (!documentForCaching && autoCacheContextualRetrieval && supportsCaching) {
		const docMatch = prompt.match(/<document>([\s\S]*?)<\/document>/);
		if (docMatch?.[1]) {
			documentForCaching = docMatch[1].trim();
		}
	}

	if (documentForCaching && supportsCaching) {
		let promptText = prompt;
		if (promptText.includes("<document>")) {
			promptText = promptText
				.replace(/<document>[\s\S]*?<\/document>/, "")
				.trim();
		}

		if (isClaudeModel) {
			return await generateClaudeWithCaching(
				runtime,
				promptText,
				system,
				modelInstance as AIModel,
				modelName,
				maxTokens,
				documentForCaching,
			);
		} else if (isGeminiModel) {
			return await generateGeminiWithCaching(
				runtime,
				promptText,
				system,
				modelInstance as AIModel,
				modelName,
				maxTokens,
				documentForCaching,
				isGemini25Model,
			);
		}
	}

	return await generateStandardOpenRouterText(
		runtime,
		prompt,
		system,
		modelInstance as AIModel,
		modelName,
		maxTokens,
	);
}

async function generateClaudeWithCaching(
	runtime: IAgentRuntime,
	promptText: string,
	system: string | undefined,
	modelInstance: AIModel,
	modelName: string,
	maxTokens: number,
	documentForCaching: string,
): Promise<TextGenerationResult> {
	const messages = [
		system
			? {
					role: "system",
					content: [
						{
							type: "text",
							text: system,
						},
						{
							type: "text",
							text: documentForCaching,
							cache_control: {
								type: "ephemeral",
							},
						},
					],
				}
			: {
					role: "user",
					content: [
						{
							type: "text",
							text: "Document for context:",
						},
						{
							type: "text",
							text: documentForCaching,
							cache_control: {
								type: "ephemeral",
							},
						},
						{
							type: "text",
							text: promptText,
						},
					],
				},
		system
			? {
					role: "user",
					content: [
						{
							type: "text",
							text: promptText,
						},
					],
				}
			: null,
	].filter(Boolean);

	const result = await generateLoggedText({
		runtime,
		modelName,
		systemPrompt: system ?? "",
		userPrompt: serializeMessages(messages as ModelMessage[]),
		maxTokens,
		temperature: 0.3,
		purpose: "documents",
		actionType: "documents.openrouter.generate_text.claude_cached",
		invoke: () =>
			aiGenerateText({
				model: modelInstance,
				messages: messages as ModelMessage[],
				temperature: 0.3,
				maxOutputTokens: maxTokens,
				providerOptions: {
					openrouter: {
						usage: {
							include: true,
						},
					},
				},
			}),
	});

	logCacheMetrics(result);
	const totalTokens =
		(result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
	logger.debug(
		`OpenRouter ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`,
	);
	return result;
}

async function generateGeminiWithCaching(
	runtime: IAgentRuntime,
	promptText: string,
	system: string | undefined,
	modelInstance: AIModel,
	modelName: string,
	maxTokens: number,
	documentForCaching: string,
	_isGemini25Model: boolean,
): Promise<TextGenerationResult> {
	const geminiSystemPrefix = system ? `${system}\n\n` : "";
	const geminiPrompt = `${geminiSystemPrefix}${documentForCaching}\n\n${promptText}`;

	const result = await generateLoggedText({
		runtime,
		modelName,
		systemPrompt: "",
		userPrompt: geminiPrompt,
		maxTokens,
		temperature: 0.3,
		purpose: "documents",
		actionType: "documents.openrouter.generate_text.gemini_cached",
		invoke: () =>
			aiGenerateText({
				model: modelInstance,
				prompt: geminiPrompt,
				temperature: 0.3,
				maxOutputTokens: maxTokens,
				providerOptions: {
					openrouter: {
						usage: {
							include: true,
						},
					},
				},
			}),
	});

	logCacheMetrics(result);
	const totalTokens =
		(result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
	logger.debug(
		`OpenRouter ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`,
	);
	return result;
}

async function generateStandardOpenRouterText(
	runtime: IAgentRuntime,
	prompt: string,
	system: string | undefined,
	modelInstance: AIModel,
	modelName: string,
	maxTokens: number,
): Promise<TextGenerationResult> {
	const result = await generateLoggedText({
		runtime,
		modelName,
		systemPrompt: system ?? "",
		userPrompt: prompt,
		maxTokens,
		temperature: 0.3,
		purpose: "documents",
		actionType: "documents.openrouter.generate_text",
		invoke: () =>
			aiGenerateText({
				model: modelInstance,
				prompt: prompt,
				system: system,
				temperature: 0.3,
				maxOutputTokens: maxTokens,
				providerOptions: {
					openrouter: {
						usage: {
							include: true,
						},
					},
				},
			}),
	});

	const totalTokens =
		(result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
	logger.debug(
		`OpenRouter ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`,
	);
	return result;
}

function logCacheMetrics(_result: TextGenerationResult): void {}
