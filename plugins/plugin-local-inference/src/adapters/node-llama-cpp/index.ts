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
} from "@elizaos/plugin-local-inference";
import {
	getLlama,
	type Llama,
	LlamaChatSession,
	type LlamaContext,
	type LlamaEmbeddingContext,
	type LlamaModel,
} from "node-llama-cpp";
import { type Config, validateConfig } from "./environment";
import {
	extractToolCalls,
	planStructuredRequest,
	type ToolCallResult,
} from "./structured-output";
import { streamLlamaPrompt } from "./text-streaming";
import { type EmbeddingModelSpec, MODEL_SPECS, type ModelSpec } from "./types";
import { DownloadManager } from "./utils/downloadManager";
import { getPlatformManager } from "./utils/platform";

const DEFAULT_LOCAL_SYSTEM_PROMPT =
	"You are a helpful AI assistant. Respond to the current request only.";

interface ChatSessionEntry {
	context: LlamaContext;
	session: LlamaChatSession;
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

/**
 * When the caller asked for streaming AND the request shape is plain text
 * (no tools, no schema, no JSON-object format), `generateText` returns a
 * `TextStreamResult` instead of a `LocalGenerationResult`. The native
 * dispatch in the model handler unwraps this back to the runtime contract:
 *  - return `TextStreamResult` directly so `runtime.ts:isTextStreamResult`
 *    matches and the SSE pump drains tokens.
 * Tool / schema requests still buffer fully (those paths require the whole
 * response before extraction / validation).
 */
type LocalGenerationOutput = LocalGenerationResult | TextStreamResult;

type LocalInferenceRouteResult<T> =
	| {
			handled: true;
			value: T;
	  }
	| {
			handled: false;
	  };

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
	if (!value || typeof value !== "object") {
		return undefined;
	}
	return (value as Record<string, unknown>)[key];
}

function extractEmbeddingText(
	params: TextEmbeddingParams | string | null,
): string | null {
	if (typeof params === "string") {
		return params;
	}
	const text = getObjectField(params, "text");
	return typeof text === "string" ? text : null;
}

const wordsToPunish = [
	" please",
	" feel",
	" free",
	"!",
	"–",
	"—",
	"?",
	".",
	",",
	"; ",
	" cosmos",
	" tapestry",
	" tapestries",
	" glitch",
	" matrix",
	" cyberspace",
	" troll",
	" questions",
	" topics",
	" discuss",
	" basically",
	" simulation",
	" simulate",
	" universe",
	" like",
	" debug",
	" debugging",
	" wild",
	" existential",
	" juicy",
	" circuits",
	" help",
	" ask",
	" happy",
	" just",
	" cosmic",
	" cool",
	" joke",
	" punchline",
	" fancy",
	" glad",
	" assist",
	" algorithm",
	" Indeed",
	" Furthermore",
	" However",
	" Notably",
	" Therefore",
];

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

/**
 * Project the plugin-local NormalizedUsage onto the public `TokenUsage`
 * contract that `TextStreamResult.usage` resolves to. The `estimated` flag
 * is plugin-local bookkeeping (used to decorate `MODEL_USED` events); core
 * `TokenUsage` has no slot for it.
 */
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
	if (typeof handler !== "function") {
		return { handled: false };
	}

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

class LocalAIManager {
	private static instance: LocalAIManager | null = null;
	private llama: Llama | undefined;
	private smallModel: LlamaModel | undefined;
	private mediumModel: LlamaModel | undefined;
	private embeddingModel: LlamaModel | undefined;
	private embeddingContext: LlamaEmbeddingContext | undefined;
	private chatSessions: Map<ModelTypeName, ChatSessionEntry> = new Map();
	private modelPath!: string;
	private mediumModelPath!: string;
	private embeddingModelPath!: string;
	private cacheDir!: string;
	private downloadManager!: DownloadManager;
	private activeModelConfig: ModelSpec;
	private embeddingModelConfig: EmbeddingModelSpec;
	private config: Config | null = null;

	private smallModelInitialized = false;
	private mediumModelInitialized = false;
	private embeddingInitialized = false;
	private environmentInitialized = false;

