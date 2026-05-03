import fs from "node:fs";
import os from "node:os";
import path, { basename } from "node:path";
import type {
  DetokenizeTextParams,
  ModelTypeName,
  TextEmbeddingParams,
  TokenizeTextParams,
} from "@elizaos/core";
import { type IAgentRuntime, logger, ModelType, type Plugin } from "@elizaos/core";
import {
  getLlama,
  type Llama,
  type LlamaEmbeddingContext,
  LlamaLogLevel,
  type LlamaModel,
} from "node-llama-cpp";
import { type Config, validateConfig } from "./environment";
import { type EmbeddingModelSpec, MODEL_SPECS, type ModelSpec } from "./types";
import { DownloadManager } from "./utils/downloadManager";
import { getPlatformManager } from "./utils/platform";
import { TokenizerManager } from "./utils/tokenizerManager";

const CORRUPTED_MODEL_ERROR_SIGNATURES = [
  "data is not within the file bounds",
  "failed to load model",
  "model is corrupted",
  "data of tensor",
  "is out of bounds",
];
const CONTEXT_LIMIT_ERROR_SIGNATURES = [
  "input is longer than the context size",
  "context size",
  "too many tokens",
  "exceeds context",
];
const NODE_LLAMA_NOISY_LOAD_ERROR_PATTERNS = [
  "llama_model_load:",
  "llama_model_load_from_file_impl: failed to load model",
];
const MIN_EMBEDDING_RETRY_TEXT_LENGTH = 1;

type EmbeddingModelHint = {
  pattern: RegExp;
  repo: string;
  dimensions: number;
  contextSize: number;
};

const EMBEDDING_MODEL_HINTS: EmbeddingModelHint[] = [
  {
    pattern: /nomic-embed-text-v1\.5/i,
    repo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
    dimensions: 768,
    contextSize: 8192,
  },
  {
    pattern: /bge-small-en-v1\.5/i,
    repo: "ChristianAzinn/bge-small-en-v1.5-gguf",
    dimensions: 384,
    contextSize: 512,
  },
  {
    pattern: /e5-mistral-7b/i,
    repo: "dranger003/e5-mistral-7b-instruct-GGUF",
    dimensions: 4096,
    contextSize: 32768,
  },
];

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function isCorruptedModelLoadError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return CORRUPTED_MODEL_ERROR_SIGNATURES.some((signature) => message.includes(signature));
}

function isContextLimitError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return CONTEXT_LIMIT_ERROR_SIGNATURES.some((signature) => message.includes(signature));
}

function shouldSuppressNodeLlamaLoadError(message: string): boolean {
  const lower = message.toLowerCase();
  return NODE_LLAMA_NOISY_LOAD_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

function shrinkEmbeddingInput(text: string): string {
  if (text.length <= MIN_EMBEDDING_RETRY_TEXT_LENGTH) return text;
  const nextLength = Math.max(MIN_EMBEDDING_RETRY_TEXT_LENGTH, Math.floor(text.length / 2));
  return text.slice(0, nextLength);
}

function inferEmbeddingModelHint(modelName: string): EmbeddingModelHint | null {
  const match = EMBEDDING_MODEL_HINTS.find((hint) => hint.pattern.test(modelName));
  return match ?? null;
}

function resolveEmbeddingModelSpec(
  config: Config,
  fallback: EmbeddingModelSpec
): EmbeddingModelSpec {
  const modelName = config.LOCAL_EMBEDDING_MODEL || fallback.name;
  const hint = inferEmbeddingModelHint(modelName);

  return {
    ...fallback,
    name: modelName,
    repo: config.LOCAL_EMBEDDING_MODEL_REPO?.trim() || hint?.repo || fallback.repo,
    dimensions: config.LOCAL_EMBEDDING_DIMENSIONS ?? hint?.dimensions ?? fallback.dimensions,
    contextSize: config.LOCAL_EMBEDDING_CONTEXT_SIZE ?? hint?.contextSize ?? fallback.contextSize,
  };
}

function readMagicHeader(filePath: string): {
  bytesRead: number;
  magic: string;
} {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const header = Buffer.alloc(4);
      const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
      return { bytesRead, magic: header.toString("ascii", 0, 4) };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { bytesRead: 0, magic: "" };
  }
}

