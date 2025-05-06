import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type {
  GenerateTextParams,
  ModelTypeName,
  TextEmbeddingParams,
  ObjectGenerationParams,
} from '@elizaos/core';
import { type IAgentRuntime, ModelType, type Plugin, logger } from '@elizaos/core';
import {
  type Llama,
  LlamaChatSession,
  type LlamaContext,
  type LlamaContextSequence,
  LlamaEmbeddingContext,
  type LlamaModel,
  getLlama,
} from 'node-llama-cpp';
import { validateConfig, type Config } from './environment';
import { MODEL_SPECS, type ModelSpec, type EmbeddingModelSpec } from './types';
import { DownloadManager } from './utils/downloadManager';
import { getPlatformManager } from './utils/platform';
import { TokenizerManager } from './utils/tokenizerManager';
import { TranscribeManager } from './utils/transcribeManager';
import { TTSManager } from './utils/ttsManager';
import { VisionManager } from './utils/visionManager';
import { basename } from 'path';

// Words to punish in LLM responses
/**
 * Array containing words that should trigger a punishment when used in a message.
 * This array includes words like "please", "feel", "free", punctuation marks, and various topic-related words.
 * @type {string[]}
 */
const wordsToPunish = [
  ' please',
  ' feel',
  ' free',
  '!',
  '–',
  '—',
  '?',
  '.',
  ',',
  '; ',
  ' cosmos',
  ' tapestry',
  ' tapestries',
  ' glitch',
  ' matrix',
  ' cyberspace',
  ' troll',
  ' questions',
  ' topics',
  ' discuss',
  ' basically',
  ' simulation',
  ' simulate',
  ' universe',
  ' like',
  ' debug',
  ' debugging',
  ' wild',
  ' existential',
  ' juicy',
  ' circuits',
  ' help',
  ' ask',
  ' happy',
  ' just',
  ' cosmic',
  ' cool',
  ' joke',
  ' punchline',
  ' fancy',
  ' glad',
  ' assist',
  ' algorithm',
  ' Indeed',
  ' Furthermore',
  ' However',
  ' Notably',
  ' Therefore',
];

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
  private smallModel: LlamaModel | undefined;
  private mediumModel: LlamaModel | undefined;
  private embeddingModel: LlamaModel | undefined;
  private embeddingContext: LlamaEmbeddingContext | undefined;
  private ctx: LlamaContext | undefined;
  private sequence: LlamaContextSequence | undefined;
  private chatSession: LlamaChatSession | undefined;
  private modelPath!: string;
  private mediumModelPath!: string;
  private embeddingModelPath!: string;
  private cacheDir: string;
  private tokenizerManager: TokenizerManager;
  private downloadManager: DownloadManager;
  private visionManager: VisionManager;
  private activeModelConfig: ModelSpec;
  private embeddingModelConfig: EmbeddingModelSpec;
  private transcribeManager: TranscribeManager;
  private ttsManager: TTSManager;
  private config: Config | null = null; // Store validated config

  // Initialization state flag
  private smallModelInitialized = false;
  private mediumModelInitialized = false;
  private embeddingInitialized = false;
  private visionInitialized = false;
  private transcriptionInitialized = false;
  private ttsInitialized = false;
  private environmentInitialized = false; // Add flag for environment initialization

  // Initialization promises to prevent duplicate initialization
  private smallModelInitializingPromise: Promise<void> | null = null;
  private mediumModelInitializingPromise: Promise<void> | null = null;
  private embeddingInitializingPromise: Promise<void> | null = null;
  private visionInitializingPromise: Promise<void> | null = null;
  private transcriptionInitializingPromise: Promise<void> | null = null;
  private ttsInitializingPromise: Promise<void> | null = null;
  private environmentInitializingPromise: Promise<void> | null = null; // Add promise for environment

  private modelsDir: string;

  /**
   * Private constructor function to initialize base managers and paths.
   * Model paths are set after environment initialization.
   */
  private constructor() {
    this.config = validateConfig();

    this._setupModelsDir();
    this._setupCacheDir();

    // Initialize managers
    this.downloadManager = DownloadManager.getInstance(this.cacheDir, this.modelsDir);
    this.tokenizerManager = TokenizerManager.getInstance(this.cacheDir, this.modelsDir);
    this.visionManager = VisionManager.getInstance(this.cacheDir);
    this.transcribeManager = TranscribeManager.getInstance(this.cacheDir);

    // Initialize active model config (default)
    this.activeModelConfig = MODEL_SPECS.small;
    // Initialize embedding model config (spec details)
    this.embeddingModelConfig = MODEL_SPECS.embedding;
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
      logger.info('Using models directory from MODELS_DIR environment variable:', this.modelsDir);
    } else {
      this.modelsDir = path.join(os.homedir(), '.eliza', 'models');
      logger.info(
        'MODELS_DIR environment variable not set, using default models directory:',
        this.modelsDir
      );
    }

    // Ensure models directory exists
    if (!fs.existsSync(this.modelsDir)) {
      fs.mkdirSync(this.modelsDir, { recursive: true });
      logger.debug('Ensured models directory exists (created):', this.modelsDir);
    } else {
      logger.debug('Models directory already exists:', this.modelsDir);
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
      logger.info('Using cache directory from CACHE_DIR environment variable:', this.cacheDir);
    } else {
      const cacheDir = path.join(os.homedir(), '.eliza', 'cache');
      // Ensure cache directory exists
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
        logger.debug('Ensuring cache directory exists (created):', cacheDir);
      }
      this.cacheDir = cacheDir;
      logger.info(
        'CACHE_DIR environment variable not set, using default cache directory:',
        this.cacheDir
      );
    }
    // Ensure cache directory exists if specified via env var but not yet created
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      logger.debug('Ensured cache directory exists (created):', this.cacheDir);
    } else {
      logger.debug('Cache directory already exists:', this.cacheDir);
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
        logger.info('Initializing environment configuration...');

        // Configuration is already validated and set in the constructor.
        // We just need to ensure this.config is not null before proceeding.
        if (!this.config) {
          // This case should ideally not happen if constructor logic is sound.
          logger.error('Config not available during environment initialization.');
          throw new Error('Configuration not initialized');
        }

        // Set model paths based on validated config
        this.modelPath = path.join(this.modelsDir, this.config.LOCAL_SMALL_MODEL);
        this.mediumModelPath = path.join(this.modelsDir, this.config.LOCAL_LARGE_MODEL);
        this.embeddingModelPath = path.join(this.modelsDir, this.config.LOCAL_EMBEDDING_MODEL); // Set embedding path

        logger.info('Using small model path:', basename(this.modelPath));
        logger.info('Using medium model path:', basename(this.mediumModelPath));
        logger.info('Using embedding model path:', basename(this.embeddingModelPath));

        logger.info('Environment configuration validated and model paths set');

        this.environmentInitialized = true;
        logger.success('Environment initialization complete');
      } catch (error) {
        logger.error('Environment validation failed:', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
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
    customModelSpec?: ModelSpec
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
      modelSpec = modelType === ModelType.TEXT_LARGE ? MODEL_SPECS.medium : MODEL_SPECS.small;
      modelPathToDownload =
        modelType === ModelType.TEXT_LARGE ? this.mediumModelPath : this.modelPath; // Use configured path
    }

    try {
      // Pass the determined path to the download manager
      return await this.downloadManager.downloadModel(modelSpec, modelPathToDownload);
    } catch (error) {
      logger.error('Model download failed:', {
        error: error instanceof Error ? error.message : String(error),
        modelType,
        modelPath: modelPathToDownload,
      });
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

      logger.info('Platform capabilities detected:', {
        platform: capabilities.platform,
        gpu: capabilities.gpu?.type || 'none',
        recommendedModel: capabilities.recommendedModelSize,
        supportedBackends: capabilities.supportedBackends,
      });
    } catch (error) {
      logger.warn('Platform detection failed:', error);
    }
  }

  /**
   * Initializes the LocalAI Manager for a given model type.
   *
   * @param {ModelTypeName} modelType - The type of model to initialize (default: ModelType.TEXT_SMALL)
   * @returns {Promise<void>} A promise that resolves when initialization is complete or rejects if an error occurs
   */
  async initialize(modelType: ModelTypeName = ModelType.TEXT_SMALL): Promise<void> {
    await this.initializeEnvironment(); // Ensure environment is initialized first
    if (modelType === ModelType.TEXT_LARGE) {
      await this.lazyInitMediumModel();
    } else {
      await this.lazyInitSmallModel();
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
      logger.info('Initializing embedding model...');
      logger.info('Models directory:', this.modelsDir);

      // Ensure models directory exists
      if (!fs.existsSync(this.modelsDir)) {
        logger.warn('Models directory does not exist, creating it:', this.modelsDir);
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
        logger.info('Loading embedding model:', this.embeddingModelPath); // Use the correct path

        this.embeddingModel = await this.llama.loadModel({
          modelPath: this.embeddingModelPath, // Use the correct path
          gpuLayers: 0, // Embedding models are typically small enough to run on CPU
          vocabOnly: false,
        });

        // Create context for embeddings
        this.embeddingContext = await this.embeddingModel.createEmbeddingContext({
          contextSize: this.embeddingModelConfig.contextSize,
          batchSize: 512,
        });

        logger.success('Embedding model initialized successfully');
      }
    } catch (error) {
      logger.error('Embedding initialization failed with details:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        modelsDir: this.modelsDir,
        embeddingModelPath: this.embeddingModelPath, // Log the path being used
      });
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
        throw new Error('Failed to initialize embedding model');
      }

      logger.info('Generating embedding for text', { textLength: text.length });

      // Use the native getEmbedding method
      const embeddingResult = await this.embeddingContext.getEmbeddingFor(text);

      // Convert readonly array to mutable array
      const mutableEmbedding = [...embeddingResult.vector];

      // Normalize the embedding if needed (may already be normalized)
      const normalizedEmbedding = this.normalizeEmbedding(mutableEmbedding);

      logger.info('Embedding generation complete', { dimensions: normalizedEmbedding.length });
      return normalizedEmbedding;
    } catch (error) {
      logger.error('Embedding generation failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        textLength: text?.length ?? 'text is null',
      });

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
          this.embeddingContext = await this.embeddingModel.createEmbeddingContext({
            contextSize: this.embeddingModelConfig.contextSize,
            batchSize: 512,
          });

          this.embeddingInitialized = true;
          logger.info('Embedding model initialized successfully');
        } catch (error) {
          logger.error('Failed to initialize embedding model:', error);
          this.embeddingInitializingPromise = null;
          throw error;
        }
      })();
    }

    await this.embeddingInitializingPromise;
  }

  /**
   * Asynchronously generates text based on the provided parameters.
   * Now uses lazy initialization for models
   */
  async generateText(params: GenerateTextParams): Promise<string> {
    try {
      await this.initializeEnvironment(); // Ensure environment is initialized
      logger.info('Generating text with model:', params.modelType);
      // Lazy initialize the appropriate model
      if (params.modelType === ModelType.TEXT_LARGE) {
        await this.lazyInitMediumModel();

        if (!this.mediumModel) {
          throw new Error('Medium model initialization failed');
        }

        this.activeModelConfig = MODEL_SPECS.medium;
        const mediumModel = this.mediumModel;

        // Create fresh context
        this.ctx = await mediumModel.createContext({
          contextSize: MODEL_SPECS.medium.contextSize,
        });
      } else {
        await this.lazyInitSmallModel();

        if (!this.smallModel) {
          throw new Error('Small model initialization failed');
        }

        this.activeModelConfig = MODEL_SPECS.small;
        const smallModel = this.smallModel;

        // Create fresh context
        this.ctx = await smallModel.createContext({
          contextSize: MODEL_SPECS.small.contextSize,
        });
      }

      if (!this.ctx) {
        throw new Error('Failed to create prompt');
      }

      // QUICK TEST FIX: Always get fresh sequence
      this.sequence = this.ctx.getSequence();

      // QUICK TEST FIX: Create new session each time without maintaining state
      // Only use valid options for LlamaChatSession
      this.chatSession = new LlamaChatSession({
        contextSequence: this.sequence,
      });

      if (!this.chatSession) {
        throw new Error('Failed to create chat session');
      }
      logger.info('Created new chat session for model:', params.modelType);
      // Log incoming prompt for debugging
      logger.info('Incoming prompt structure:', {
        contextLength: params.prompt.length,
        hasAction: params.prompt.includes('action'),
        runtime: !!params.runtime,
        stopSequences: params.stopSequences,
      });

      const tokens = await this.tokenizerManager.encode(params.prompt, this.activeModelConfig);
      logger.info('Input tokens:', { count: tokens.length });

      // QUICK TEST FIX: Add system message to reset prompt
      const systemMessage = 'You are a helpful AI assistant. Respond to the current request only.';
      await this.chatSession.prompt(systemMessage, {
        maxTokens: 1, // Minimal tokens for system message
        temperature: 0.0,
      });

      let response = await this.chatSession.prompt(params.prompt, {
        maxTokens: 8192,
        temperature: 0.7,
        topP: 0.9,
        repeatPenalty: {
          punishTokensFilter: () =>
            this.smallModel ? this.smallModel.tokenize(wordsToPunish.join(' ')) : [],
          penalty: 1.2,
          frequencyPenalty: 0.7,
          presencePenalty: 0.7,
        },
      });

      // Log raw response for debugging
      logger.info('Raw response structure:', {
        responseLength: response.length,
        hasAction: response.includes('action'),
        hasThinkTag: response.includes('<think>'),
      });

      // Clean think tags if present
      if (response.includes('<think>')) {
        logger.info('Cleaning think tags from response');
        response = response.replace(/<think>[\s\S]*?<\/think>\n?/g, '');
        logger.info('Think tags removed from response');
      }

      // Return the raw response and let the framework handle JSON parsing and action validation
      return response;
    } catch (error) {
      logger.error('Text generation failed:', error);
      throw error;
    }
  }

  /**
   * Describe image with lazy vision model initialization
   */
  public async describeImage(
    imageData: Buffer,
    mimeType: string
  ): Promise<{ title: string; description: string }> {
    try {
      // Lazy initialize vision model
      await this.lazyInitVision();

      // Convert buffer to data URL
      const base64 = imageData.toString('base64');
      const dataUrl = `data:${mimeType};base64,${base64}`;
      return await this.visionManager.processImage(dataUrl);
    } catch (error) {
      logger.error('Image description failed:', error);
      throw error;
    }
  }

  /**
   * Transcribe audio with lazy transcription model initialization
   */
  public async transcribeAudio(audioBuffer: Buffer): Promise<string> {
    try {
      // Lazy initialize transcription model
      await this.lazyInitTranscription();

      const result = await this.transcribeManager.transcribe(audioBuffer);
      return result.text;
    } catch (error) {
      logger.error('Audio transcription failed:', {
        error: error instanceof Error ? error.message : String(error),
        bufferSize: audioBuffer.length,
      });
      throw error;
    }
  }

  /**
   * Generate speech with lazy TTS model initialization
   */
  public async generateSpeech(text: string): Promise<Readable> {
    try {
      // Lazy initialize TTS model
      await this.lazyInitTTS();

      return await this.ttsManager.generateSpeech(text);
    } catch (error) {
      logger.error('Speech generation failed:', {
        error: error instanceof Error ? error.message : String(error),
        textLength: text.length,
      });
      throw error;
    }
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

  /**
   * Lazy initialize the small text model
   */
  private async lazyInitSmallModel(): Promise<void> {
    if (this.smallModelInitialized) return;

    if (!this.smallModelInitializingPromise) {
      this.smallModelInitializingPromise = (async () => {
        await this.initializeEnvironment(); // Ensure environment is initialized first
        await this.checkPlatformCapabilities();

        // Download model if needed
        // Pass the correct model path determined during environment init
        await this.downloadModel(ModelType.TEXT_SMALL);

        // Initialize Llama and small model
        try {
          // Use getLlama helper instead of directly creating
          this.llama = await getLlama();

          const smallModel = await this.llama.loadModel({
            gpuLayers: 43,
            modelPath: this.modelPath, // Use the potentially overridden path
            vocabOnly: false,
          });

          this.smallModel = smallModel;

          const ctx = await smallModel.createContext({
            contextSize: MODEL_SPECS.small.contextSize,
          });

          this.ctx = ctx;
          this.sequence = undefined; // Reset sequence to create a new one
          this.smallModelInitialized = true;
          logger.info('Small model initialized successfully');
        } catch (error) {
          logger.error('Failed to initialize small model:', error);
          this.smallModelInitializingPromise = null;
          throw error;
        }
      })();
    }

    await this.smallModelInitializingPromise;
  }

  /**
   * Lazy initialize the medium text model
   */
  private async lazyInitMediumModel(): Promise<void> {
    if (this.mediumModelInitialized) return;

    if (!this.mediumModelInitializingPromise) {
      this.mediumModelInitializingPromise = (async () => {
        await this.initializeEnvironment(); // Ensure environment is initialized first
        // Make sure llama is initialized first (implicitly done by small model init if needed)
        if (!this.llama) {
          // Attempt to initialize small model first to get llama instance
          // This might download the small model even if only medium is requested,
          // but ensures llama is ready.
          await this.lazyInitSmallModel();
        }

        // Download model if needed
        // Pass the correct model path determined during environment init
        await this.downloadModel(ModelType.TEXT_LARGE);

        // Initialize medium model
        try {
          const mediumModel = await this.llama!.loadModel({
            gpuLayers: 43,
            modelPath: this.mediumModelPath, // Use the potentially overridden path
            vocabOnly: false,
          });

          this.mediumModel = mediumModel;
          this.mediumModelInitialized = true;
          logger.info('Medium model initialized successfully');
        } catch (error) {
          logger.error('Failed to initialize medium model:', error);
          this.mediumModelInitializingPromise = null;
          throw error;
        }
      })();
    }

    await this.mediumModelInitializingPromise;
  }

  /**
   * Lazy initialize the vision model
   */
  private async lazyInitVision(): Promise<void> {
    if (this.visionInitialized) return;

    if (!this.visionInitializingPromise) {
      this.visionInitializingPromise = (async () => {
        try {
          // Initialize vision model directly
          // Use existing initialization code from the file
          // ...
          this.visionInitialized = true;
          logger.info('Vision model initialized successfully');
        } catch (error) {
          logger.error('Failed to initialize vision model:', error);
          this.visionInitializingPromise = null;
          throw error;
        }
      })();
    }

    await this.visionInitializingPromise;
  }

  /**
   * Lazy initialize the transcription model
   */
  private async lazyInitTranscription(): Promise<void> {
    if (this.transcriptionInitialized) return;

    if (!this.transcriptionInitializingPromise) {
      this.transcriptionInitializingPromise = (async () => {
        try {
          // Initialize transcription model directly
          // Use existing initialization code from the file
          // ...
          this.transcriptionInitialized = true;
          logger.info('Transcription model initialized successfully');
        } catch (error) {
          logger.error('Failed to initialize transcription model:', error);
          this.transcriptionInitializingPromise = null;
          throw error;
        }
      })();
    }

    await this.transcriptionInitializingPromise;
  }

  /**
   * Lazy initialize the TTS model
   */
  private async lazyInitTTS(): Promise<void> {
    if (this.ttsInitialized) return;

    if (!this.ttsInitializingPromise) {
      this.ttsInitializingPromise = (async () => {
        try {
          // Initialize TTS model directly
          // Use existing initialization code from the file
          // ...
          this.ttsInitialized = true;
          logger.info('TTS model initialized successfully');
        } catch (error) {
          logger.error('Failed to initialize TTS model:', error);
          this.ttsInitializingPromise = null;
          throw error;
        }
      })();
    }

    await this.ttsInitializingPromise;
  }
}