	private smallModelInitializingPromise: Promise<void> | null = null;
	private mediumModelInitializingPromise: Promise<void> | null = null;
	private embeddingInitializingPromise: Promise<void> | null = null;
	private environmentInitializingPromise: Promise<void> | null = null;

	private modelsDir!: string;

	private constructor() {
		this.config = validateConfig();

		this._setupCacheDir();

		this.activeModelConfig = MODEL_SPECS.small;
		this.embeddingModelConfig = MODEL_SPECS.embedding;
	}

	private _postValidateInit(): void {
		this._setupModelsDir();

		this.downloadManager = DownloadManager.getInstance(
			this.cacheDir,
			this.modelsDir,
		);
	}

	private _setupModelsDir(): void {
		const modelsDirEnv =
			this.config?.MODELS_DIR?.trim() || process.env.MODELS_DIR?.trim();
		if (modelsDirEnv) {
			this.modelsDir = path.resolve(modelsDirEnv);
			logger.info(
				"Using models directory from MODELS_DIR environment variable:",
				this.modelsDir,
			);
		} else {
			this.modelsDir = path.join(os.homedir(), ".eliza", "models");
			logger.info(
				"MODELS_DIR environment variable not set, using default models directory:",
				this.modelsDir,
			);
		}

		if (!fs.existsSync(this.modelsDir)) {
			fs.mkdirSync(this.modelsDir, { recursive: true });
			logger.debug(
				"Ensured models directory exists (created):",
				this.modelsDir,
			);
		} else {
			logger.debug("Models directory already exists:", this.modelsDir);
		}
	}

