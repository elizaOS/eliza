import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type {
  GenerateTextParams,
  ModelTypeName,
  TextEmbeddingParams,
  ObjectGenerationParams,
} from '@elizaos/core';
import { type IAgentRuntime, ModelType, type Plugin, logger } from '@elizaos/core';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import {
  type Llama,
  LlamaChatSession,
  type LlamaContext,
  type LlamaContextSequence,
  type LlamaModel,
  getLlama,
} from 'node-llama-cpp';
import { validateConfig } from './environment';
import { MODEL_SPECS, type ModelSpec } from './types';
import { DownloadManager } from './utils/downloadManager';
import { OllamaManager } from './utils/ollamaManager';
import { getPlatformManager } from './utils/platform';
import { StudioLMManager } from './utils/studiolmManager';
import { TokenizerManager } from './utils/tokenizerManager';
import { TranscribeManager } from './utils/transcribeManager';
import { TTSManager } from './utils/ttsManager';
import { VisionManager } from './utils/visionManager';

// const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Add type definitions for model source selection
/**
 * Represents the available sources for a text model: "local", "studiolm", or "ollama".
 */
type TextModelSource = 'local' | 'studiolm' | 'ollama';

/**
 * Interface representing the configuration for a text model.
 *
 * @property {TextModelSource} source - The source of the text model.
 * @property {ModelTypeName} modelType - The type of the model.
 */
interface TextModelConfig {
  source: TextModelSource;
  modelType: ModelTypeName;
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
  private smallModel: LlamaModel | undefined;
  private mediumModel: LlamaModel | undefined;
  private ctx: LlamaContext | undefined;
  private sequence: LlamaContextSequence | undefined;
  private chatSession: LlamaChatSession | undefined;
  private modelPath: string;
  private mediumModelPath: string;
  private cacheDir: string;
  private embeddingModel: FlagEmbedding | null = null;
  private tokenizerManager: TokenizerManager;
  private downloadManager: DownloadManager;
  private visionManager: VisionManager;
  private activeModelConfig: ModelSpec;
  private transcribeManager: TranscribeManager;
  private ttsManager: TTSManager;
  private studioLMManager: StudioLMManager;
  private ollamaManager: OllamaManager;

  // Initialization state flags
  private ollamaInitialized = false;
  private studioLMInitialized = false;
  private smallModelInitialized = false;
  private mediumModelInitialized = false;
  private embeddingInitialized = false;
  private visionInitialized = false;
  private transcriptionInitialized = false;
  private ttsInitialized = false;

  // Initialization promises to prevent duplicate initialization
  private smallModelInitializingPromise: Promise<void> | null = null;
  private mediumModelInitializingPromise: Promise<void> | null = null;
  private embeddingInitializingPromise: Promise<void> | null = null;
  private visionInitializingPromise: Promise<void> | null = null;
  private transcriptionInitializingPromise: Promise<void> | null = null;
  private ttsInitializingPromise: Promise<void> | null = null;
  private ollamaInitializingPromise: Promise<void> | null = null;
  private studioLMInitializingPromise: Promise<void> | null = null;

  private modelsDir: string;

  /**
   * Private constructor function to initialize base managers and paths.
   * This now only sets up the basic infrastructure without loading any models.
   */
  private constructor() {
    // Set up models directory consistently, similar to cacheDir
    const modelsDir = path.join(os.homedir(), '.eliza', 'models');

    // Check if LLAMALOCAL_PATH is set
    if (process.env.LLAMALOCAL_PATH?.trim()) {
      this.modelsDir = path.resolve(process.env.LLAMALOCAL_PATH.trim());
    } else {
      // Ensure models directory exists
      if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
        logger.debug('Created models directory');
      }
      this.modelsDir = modelsDir;
    }

    // Set paths for models
    this.modelPath = path.join(this.modelsDir, 'DeepHermes-3-Llama-3-3B-Preview-q4.gguf');

    this.mediumModelPath = path.join(this.modelsDir, 'DeepHermes-3-Llama-3-8B-q4.gguf');