function isValidGgufFile(filePath: string): boolean {
  const { bytesRead, magic } = readMagicHeader(filePath);
  return bytesRead === 4 && magic === "GGUF";
}

function safeUnlink(filePath: string): void {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    logger.warn(
      `Failed to remove model file ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Class representing a LocalAIManager.
 * @property {LocalAIManager | null} instance - The static instance of LocalAIManager.
 * @property {Llama | undefined} llama - The llama object.
 * @property {LlamaModel | undefined} smallModel - The small LlamaModel object.
 * @property {LlamaModel | undefined} mediumModel - The medium LlamaModel object.
 * @property {LlamaContext | undefined} ctx - The LlamaContext object.
 * @property {LlamaContextSequence | undefined} sequence - The LlamaContextSequence object.
 * @property {LlamaChatSession | undefined} chatSession - The LlamaChatSession object.
 * @property {string} modelPath - The path to the model.
 */
class LocalAIManager {
  private static instance: LocalAIManager | null = null;
  private llama: Llama | undefined;
  private embeddingModel: LlamaModel | undefined;
  private embeddingContext: LlamaEmbeddingContext | undefined;
  private modelPath!: string;
  private mediumModelPath!: string;
  private embeddingModelPath!: string;
  private cacheDir!: string;
  private tokenizerManager!: TokenizerManager;
  private downloadManager!: DownloadManager;
  private activeModelConfig: ModelSpec;
  private embeddingModelConfig: EmbeddingModelSpec;
  private config: Config | null = null; // Store validated config

  // Initialization state flag
  private embeddingInitialized = false;
  private environmentInitialized = false; // Add flag for environment initialization

  // Initialization promises to prevent duplicate initialization
  private embeddingInitializingPromise: Promise<void> | null = null;
  private environmentInitializingPromise: Promise<void> | null = null; // Add promise for environment

  private modelsDir!: string;

  /**
   * Private constructor function to initialize base managers and paths.
   * Model paths are set after environment initialization.
   */
  private constructor() {
    this.config = validateConfig();

    this._setupCacheDir();

    // Initialize active model config (default)
    this.activeModelConfig = MODEL_SPECS.small;
    // Initialize embedding model config (spec details)
    this.embeddingModelConfig = MODEL_SPECS.embedding;
  }

  /**
   * Post-validation initialization steps that require config to be set.
   * Called after config validation in initializeEnvironment.
   */
  private _postValidateInit(): void {
    this._setupModelsDir();

    // Initialize managers that depend on modelsDir
    this.downloadManager = DownloadManager.getInstance(this.cacheDir, this.modelsDir);
    this.tokenizerManager = TokenizerManager.getInstance(this.cacheDir, this.modelsDir);
  }

  /**
   * Sets up the models directory, reading from config or environment variables,
   * and ensures the directory exists.
   */
  private _setupModelsDir(): void {
    // Set up models directory consistently, similar to cacheDir
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

    // Ensure models directory exists
    if (!fs.existsSync(this.modelsDir)) {
      fs.mkdirSync(this.modelsDir, { recursive: true });
      logger.debug("Ensured models directory exists (created):", this.modelsDir);
    } else {
      logger.debug("Models directory already exists:", this.modelsDir);
    }
  }

  /**
   * Sets up the cache directory, reading from config or environment variables,
   * and ensures the directory exists.
   */
  private _setupCacheDir(): void {
    // Set up cache directory
    const cacheDirEnv = this.config?.CACHE_DIR?.trim() || process.env.CACHE_DIR?.trim();
    if (cacheDirEnv) {
      this.cacheDir = path.resolve(cacheDirEnv);
      logger.info("Using cache directory from CACHE_DIR environment variable:", this.cacheDir);
    } else {
      const cacheDir = path.join(os.homedir(), ".eliza", "cache");
      // Ensure cache directory exists
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
    // Ensure cache directory exists if specified via env var but not yet created
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      logger.debug("Ensured cache directory exists (created):", this.cacheDir);
    } else {
      logger.debug("Cache directory already exists:", this.cacheDir);
    }
  }

  /**
   * Retrieves the singleton instance of LocalAIManager. If an instance does not already exist, a new one is created and returned.
   * @returns {LocalAIManager} The singleton instance of LocalAIManager
   */
  public static getInstance(): LocalAIManager {
    if (!LocalAIManager.instance) {
      LocalAIManager.instance = new LocalAIManager();
    }
    return LocalAIManager.instance;
  }

  /**
   * Initializes the environment by validating the configuration and setting model paths.
   * Now public to be callable from plugin init and model handlers.
   *
   * @returns {Promise<void>} A Promise that resolves once the environment has been successfully initialized.
   */
  public async initializeEnvironment(): Promise<void> {
    // Prevent duplicate initialization
    if (this.environmentInitialized) return;
    if (this.environmentInitializingPromise) {
      await this.environmentInitializingPromise;
      return;
    }

    this.environmentInitializingPromise = (async () => {
      try {
        logger.info("Initializing environment configuration...");

        // Re-validate config to ensure it's up to date
        this.config = await validateConfig();
        this.embeddingModelConfig = resolveEmbeddingModelSpec(this.config, MODEL_SPECS.embedding);

        // Initialize components that depend on validated config
        this._postValidateInit();

        // Set model paths based on validated config
        this.embeddingModelPath = path.join(this.modelsDir, this.embeddingModelConfig.name); // Set embedding path

        logger.info("Using embedding model path:", basename(this.embeddingModelPath));
        logger.info(
          {
            model: this.embeddingModelConfig.name,
            repo: this.embeddingModelConfig.repo,
            dimensions: this.embeddingModelConfig.dimensions,
            contextSize: this.embeddingModelConfig.contextSize,
          },
          "Resolved embedding model spec"
        );

        this.ensureEmbeddingModelFileIsValid();

        logger.info("Environment configuration validated and model paths set");

        this.environmentInitialized = true;
        logger.success("Environment initialization complete");
      } catch (error) {
        logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          "Environment validation failed"
        );
        this.environmentInitializingPromise = null; // Allow retry on failure
        throw error;
      }
    })();

    await this.environmentInitializingPromise;
  }

  /**
   * Downloads the model based on the modelPath provided.
   * Determines the model spec and path based on the model type.
   *
   * @param {ModelTypeName} modelType - The type of model to download
   * @param {ModelSpec} [customModelSpec] - Optional custom model spec to use instead of the default
   * @returns A Promise that resolves to a boolean indicating whether the model download was successful.
   */
  private async downloadModel(
    modelType: ModelTypeName,
    customModelSpec?: ModelSpec,
    forceDownload = false
  ): Promise<boolean> {
    let modelSpec: ModelSpec;
    let modelPathToDownload: string;

    // Ensure environment is initialized to have correct paths
    await this.initializeEnvironment();

    if (customModelSpec) {
      modelSpec = customModelSpec;
      // Use appropriate path based on model type, now read from instance properties
      modelPathToDownload =
        modelType === ModelType.TEXT_EMBEDDING
          ? this.embeddingModelPath
          : modelType === ModelType.TEXT_LARGE
            ? this.mediumModelPath
            : this.modelPath;
    } else if (modelType === ModelType.TEXT_EMBEDDING) {
      modelSpec = this.embeddingModelConfig;
      modelPathToDownload = this.embeddingModelPath; // Use configured path
      this.ensureEmbeddingModelFileIsValid();
    } else {
      modelSpec = modelType === ModelType.TEXT_LARGE ? MODEL_SPECS.medium : MODEL_SPECS.small;
      modelPathToDownload =
        modelType === ModelType.TEXT_LARGE ? this.mediumModelPath : this.modelPath; // Use configured path
    }

    try {
      // Pass the determined path to the download manager
      return await this.downloadManager.downloadModel(
        modelSpec,
        modelPathToDownload,
        forceDownload
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          modelType,
          modelPath: modelPathToDownload,
        },
        "Model download failed"
      );
      throw error;
    }
  }

  /**
   * Asynchronously checks the platform capabilities.
   *
   * @returns {Promise<void>} A promise that resolves once the platform capabilities have been checked.
   */
  public async checkPlatformCapabilities(): Promise<void> {
    try {
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
        "Platform capabilities detected"
      );
    } catch (error) {
      logger.warn(error instanceof Error ? error : String(error), "Platform detection failed");
    }
  }

  /**
   * Initializes the LocalAI Manager for a given model type.
   *
   * @param {ModelTypeName} modelType - The type of model to initialize (default: ModelType.TEXT_SMALL)
   * @returns {Promise<void>} A promise that resolves when initialization is complete or rejects if an error occurs
   */
  async initialize(_modelType: ModelTypeName = ModelType.TEXT_SMALL): Promise<void> {
    await this.initializeEnvironment(); // Ensure environment is initialized first
  }

  public getEmbeddingDimensions(): number {
    return this.embeddingModelConfig.dimensions;
  }

  private ensureEmbeddingModelFileIsValid(): void {
    if (!this.embeddingModelPath || !fs.existsSync(this.embeddingModelPath)) return;
    if (isValidGgufFile(this.embeddingModelPath)) return;

    const { bytesRead, magic } = readMagicHeader(this.embeddingModelPath);
    logger.warn(
      {
        embeddingModelPath: this.embeddingModelPath,
        bytesRead,
        magic,
      },
      "Invalid embedding model file detected; removing corrupt file before download/retry"
    );
    safeUnlink(this.embeddingModelPath);
  }

  private async ensureLlama(): Promise<void> {
    if (this.llama) return;
    this.llama = await getLlama({
      gpu: this.config?.LOCAL_EMBEDDING_FORCE_CPU ? false : "auto",
      logLevel: LlamaLogLevel.error,
      logger: (level, message) => {
        if (level !== "error" && level !== "fatal") return;
        const text = message.trim();
        if (!text) return;
        if (shouldSuppressNodeLlamaLoadError(text)) return;
        logger.error(`[node-llama-cpp] ${text}`);
      },
    });
  }

  private async loadEmbeddingModel(): Promise<void> {
    this.ensureEmbeddingModelFileIsValid();
    const gpuLayers =
      this.config?.LOCAL_EMBEDDING_GPU_LAYERS === -1
        ? "auto"
        : (this.config?.LOCAL_EMBEDDING_GPU_LAYERS ?? 0);
    const useMmap = this.config?.LOCAL_EMBEDDING_USE_MMAP ?? true;

    if (!this.llama) {
      throw new Error(
        "[plugin-local-embedding] llama runtime is not initialized; cannot load embedding model"
      );
    }

    this.embeddingModel = await this.llama.loadModel({
      modelPath: this.embeddingModelPath,
      gpuLayers: gpuLayers as number | "auto" | undefined,
      vocabOnly: false,
      useMmap,
    });

    this.embeddingContext = await this.embeddingModel.createEmbeddingContext({
      contextSize: this.embeddingModelConfig.contextSize,
      batchSize: 512,
    });
  }

  private async initializeEmbeddingWithRecovery(): Promise<void> {
    logger.info("Loading embedding model:", this.embeddingModelPath);
    try {
      await this.loadEmbeddingModel();
      logger.success("Embedding model initialized successfully");
      return;
    } catch (error) {
      if (!isCorruptedModelLoadError(error)) {
        throw error;
      }
      logger.warn(
        {
          error: getErrorMessage(error),
          embeddingModelPath: this.embeddingModelPath,
        },
        "Embedding model appears corrupted/incomplete; deleting and re-downloading"
      );

      this.embeddingModel = undefined;
      this.embeddingContext = undefined;
      safeUnlink(this.embeddingModelPath);

      await this.downloadModel(ModelType.TEXT_EMBEDDING, undefined, true);
      this.ensureEmbeddingModelFileIsValid();
      await this.loadEmbeddingModel();
      logger.success("Embedding model recovered after re-download");
    }
  }

  /**
   * Asynchronously initializes the embedding model.
   *
   * @returns {Promise<void>} A promise that resolves once the initialization is complete.
   */
  public async initializeEmbedding(): Promise<void> {
    try {
      await this.initializeEnvironment(); // Ensure environment/paths are ready
      logger.info("Initializing embedding model...");
      logger.info("Models directory:", this.modelsDir);

      // Ensure models directory exists
      if (!fs.existsSync(this.modelsDir)) {
        logger.warn("Models directory does not exist, creating it:", this.modelsDir);
        fs.mkdirSync(this.modelsDir, { recursive: true });
      }

      // Download the embedding model using the common downloadModel function
      // This will now use the correct embeddingModelPath
      await this.downloadModel(ModelType.TEXT_EMBEDDING);
      this.ensureEmbeddingModelFileIsValid();

      // Initialize the llama instance if not already done
      await this.ensureLlama();

      // Load the embedding model
      if (!this.embeddingModel) {
        await this.initializeEmbeddingWithRecovery();
      }
    } catch (error) {
      if (isCorruptedModelLoadError(error)) {
        logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            modelsDir: this.modelsDir,
            embeddingModelPath: this.embeddingModelPath,
          },
          "Embedding initialization failed due to model corruption"
        );
        safeUnlink(this.embeddingModelPath);
      } else {
        logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            modelsDir: this.modelsDir,
            embeddingModelPath: this.embeddingModelPath, // Log the path being used
          },
          "Embedding initialization failed with details"
        );
      }
      throw error;
    }
  }

  /**
   * Generate embeddings using the proper LlamaContext.getEmbedding method.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      // Lazy initialize embedding model
      await this.lazyInitEmbedding();

      if (!this.embeddingModel || !this.embeddingContext) {
        throw new Error("Failed to initialize embedding model");
      }

      logger.info({ textLength: text.length }, "Generating embedding for text");
      let candidateText = text;
      let attempt = 0;
      while (true) {
        try {
          const embeddingResult = await this.embeddingContext.getEmbeddingFor(candidateText);
          const mutableEmbedding = [...embeddingResult.vector];
          const sizedEmbedding = this.alignEmbeddingDimensions(mutableEmbedding);
          const normalizedEmbedding = this.normalizeEmbedding(sizedEmbedding);
          logger.info({ dimensions: normalizedEmbedding.length }, "Embedding generation complete");
          return normalizedEmbedding;
        } catch (error) {
          if (!isContextLimitError(error)) {
            throw error;
          }
          const nextCandidate = shrinkEmbeddingInput(candidateText);
          if (nextCandidate === candidateText) {
            throw error;
          }
          attempt += 1;
          logger.warn(
            {
              attempt,
              currentChars: candidateText.length,
              nextChars: nextCandidate.length,
            },
            "Embedding input exceeded context window; retrying with truncated text"
          );
          candidateText = nextCandidate;
        }
      }
    } catch (error) {
      if (isCorruptedModelLoadError(error)) {
        logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            textLength: text?.length ?? "text is null",
            embeddingModelPath: this.embeddingModelPath,
          },
          "Embedding generation failed due to model corruption; model file removed"
        );
        safeUnlink(this.embeddingModelPath);
        this.embeddingModel = undefined;
        this.embeddingContext = undefined;
        this.embeddingInitialized = false;
      } else {
        logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            textLength: text?.length ?? "text is null",
          },
          "Embedding generation failed"
        );
      }

      throw error instanceof Error
        ? error
        : new Error(`Embedding generation failed: ${String(error)}`);
    }
  }

  /**
   * Normalizes an embedding vector using L2 normalization
   *
   * @param {number[]} embedding - The embedding vector to normalize
   * @returns {number[]} - The normalized embedding vector
   */
  private alignEmbeddingDimensions(embedding: number[]): number[] {
    const targetDimensions = this.getEmbeddingDimensions();
    if (targetDimensions <= 0 || embedding.length === targetDimensions) {
      return embedding;
    }

    logger.warn(
      {
        observedDimensions: embedding.length,
        targetDimensions,
      },
      "Embedding dimensions mismatch; adjusting output dimensions"
    );

    if (embedding.length > targetDimensions) {
      return embedding.slice(0, targetDimensions);
    }

    return [...embedding, ...new Array(targetDimensions - embedding.length).fill(0)];
  }

  private normalizeEmbedding(embedding: number[]): number[] {
    // Calculate the L2 norm (Euclidean norm)
    const squareSum = embedding.reduce((sum, val) => sum + val * val, 0);
    const norm = Math.sqrt(squareSum);

    // Avoid division by zero
    if (norm === 0) {
      return embedding;
    }

    // Normalize each component
    return embedding.map((val) => val / norm);
  }

  /**
   * Lazy initialize the embedding model
   */
  private async lazyInitEmbedding(): Promise<void> {
    if (this.embeddingInitialized) return;

    if (!this.embeddingInitializingPromise) {
      this.embeddingInitializingPromise = (async () => {
        try {
          // Ensure environment is initialized first to get correct paths
          await this.initializeEnvironment();

          // Download model if needed (uses the correct path now)
          await this.downloadModel(ModelType.TEXT_EMBEDDING);
          this.ensureEmbeddingModelFileIsValid();

          // Initialize the llama instance if not already done
          await this.ensureLlama();

          await this.initializeEmbeddingWithRecovery();

          this.embeddingInitialized = true;
          logger.info("Embedding model initialized successfully");
        } catch (error) {
          if (isCorruptedModelLoadError(error)) {
            logger.warn(
              error instanceof Error ? error : String(error),
              "Failed to initialize embedding model due to corruption"
            );
            safeUnlink(this.embeddingModelPath);
          } else {
            logger.error(
              error instanceof Error ? error : String(error),
              "Failed to initialize embedding model"
            );
          }
          this.embeddingInitializingPromise = null;
          throw error;
        }
      })();
    }

    await this.embeddingInitializingPromise;
  }

  /**
   * Returns the TokenizerManager associated with this object.
   *
   * @returns {TokenizerManager} The TokenizerManager object.
   */
  public getTokenizerManager(): TokenizerManager {
    return this.tokenizerManager;
  }

  /**
   * Returns the active model configuration.
   * @returns {ModelSpec} The active model configuration.
   */
  public getActiveModelConfig(): ModelSpec {
    return this.activeModelConfig;
  }
}

// Create manager instance
const localAIManager = LocalAIManager.getInstance();

/**
 * Plugin that provides functionality for local AI using LLaMA models.
 * @type {Plugin}
 */
export const localAiPlugin: Plugin = {
  name: "local-ai",
  description: "Local AI plugin using LLaMA models",
  // Higher priority ensures local embeddings are used instead of remote
  // providers (e.g. ElizaCloud, OpenAI) even when plugins register in
  // parallel and the registration order is non-deterministic.
  priority: 10,

  async init(_config: unknown, _runtime: IAgentRuntime) {
    logger.info("Initializing local embedding plugin...");

    try {
      await localAIManager.initializeEnvironment();
      await localAIManager.checkPlatformCapabilities();

      const config = validateConfig();
      const modelsDir = config.MODELS_DIR || path.join(os.homedir(), ".eliza", "models");
      const embeddingModelPath = path.join(modelsDir, config.LOCAL_EMBEDDING_MODEL);

      if (fs.existsSync(embeddingModelPath)) {
        logger.info(
          { embeddingModelPath: basename(embeddingModelPath) },
          "Embedding model file is present"
        );
      } else {
        logger.info(
          { embeddingModelPath: basename(embeddingModelPath) },
          "Embedding model file not present yet; it will be downloaded on first use"
        );
      }

      logger.success("Local embedding plugin initialized");
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to initialize local embedding plugin"
      );
      throw error instanceof Error
        ? error
        : new Error(`Failed to initialize local embedding plugin: ${String(error)}`);
    }
  },
  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      _runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      // Extract text from params - can be string, object with text, or null
      let text: string | undefined;
      if (typeof params === "string") {
        text = params;
      } else if (params && typeof params === "object" && "text" in params) {
        text = params.text;
      }

      try {
        if (params == null) {
          return new Array(localAIManager.getEmbeddingDimensions()).fill(0);
        }

        if (!text || text.trim().length === 0) {
          throw new Error("TEXT_EMBEDDING requires non-empty text");
        }

        // Pass the raw text directly to the framework without any manipulation
        return await localAIManager.generateEmbedding(text);
      } catch (error) {
        logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
            fullText: text,
            textType: typeof text,
            textStructure: text !== null ? JSON.stringify(text, null, 2) : "null",
          },
          "Error in TEXT_EMBEDDING handler"
        );
        throw error instanceof Error
          ? error
          : new Error(`TEXT_EMBEDDING handler failed: ${String(error)}`);
      }
    },

    [ModelType.TEXT_TOKENIZER_ENCODE]: async (
      _runtime: IAgentRuntime,
      params: TokenizeTextParams
    ): Promise<number[]> => {
      try {
        const manager = localAIManager.getTokenizerManager();
        const config = localAIManager.getActiveModelConfig();
        return await manager.encode(params.prompt, config);
      } catch (error) {
        logger.error(
          error instanceof Error ? error : String(error),
          "Error in TEXT_TOKENIZER_ENCODE handler"
        );
        throw error;
      }
    },

    [ModelType.TEXT_TOKENIZER_DECODE]: async (
      _runtime: IAgentRuntime,
      params: DetokenizeTextParams
    ): Promise<string> => {
      try {
        const manager = localAIManager.getTokenizerManager();
        const config = localAIManager.getActiveModelConfig();
        return await manager.decode(params.tokens, config);
      } catch (error) {
        logger.error(
          error instanceof Error ? error : String(error),
          "Error in TEXT_TOKENIZER_DECODE handler"
        );
        throw error;
      }
    },
  },
  tests: [
    {
      name: "local_ai_plugin_tests",
      tests: [
        {
          name: "local_ai_test_text_embedding",
          fn: async (runtime) => {
            try {
              logger.info("Starting TEXT_EMBEDDING test");

              // Test with normal text
              const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
                text: "This is a test of the text embedding model.",
              });

              logger.info({ count: embedding.length }, "Embedding generated with dimensions");

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
              logger.error(
                {
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                },
                "TEXT_EMBEDDING test failed"
              );
              throw error;
            }
          },
        },
        {
          name: "local_ai_test_tokenizer_encode",
          fn: async (runtime) => {
            try {
              logger.info("Starting TEXT_TOKENIZER_ENCODE test");
              const prompt = "Hello tokenizer test!";

              const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, {
                prompt,
                modelType: ModelType.TEXT_TOKENIZER_ENCODE,
              });
              logger.info({ count: tokens.length }, "Encoded tokens");

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
              logger.error(
                {
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                },
                "TEXT_TOKENIZER_ENCODE test failed"
              );
              throw error;
            }
          },
        },
        {
          name: "local_ai_test_tokenizer_decode",
          fn: async (runtime) => {
            try {
              logger.info("Starting TEXT_TOKENIZER_DECODE test");

              // First encode some text
              const originalText = "Hello tokenizer test!";
              const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, {
                prompt: originalText,
                modelType: ModelType.TEXT_TOKENIZER_ENCODE,
              });

              // Then decode it back
              const decodedText = await runtime.useModel(ModelType.TEXT_TOKENIZER_DECODE, {
                tokens,
                modelType: ModelType.TEXT_TOKENIZER_DECODE,
              });
              logger.info(
                { original: originalText, decoded: decodedText },
                "Round trip tokenization"
              );

              if (typeof decodedText !== "string") {
                throw new Error("Decoded output is not a string");
              }

              logger.success("TEXT_TOKENIZER_DECODE test completed successfully");
            } catch (error) {
              logger.error(
                {
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                },
                "TEXT_TOKENIZER_DECODE test failed"
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
