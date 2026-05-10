// @ts-nocheck — pending migration: @huggingface/transformers 3->4
// (PreTrainedModel/Florence2 interface changes), @elizaos/core logger
// signature drift (structured-context overload removed), and
// GenerateTextParams.{modelType,runtime} field removal. Tracked separately.
import fs from "node:fs";
import os from "node:os";
import path, { basename } from "node:path";
import { Readable } from "node:stream";
import type {
  EventPayload,
  GenerateTextParams,
  JSONSchema,
  ModelTypeName,
  TextEmbeddingParams,
  ToolDefinition,
} from "@elizaos/core";
import { EventType, type IAgentRuntime, logger, ModelType, type Plugin } from "@elizaos/core";
import {
  getLlama,
  type Llama,
  LlamaChatSession,
  type LlamaContext,
  type LlamaEmbeddingContext,
  type LlamaModel,
} from "node-llama-cpp";
import { type Config, validateConfig } from "./environment";
import { extractToolCalls, planStructuredRequest, type ToolCallResult } from "./structured-output";
import { type EmbeddingModelSpec, MODEL_SPECS, type ModelSpec } from "./types";
import { DownloadManager } from "./utils/downloadManager";
import { getPlatformManager } from "./utils/platform";
import { TokenizerManager } from "./utils/tokenizerManager";
import { TranscribeManager } from "./utils/transcribeManager";
import { TTSManager } from "./utils/ttsManager";
import { VisionManager } from "./utils/visionManager";

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
  return text.includes("<think>") ? text.replace(/<think>[\s\S]*?<\/think>\n?/g, "") : text;
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

function buildNativeResult(result: LocalGenerationResult): {
  text: string;
  toolCalls: ToolCallResult[];
  finishReason?: string;
} {
  return {
    text: result.text,
    toolCalls: result.toolCalls,
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
  };
}

function getLocalModelLabel(runtime: IAgentRuntime, type: ModelTypeName): string {
  const config = validateConfig();
  if (type === ModelType.TEXT_EMBEDDING) {
    return String(runtime.getSetting("LOCAL_EMBEDDING_MODEL") || config.LOCAL_EMBEDDING_MODEL);
  }
  if (type === ModelType.TEXT_LARGE) {
    return String(runtime.getSetting("LOCAL_LARGE_MODEL") || config.LOCAL_LARGE_MODEL);
  }
  return String(runtime.getSetting("LOCAL_SMALL_MODEL") || config.LOCAL_SMALL_MODEL);
}

