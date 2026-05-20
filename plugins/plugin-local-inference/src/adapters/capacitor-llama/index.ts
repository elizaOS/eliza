/**
 * Local-AI plugin backed by the Capacitor-llama adapter.
 *
 * This is the unified replacement for the deprecated capacitor-llama adapter.
 * It registers a `Plugin` that handles `ModelType.TEXT_SMALL/LARGE/EMBEDDING`
 * via `CapacitorLlamaContext` — a single contract that resolves to
 * `llama-cpp-capacitor` on mobile and the desktop bun:ffi adapter on
 * desktop. Both load THE vendored llama.cpp at
 * `plugins/plugin-local-inference/native/llama.cpp/` (Wave 2's cross-compiles).
 *
 * `capacitor-llama` is NEVER imported here.
 */

import fs from "node:fs";
import os from "node:os";
import path, { basename } from "node:path";
import type {
	DetokenizeTextParams,
	EventPayload,
	GenerateTextParams,
	ImageDescriptionParams,
	ImageDescriptionResult,
	JSONSchema,
	ModelTypeName,
	TextEmbeddingParams,
	TextStreamResult,
	TextToSpeechParams,
	TokenizeTextParams,
	TokenUsage,
	ToolDefinition,
	TranscriptionParams,
} from "@elizaos/core";
import {
	EventType,
	type IAgentRuntime,
	logger,
	ModelType,
	type Plugin,
} from "@elizaos/core";
import {
	createLocalInferenceModelHandlers,
	isLocalInferenceUnavailableError,
} from "../..";
import { type Config, validateConfig } from "./environment";
import { initCapacitorLlama } from "./loader";
import {
	applyStructuredPlan,
	extractToolCalls,
	planStructuredRequest,
	type ToolCallResult,
} from "./structured-output";
import { streamCapacitorPrompt } from "./text-streaming";
import {
	type CapacitorLlamaCompletionParams,
	type CapacitorLlamaContext,
	type EmbeddingModelSpec,
	MODEL_SPECS,
	type ModelSpec,
} from "./types";

const DEFAULT_LOCAL_SYSTEM_PROMPT = "Respond to the current request only.";

interface ContextEntry {
	ctx: CapacitorLlamaContext;
	systemPrompt: string;
}

interface LocalGenerationResult {
	text: string;
	toolCalls: ToolCallResult[];
	finishReason: string | undefined;
}

type LocalGenerateTextParams = GenerateTextParams & {
	modelType?: ModelTypeName;
};

type LocalGenerationOutput = LocalGenerationResult | TextStreamResult;

type LocalInferenceRouteResult<T> =
	| { handled: true; value: T }
	| { handled: false };

function isStreamResult(
	value: LocalGenerationOutput,
): value is TextStreamResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"textStream" in value &&
		"text" in value &&
		"usage" in value &&
		"finishReason" in value
	);
}

type LocalNativeTextModelResult = string & {
	text: string;
	toolCalls: ToolCallResult[];
	finishReason?: string;
};

function getObjectField(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

function extractEmbeddingText(
	params: TextEmbeddingParams | string | null,
): string | null {
	if (typeof params === "string") return params;
	const text = getObjectField(params, "text");
	return typeof text === "string" ? text : null;
}

type NormalizedUsage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	estimated?: boolean;
};

