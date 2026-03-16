import type {
  ModelTypeName,
  TextEmbeddingParams,
  TokenizeTextParams,
  DetokenizeTextParams,
} from "@elizaos/core";
import {
  type IAgentRuntime,
  ModelType,
  type Plugin,
  logger,
} from "@elizaos/core";
import {
  type Llama,
  LlamaEmbeddingContext,
  type LlamaModel,
  getLlama,
} from "node-llama-cpp";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { basename } from "path";
import { type Config, validateConfig } from "./environment";
import { type EmbeddingModelSpec, MODEL_SPECS, type ModelSpec } from "./types";
import { DownloadManager } from "./utils/downloadManager";
import { getPlatformManager } from "./utils/platform";
import { TokenizerManager } from "./utils/tokenizerManager";

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
    this.downloadManager = DownloadManager.getInstance(
      this.cacheDir,
      this.modelsDir,
    );
    this.tokenizerManager = TokenizerManager.getInstance(
      this.cacheDir,
      this.modelsDir,
    );
  }

  /**
   * Sets up the models directory, reading from config or environment variables,
   * and ensures the directory exists.
   */
  private _setupModelsDir(): void {
    // Set up models directory consistently, similar to cacheDir
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

    // Ensure models directory exists
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

  /**
   * Sets up the cache directory, reading from config or environment variables,
   * and ensures the directory exists.
   */
  private _setupCacheDir(): void {
    // Set up cache directory
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
      // Ensure cache directory exists
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

        // Initialize components that depend on validated config
        this._postValidateInit();

        // Set model paths based on validated config
        this.embeddingModelPath = path.join(
          this.modelsDir,
          this.config.LOCAL_EMBEDDING_MODEL,
        ); // Set embedding path

        logger.info(
          "Using embedding model path:",
          basename(this.embeddingModelPath),
        );

        logger.info("Environment configuration validated and model paths set");

        this.environmentInitialized = true;
        logger.success("Environment initialization complete");
      } catch (error) {
        logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          "Environment validation failed",
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

    try {
      // Pass the determined path to the download manager
      return await this.downloadManager.downloadModel(
        modelSpec,
        modelPathToDownload,
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          modelType,
          modelPath: modelPathToDownload,
        },
        "Model download failed",
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
        "Platform capabilities detected",
      );
    } catch (error) {
      logger.warn(
        error instanceof Error ? error : String(error),
        "Platform detection failed",
      );
    }
  }

  /**
   * Initializes the LocalAI Manager for a given model type.
   *
   * @param {ModelTypeName} modelType - The type of model to initialize (default: ModelType.TEXT_SMALL)
   * @returns {Promise<void>} A promise that resolves when initialization is complete or rejects if an error occurs
   */
  async initialize(
    modelType: ModelTypeName = ModelType.TEXT_SMALL,
  ): Promise<void> {
    await this.initializeEnvironment(); // Ensure environment is initialized first
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
        logger.warn(
          "Models directory does not exist, creating it:",
          this.modelsDir,
        );
        fs.mkdirSync(this.modelsDir, { recursive: true });
      }

      // Download the embedding model using the common downloadModel function
      // This will now use the correct embeddingModelPath
      await this.downloadModel(ModelType.TEXT_EMBEDDING);

      // Initialize the llama instance if not already done
      if (!this.llama) {
        this.llama = await getLlama();
      }

      // Load the embedding model
      if (!this.embeddingModel) {
        logger.info("Loading embedding model:", this.embeddingModelPath); // Use the correct path

        this.embeddingModel = await this.llama.loadModel({
          modelPath: this.embeddingModelPath, // Use the correct path
          gpuLayers: 0, // Embedding models are typically small enough to run on CPU
          vocabOnly: false,
        });

        // Create context for embeddings
        this.embeddingContext =
          await this.embeddingModel.createEmbeddingContext({
            contextSize: this.embeddingModelConfig.contextSize,
            batchSize: 512,
          });

        logger.success("Embedding model initialized successfully");
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          modelsDir: this.modelsDir,
          embeddingModelPath: this.embeddingModelPath, // Log the path being used
        },
        "Embedding initialization failed with details",
      );
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

      // Use the native getEmbedding method
      const embeddingResult = await this.embeddingContext.getEmbeddingFor(text);

      // Convert readonly array to mutable array
      const mutableEmbedding = [...embeddingResult.vector];

      // Normalize the embedding if needed (may already be normalized)
      const normalizedEmbedding = this.normalizeEmbedding(mutableEmbedding);

      logger.info(
        { dimensions: normalizedEmbedding.length },
        "Embedding generation complete",
      );
      return normalizedEmbedding;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          textLength: text?.length ?? "text is null",
        },
        "Embedding generation failed",
      );

      // Return zero vector with correct dimensions as fallback
      const zeroDimensions = this.config?.LOCAL_EMBEDDING_DIMENSIONS // Use validated config
        ? this.config.LOCAL_EMBEDDING_DIMENSIONS
        : this.embeddingModelConfig.dimensions;

      return new Array(zeroDimensions).fill(0);
    }
  }

  /**
   * Normalizes an embedding vector using L2 normalization
   *
   * @param {number[]} embedding - The embedding vector to normalize
   * @returns {number[]} - The normalized embedding vector
   */
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

          // Initialize the llama instance if not already done
          if (!this.llama) {
            this.llama = await getLlama();
          }

          // Load the embedding model (uses the correct path)
          this.embeddingModel = await this.llama.loadModel({
            modelPath: this.embeddingModelPath,
            gpuLayers: 0, // Embedding models are typically small enough to run on CPU
            vocabOnly: false,
          });

          // Create context for embeddings
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
            "Failed to initialize embedding model",
          );
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

  async init(_config: any, runtime: IAgentRuntime) {
    logger.info("🚀 Initializing Local AI plugin...");

    try {
      // Initialize environment and validate configuration
      await localAIManager.initializeEnvironment();
      const config = validateConfig();

      // Check if models directory is accessible
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

      // Perform a basic initialization test
      logger.info("🔍 Testing Local AI initialization...");

      try {
        // Check platform capabilities
        await localAIManager.checkPlatformCapabilities();

        // Test if we can get the llama instance
        const llamaInstance = await getLlama();
        if (llamaInstance) {
          logger.success("✅ Local AI: llama.cpp library loaded successfully");
        } else {
          throw new Error("Failed to load llama.cpp library");
        }

        // Check if at least one model file exists
        const embeddingModelPath = path.join(
          modelsDir,
          config.LOCAL_EMBEDDING_MODEL,
        );

        const modelsExist = {
          embedding: fs.existsSync(embeddingModelPath),
        };

        if (!modelsExist.embedding) {
          logger.warn("⚠️ No model files found in models directory");
          logger.warn(
            "Models will be downloaded on first use, which may take time",
          );
          logger.warn(
            "To pre-download models, run the plugin and it will fetch them automatically",
          );
        } else {
          logger.info(
            { embedding: modelsExist.embedding ? "✓" : "✗" },
            "📦 Found model files",
          );
        }

        logger.success("✅ Local AI plugin initialized successfully");
        logger.info("💡 Models will be loaded on-demand when first used");
      } catch (testError) {
        logger.error(
          testError instanceof Error ? testError : String(testError),
          "❌ Local AI initialization test failed",
        );
        logger.warn("The plugin may not function correctly");
        logger.warn("Please check:");
        logger.warn("1. Your system has sufficient memory (8GB+ recommended)");
        logger.warn("2. C++ build tools are installed (for node-llama-cpp)");
        logger.warn("3. Your CPU supports the required instruction sets");
        // Don't throw here - allow the plugin to load even if the test fails
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "❌ Failed to initialize Local AI plugin",
      );

      // Provide helpful guidance based on common errors
      if (error instanceof Error) {
        if (error.message.includes("Cannot find module")) {
          logger.error("📚 Missing dependencies detected");
          logger.error("Please run: npm install or bun install");
        } else if (error.message.includes("node-llama-cpp")) {
          logger.error("🔧 node-llama-cpp build issue detected");
          logger.error("Please ensure C++ build tools are installed:");
          logger.error("- Windows: Install Visual Studio Build Tools");
          logger.error("- macOS: Install Xcode Command Line Tools");
          logger.error("- Linux: Install build-essential package");
        }
      }

      // Don't throw - allow the system to continue without this plugin
      logger.warn("⚠️ Local AI plugin will not be available");
    }
  },
  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      _runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null,
    ): Promise<number[]> => {
      // Extract text from params - can be string, object with text, or null
      let text: string | undefined;
      if (typeof params === "string") {
        text = params;
      } else if (params && typeof params === "object" && "text" in params) {
        text = params.text;
      }

      try {
        // Handle null/undefined/empty text
        if (!text) {
          logger.debug(
            "Null or empty text input for embedding, returning zero vector",
          );
          return new Array(384).fill(0);
        }

        // Pass the raw text directly to the framework without any manipulation
        return await localAIManager.generateEmbedding(text);
      } catch (error) {
        logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
            fullText: text,
            textType: typeof text,
            textStructure:
              text !== null ? JSON.stringify(text, null, 2) : "null",
          },
          "Error in TEXT_EMBEDDING handler",
        );
        return new Array(384).fill(0);
      }
    },

    [ModelType.TEXT_TOKENIZER_ENCODE]: async (
      _runtime: IAgentRuntime,
      params: TokenizeTextParams,
    ): Promise<number[]> => {
      try {
        const manager = localAIManager.getTokenizerManager();
        const config = localAIManager.getActiveModelConfig();
        return await manager.encode(params.prompt, config);
      } catch (error) {
        logger.error(
          error instanceof Error ? error : String(error),
          "Error in TEXT_TOKENIZER_ENCODE handler",
        );
        throw error;
      }
    },

    [ModelType.TEXT_TOKENIZER_DECODE]: async (
      _runtime: IAgentRuntime,
      params: DetokenizeTextParams,
    ): Promise<string> => {
      try {
        const manager = localAIManager.getTokenizerManager();
        const config = localAIManager.getActiveModelConfig();
        return await manager.decode(params.tokens, config);
      } catch (error) {
        logger.error(
          error instanceof Error ? error : String(error),
          "Error in TEXT_TOKENIZER_DECODE handler",
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
              const embedding = await runtime.useModel(
                ModelType.TEXT_EMBEDDING,
                {
                  text: "This is a test of the text embedding model.",
                },
              );

              logger.info(
                { count: embedding.length },
                "Embedding generated with dimensions",
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
                "TEXT_EMBEDDING test failed",
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

              const tokens = await runtime.useModel(
                ModelType.TEXT_TOKENIZER_ENCODE,
                {
                  prompt,
                  modelType: ModelType.TEXT_TOKENIZER_ENCODE,
                },
              );
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

              logger.success(
                "TEXT_TOKENIZER_ENCODE test completed successfully",
              );
            } catch (error) {
              logger.error(
                {
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                },
                "TEXT_TOKENIZER_ENCODE test failed",
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
              const tokens = await runtime.useModel(
                ModelType.TEXT_TOKENIZER_ENCODE,
                {
                  prompt: originalText,
                  modelType: ModelType.TEXT_TOKENIZER_ENCODE,
                },
              );

              // Then decode it back
              const decodedText = await runtime.useModel(
                ModelType.TEXT_TOKENIZER_DECODE,
                {
                  tokens,
                  modelType: ModelType.TEXT_TOKENIZER_DECODE,
                },
              );
              logger.info(
                { original: originalText, decoded: decodedText },
                "Round trip tokenization",
              );

              if (typeof decodedText !== "string") {
                throw new Error("Decoded output is not a string");
              }

              logger.success(
                "TEXT_TOKENIZER_DECODE test completed successfully",
              );
            } catch (error) {
              logger.error(
                {
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                },
                "TEXT_TOKENIZER_DECODE test failed",
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