	private _setupCacheDir(): void {
		const cacheDirEnv =
			this.config?.CACHE_DIR?.trim() || process.env.CACHE_DIR?.trim();
		if (cacheDirEnv) {
			this.cacheDir = path.resolve(cacheDirEnv);
			logger.info(
				"Using cache directory from CACHE_DIR environment variable:",
				this.cacheDir,
			);
		} else {
			const cacheDir = path.join(os.homedir(), ".eliza", "cache");
			if (!fs.existsSync(cacheDir)) {
				fs.mkdirSync(cacheDir, { recursive: true });
				logger.debug("Ensuring cache directory exists (created):", cacheDir);
			}
			this.cacheDir = cacheDir;
			logger.info(
				"CACHE_DIR environment variable not set, using default cache directory:",
				this.cacheDir,
			);
		}
		if (!fs.existsSync(this.cacheDir)) {
			fs.mkdirSync(this.cacheDir, { recursive: true });
			logger.debug("Ensured cache directory exists (created):", this.cacheDir);
		} else {
			logger.debug("Cache directory already exists:", this.cacheDir);
		}
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
			logger.info("Initializing environment configuration...");

			this.config = await validateConfig();

			this._postValidateInit();

			this.modelPath = path.join(this.modelsDir, this.config.LOCAL_SMALL_MODEL);
			this.mediumModelPath = path.join(
				this.modelsDir,
				this.config.LOCAL_LARGE_MODEL,
			);
			this.embeddingModelPath = path.join(
				this.modelsDir,
				this.config.LOCAL_EMBEDDING_MODEL,
			);

			logger.info("Using small model path:", basename(this.modelPath));
			logger.info("Using medium model path:", basename(this.mediumModelPath));
			logger.info(
				"Using embedding model path:",
				basename(this.embeddingModelPath),
			);

			logger.info("Environment configuration validated and model paths set");

			this.environmentInitialized = true;
			logger.success("Environment initialization complete");
		})();

		await this.environmentInitializingPromise;
	}

	private async downloadModel(
		modelType: ModelTypeName,
		customModelSpec?: ModelSpec,
	): Promise<boolean> {
		let modelSpec: ModelSpec;
		let modelPathToDownload: string;

		await this.initializeEnvironment();

		if (customModelSpec) {
			modelSpec = customModelSpec;
			modelPathToDownload =
				modelType === ModelType.TEXT_EMBEDDING
					? this.embeddingModelPath
					: modelType === ModelType.TEXT_LARGE
						? this.mediumModelPath
						: this.modelPath;
		} else if (modelType === ModelType.TEXT_EMBEDDING) {
			modelSpec = MODEL_SPECS.embedding;
			modelPathToDownload = this.embeddingModelPath; // Use configured path
		} else {
			modelSpec =
				modelType === ModelType.TEXT_LARGE
					? MODEL_SPECS.medium
					: MODEL_SPECS.small;
			modelPathToDownload =
				modelType === ModelType.TEXT_LARGE
					? this.mediumModelPath
					: this.modelPath; // Use configured path
		}

		// Pass the determined path to the download manager
		return await this.downloadManager.downloadModel(
			modelSpec,
			modelPathToDownload,
		);
	}

	async checkPlatformCapabilities(): Promise<void> {
		const platformManager = getPlatformManager();
		await platformManager.initialize();
		const capabilities = platformManager.getCapabilities();

		logger.info(
			{
				platform: capabilities.platform,
				gpu: capabilities.gpu?.type || "none",
				recommendedModel: capabilities.recommendedModelSize,
				supportedBackends: capabilities.supportedBackends,
			},
			"Platform capabilities detected:",
		);
	}

	async initialize(
		modelType: ModelTypeName = ModelType.TEXT_SMALL,
	): Promise<void> {
		await this.initializeEnvironment();
		if (modelType === ModelType.TEXT_LARGE) {
			await this.lazyInitMediumModel();
		} else {
			await this.lazyInitSmallModel();
		}
	}

	public async initializeEmbedding(): Promise<void> {
		try {
			await this.initializeEnvironment();
			logger.info("Initializing embedding model...");
			logger.info("Models directory:", this.modelsDir);

			if (!fs.existsSync(this.modelsDir)) {
				logger.warn(
					"Models directory does not exist, creating it:",
					this.modelsDir,
				);
				fs.mkdirSync(this.modelsDir, { recursive: true });
			}

			await this.downloadModel(ModelType.TEXT_EMBEDDING);

			if (!this.llama) {
				this.llama = await getLlama();
			}

			if (!this.embeddingModel) {
				logger.info("Loading embedding model:", this.embeddingModelPath);

				this.embeddingModel = await this.llama.loadModel({
					modelPath: this.embeddingModelPath,
					gpuLayers: 0,
					vocabOnly: false,
				});

				this.embeddingContext =
					await this.embeddingModel.createEmbeddingContext({
						contextSize: this.embeddingModelConfig.contextSize,
						batchSize: 512,
					});

				logger.success("Embedding model initialized successfully");
			}
		} catch (error) {
			logger.error(
				error instanceof Error ? error : String(error),
				"Failed to initialize embedding model:",
			);
			throw error;
		}
	}

	async generateEmbedding(text: string): Promise<number[]> {
		await this.lazyInitEmbedding();

		if (!this.embeddingModel || !this.embeddingContext) {
			throw new Error("Failed to initialize embedding model");
		}

		logger.info({ textLength: text.length }, "Generating embedding for text");

		const embeddingResult = await this.embeddingContext.getEmbeddingFor(text);

		const mutableEmbedding = [...embeddingResult.vector];

		const normalizedEmbedding = this.normalizeEmbedding(mutableEmbedding);

		logger.info(
			{ dimensions: normalizedEmbedding.length },
			"Embedding generation complete",
		);
		return normalizedEmbedding;
	}

	private normalizeEmbedding(embedding: number[]): number[] {
		const squareSum = embedding.reduce((sum, val) => sum + val * val, 0);
		const norm = Math.sqrt(squareSum);

		if (norm === 0) {
			return embedding;
		}

		return embedding.map((val) => val / norm);
	}

	private async lazyInitEmbedding(): Promise<void> {
		if (this.embeddingInitialized) return;

		if (!this.embeddingInitializingPromise) {
			this.embeddingInitializingPromise = (async () => {
				try {
					await this.initializeEnvironment();

					await this.downloadModel(ModelType.TEXT_EMBEDDING);

					if (!this.llama) {
						this.llama = await getLlama();
					}

					this.embeddingModel = await this.llama.loadModel({
						modelPath: this.embeddingModelPath,
						gpuLayers: 0,
						vocabOnly: false,
					});

					this.embeddingContext =
						await this.embeddingModel.createEmbeddingContext({
							contextSize: this.embeddingModelConfig.contextSize,
							batchSize: 512,
						});

					this.embeddingInitialized = true;
					logger.info("Embedding model initialized successfully");
				} catch (error) {
					logger.error(
						error instanceof Error ? error : String(error),
						"Failed to initialize embedding model:",
					);
					this.embeddingInitializingPromise = null;
					throw error;
				}
			})();
		}

		await this.embeddingInitializingPromise;
	}

	/**
	 * Resolve (and cache) the LlamaContext + LlamaChatSession for a given model
	 * type. Reusing the context preserves the KV cache across turns: subsequent
	 * `prompt` calls reuse the prefix already evaluated, just like the openai
	 * and anthropic providers do via their cache_control / stable-system-prompt
	 * patterns.
	 */
	private async getOrCreateChatSession(
		modelType: ModelTypeName,
		systemPrompt: string,
	): Promise<ChatSessionEntry> {
		const existing = this.chatSessions.get(modelType);
		if (existing && existing.systemPrompt === systemPrompt) {
			return existing;
		}
		if (existing) {
			// System prompt changed — drop the cached session for this model.
			try {
				existing.context.dispose();
			} catch (err) {
				logger.warn(
					err instanceof Error ? err : String(err),
					"[plugin-local-ai] Failed disposing stale context:",
				);
			}
			this.chatSessions.delete(modelType);
		}

		let model: LlamaModel;
		let contextSize: number;
		if (modelType === ModelType.TEXT_LARGE) {
			await this.lazyInitMediumModel();
			if (!this.mediumModel)
				throw new Error("Medium model initialization failed");
			model = this.mediumModel;
			contextSize = MODEL_SPECS.medium.contextSize;
			this.activeModelConfig = MODEL_SPECS.medium;
		} else {
			await this.lazyInitSmallModel();
			if (!this.smallModel)
				throw new Error("Small model initialization failed");
			model = this.smallModel;
			contextSize = MODEL_SPECS.small.contextSize;
			this.activeModelConfig = MODEL_SPECS.small;
		}

		const context = await model.createContext({ contextSize });
		const sequence = context.getSequence();
		const session = new LlamaChatSession({
			contextSequence: sequence,
			systemPrompt,
		});
		const entry: ChatSessionEntry = { context, session, systemPrompt };
		this.chatSessions.set(modelType, entry);
		logger.info(
			{
				modelType,
				contextSize,
				systemPromptLength: systemPrompt.length,
			},
			"[plugin-local-ai] Created new chat session",
		);
		return entry;
	}

	async generateText(
		params: LocalGenerateTextParams,
	): Promise<LocalGenerationOutput> {
		await this.initializeEnvironment();
		const modelType = params.modelType ?? ModelType.TEXT_SMALL;
		const systemPrompt = params.system?.trim() || DEFAULT_LOCAL_SYSTEM_PROMPT;
		const entry = await this.getOrCreateChatSession(modelType, systemPrompt);

		const prompt = params.prompt ?? "";
		if (!this.llama)
			throw new Error("[plugin-local-ai] Llama runtime not initialized");

		const plan = await planStructuredRequest(
			{ llama: this.llama },
			{
				tools: params.tools as readonly ToolDefinition[] | undefined,
				responseSchema: params.responseSchema as JSONSchema | undefined,
				responseFormat: params.responseFormat,
			},
		);

		const usedTokensBefore = entry.session.sequence.contextTokens.length;
		logger.info(
			{
				modelType,
				kind: plan.kind,
				promptLength: prompt.length,
				cachedPrefixTokens: usedTokensBefore,
			},
			"[plugin-local-ai] generateText",
		);

		const punishModel =
			modelType === ModelType.TEXT_LARGE ? this.mediumModel : this.smallModel;
		const baseOptions = {
			maxTokens: params.maxTokens ?? 8192,
			temperature: params.temperature ?? 0.7,
			topP: params.topP ?? 0.9,
			repeatPenalty: {
				punishTokensFilter: () =>
					punishModel ? punishModel.tokenize(wordsToPunish.join(" ")) : [],
				penalty: 1.2,
				frequencyPenalty: 0.7,
				presencePenalty: 0.7,
			},
		} as const;

		if (plan.kind === "tools") {
			const meta = await entry.session.promptWithMeta(prompt, {
				...baseOptions,
				functions: plan.functions,
			});
			const toolCalls = extractToolCalls(meta.response);
			const text = stripThinkTags(meta.responseText);
			const usedTokensAfter = entry.session.sequence.contextTokens.length;
			logger.info(
				{
					toolCallCount: toolCalls.length,
					textLength: text.length,
					cacheGrewBy: usedTokensAfter - usedTokensBefore,
				},
				"[plugin-local-ai] tool-call response",
			);
			return { text, toolCalls, finishReason: meta.stopReason };
		}

		if (plan.kind === "schema" || plan.kind === "json_object") {
			const meta = await entry.session.promptWithMeta(prompt, {
				...baseOptions,
				grammar: plan.grammar,
			});
			const text = stripThinkTags(meta.responseText);
			const usedTokensAfter = entry.session.sequence.contextTokens.length;
			logger.info(
				{
					kind: plan.kind,
					textLength: text.length,
					cacheGrewBy: usedTokensAfter - usedTokensBefore,
				},
				"[plugin-local-ai] structured response",
			);
			return { text, toolCalls: [], finishReason: meta.stopReason };
		}

		// Streaming branch — only available for the plain-text plan (no tools,
		// no schema, no JSON-object format). Tool / schema requests need the
		// full response before extraction or validation, so they continue to
		// buffer through `entry.session.promptWithMeta`.
		//
		// The runtime decides streaming via `params.stream === true` OR by
		// setting `params.onStreamChunk`; we honour either signal so callers
		// that omit `stream` but pass an SSE callback still get token deltas
		// (matches the openrouter / anthropic plugins).
		const streamParams = params as GenerateTextParams & {
			onStreamChunk?: unknown;
		};
		const wantsStreaming =
			params.stream === true ||
			typeof streamParams.onStreamChunk === "function";

		if (wantsStreaming) {
			logger.info(
				{
					modelType,
					promptLength: prompt.length,
					cachedPrefixTokens: usedTokensBefore,
				},
				"[plugin-local-ai] text response (streaming)",
			);
			return streamLlamaPrompt({
				session: entry.session,
				prompt,
				options: baseOptions,
				estimateUsage: (p, fullText) =>
					normalizedToTokenUsage(estimateUsage(p, fullText)),
				postProcess: stripThinkTags,
			});
		}

		const responseText = await entry.session.prompt(prompt, baseOptions);
		const text = stripThinkTags(responseText);
		const usedTokensAfter = entry.session.sequence.contextTokens.length;
		logger.info(
			{
				textLength: text.length,
				cacheGrewBy: usedTokensAfter - usedTokensBefore,
			},
			"[plugin-local-ai] text response",
		);
		return { text, toolCalls: [], finishReason: undefined };
	}

	public getActiveModelConfig(): ModelSpec {
		return this.activeModelConfig;
	}

	private async lazyInitSmallModel(): Promise<void> {
		if (this.smallModelInitialized) return;

		if (!this.smallModelInitializingPromise) {
			this.smallModelInitializingPromise = (async () => {
				await this.initializeEnvironment();
				await this.checkPlatformCapabilities();

				await this.downloadModel(ModelType.TEXT_SMALL);

				this.llama = await getLlama();

				const smallModel = await this.llama.loadModel({
					gpuLayers: 43,
					modelPath: this.modelPath,
					vocabOnly: false,
				});

				this.smallModel = smallModel;
				this.smallModelInitialized = true;
				logger.info("Small model initialized successfully");
			})();
		}

		await this.smallModelInitializingPromise;
	}

	private async lazyInitMediumModel(): Promise<void> {
		if (this.mediumModelInitialized) return;

		if (!this.mediumModelInitializingPromise) {
			this.mediumModelInitializingPromise = (async () => {
				await this.initializeEnvironment();
				if (!this.llama) {
					await this.lazyInitSmallModel();
				}

				await this.downloadModel(ModelType.TEXT_LARGE);

				const mediumModel = await this.llama?.loadModel({
					gpuLayers: 43,
					modelPath: this.mediumModelPath,
					vocabOnly: false,
				});

				this.mediumModel = mediumModel;
				this.mediumModelInitialized = true;
				logger.info("Medium model initialized successfully");
			})();
		}

		await this.mediumModelInitializingPromise;
	}

}