function emitModelUsed(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  model: string,
  usage: NormalizedUsage
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
    } as EventPayload
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
  private tokenizerManager!: TokenizerManager;
  private downloadManager!: DownloadManager;
  private visionManager!: VisionManager;
  private activeModelConfig: ModelSpec;
  private embeddingModelConfig: EmbeddingModelSpec;
  private transcribeManager!: TranscribeManager;
  private ttsManager!: TTSManager;
  private config: Config | null = null;

  private smallModelInitialized = false;
  private mediumModelInitialized = false;
  private embeddingInitialized = false;
  private visionInitialized = false;
  private transcriptionInitialized = false;
  private ttsInitialized = false;
  private environmentInitialized = false;

  private smallModelInitializingPromise: Promise<void> | null = null;
  private mediumModelInitializingPromise: Promise<void> | null = null;
  private embeddingInitializingPromise: Promise<void> | null = null;
  private visionInitializingPromise: Promise<void> | null = null;
  private transcriptionInitializingPromise: Promise<void> | null = null;
  private ttsInitializingPromise: Promise<void> | null = null;
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

    this.downloadManager = DownloadManager.getInstance(this.cacheDir, this.modelsDir);
    this.tokenizerManager = TokenizerManager.getInstance(this.cacheDir, this.modelsDir);
    this.visionManager = VisionManager.getInstance(this.cacheDir);
    this.transcribeManager = TranscribeManager.getInstance(this.cacheDir);
    this.ttsManager = TTSManager.getInstance(this.cacheDir);
  }

  private _setupModelsDir(): void {
    const modelsDirEnv = this.config?.MODELS_DIR?.trim() || process.env.MODELS_DIR?.trim();
    if (modelsDirEnv) {
      this.modelsDir = path.resolve(modelsDirEnv);
      logger.info("Using models directory from MODELS_DIR environment variable:", this.modelsDir);
    } else {
      this.modelsDir = path.join(os.homedir(), ".eliza", "models");
      logger.info(
        "MODELS_DIR environment variable not set, using default models directory:",
        this.modelsDir
      );
    }

    if (!fs.existsSync(this.modelsDir)) {
      fs.mkdirSync(this.modelsDir, { recursive: true });
      logger.debug("Ensured models directory exists (created):", this.modelsDir);
    } else {
      logger.debug("Models directory already exists:", this.modelsDir);
    }
  }

  private _setupCacheDir(): void {
    const cacheDirEnv = this.config?.CACHE_DIR?.trim() || process.env.CACHE_DIR?.trim();
    if (cacheDirEnv) {
      this.cacheDir = path.resolve(cacheDirEnv);
      logger.info("Using cache directory from CACHE_DIR environment variable:", this.cacheDir);
    } else {
      const cacheDir = path.join(os.homedir(), ".eliza", "cache");
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
        logger.debug("Ensuring cache directory exists (created):", cacheDir);
      }
      this.cacheDir = cacheDir;
      logger.info(
        "CACHE_DIR environment variable not set, using default cache directory:",
        this.cacheDir
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
      this.mediumModelPath = path.join(this.modelsDir, this.config.LOCAL_LARGE_MODEL);
      this.embeddingModelPath = path.join(this.modelsDir, this.config.LOCAL_EMBEDDING_MODEL);

      logger.info("Using small model path:", basename(this.modelPath));
      logger.info("Using medium model path:", basename(this.mediumModelPath));
      logger.info("Using embedding model path:", basename(this.embeddingModelPath));

      logger.info("Environment configuration validated and model paths set");

      this.environmentInitialized = true;
      logger.success("Environment initialization complete");
    })();

    await this.environmentInitializingPromise;
  }

  private async downloadModel(
    modelType: ModelTypeName,
    customModelSpec?: ModelSpec
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
      modelSpec = modelType === ModelType.TEXT_LARGE ? MODEL_SPECS.medium : MODEL_SPECS.small;
      modelPathToDownload =
        modelType === ModelType.TEXT_LARGE ? this.mediumModelPath : this.modelPath; // Use configured path
    }

    // Pass the determined path to the download manager
    return await this.downloadManager.downloadModel(modelSpec, modelPathToDownload);
  }

  async checkPlatformCapabilities(): Promise<void> {
    const platformManager = getPlatformManager();
    await platformManager.initialize();
    const capabilities = platformManager.getCapabilities();

    logger.info("Platform capabilities detected:", {
      platform: capabilities.platform,
      gpu: capabilities.gpu?.type || "none",
      recommendedModel: capabilities.recommendedModelSize,
      supportedBackends: capabilities.supportedBackends,
    });
  }

  async initialize(modelType: ModelTypeName = ModelType.TEXT_SMALL): Promise<void> {
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
        logger.warn("Models directory does not exist, creating it:", this.modelsDir);
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

        this.embeddingContext = await this.embeddingModel.createEmbeddingContext({
          contextSize: this.embeddingModelConfig.contextSize,
          batchSize: 512,
        });

        logger.success("Embedding model initialized successfully");
      }
    } catch (error) {
      logger.error("Failed to initialize embedding model:", error);
      throw error;
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    await this.lazyInitEmbedding();

    if (!this.embeddingModel || !this.embeddingContext) {
      throw new Error("Failed to initialize embedding model");
    }

    logger.info("Generating embedding for text", { textLength: text.length });

    const embeddingResult = await this.embeddingContext.getEmbeddingFor(text);

    const mutableEmbedding = [...embeddingResult.vector];

    const normalizedEmbedding = this.normalizeEmbedding(mutableEmbedding);

    logger.info("Embedding generation complete", {
      dimensions: normalizedEmbedding.length,
    });
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

          this.embeddingContext = await this.embeddingModel.createEmbeddingContext({
            contextSize: this.embeddingModelConfig.contextSize,
            batchSize: 512,
          });

          this.embeddingInitialized = true;
          logger.info("Embedding model initialized successfully");
        } catch (error) {
          logger.error("Failed to initialize embedding model:", error);
          this.embeddingInitializingPromise = undefined;
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
    systemPrompt: string
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
        logger.warn("[plugin-local-ai] Failed disposing stale context:", err);
      }
      this.chatSessions.delete(modelType);
    }

    let model: LlamaModel;
    let contextSize: number;
    if (modelType === ModelType.TEXT_LARGE) {
      await this.lazyInitMediumModel();
      if (!this.mediumModel) throw new Error("Medium model initialization failed");
      model = this.mediumModel;
      contextSize = MODEL_SPECS.medium.contextSize;
      this.activeModelConfig = MODEL_SPECS.medium;
    } else {
      await this.lazyInitSmallModel();
      if (!this.smallModel) throw new Error("Small model initialization failed");
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
    logger.info("[plugin-local-ai] Created new chat session", {
      modelType,
      contextSize,
      systemPromptLength: systemPrompt.length,
    });
    return entry;
  }

  async generateText(params: GenerateTextParams): Promise<LocalGenerationResult> {
    await this.initializeEnvironment();
    const modelType = params.modelType ?? ModelType.TEXT_SMALL;
    const systemPrompt = params.system?.trim() || DEFAULT_LOCAL_SYSTEM_PROMPT;
    const entry = await this.getOrCreateChatSession(modelType, systemPrompt);

    const prompt = params.prompt ?? "";
    if (!this.llama) throw new Error("[plugin-local-ai] Llama runtime not initialized");

    const plan = await planStructuredRequest(
      { llama: this.llama },
      {
        tools: params.tools as readonly ToolDefinition[] | undefined,
        responseSchema: params.responseSchema as JSONSchema | undefined,
        responseFormat: params.responseFormat,
      }
    );

    const usedTokensBefore = entry.session.sequence?.contextTokens?.length ?? 0;
    logger.info("[plugin-local-ai] generateText", {
      modelType,
      kind: plan.kind,
      promptLength: prompt.length,
      cachedPrefixTokens: usedTokensBefore,
    });

    const punishModel = modelType === ModelType.TEXT_LARGE ? this.mediumModel : this.smallModel;
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
      const usedTokensAfter = entry.session.sequence?.contextTokens?.length ?? 0;
      logger.info("[plugin-local-ai] tool-call response", {
        toolCallCount: toolCalls.length,
        textLength: text.length,
        cacheGrewBy: usedTokensAfter - usedTokensBefore,
      });
      return { text, toolCalls, finishReason: meta.stopReason };
    }

    if (plan.kind === "schema" || plan.kind === "json_object") {
      const meta = await entry.session.promptWithMeta(prompt, {
        ...baseOptions,
        grammar: plan.grammar,
      });
      const text = stripThinkTags(meta.responseText);
      const usedTokensAfter = entry.session.sequence?.contextTokens?.length ?? 0;
      logger.info("[plugin-local-ai] structured response", {
        kind: plan.kind,
        textLength: text.length,
        cacheGrewBy: usedTokensAfter - usedTokensBefore,
      });
      return { text, toolCalls: [], finishReason: meta.stopReason };
    }

    const responseText = await entry.session.prompt(prompt, baseOptions);
    const text = stripThinkTags(responseText);
    const usedTokensAfter = entry.session.sequence?.contextTokens?.length ?? 0;
    logger.info("[plugin-local-ai] text response", {
      textLength: text.length,
      cacheGrewBy: usedTokensAfter - usedTokensBefore,
    });
    return { text, toolCalls: [], finishReason: undefined };
  }

  public async describeImage(
    imageData: Buffer,
    mimeType: string
  ): Promise<{ title: string; description: string }> {
    await this.lazyInitVision();

    const base64 = imageData.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;
    return await this.visionManager.processImage(dataUrl);
  }

  public async transcribeAudio(audioBuffer: Buffer): Promise<string> {
    await this.lazyInitTranscription();

    const result = await this.transcribeManager.transcribe(audioBuffer);
    return result.text;
  }

  public async generateSpeech(text: string): Promise<Readable> {
    try {
      await this.lazyInitTTS();

      return await this.ttsManager.generateSpeech(text);
    } catch (error) {
      logger.error("Speech generation failed:", {
        error: error instanceof Error ? error.message : String(error),
        textLength: text.length,
      });
      throw error;
    }
  }

  public getTokenizerManager(): TokenizerManager {
    return this.tokenizerManager;
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

  private async lazyInitVision(): Promise<void> {
    if (this.visionInitialized) return;

    if (!this.visionInitializingPromise) {
      this.visionInitializingPromise = (async () => {
        try {
          this.visionInitialized = true;
          logger.info("Vision model initialized successfully");
        } catch (error) {
          logger.error("Failed to initialize vision model:", error);
          this.visionInitializingPromise = null;
          throw error;
        }
      })();
    }

    await this.visionInitializingPromise;
  }

  private async lazyInitTranscription(): Promise<void> {
    if (this.transcriptionInitialized) return;

    if (!this.transcriptionInitializingPromise) {
      this.transcriptionInitializingPromise = (async () => {
        try {
          await this.initializeEnvironment();

          if (!this.transcribeManager) {
            this.transcribeManager = TranscribeManager.getInstance(this.cacheDir);
          }

          // Ensure FFmpeg is available
          const ffmpegReady = await this.transcribeManager.ensureFFmpeg();
          if (!ffmpegReady) {
            logger.error(
              "FFmpeg is not available or not configured correctly. Cannot proceed with transcription."
            );
            throw new Error(
              "FFmpeg is required for transcription but is not available. Please see server logs for installation instructions."
            );
          }

          this.transcriptionInitialized = true;
          logger.info("Transcription prerequisites (FFmpeg) checked and ready.");
          logger.info("Transcription model initialized successfully");
        } catch (error) {
          logger.error("Failed to initialize transcription model:", error);
          this.transcriptionInitializingPromise = null;
          throw error;
        }
      })();
    }

    await this.transcriptionInitializingPromise;
  }

  private async lazyInitTTS(): Promise<void> {
    if (this.ttsInitialized) return;

    if (!this.ttsInitializingPromise) {
      this.ttsInitializingPromise = (async () => {
        await this.initializeEnvironment();
        this.ttsManager = TTSManager.getInstance(this.cacheDir);
        this.ttsInitialized = true;
        logger.info("TTS model initialized successfully");
      })();
    }

    await this.ttsInitializingPromise;
  }
}