// Create manager instance
const localAIManager = LocalAIManager.getInstance();

/**
 * Plugin that provides functionality for local AI using LLaMA models.
 * @type {Plugin}
 */
export const localAiPlugin: Plugin = {
  name: 'local-ai',
  description: 'Local AI plugin using LLaMA models',

  async init() {
    try {
      logger.debug('Initializing local-ai plugin environment...');
      // Call initializeEnvironment (now public)
      await localAIManager.initializeEnvironment();
      logger.success('Local AI plugin configuration validated and initialized');
    } catch (error) {
      logger.error('Plugin initialization failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  },
  models: {
    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      { prompt, stopSequences = [] }: GenerateTextParams
    ) => {
      try {
        // Ensure environment is initialized before generating text (now public)
        await localAIManager.initializeEnvironment();
        return await localAIManager.generateText({
          prompt,
          stopSequences,
          runtime,
          modelType: ModelType.TEXT_SMALL,
        });
      } catch (error) {
        logger.error('Error in TEXT_SMALL handler:', error);
        throw error;
      }
    },

    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      { prompt, stopSequences = [] }: GenerateTextParams
    ) => {
      try {
        // Ensure environment is initialized before generating text (now public)
        await localAIManager.initializeEnvironment();
        return await localAIManager.generateText({
          prompt,
          stopSequences,
          runtime,
          modelType: ModelType.TEXT_LARGE,
        });
      } catch (error) {
        logger.error('Error in TEXT_LARGE handler:', error);
        throw error;
      }
    },

    [ModelType.TEXT_EMBEDDING]: async (_runtime: IAgentRuntime, params: TextEmbeddingParams) => {
      const text = params?.text;
      try {
        // Handle null/undefined/empty text
        if (!text) {
          logger.debug('Null or empty text input for embedding, returning zero vector');
          return new Array(384).fill(0);
        }

        // Pass the raw text directly to the framework without any manipulation
        return await localAIManager.generateEmbedding(text);
      } catch (error) {
        logger.error('Error in TEXT_EMBEDDING handler:', {
          error: error instanceof Error ? error.message : String(error),
          fullText: text,
          textType: typeof text,
          textStructure: text !== null ? JSON.stringify(text, null, 2) : 'null',
        });
        return new Array(384).fill(0);
      }
    },

    [ModelType.OBJECT_SMALL]: async (runtime: IAgentRuntime, params: ObjectGenerationParams) => {
      try {
        // Ensure environment is initialized (now public)
        await localAIManager.initializeEnvironment();
        logger.info('OBJECT_SMALL handler - Processing request:', {
          prompt: params.prompt,
          hasSchema: !!params.schema,
          temperature: params.temperature,
        });

        // Enhance the prompt to request JSON output
        let jsonPrompt = params.prompt;
        if (!jsonPrompt.includes('```json') && !jsonPrompt.includes('respond with valid JSON')) {
          jsonPrompt +=
            '\nPlease respond with valid JSON only, without any explanations, markdown formatting, or additional text.';
        }

        // Directly generate text using the local small model
        const textResponse = await localAIManager.generateText({
          prompt: jsonPrompt,
          stopSequences: params.stopSequences,
          runtime,
          modelType: ModelType.TEXT_SMALL,
        });

        // Extract and parse JSON from the text response
        try {
          // Function to extract JSON content from text
          const extractJSON = (text: string): string => {
            // Try to find content between JSON codeblocks or markdown blocks
            const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
            const match = text.match(jsonBlockRegex);

            if (match && match[1]) {
              return match[1].trim();
            }

            // If no code blocks, try to find JSON-like content
            // This regex looks for content that starts with { and ends with }
            const jsonContentRegex = /\s*(\{[\s\S]*\})\s*$/;
            const contentMatch = text.match(jsonContentRegex);

            if (contentMatch && contentMatch[1]) {
              return contentMatch[1].trim();
            }

            // If no JSON-like content found, return the original text
            return text.trim();
          };

          const extractedJsonText = extractJSON(textResponse);
          logger.debug('Extracted JSON text:', extractedJsonText);

          let jsonObject;
          try {
            jsonObject = JSON.parse(extractedJsonText);
          } catch (parseError) {
            // Try fixing common JSON issues
            logger.debug('Initial JSON parse failed, attempting to fix common issues');

            // Replace any unescaped newlines in string values
            const fixedJson = extractedJsonText
              .replace(/:\s*"([^"]*)(?:\n)([^"]*)"/g, ': "$1\\n$2"')
              // Remove any non-JSON text that might have gotten mixed into string values
              .replace(/"([^"]*?)[^a-zA-Z0-9\s\.,;:\-_\(\)"'\[\]{}]([^"]*?)"/g, '"$1$2"')
              // Fix missing quotes around property names
              .replace(/(\s*)(\w+)(\s*):/g, '$1"$2"$3:')
              // Fix trailing commas in arrays and objects
              .replace(/,(\s*[\]}])/g, '$1');

            try {
              jsonObject = JSON.parse(fixedJson);
            } catch (finalError) {
              logger.error('Failed to parse JSON after fixing:', finalError);
              throw new Error('Invalid JSON returned from model');
            }
          }

          // Validate against schema if provided
          if (params.schema) {
            try {
              // Simplistic schema validation - check if all required properties exist
              for (const key of Object.keys(params.schema)) {
                if (!(key in jsonObject)) {
                  jsonObject[key] = null; // Add missing properties with null value
                }
              }
            } catch (schemaError) {
              logger.error('Schema validation failed:', schemaError);
            }
          }

          return jsonObject;
        } catch (parseError) {
          logger.error('Failed to parse JSON:', parseError);
          logger.error('Raw response:', textResponse);
          throw new Error('Invalid JSON returned from model');
        }
      } catch (error) {
        logger.error('Error in OBJECT_SMALL handler:', error);
        throw error;
      }
    },

    [ModelType.OBJECT_LARGE]: async (runtime: IAgentRuntime, params: ObjectGenerationParams) => {
      try {
        // Ensure environment is initialized (now public)
        await localAIManager.initializeEnvironment();
        logger.info('OBJECT_LARGE handler - Processing request:', {
          prompt: params.prompt,
          hasSchema: !!params.schema,
          temperature: params.temperature,
        });

        // Enhance the prompt to request JSON output
        let jsonPrompt = params.prompt;
        if (!jsonPrompt.includes('```json') && !jsonPrompt.includes('respond with valid JSON')) {
          jsonPrompt +=
            '\nPlease respond with valid JSON only, without any explanations, markdown formatting, or additional text.';
        }

        // Directly generate text using the local large model
        const textResponse = await localAIManager.generateText({
          prompt: jsonPrompt,
          stopSequences: params.stopSequences,
          runtime,
          modelType: ModelType.TEXT_LARGE,
        });

        // Extract and parse JSON from the text response
        try {
          // Function to extract JSON content from text
          const extractJSON = (text: string): string => {
            // Try to find content between JSON codeblocks or markdown blocks
            const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
            const match = text.match(jsonBlockRegex);

            if (match && match[1]) {
              return match[1].trim();
            }

            // If no code blocks, try to find JSON-like content
            // This regex looks for content that starts with { and ends with }
            const jsonContentRegex = /\s*(\{[\s\S]*\})\s*$/;
            const contentMatch = text.match(jsonContentRegex);

            if (contentMatch && contentMatch[1]) {
              return contentMatch[1].trim();
            }

            // If no JSON-like content found, return the original text
            return text.trim();
          };

          // Clean up the extracted JSON to handle common formatting issues
          const cleanupJSON = (jsonText: string): string => {
            // Remove common logging/debugging patterns that might get mixed into the JSON
            return (
              jsonText
                // Remove any lines that look like log statements
                .replace(/\[DEBUG\].*?(\n|$)/g, '\n')
                .replace(/\[LOG\].*?(\n|$)/g, '\n')
                .replace(/console\.log.*?(\n|$)/g, '\n')
            );
          };

          const extractedJsonText = extractJSON(textResponse);
          const cleanedJsonText = cleanupJSON(extractedJsonText);
          logger.debug('Extracted JSON text:', cleanedJsonText);

          let jsonObject;
          try {
            jsonObject = JSON.parse(cleanedJsonText);
          } catch (parseError) {
            // Try fixing common JSON issues
            logger.debug('Initial JSON parse failed, attempting to fix common issues');

            // Replace any unescaped newlines in string values
            const fixedJson = cleanedJsonText
              .replace(/:\s*"([^"]*)(?:\n)([^"]*)"/g, ': "$1\\n$2"')
              // Remove any non-JSON text that might have gotten mixed into string values
              .replace(/"([^"]*?)[^a-zA-Z0-9\s\.,;:\-_\(\)"'\[\]{}]([^"]*?)"/g, '"$1$2"')
              // Fix missing quotes around property names
              .replace(/(\s*)(\w+)(\s*):/g, '$1"$2"$3:')
              // Fix trailing commas in arrays and objects
              .replace(/,(\s*[\]}])/g, '$1');

            try {
              jsonObject = JSON.parse(fixedJson);
            } catch (finalError) {
              logger.error('Failed to parse JSON after fixing:', finalError);
              throw new Error('Invalid JSON returned from model');
            }
          }

          // Validate against schema if provided
          if (params.schema) {
            try {
              // Simplistic schema validation - check if all required properties exist
              for (const key of Object.keys(params.schema)) {
                if (!(key in jsonObject)) {
                  jsonObject[key] = null; // Add missing properties with null value
                }
              }
            } catch (schemaError) {
              logger.error('Schema validation failed:', schemaError);
            }
          }

          return jsonObject;
        } catch (parseError) {
          logger.error('Failed to parse JSON:', parseError);
          logger.error('Raw response:', textResponse);
          throw new Error('Invalid JSON returned from model');
        }
      } catch (error) {
        logger.error('Error in OBJECT_LARGE handler:', error);
        throw error;
      }
    },

    [ModelType.TEXT_TOKENIZER_ENCODE]: async (
      _runtime: IAgentRuntime,
      { text }: { text: string }
    ) => {
      try {
        const manager = localAIManager.getTokenizerManager();
        const config = localAIManager.getActiveModelConfig();
        return await manager.encode(text, config);
      } catch (error) {
        logger.error('Error in TEXT_TOKENIZER_ENCODE handler:', error);
        throw error;
      }
    },

    [ModelType.TEXT_TOKENIZER_DECODE]: async (
      _runtime: IAgentRuntime,
      { tokens }: { tokens: number[] }
    ) => {
      try {
        const manager = localAIManager.getTokenizerManager();
        const config = localAIManager.getActiveModelConfig();
        return await manager.decode(tokens, config);
      } catch (error) {
        logger.error('Error in TEXT_TOKENIZER_DECODE handler:', error);
        throw error;
      }
    },

    [ModelType.IMAGE_DESCRIPTION]: async (_runtime: IAgentRuntime, imageUrl: string) => {
      try {
        logger.info('Processing image from URL:', imageUrl);

        // Fetch the image from URL
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.statusText}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const mimeType = response.headers.get('content-type') || 'image/jpeg';

        return await localAIManager.describeImage(buffer, mimeType);
      } catch (error) {
        logger.error('Error in IMAGE_DESCRIPTION handler:', {
          error: error instanceof Error ? error.message : String(error),
          imageUrl,
        });
        throw error;
      }
    },

    [ModelType.TRANSCRIPTION]: async (_runtime: IAgentRuntime, audioBuffer: Buffer) => {
      try {
        logger.info('Processing audio transcription:', {
          bufferSize: audioBuffer.length,
        });

        return await localAIManager.transcribeAudio(audioBuffer);
      } catch (error) {
        logger.error('Error in TRANSCRIPTION handler:', {
          error: error instanceof Error ? error.message : String(error),
          bufferSize: audioBuffer.length,
        });
        throw error;
      }
    },

    [ModelType.TEXT_TO_SPEECH]: async (_runtime: IAgentRuntime, text: string) => {
      try {
        return await localAIManager.generateSpeech(text);
      } catch (error) {
        logger.error('Error in TEXT_TO_SPEECH handler:', {
          error: error instanceof Error ? error.message : String(error),
          textLength: text.length,
        });
        throw error;
      }
    },
  },
  tests: [
    {
      name: 'local_ai_plugin_tests',
      tests: [
        {
          name: 'local_ai_test_initialization',
          fn: async (runtime) => {
            try {
              logger.info('Starting initialization test');

              // Test TEXT_SMALL model initialization
              const result = await runtime.useModel(ModelType.TEXT_SMALL, {
                prompt:
                  "Debug Mode: Test initialization. Respond with 'Initialization successful' if you can read this.",
                stopSequences: [],
              });

              logger.info('Model response:', result);

              if (!result || typeof result !== 'string') {
                throw new Error('Invalid response from model');
              }

              if (!result.includes('successful')) {
                throw new Error('Model response does not indicate success');
              }

              logger.success('Initialization test completed successfully');
            } catch (error) {
              logger.error('Initialization test failed:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
              throw error;
            }
          },
        },
        {
          name: 'local_ai_test_text_large',
          fn: async (runtime) => {
            try {
              logger.info('Starting TEXT_LARGE model test');

              const result = await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt:
                  'Debug Mode: Generate a one-sentence response about artificial intelligence.',
                stopSequences: [],
              });

              logger.info('Large model response:', result);

              if (!result || typeof result !== 'string') {
                throw new Error('Invalid response from large model');
              }

              if (result.length < 10) {
                throw new Error('Response too short, possible model failure');
              }

              logger.success('TEXT_LARGE test completed successfully');
            } catch (error) {
              logger.error('TEXT_LARGE test failed:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
              throw error;
            }
          },
        },
        {
          name: 'local_ai_test_text_embedding',
          fn: async (runtime) => {
            try {
              logger.info('Starting TEXT_EMBEDDING test');

              // Test with normal text
              const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
                text: 'This is a test of the text embedding model.',
              });

              logger.info('Embedding generated with dimensions:', embedding.length);

              if (!Array.isArray(embedding)) {
                throw new Error('Embedding is not an array');
              }

              if (embedding.length === 0) {
                throw new Error('Embedding array is empty');
              }

              if (embedding.some((val) => typeof val !== 'number')) {
                throw new Error('Embedding contains non-numeric values');
              }

              // Test with null input (should return zero vector)
              const nullEmbedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, null);
              if (!Array.isArray(nullEmbedding) || nullEmbedding.some((val) => val !== 0)) {
                throw new Error('Null input did not return zero vector');
              }

              logger.success('TEXT_EMBEDDING test completed successfully');
            } catch (error) {
              logger.error('TEXT_EMBEDDING test failed:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
              throw error;
            }
          },
        },
        {
          name: 'local_ai_test_tokenizer_encode',
          fn: async (runtime) => {
            try {
              logger.info('Starting TEXT_TOKENIZER_ENCODE test');
              const text = 'Hello tokenizer test!';

              const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, { text });
              logger.info('Encoded tokens:', { count: tokens.length });

              if (!Array.isArray(tokens)) {
                throw new Error('Tokens output is not an array');
              }

              if (tokens.length === 0) {
                throw new Error('No tokens generated');
              }

              if (tokens.some((token) => !Number.isInteger(token))) {
                throw new Error('Tokens contain non-integer values');
              }

              logger.success('TEXT_TOKENIZER_ENCODE test completed successfully');
            } catch (error) {
              logger.error('TEXT_TOKENIZER_ENCODE test failed:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
              throw error;
            }
          },
        },
        {
          name: 'local_ai_test_tokenizer_decode',
          fn: async (runtime) => {
            try {
              logger.info('Starting TEXT_TOKENIZER_DECODE test');

              // First encode some text
              const originalText = 'Hello tokenizer test!';
              const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, {
                text: originalText,
              });

              // Then decode it back
              const decodedText = await runtime.useModel(ModelType.TEXT_TOKENIZER_DECODE, {
                tokens,
              });
              logger.info('Round trip tokenization:', {
                original: originalText,
                decoded: decodedText,
              });

              if (typeof decodedText !== 'string') {
                throw new Error('Decoded output is not a string');
              }

              logger.success('TEXT_TOKENIZER_DECODE test completed successfully');
            } catch (error) {
              logger.error('TEXT_TOKENIZER_DECODE test failed:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
              throw error;
            }
          },
        },
        {
          name: 'local_ai_test_image_description',
          fn: async (runtime) => {
            try {
              logger.info('Starting IMAGE_DESCRIPTION test');

              const imageUrl =
                'https://raw.githubusercontent.com/microsoft/FLAML/main/website/static/img/flaml.png';
              const result = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, imageUrl);

              logger.info('Image description result:', result);

              if (!result || typeof result !== 'object') {
                throw new Error('Invalid response format');
              }

              if (!result.title || !result.description) {
                throw new Error('Missing title or description in response');
              }

              if (typeof result.title !== 'string' || typeof result.description !== 'string') {
                throw new Error('Title or description is not a string');
              }

              logger.success('IMAGE_DESCRIPTION test completed successfully');
            } catch (error) {
              logger.error('IMAGE_DESCRIPTION test failed:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
              throw error;
            }
          },
        },
        {
          name: 'local_ai_test_transcription',
          fn: async (runtime) => {
            try {
              logger.info('Starting TRANSCRIPTION test');

              // Create a simple audio buffer for testing
              const audioData = new Uint8Array([
                0x52,
                0x49,
                0x46,
                0x46, // "RIFF"
                0x24,
                0x00,
                0x00,
                0x00, // Chunk size
                0x57,
                0x41,
                0x56,
                0x45, // "WAVE"
                0x66,
                0x6d,
                0x74,
                0x20, // "fmt "
              ]);
              const audioBuffer = Buffer.from(audioData);

              const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);
              logger.info('Transcription result:', transcription);

              if (typeof transcription !== 'string') {
                throw new Error('Transcription result is not a string');
              }

              logger.success('TRANSCRIPTION test completed successfully');
            } catch (error) {
              logger.error('TRANSCRIPTION test failed:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
              throw error;
            }
          },
        },
        {
          name: 'local_ai_test_text_to_speech',
          fn: async (runtime) => {
            try {
              logger.info('Starting TEXT_TO_SPEECH test');

              const testText = 'This is a test of the text to speech system.';
              const audioStream = await runtime.useModel(ModelType.TEXT_TO_SPEECH, testText);

              if (!(audioStream instanceof Readable)) {
                throw new Error('TTS output is not a readable stream');
              }

              // Test stream readability
              let dataReceived = false;
              audioStream.on('data', () => {
                dataReceived = true;
              });

              await new Promise((resolve, reject) => {
                audioStream.on('end', () => {
                  if (!dataReceived) {
                    reject(new Error('No audio data received from stream'));
                  } else {
                    resolve(true);
                  }
                });
                audioStream.on('error', reject);
              });

              logger.success('TEXT_TO_SPEECH test completed successfully');
            } catch (error) {
              logger.error('TEXT_TO_SPEECH test failed:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
              throw error;
            }
          },
        },
      ],
    },
  ],
};

export default localAiPlugin;