    // Set up cache directory
    const cacheDirEnv = process.env.CACHE_DIR?.trim();
    if (cacheDirEnv) {
      this.cacheDir = path.resolve(cacheDirEnv);
    } else {
      const cacheDir = path.join(os.homedir(), '.eliza', 'cache');
      // Ensure cache directory exists
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
        logger.debug('Ensuring cache directory exists:', cacheDir);
      }
      this.cacheDir = cacheDir;
    }

    // Initialize the download manager
    this.downloadManager = DownloadManager.getInstance(this.cacheDir, this.modelsDir);

    // Initialize tokenizer manager
    this.tokenizerManager = TokenizerManager.getInstance(this.cacheDir, this.modelsDir);

    // Initialize vision manager
    this.visionManager = VisionManager.getInstance(this.cacheDir);

    // Initialize transcribe manager
    this.transcribeManager = TranscribeManager.getInstance(this.cacheDir);

    // Initialize TTS manager
    this.ttsManager = TTSManager.getInstance(this.cacheDir);

    // Initialize StudioLM manager if enabled
    if (process.env.USE_STUDIOLM_TEXT_MODELS === 'true') {
      this.studioLMManager = StudioLMManager.getInstance();
    }

    // Initialize Ollama manager if enabled
    if (process.env.USE_OLLAMA_TEXT_MODELS === 'true') {
      this.ollamaManager = OllamaManager.getInstance();
    }

    // Initialize active model config
    this.activeModelConfig = MODEL_SPECS.small;
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
   * Initializes the environment by validating the configuration and setting the environment variables with the validated values.
   *
   * @returns {Promise<void>} A Promise that resolves once the environment has been successfully initialized.
   */
  private async initializeEnvironment(): Promise<void> {
    try {
      logger.info('Validating environment configuration...');

      // Create initial config from current env vars
      const config = {
        USE_LOCAL_AI: process.env.USE_LOCAL_AI,
        USE_STUDIOLM_TEXT_MODELS: process.env.USE_STUDIOLM_TEXT_MODELS,
        USE_OLLAMA_TEXT_MODELS: process.env.USE_OLLAMA_TEXT_MODELS,
      };

      // Validate configuration
      const validatedConfig = await validateConfig(config);

      // Log the validated configuration
      // logger.info("Environment configuration validated:", validatedConfig);
      logger.info('Environment configuration validated');

      // Ensure environment variables are set with validated values
      process.env.USE_LOCAL_AI = String(validatedConfig.USE_LOCAL_AI);
      process.env.USE_STUDIOLM_TEXT_MODELS = String(validatedConfig.USE_STUDIOLM_TEXT_MODELS);
      process.env.USE_OLLAMA_TEXT_MODELS = String(validatedConfig.USE_OLLAMA_TEXT_MODELS);

      // logger.info("Environment variables updated with validated values:", {
      //   USE_LOCAL_AI: process.env.USE_LOCAL_AI,
      //   USE_STUDIOLM_TEXT_MODELS: process.env.USE_STUDIOLM_TEXT_MODELS,
      //   USE_OLLAMA_TEXT_MODELS: process.env.USE_OLLAMA_TEXT_MODELS
      // });

      logger.success('Environment initialization complete');
    } catch (error) {
      logger.error('Environment validation failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Asynchronously initializes the Ollama model.
   *
   * @returns {Promise<void>} A Promise that resolves when the initialization is complete.
   * @throws {Error} If the Ollama manager is not created, or if initialization of Ollama models fails.
   */
  private async initializeOllama(): Promise<void> {
    try {
      logger.info('Initializing Ollama models...');

      // Check if Ollama manager exists
      if (!this.ollamaManager) {
        throw new Error('Ollama manager not created - cannot initialize');
      }

      // Initialize and test models
      await this.ollamaManager.initialize();

      if (!this.ollamaManager.isInitialized()) {
        throw new Error('Ollama initialization failed - models not properly loaded');
      }

      logger.success('Ollama initialization complete');
    } catch (error) {
      logger.error('Ollama initialization failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * Initializes StudioLM model with error handling.
   * @returns A Promise that resolves when the initialization is complete.
   * @throws {Error} If StudioLM manager is not created, initialization fails, or models are not properly loaded.
   */
  private async initializeStudioLM(): Promise<void> {
    try {
      logger.info('Initializing StudioLM models...');

      // Check if StudioLM manager exists
      if (!this.studioLMManager) {
        throw new Error('StudioLM manager not created - cannot initialize');
      }

      // Initialize and test models
      await this.studioLMManager.initialize();

      if (!this.studioLMManager.isInitialized()) {
        throw new Error('StudioLM initialization failed - models not properly loaded');
      }

      this.studioLMInitialized = true;
      logger.success('StudioLM initialization complete');
    } catch (error) {
      logger.error('StudioLM initialization failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * Downloads the model based on the modelPath provided.
   * Determines whether to download a large or small model based on the current modelPath.
   *
   * @returns A Promise that resolves to a boolean indicating whether the model download was successful.
   */
  private async downloadModel(modelType: ModelTypeName): Promise<boolean> {
    const modelSpec = modelType === ModelType.TEXT_LARGE ? MODEL_SPECS.medium : MODEL_SPECS.small;
    const modelPath = modelType === ModelType.TEXT_LARGE ? this.mediumModelPath : this.modelPath;
    try {
      return await this.downloadManager.downloadModel(modelSpec, modelPath);
    } catch (error) {
      logger.error('Model download failed:', {
        error: error instanceof Error ? error.message : String(error),
        modelPath,
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
      logger.info('Initializing embedding model...');
      logger.info('Models directory:', this.modelsDir);

      // Ensure models directory exists
      if (!fs.existsSync(this.modelsDir)) {
        logger.warn('Models directory does not exist, creating it:', this.modelsDir);
        fs.mkdirSync(this.modelsDir, { recursive: true });
      }

      if (!this.embeddingModel) {
        logger.info('Creating new FlagEmbedding instance with BGESmallENV15 model');
        // logger.info("Embedding model download details:", {
        //   model: EmbeddingModel.BGESmallENV15,
        //   modelsDir: this.modelsDir,
        //   maxLength: 512,
        //   timestamp: new Date().toISOString()
        // });

        // Display initial progress bar
        const barLength = 30;
        const emptyBar = '▱'.repeat(barLength);
        logger.info(`Downloading embedding model: ${emptyBar} 0%`);

        // Disable built-in progress bar and initialize the model
        this.embeddingModel = await FlagEmbedding.init({
          cacheDir: this.modelsDir,
          model: EmbeddingModel.BGESmallENV15,
          maxLength: 512,
          showDownloadProgress: false,
        });

        // Display completed progress bar
        const completedBar = '▰'.repeat(barLength);
        logger.info(`Downloading embedding model: ${completedBar} 100%`);
        logger.success('FlagEmbedding instance created successfully');
      }
    } catch (error) {
      logger.error('Embedding initialization failed with details:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        modelsDir: this.modelsDir,
        model: EmbeddingModel.BGESmallENV15,
      });
      throw error;
    }
  }

  /**
   * Asynchronously generates text using either StudioLM or Ollama models based on the specified parameters.
   *
   * @param {GenerateTextParams} params - The parameters for generating the text.
   * @returns {Promise<string>} - A promise that resolves to the generated text.
   */
  async generateTextOllamaStudio(params: GenerateTextParams): Promise<string> {
    try {
      const modelConfig = this.getTextModelSource();
      logger.info('generateTextOllamaStudio called with:', {
        modelSource: modelConfig.source,
        modelType: params.modelType,
        studioLMInitialized: this.studioLMInitialized,
        ollamaInitialized: this.ollamaInitialized,
        studioLMEnabled: process.env.USE_STUDIOLM_TEXT_MODELS === 'true',
        ollamaEnabled: process.env.USE_OLLAMA_TEXT_MODELS === 'true',
      });

      if (modelConfig.source === 'studiolm') {
        // Check if StudioLM is enabled in environment
        if (process.env.USE_STUDIOLM_TEXT_MODELS !== 'true') {
          logger.warn(
            'StudioLM requested but disabled in environment, falling back to local models'
          );
          return this.generateText(params);
        }

        // Check if StudioLM manager exists
        if (!this.studioLMManager) {
          logger.warn('StudioLM manager not initialized, falling back to local models');
          return this.generateText(params);
        }

        // Only initialize if not already initialized
        if (!this.studioLMInitialized) {
          logger.info('StudioLM not initialized, initializing now...');
          await this.initializeStudioLM();
        }

        // Pass initialization flag to generateText
        return await this.studioLMManager.generateText(params, this.studioLMInitialized);
      }

      if (modelConfig.source === 'ollama') {
        // Check if Ollama is enabled in environment
        if (process.env.USE_OLLAMA_TEXT_MODELS !== 'true') {
          logger.warn('Ollama requested but disabled in environment, falling back to local models');
          return this.generateText(params);
        }

        // Check if Ollama manager exists
        if (!this.ollamaManager) {
          logger.warn('Ollama manager not initialized, falling back to local models');
          return this.generateText(params);
        }

        // Only initialize if not already initialized
        if (!this.ollamaInitialized && !this.ollamaManager.isInitialized()) {
          logger.info('Initializing Ollama in generateTextOllamaStudio');
          await this.ollamaManager.initialize();
          this.ollamaInitialized = true;
        }

        // Pass initialization flag to generateText
        return await this.ollamaManager.generateText(params, this.ollamaInitialized);
      }

      // Fallback to local models if something goes wrong
      return this.generateText(params);
    } catch (error) {
      logger.error('Text generation with Ollama/StudioLM failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        modelSource: this.getTextModelSource().source,
      });
      // Fallback to local models
      return this.generateText(params);
    }
  }

  /**
   * Asynchronously generates text based on the provided parameters.
   * Now uses lazy initialization for models
   */
  async generateText(params: GenerateTextParams): Promise<string> {
    try {
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
          punishTokensFilter: () => this.smallModel!.tokenize(wordsToPunish.join(' ')),
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
   * Generate embeddings - now with lazy initialization
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      // Lazy initialize embedding model
      await this.lazyInitEmbedding();

      if (!this.embeddingModel) {
        throw new Error('Failed to initialize embedding model');
      }

      logger.info('Generating query embedding...');
      const embedding = await this.embeddingModel.queryEmbed(text);
      const dimensions = embedding.length;
      logger.info('Embedding generation complete', { dimensions });

      return Array.from(embedding);
    } catch (error) {
      logger.error('Embedding generation failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        // Only access text.length if text exists
        textLength: text?.length ?? 'text is null',
      });
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

  // Add public accessor methods
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
   * Retrieves the source configuration for the text model based on environment variables and manager existence.
   * @returns {TextModelConfig} The configuration object containing the text model source and type.
   */
  public getTextModelSource(): TextModelConfig {
    try {
      // Default configuration
      const config: TextModelConfig = {
        source: 'local',
        modelType: ModelType.TEXT_SMALL,
      };

      // Check environment configuration and manager existence
      if (process.env.USE_STUDIOLM_TEXT_MODELS === 'true' && this.studioLMManager) {
        config.source = 'studiolm';
      } else if (process.env.USE_OLLAMA_TEXT_MODELS === 'true' && this.ollamaManager) {
        config.source = 'ollama';
      }

      logger.info('Selected text model source:', config);
      return config;
    } catch (error) {
      logger.error('Error determining text model source:', error);
      // Fallback to local models
      return { source: 'local', modelType: ModelType.TEXT_SMALL };
    }
  }

  /**
   * Generic lazy initialization handler for any model type
   */
  private async lazyInitialize<T>(
    modelType: string,
    isInitialized: boolean,
    initPromise: Promise<T> | null,
    initFunction: () => Promise<T>
  ): Promise<T> {
    // If already initialized, return immediately
    if (isInitialized) {
      return Promise.resolve(null) as Promise<T>;
    }

    // If currently initializing, wait for it to complete
    if (initPromise) {
      logger.info(`Waiting for ${modelType} initialization to complete...`);
      await initPromise;
      return Promise.resolve(null) as Promise<T>;
    }

    // Otherwise start initialization
    logger.info(`Lazy initializing ${modelType}...`);
    return initFunction();
  }

  /**
   * Lazy initialize the small text model
   */
  private async lazyInitSmallModel(): Promise<void> {
    if (this.smallModelInitialized) return;

    if (!this.smallModelInitializingPromise) {
      this.smallModelInitializingPromise = (async () => {
        await this.initializeEnvironment();
        await this.checkPlatformCapabilities();

        // Download model if needed
        await this.downloadModel(ModelType.TEXT_SMALL);

        // Initialize Llama and small model
        try {
          // Use getLlama helper instead of directly creating
          this.llama = await getLlama();

          const smallModel = await this.llama.loadModel({
            gpuLayers: 43,
            modelPath: this.modelPath,
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
        // Make sure llama is initialized first
        if (!this.llama) {
          await this.lazyInitSmallModel();
        }

        await this.downloadModel(ModelType.TEXT_LARGE);

        // Initialize medium model
        try {
          const mediumModel = await this.llama!.loadModel({
            gpuLayers: 43,
            modelPath: this.mediumModelPath,
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
   * Lazy initialize the embedding model
   */
  private async lazyInitEmbedding(): Promise<void> {
    if (this.embeddingInitialized) return;

    if (!this.embeddingInitializingPromise) {
      this.embeddingInitializingPromise = (async () => {
        try {
          await this.initializeEmbedding();
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

  /**
   * Lazy initialize the Ollama integration
   */
  private async lazyInitOllama(): Promise<void> {
    if (this.ollamaInitialized) return;

    if (!this.ollamaInitializingPromise) {
      this.ollamaInitializingPromise = (async () => {
        try {
          await this.initializeOllama();
          this.ollamaInitialized = true;
          logger.info('Ollama initialized successfully');
        } catch (error) {
          logger.error('Failed to initialize Ollama:', error);
          this.ollamaInitializingPromise = null;
          throw error;
        }
      })();
    }

    await this.ollamaInitializingPromise;
  }

  /**
   * Lazy initialize the StudioLM integration
   */
  private async lazyInitStudioLM(): Promise<void> {
    if (this.studioLMInitialized) return;

    if (!this.studioLMInitializingPromise) {
      this.studioLMInitializingPromise = (async () => {
        try {
          await this.initializeStudioLM();
          this.studioLMInitialized = true;
          logger.info('StudioLM initialized successfully');
        } catch (error) {
          logger.error('Failed to initialize StudioLM:', error);
          this.studioLMInitializingPromise = null;
          throw error;
        }
      })();
    }

    await this.studioLMInitializingPromise;
  }
}

// Create manager instance
const localAIManager = LocalAIManager.getInstance();

/**
 * Plugin that provides functionality for local AI using LLaMA models.
 * @type {Plugin}
 */
export const localAIPlugin: Plugin = {
  name: 'local-ai',
  description: 'Local AI plugin using LLaMA models',

  async init() {
    try {
      logger.debug('Initializing local-ai plugin...');
      // Only validate config - actual models will be lazy-loaded when needed
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
        const modelConfig = localAIManager.getTextModelSource();

        if (modelConfig.source !== 'local') {
          return await localAIManager.generateTextOllamaStudio({
            prompt,
            stopSequences,
            runtime,
            modelType: ModelType.TEXT_SMALL,
          });
        }

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
        const modelConfig = localAIManager.getTextModelSource();

        if (modelConfig.source !== 'local') {
          return await localAIManager.generateTextOllamaStudio({
            prompt,
            stopSequences,
            runtime,
            modelType: ModelType.TEXT_LARGE,
          });
        }

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

        const modelConfig = localAIManager.getTextModelSource();

        // Generate text based on the configured model source
        let textResponse: string;
        if (modelConfig.source !== 'local') {
          textResponse = await localAIManager.generateTextOllamaStudio({
            prompt: jsonPrompt,
            stopSequences: params.stopSequences,
            runtime,
            modelType: ModelType.TEXT_SMALL,
          });
        } else {
          textResponse = await localAIManager.generateText({
            prompt: jsonPrompt,
            stopSequences: params.stopSequences,
            runtime,
            modelType: ModelType.TEXT_SMALL,
          });
        }

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

        const modelConfig = localAIManager.getTextModelSource();

        // Generate text based on the configured model source
        let textResponse: string;
        if (modelConfig.source !== 'local') {
          textResponse = await localAIManager.generateTextOllamaStudio({
            prompt: jsonPrompt,
            stopSequences: params.stopSequences,
            runtime,
            modelType: ModelType.TEXT_LARGE,
          });
        } else {
          textResponse = await localAIManager.generateText({
            prompt: jsonPrompt,
            stopSequences: params.stopSequences,
            runtime,
            modelType: ModelType.TEXT_LARGE,
          });
        }

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

export default localAIPlugin;