function estimateTokenCount(text: string): number {
	return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function estimateUsage(prompt: string, response: unknown): NormalizedUsage {
	const responseText =
		typeof response === "string"
			? response
			: (() => {
					try {
						return JSON.stringify(response);
					} catch {
						return String(response);
					}
				})();
	const promptTokens = estimateTokenCount(prompt);
	const completionTokens = estimateTokenCount(responseText);
	return {
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
		estimated: true,
	};
}

function normalizedToTokenUsage(usage: NormalizedUsage): TokenUsage {
	return {
		promptTokens: usage.promptTokens,
		completionTokens: usage.completionTokens,
		totalTokens: usage.totalTokens,
	};
}

function estimateEmbeddingUsage(text: string): NormalizedUsage {
	const promptTokens = estimateTokenCount(text);
	return {
		promptTokens,
		completionTokens: 0,
		totalTokens: promptTokens,
		estimated: true,
	};
}

function stripThinkTags(text: string): string {
	return text.includes("<think>")
		? text.replace(/<think>[\s\S]*?<\/think>\n?/g, "")
		: text;
}

function wantsNativeShape(params: GenerateTextParams): boolean {
	if (params.tools && params.tools.length > 0) return true;
	if (params.responseSchema) return true;
	if (params.toolChoice) return true;
	if (
		params.responseFormat &&
		typeof params.responseFormat === "object" &&
		params.responseFormat.type === "json_object"
	) {
		return true;
	}
	return false;
}

function shouldFallbackFromLocalInference(error: unknown): boolean {
	return (
		isLocalInferenceUnavailableError(error) &&
		("reason" in error
			? error.reason === "backend_unavailable" ||
				error.reason === "capability_unavailable"
			: true)
	);
}

async function tryLocalInferenceModel<T>(
	runtime: IAgentRuntime,
	modelType: ModelTypeName,
	params: unknown,
): Promise<LocalInferenceRouteResult<T>> {
	const handler =
		localInferenceModelHandlers[
			modelType as keyof typeof localInferenceModelHandlers
		];
	if (typeof handler !== "function") return { handled: false };

	try {
		const value = await handler(runtime, params as never);
		return { handled: true, value: value as T };
	} catch (error) {
		if (shouldFallbackFromLocalInference(error)) {
			logger.debug(
				{
					modelType,
					reason:
						isLocalInferenceUnavailableError(error) && "reason" in error
							? error.reason
							: "unknown",
				},
				"[plugin-local-ai] Local-inference route unavailable; falling back to legacy compatibility path.",
			);
			return { handled: false };
		}
		throw error;
	}
}

function buildNativeResult(
	result: LocalGenerationResult,
): LocalNativeTextModelResult {
	const nativeResult = {
		text: result.text,
		toolCalls: result.toolCalls,
		...(result.finishReason ? { finishReason: result.finishReason } : {}),
	};
	return nativeResult as unknown as LocalNativeTextModelResult;
}

function getLocalModelLabel(
	runtime: IAgentRuntime,
	type: ModelTypeName,
): string {
	const config = validateConfig();
	if (type === ModelType.TEXT_EMBEDDING) {
		return String(
			runtime.getSetting("LOCAL_EMBEDDING_MODEL") ||
				config.LOCAL_EMBEDDING_MODEL,
		);
	}
	if (type === ModelType.TEXT_LARGE) {
		return String(
			runtime.getSetting("LOCAL_LARGE_MODEL") || config.LOCAL_LARGE_MODEL,
		);
	}
	return String(
		runtime.getSetting("LOCAL_SMALL_MODEL") || config.LOCAL_SMALL_MODEL,
	);
}

function emitModelUsed(
	runtime: IAgentRuntime,
	type: ModelTypeName,
	model: string,
	usage: NormalizedUsage,
): void {
	void runtime.emitEvent(
		EventType.MODEL_USED as string,
		{
			runtime,
			source: "local-ai",
			provider: "local-ai",
			type,
			model,
			modelName: model,
			tokens: {
				prompt: usage.promptTokens,
				completion: usage.completionTokens,
				total: usage.totalTokens,
				...(usage.estimated ? { estimated: true } : {}),
			},
			...(usage.estimated ? { usageEstimated: true } : {}),
		} as EventPayload,
	);
}

/**
 * Singleton manager. Holds one Capacitor context per `ModelType` (small,
 * large, embedding), plus the resolved environment configuration and model
 * paths. The KV cache survives between turns inside `CapacitorLlamaContext`
 * because we reuse the same handle.
 */
class LocalAIManager {
	private static instance: LocalAIManager | null = null;
	private smallCtx: ContextEntry | null = null;
	private mediumCtx: ContextEntry | null = null;
	private embeddingCtx: CapacitorLlamaContext | null = null;
	private modelPath!: string;
	private mediumModelPath!: string;
	private embeddingModelPath!: string;
	private cacheDir!: string;
	private activeModelConfig: ModelSpec;
	private embeddingModelConfig: EmbeddingModelSpec;
	private config: Config | null = null;
	private environmentInitialized = false;
	private environmentInitializingPromise: Promise<void> | null = null;
	private modelsDir!: string;

	private constructor() {
		this.config = validateConfig();
		this._setupCacheDir();
		this.activeModelConfig = MODEL_SPECS.small;
		this.embeddingModelConfig = MODEL_SPECS.embedding;
	}

	private _setupModelsDir(): void {
		const modelsDirEnv =
			this.config?.MODELS_DIR?.trim() || process.env.MODELS_DIR?.trim();
		this.modelsDir = modelsDirEnv
			? path.resolve(modelsDirEnv)
			: path.join(os.homedir(), ".eliza", "models");
		if (!fs.existsSync(this.modelsDir)) {
			fs.mkdirSync(this.modelsDir, { recursive: true });
		}
		logger.info({ modelsDir: this.modelsDir }, "Models directory ready");
	}

	private _setupCacheDir(): void {
		const cacheDirEnv =
			this.config?.CACHE_DIR?.trim() || process.env.CACHE_DIR?.trim();
		this.cacheDir = cacheDirEnv
			? path.resolve(cacheDirEnv)
			: path.join(os.homedir(), ".eliza", "cache");
		if (!fs.existsSync(this.cacheDir)) {
			fs.mkdirSync(this.cacheDir, { recursive: true });
		}
		logger.info({ cacheDir: this.cacheDir }, "Cache directory ready");
	}

	public static getInstance(): LocalAIManager {
		if (!LocalAIManager.instance) {
			LocalAIManager.instance = new LocalAIManager();
		}
		return LocalAIManager.instance;
	}

	public async initializeEnvironment(): Promise<void> {
		if (this.environmentInitialized) return;
		if (this.environmentInitializingPromise) {
			await this.environmentInitializingPromise;
			return;
		}
		this.environmentInitializingPromise = (async () => {
			this.config = await validateConfig();
			this._setupModelsDir();
			this.modelPath = path.join(this.modelsDir, this.config.LOCAL_SMALL_MODEL);
			this.mediumModelPath = path.join(
				this.modelsDir,
				this.config.LOCAL_LARGE_MODEL,
			);
			this.embeddingModelPath = path.join(
				this.modelsDir,
				this.config.LOCAL_EMBEDDING_MODEL,
			);
			logger.info(
				{
					small: basename(this.modelPath),
					medium: basename(this.mediumModelPath),
					embedding: basename(this.embeddingModelPath),
				},
				"Model paths resolved",
			);
			this.environmentInitialized = true;
		})();
		await this.environmentInitializingPromise;
	}

	public getActiveModelConfig(): ModelSpec {
		return this.activeModelConfig;
	}

	private async resolveCtx(
		modelType: ModelTypeName,
		systemPrompt: string,
	): Promise<ContextEntry> {
		const slot = modelType === ModelType.TEXT_LARGE ? "medium" : "small";
		const existing = slot === "medium" ? this.mediumCtx : this.smallCtx;
		if (existing && existing.systemPrompt === systemPrompt) {
			if (slot === "medium") this.activeModelConfig = MODEL_SPECS.medium;
			else this.activeModelConfig = MODEL_SPECS.small;
			return existing;
		}
		if (existing) {
			// System prompt changed — release the cached context.
			try {
				await existing.ctx.release();
			} catch (err) {
				logger.warn(
					{ err: err instanceof Error ? err.message : String(err) },
					"[plugin-local-ai] Failed releasing stale context",
				);
			}
			if (slot === "medium") this.mediumCtx = null;
			else this.smallCtx = null;
		}

		const spec = slot === "medium" ? MODEL_SPECS.medium : MODEL_SPECS.small;
		const modelPath = slot === "medium" ? this.mediumModelPath : this.modelPath;
		const ctx = await initCapacitorLlama({
			model: modelPath,
			n_ctx: spec.contextSize,
			n_gpu_layers: 999,
			use_mmap: true,
		});
		const entry: ContextEntry = { ctx, systemPrompt };
		if (slot === "medium") this.mediumCtx = entry;
		else this.smallCtx = entry;
		this.activeModelConfig = spec;
		return entry;
	}

	async initialize(
		modelType: ModelTypeName = ModelType.TEXT_SMALL,
	): Promise<void> {
		await this.initializeEnvironment();
		await this.resolveCtx(modelType, DEFAULT_LOCAL_SYSTEM_PROMPT);
	}

	public async initializeEmbedding(): Promise<void> {
		await this.initializeEnvironment();
		if (this.embeddingCtx) return;
		this.embeddingCtx = await initCapacitorLlama({
			model: this.embeddingModelPath,
			n_ctx: this.embeddingModelConfig.contextSize,
			n_gpu_layers: 0,
			embedding: true,
			pooling_type: "mean",
		});
	}

	async generateEmbedding(text: string): Promise<number[]> {
		await this.initializeEmbedding();
		if (!this.embeddingCtx) {
			throw new Error("Failed to initialize embedding context");
		}
		const result = await this.embeddingCtx.embedding(text, {
			embd_normalize: 2,
		});
		return result.embedding;
	}

	async generateText(
		params: LocalGenerateTextParams,
	): Promise<LocalGenerationOutput> {
		await this.initializeEnvironment();
		const modelType = params.modelType ?? ModelType.TEXT_SMALL;
		const systemPrompt = params.system?.trim() || DEFAULT_LOCAL_SYSTEM_PROMPT;
		const entry = await this.resolveCtx(modelType, systemPrompt);
		const prompt = params.prompt ?? "";

		const toolChoiceLabel =
			typeof params.toolChoice === "string"
				? params.toolChoice
				: params.toolChoice && typeof params.toolChoice === "object"
					? ((params.toolChoice as { name?: string }).name ?? undefined)
					: undefined;
		const plan = planStructuredRequest({
			tools: params.tools as readonly ToolDefinition[] | undefined,
			responseSchema: params.responseSchema as JSONSchema | undefined,
			responseFormat: params.responseFormat,
			toolChoice: toolChoiceLabel,
		});

		const baseParams: CapacitorLlamaCompletionParams = {
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: prompt },
			],
			jinja: true,
			n_predict: params.maxTokens ?? 8192,
			temperature: params.temperature ?? 0.7,
			top_p: params.topP ?? 0.9,
			penalty_repeat: 1.2,
			penalty_freq: 0.7,
			penalty_present: 0.7,
			stop: params.stopSequences ?? [],
		};
		const fullParams = applyStructuredPlan(baseParams, plan);

		if (plan.kind === "tools") {
			const result = await entry.ctx.completion(fullParams);
			const toolCalls = extractToolCalls(result);
			const text = stripThinkTags(result.content || result.text);
			return {
				text,
				toolCalls,
				finishReason: result.stopped_eos ? "stop" : undefined,
			};
		}

		if (plan.kind === "schema" || plan.kind === "json_object") {
			const result = await entry.ctx.completion(fullParams);
			const text = stripThinkTags(result.content || result.text);
			return {
				text,
				toolCalls: [],
				finishReason: result.stopped_eos ? "stop" : undefined,
			};
		}

		const streamParams = params as GenerateTextParams & {
			onStreamChunk?: unknown;
		};
		const wantsStreaming =
			params.stream === true ||
			typeof streamParams.onStreamChunk === "function";

		if (wantsStreaming) {
			return streamCapacitorPrompt({
				ctx: entry.ctx,
				params: fullParams,
				estimateUsage: (p, fullText) =>
					normalizedToTokenUsage(estimateUsage(p, fullText)),
				postProcess: stripThinkTags,
			});
		}

		const result = await entry.ctx.completion(fullParams);
		const text = stripThinkTags(result.content || result.text);
		return {
			text,
			toolCalls: [],
			finishReason: result.stopped_eos ? "stop" : undefined,
		};
	}
}