/**
 * Convert the manager's `LocalGenerationOutput` (string or stream) into the
 * shape `runtime.useModel` expects:
 *   - **Streaming:** return the `TextStreamResult` verbatim. The runtime's
 *     `isTextStreamResult` check (`packages/core/src/runtime.ts:417`) keys
 *     on the same four-field shape, drains `textStream`, and forwards every
 *     chunk to `params.onStreamChunk` / the SSE bridge. We deliberately do
 *     NOT also call `params.onStreamChunk` from inside the handler — that
 *     would double-deliver each token.
 *   - **Non-streaming, native shape:** wrap in `{ text, toolCalls, ... }`
 *     for tool / schema callers.
 *   - **Non-streaming, plain:** return the raw string.
 *
 * Usage tracking for the streaming path is wired via the stream's `usage`
 * promise (`text-streaming.ts`), with a one-shot `MODEL_USED` emit when
 * the stream completes — same pattern as plugin-ollama's
 * `usagePromise.then(emitModelUsed)`.
 */
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
	description: "Local AI plugin using Eliza-1 GGUF models",

	async init(
		_config: Record<string, unknown> | undefined,
		_runtime: IAgentRuntime,
	) {
		logger.info("🚀 Initializing Local AI plugin...");

		await localAIManager.initializeEnvironment();
		const config = validateConfig();

		if (
			!config.LOCAL_SMALL_MODEL ||
			!config.LOCAL_LARGE_MODEL ||
			!config.LOCAL_EMBEDDING_MODEL
		) {
			logger.warn("⚠️ Local AI plugin: Model configuration is incomplete");
			logger.warn("Please ensure the following environment variables are set:");
			logger.warn("- LOCAL_SMALL_MODEL: Path to small language model file");
			logger.warn("- LOCAL_LARGE_MODEL: Path to large language model file");
			logger.warn("- LOCAL_EMBEDDING_MODEL: Path to embedding model file");
			logger.warn("Example: LOCAL_SMALL_MODEL=text/eliza-1-2b-32k.gguf");
		}

		const modelsDir =
			config.MODELS_DIR || path.join(os.homedir(), ".eliza", "models");
		if (!fs.existsSync(modelsDir)) {
			logger.warn(`⚠️ Models directory does not exist: ${modelsDir}`);
			logger.warn(
				"The directory will be created, but you need to download model files",
			);
			logger.warn(
				"Visit https://huggingface.co/models to download compatible GGUF models",
			);
		}

		logger.info("🔍 Testing Local AI initialization...");

		await localAIManager.checkPlatformCapabilities();

		const llamaInstance = await getLlama();
		if (llamaInstance) {
			logger.success("✅ Local AI: llama.cpp library loaded successfully");
		} else {
			throw new Error("Failed to load llama.cpp library");
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

		if (!modelsExist.small && !modelsExist.large && !modelsExist.embedding) {
			logger.warn("⚠️ No model files found in models directory");
			logger.warn(
				"Models will be downloaded on first use, which may take time",
			);
			logger.warn(
				"To pre-download models, run the plugin and it will fetch them automatically",
			);
		} else {
			logger.info(
				{
					small: modelsExist.small ? "✓" : "✗",
					large: modelsExist.large ? "✓" : "✗",
					embedding: modelsExist.embedding ? "✓" : "✗",
				},
				"📦 Found model files:",
			);
		}

		logger.success("✅ Local AI plugin initialized successfully");
		logger.info("💡 Models will be loaded on-demand when first used");
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
				logger.debug(
					"Null or empty text input for embedding, returning zero vector",
				);
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
				"plugin-local-ai tokenizer (Transformers.js) has been removed. " +
					"Use @elizaos/plugin-local-inference with an Eliza-1 bundle for local tokenization.",
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
				"plugin-local-ai tokenizer (Transformers.js) has been removed. " +
					"Use @elizaos/plugin-local-inference with an Eliza-1 bundle for local tokenization.",
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
				"plugin-local-ai image description (Florence-2 / Transformers.js) has been removed. " +
					"Use @elizaos/plugin-local-inference with an Eliza-1 bundle for canonical local vision.",
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

			// Legacy whisper.cpp transcription has been removed. Local ASR
			// must go through @elizaos/plugin-local-inference (Qwen3-ASR via
			// libelizainference) per plugin-local-inference/native/AGENTS.md.
			throw new Error(
				"plugin-local-ai whisper.cpp transcription has been removed. " +
					"Use @elizaos/plugin-local-inference with an Eliza-1 bundle " +
					"(Qwen3-ASR via libelizainference) for canonical local ASR.",
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
				"plugin-local-ai TTS (Transformers.js) has been removed. " +
					"Use @elizaos/plugin-local-inference with an Eliza-1 bundle for canonical local TTS.",
			);
		},
	},
	tests: [
		{
			name: "local_ai_plugin_tests",
			tests: [
				{
					name: "local_ai_test_initialization",
					fn: async (runtime) => {
						try {
							logger.info("Starting initialization test");

							const result = await runtime.useModel(ModelType.TEXT_SMALL, {
								prompt:
									"Debug Mode: Test initialization. Respond with 'Initialization successful' if you can read this.",
								stopSequences: [],
							});

							logger.info("Model response:", result);

							if (!result || typeof result !== "string") {
								throw new Error("Invalid response from model");
							}

							if (!result.includes("successful")) {
								throw new Error("Model response does not indicate success");
							}

							logger.success("Initialization test completed successfully");
						} catch (error) {
							logger.error(
								{
									error: error instanceof Error ? error.message : String(error),
									stack: error instanceof Error ? error.stack : undefined,
								},
								"Initialization test failed:",
							);
							throw error;
						}
					},
				},
				{
					name: "local_ai_test_text_large",
					fn: async (runtime) => {
						try {
							logger.info("Starting TEXT_LARGE model test");

							const result = await runtime.useModel(ModelType.TEXT_LARGE, {
								prompt:
									"Debug Mode: Generate a one-sentence response about artificial intelligence.",
								stopSequences: [],
							});

							logger.info("Large model response:", result);

							if (!result || typeof result !== "string") {
								throw new Error("Invalid response from large model");
							}

							if (result.length < 10) {
								throw new Error("Response too short, possible model failure");
							}

							logger.success("TEXT_LARGE test completed successfully");
						} catch (error) {
							logger.error(
								{
									error: error instanceof Error ? error.message : String(error),
									stack: error instanceof Error ? error.stack : undefined,
								},
								"TEXT_LARGE test failed:",
							);
							throw error;
						}
					},
				},
				{
					name: "local_ai_test_text_embedding",
					fn: async (runtime) => {
						try {
							logger.info("Starting TEXT_EMBEDDING test");

							const embedding = await runtime.useModel(
								ModelType.TEXT_EMBEDDING,
								{
									text: "This is a test of the text embedding model.",
								},
							);

							logger.info(
								{ dimensions: embedding.length },
								"Embedding generated with dimensions:",
							);

							if (!Array.isArray(embedding)) {
								throw new Error("Embedding is not an array");
							}

							if (embedding.length === 0) {
								throw new Error("Embedding array is empty");
							}

							if (embedding.some((val) => typeof val !== "number")) {
								throw new Error("Embedding contains non-numeric values");
							}

							// Test with null input (should return zero vector)
							const nullEmbedding = await runtime.useModel(
								ModelType.TEXT_EMBEDDING,
								null,
							);
							if (
								!Array.isArray(nullEmbedding) ||
								nullEmbedding.some((val) => val !== 0)
							) {
								throw new Error("Null input did not return zero vector");
							}

							logger.success("TEXT_EMBEDDING test completed successfully");
						} catch (error) {
							logger.error(
								{
									error: error instanceof Error ? error.message : String(error),
									stack: error instanceof Error ? error.stack : undefined,
								},
								"TEXT_EMBEDDING test failed:",
							);
							throw error;
						}
					},
				},
			],
		},
	],
};

export default localAiPlugin;