const localAIManager = LocalAIManager.getInstance();

export const localAiPlugin: Plugin = {
  name: "local-ai",
  description: "Local AI plugin using Eliza-1 GGUF models",

  async init(_config: Record<string, unknown> | undefined, _runtime: IAgentRuntime) {
    logger.info("🚀 Initializing Local AI plugin...");

    await localAIManager.initializeEnvironment();
    const config = validateConfig();

    if (!config.LOCAL_SMALL_MODEL || !config.LOCAL_LARGE_MODEL || !config.LOCAL_EMBEDDING_MODEL) {
      logger.warn("⚠️ Local AI plugin: Model configuration is incomplete");
      logger.warn("Please ensure the following environment variables are set:");
      logger.warn("- LOCAL_SMALL_MODEL: Path to small language model file");
      logger.warn("- LOCAL_LARGE_MODEL: Path to large language model file");
      logger.warn("- LOCAL_EMBEDDING_MODEL: Path to embedding model file");
      logger.warn("Example: LOCAL_SMALL_MODEL=text/eliza-1-mobile-1_7b-32k.gguf");
    }

    const modelsDir = config.MODELS_DIR || path.join(os.homedir(), ".eliza", "models");
    if (!fs.existsSync(modelsDir)) {
      logger.warn(`⚠️ Models directory does not exist: ${modelsDir}`);
      logger.warn("The directory will be created, but you need to download model files");
      logger.warn("Visit https://huggingface.co/models to download compatible GGUF models");
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
    const embeddingModelPath = path.join(modelsDir, config.LOCAL_EMBEDDING_MODEL);

    const modelsExist = {
      small: fs.existsSync(smallModelPath),
      large: fs.existsSync(largeModelPath),
      embedding: fs.existsSync(embeddingModelPath),
    };

    if (!modelsExist.small && !modelsExist.large && !modelsExist.embedding) {
      logger.warn("⚠️ No model files found in models directory");
      logger.warn("Models will be downloaded on first use, which may take time");
      logger.warn("To pre-download models, run the plugin and it will fetch them automatically");
    } else {
      logger.info("📦 Found model files:", {
        small: modelsExist.small ? "✓" : "✗",
        large: modelsExist.large ? "✓" : "✗",
        embedding: modelsExist.embedding ? "✓" : "✗",
      });
    }

    logger.success("✅ Local AI plugin initialized successfully");
    logger.info("💡 Models will be loaded on-demand when first used");
  },
  models: {
    [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params: GenerateTextParams) => {
      await localAIManager.initializeEnvironment();
      const result = await localAIManager.generateText({
        ...params,
        modelType: ModelType.TEXT_SMALL,
      });
      emitModelUsed(
        runtime,
        ModelType.TEXT_SMALL,
        getLocalModelLabel(runtime, ModelType.TEXT_SMALL),
        estimateUsage(params.prompt ?? "", result.text)
      );
      return wantsNativeShape(params) ? buildNativeResult(result) : result.text;
    },

    [ModelType.TEXT_LARGE]: async (runtime: IAgentRuntime, params: GenerateTextParams) => {
      await localAIManager.initializeEnvironment();
      const result = await localAIManager.generateText({
        ...params,
        modelType: ModelType.TEXT_LARGE,
      });
      emitModelUsed(
        runtime,
        ModelType.TEXT_LARGE,
        getLocalModelLabel(runtime, ModelType.TEXT_LARGE),
        estimateUsage(params.prompt ?? "", result.text)
      );
      return wantsNativeShape(params) ? buildNativeResult(result) : result.text;
    },

    [ModelType.TEXT_EMBEDDING]: async (runtime: IAgentRuntime, params: TextEmbeddingParams) => {
      const text = params?.text;
      if (!text) {
        logger.debug("Null or empty text input for embedding, returning zero vector");
        return new Array(1024).fill(0);
      }

      const embedding = await localAIManager.generateEmbedding(text);
      emitModelUsed(
        runtime,
        ModelType.TEXT_EMBEDDING,
        getLocalModelLabel(runtime, ModelType.TEXT_EMBEDDING),
        estimateEmbeddingUsage(text)
      );
      return embedding;
    },

    [ModelType.TEXT_TOKENIZER_ENCODE]: async (
      _runtime: IAgentRuntime,
      { text }: { text: string }
    ) => {
      const manager = localAIManager.getTokenizerManager();
      const config = localAIManager.getActiveModelConfig();
      return await manager.encode(text, config);
    },

    [ModelType.TEXT_TOKENIZER_DECODE]: async (
      _runtime: IAgentRuntime,
      { tokens }: { tokens: number[] }
    ) => {
      const manager = localAIManager.getTokenizerManager();
      const config = localAIManager.getActiveModelConfig();
      return await manager.decode(tokens, config);
    },

    [ModelType.IMAGE_DESCRIPTION]: async (_runtime: IAgentRuntime, imageUrl: string) => {
      logger.info("Processing image from URL:", imageUrl);

      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get("content-type") || "image/jpeg";
      return await localAIManager.describeImage(buffer, mimeType);
    },

    [ModelType.TRANSCRIPTION]: async (_runtime: IAgentRuntime, audioBuffer: Buffer) => {
      logger.info("Processing audio transcription:", {
        bufferSize: audioBuffer.length,
      });

      return await localAIManager.transcribeAudio(audioBuffer);
    },

    [ModelType.TEXT_TO_SPEECH]: async (_runtime: IAgentRuntime, text: string) => {
      return await localAIManager.generateSpeech(text);
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
              logger.error("Initialization test failed:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
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
              logger.error("TEXT_LARGE test failed:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
              throw error;
            }
          },
        },
        {
          name: "local_ai_test_text_embedding",
          fn: async (runtime) => {
            try {
              logger.info("Starting TEXT_EMBEDDING test");

              const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
                text: "This is a test of the text embedding model.",
              });

              logger.info("Embedding generated with dimensions:", embedding.length);

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
              const nullEmbedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, null);
              if (!Array.isArray(nullEmbedding) || nullEmbedding.some((val) => val !== 0)) {
                throw new Error("Null input did not return zero vector");
              }

              logger.success("TEXT_EMBEDDING test completed successfully");
            } catch (error) {
              logger.error("TEXT_EMBEDDING test failed:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
              throw error;
            }
          },
        },
        {
          name: "local_ai_test_tokenizer_encode",
          fn: async (runtime) => {
            try {
              logger.info("Starting TEXT_TOKENIZER_ENCODE test");
              const text = "Hello tokenizer test!";
              const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, { text });
              logger.info("Encoded tokens:", { count: tokens.length });

              if (!Array.isArray(tokens)) {
                throw new Error("Tokens output is not an array");
              }

              if (tokens.length === 0) {
                throw new Error("No tokens generated");
              }

              if (tokens.some((token) => !Number.isInteger(token))) {
                throw new Error("Tokens contain non-integer values");
              }

              logger.success("TEXT_TOKENIZER_ENCODE test completed successfully");
            } catch (error) {
              logger.error("TEXT_TOKENIZER_ENCODE test failed:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
              throw error;
            }
          },
        },
        {
          name: "local_ai_test_tokenizer_decode",
          fn: async (runtime) => {
            try {
              logger.info("Starting TEXT_TOKENIZER_DECODE test");

              const originalText = "Hello tokenizer test!";
              const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, {
                text: originalText,
              });

              const decodedText = await runtime.useModel(ModelType.TEXT_TOKENIZER_DECODE, {
                tokens,
              });
              logger.info("Round trip tokenization:", {
                original: originalText,
                decoded: decodedText,
              });

              if (typeof decodedText !== "string") {
                throw new Error("Decoded output is not a string");
              }

              logger.success("TEXT_TOKENIZER_DECODE test completed successfully");
            } catch (error) {
              logger.error("TEXT_TOKENIZER_DECODE test failed:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
              throw error;
            }
          },
        },
        {
          name: "local_ai_test_image_description",
          fn: async (runtime) => {
            try {
              logger.info("Starting IMAGE_DESCRIPTION test");

              const imageUrl =
                "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/320px-Cat03.jpg";
              const result = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, imageUrl);

              logger.info("Image description result:", result);

              if (!result || typeof result !== "object") {
                throw new Error("Invalid response format");
              }

              if (!result.title || !result.description) {
                throw new Error("Missing title or description in response");
              }

              if (typeof result.title !== "string" || typeof result.description !== "string") {
                throw new Error("Title or description is not a string");
              }

              logger.success("IMAGE_DESCRIPTION test completed successfully");
            } catch (error) {
              logger.error("IMAGE_DESCRIPTION test failed:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
              throw error;
            }
          },
        },
        {
          name: "local_ai_test_transcription",
          fn: async (runtime) => {
            try {
              logger.info("Starting TRANSCRIPTION test");

              const channels = 1;
              const sampleRate = 16000;
              const bitsPerSample = 16;
              const duration = 0.5; // 500ms for better transcription
              const numSamples = Math.floor(sampleRate * duration);
              const dataSize = numSamples * channels * (bitsPerSample / 8);

              const buffer = Buffer.alloc(44 + dataSize);

              buffer.write("RIFF", 0);
              buffer.writeUInt32LE(36 + dataSize, 4);
              buffer.write("WAVE", 8);

              buffer.write("fmt ", 12);
              buffer.writeUInt32LE(16, 16);
              buffer.writeUInt16LE(1, 20);
              buffer.writeUInt16LE(channels, 22);
              buffer.writeUInt32LE(sampleRate, 24);
              buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
              buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
              buffer.writeUInt16LE(bitsPerSample, 34);

              buffer.write("data", 36);
              buffer.writeUInt32LE(dataSize, 40);

              const frequency = 440;
              for (let i = 0; i < numSamples; i++) {
                const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.1 * 32767;
                buffer.writeInt16LE(Math.floor(sample), 44 + i * 2);
              }

              const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, buffer);
              logger.info("Transcription result:", transcription);

              if (typeof transcription !== "string") {
                throw new Error("Transcription result is not a string");
              }

              logger.info("Transcription completed (may be empty for non-speech audio)");

              logger.success("TRANSCRIPTION test completed successfully");
            } catch (error) {
              logger.error(
                {
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                },
                "TRANSCRIPTION test failed"
              );
              throw error;
            }
          },
        },
        {
          name: "local_ai_test_text_to_speech",
          fn: async (runtime) => {
            try {
              logger.info("Starting TEXT_TO_SPEECH test");

              const testText = "This is a test of the text to speech system.";
              const audioStream = await runtime.useModel(ModelType.TEXT_TO_SPEECH, testText);

              if (!(audioStream instanceof Readable)) {
                throw new Error("TTS output is not a readable stream");
              }

              let dataReceived = false;
              audioStream.on("data", () => {
                dataReceived = true;
              });

              await new Promise((resolve, reject) => {
                audioStream.on("end", () => {
                  if (!dataReceived) {
                    reject(new Error("No audio data received from stream"));
                  } else {
                    resolve(true);
                  }
                });
                audioStream.on("error", reject);
              });

              logger.success("TEXT_TO_SPEECH test completed successfully");
            } catch (error) {
              logger.error(
                {
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                },
                "TEXT_TO_SPEECH test failed"
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