function finalizeTextResult(
	runtime: IAgentRuntime,
	modelType: ModelTypeName,
	params: GenerateTextParams,
	result: LocalGenerationOutput,
): string | LocalNativeTextModelResult | TextStreamResult {
	if (isStreamResult(result)) {
		const modelLabel = getLocalModelLabel(runtime, modelType);
		void result.usage.then((usage) => {
			if (!usage) return;
			emitModelUsed(runtime, modelType, modelLabel, {
				promptTokens: usage.promptTokens,
				completionTokens: usage.completionTokens,
				totalTokens: usage.totalTokens,
				estimated: true,
			});
		});
		return result;
	}

	emitModelUsed(
		runtime,
		modelType,
		getLocalModelLabel(runtime, modelType),
		estimateUsage(params.prompt ?? "", result.text),
	);
	return wantsNativeShape(params) ? buildNativeResult(result) : result.text;
}

const localInferenceModelHandlers = createLocalInferenceModelHandlers();
const localAIManager = LocalAIManager.getInstance();

export const localAiPlugin: Plugin = {
	name: "local-ai",
	description:
		"Local AI plugin using Eliza-1 GGUF models via the canonical Capacitor-llama adapter (mobile + desktop FFI; no node-llama-cpp).",

	async init(
		_config: Record<string, unknown> | undefined,
		_runtime: IAgentRuntime,
	) {
		logger.info("Initializing Local AI plugin (Capacitor-llama backend)");
		await localAIManager.initializeEnvironment();
		const config = validateConfig();
		const modelsDir =
			config.MODELS_DIR || path.join(os.homedir(), ".eliza", "models");
		if (!fs.existsSync(modelsDir)) {
			logger.warn(
				{ modelsDir },
				"Models directory missing; will be created on first download",
			);
		}
		const smallModelPath = path.join(modelsDir, config.LOCAL_SMALL_MODEL);
		const largeModelPath = path.join(modelsDir, config.LOCAL_LARGE_MODEL);
		const embeddingModelPath = path.join(
			modelsDir,
			config.LOCAL_EMBEDDING_MODEL,
		);
		const modelsExist = {
			small: fs.existsSync(smallModelPath),
			large: fs.existsSync(largeModelPath),
			embedding: fs.existsSync(embeddingModelPath),
		};
		logger.info(modelsExist, "Local AI model file presence");
		logger.info("Local AI plugin initialized");
	},

	models: {
		[ModelType.TEXT_SMALL]: async (
			runtime: IAgentRuntime,
			params: GenerateTextParams,
		) => {
			if (!wantsNativeShape(params)) {
				const routed = await tryLocalInferenceModel<string>(
					runtime,
					ModelType.TEXT_SMALL,
					params,
				);
				if (routed.handled) return routed.value;
			}
			await localAIManager.initializeEnvironment();
			const result = await localAIManager.generateText({
				...params,
				modelType: ModelType.TEXT_SMALL,
			});
			return finalizeTextResult(runtime, ModelType.TEXT_SMALL, params, result);
		},

		[ModelType.TEXT_LARGE]: async (
			runtime: IAgentRuntime,
			params: GenerateTextParams,
		) => {
			if (!wantsNativeShape(params)) {
				const routed = await tryLocalInferenceModel<string>(
					runtime,
					ModelType.TEXT_LARGE,
					params,
				);
				if (routed.handled) return routed.value;
			}
			await localAIManager.initializeEnvironment();
			const result = await localAIManager.generateText({
				...params,
				modelType: ModelType.TEXT_LARGE,
			});
			return finalizeTextResult(runtime, ModelType.TEXT_LARGE, params, result);
		},

		[ModelType.TEXT_EMBEDDING]: async (
			runtime: IAgentRuntime,
			params: TextEmbeddingParams | string | null,
		) => {
			const text = extractEmbeddingText(params);
			if (!text) {
				return new Array(1024).fill(0);
			}
			const routed = await tryLocalInferenceModel<number[]>(
				runtime,
				ModelType.TEXT_EMBEDDING,
				params,
			);
			if (routed.handled) return routed.value;

			const embedding = await localAIManager.generateEmbedding(text);
			emitModelUsed(
				runtime,
				ModelType.TEXT_EMBEDDING,
				getLocalModelLabel(runtime, ModelType.TEXT_EMBEDDING),
				estimateEmbeddingUsage(text),
			);
			return embedding;
		},

		[ModelType.TEXT_TOKENIZER_ENCODE]: async (
			runtime: IAgentRuntime,
			params: TokenizeTextParams,
		) => {
			const routed = await tryLocalInferenceModel<number[]>(
				runtime,
				ModelType.TEXT_TOKENIZER_ENCODE,
				params,
			);
			if (routed.handled) return routed.value;
			throw new Error(
				"plugin-local-ai tokenizer has been migrated to @elizaos/plugin-local-inference. " +
					"Enable an Eliza-1 bundle and route via plugin-local-inference for tokenization.",
			);
		},

		[ModelType.TEXT_TOKENIZER_DECODE]: async (
			runtime: IAgentRuntime,
			params: DetokenizeTextParams,
		) => {
			const routed = await tryLocalInferenceModel<string>(
				runtime,
				ModelType.TEXT_TOKENIZER_DECODE,
				params,
			);
			if (routed.handled) return routed.value;
			throw new Error(
				"plugin-local-ai detokenizer has been migrated to @elizaos/plugin-local-inference. " +
					"Enable an Eliza-1 bundle and route via plugin-local-inference for detokenization.",
			);
		},

		[ModelType.IMAGE_DESCRIPTION]: async (
			runtime: IAgentRuntime,
			params: ImageDescriptionParams | string,
		) => {
			const routed = await tryLocalInferenceModel<ImageDescriptionResult>(
				runtime,
				ModelType.IMAGE_DESCRIPTION,
				params,
			);
			if (routed.handled) return routed.value;
			throw new Error(
				"plugin-local-ai image description has been migrated to @elizaos/plugin-local-inference.",
			);
		},

		[ModelType.TRANSCRIPTION]: async (
			runtime: IAgentRuntime,
			params: TranscriptionParams | Buffer | string,
		) => {
			const routed = await tryLocalInferenceModel<string>(
				runtime,
				ModelType.TRANSCRIPTION,
				params,
			);
			if (routed.handled) return routed.value;
			throw new Error(
				"plugin-local-ai transcription has been migrated to @elizaos/plugin-local-inference.",
			);
		},

		[ModelType.TEXT_TO_SPEECH]: async (
			runtime: IAgentRuntime,
			params: TextToSpeechParams | string,
		) => {
			const routed = await tryLocalInferenceModel<Uint8Array>(
				runtime,
				ModelType.TEXT_TO_SPEECH,
				params,
			);
			if (routed.handled) return routed.value;
			throw new Error(
				"plugin-local-ai TTS has been migrated to @elizaos/plugin-local-inference.",
			);
		},
	},
};

export default localAiPlugin;
