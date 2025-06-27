# elizaOS

This is the elizaOS codebase, located at https://github.com/elizaOS/eliza

We also have a plugin registry available here: https://github.com/elizaos-plugins/registry

And plugins for virtually everything.

Here is the source code for a plugin, complete with elizaos tests:

```
Project Path: packages/plugin-local-ai/src

Source Tree:

```

src
├── environment.ts
├── utils
│ ├── ttsManager.ts
│ ├── runtime_test.ts
│ ├── tokenizerManager.ts
│ ├── platform.ts
│ ├── visionManager.ts
│ ├── transcribeManager.ts
│ └── downloadManager.ts
├── types.ts
└── index.ts

````

`/Users/shawwalters/eliza/packages/plugin-local-ai/src/environment.ts`:

```ts
import { logger } from '@elizaos/core';
import { z } from 'zod';

// Default model filenames
const DEFAULT_SMALL_MODEL = 'DeepHermes-3-Llama-3-3B-Preview-q4.gguf';
const DEFAULT_LARGE_MODEL = 'DeepHermes-3-Llama-3-8B-q4.gguf';
const DEFAULT_EMBEDDING_MODEL = 'bge-small-en-v1.5.Q4_K_M.gguf';

// Configuration schema focused only on local AI settings
/**
 * Configuration schema for local AI settings.
 * Allows overriding default model filenames via environment variables.
 */
export const configSchema = z.object({
  LOCAL_SMALL_MODEL: z.string().optional().default(DEFAULT_SMALL_MODEL),
  LOCAL_LARGE_MODEL: z.string().optional().default(DEFAULT_LARGE_MODEL),
  LOCAL_EMBEDDING_MODEL: z.string().optional().default(DEFAULT_EMBEDDING_MODEL),
  MODELS_DIR: z.string().optional(), // Path for the models directory
  CACHE_DIR: z.string().optional(), // Path for the cache directory
  LOCAL_EMBEDDING_DIMENSIONS: z
    .string()
    .optional()
    .default('384') // Default to 384 if not provided
    .transform((val) => parseInt(val, 10)), // Transform to number
});

/**
 * Export type representing the inferred type of the 'configSchema'.
 */
export type Config = z.infer<typeof configSchema>;

/**
 * Validates and parses the configuration, reading from environment variables.
 * Since only local AI is supported, this primarily ensures the structure
 * and applies defaults or environment variable overrides for model filenames.
 * @returns {Config} The validated configuration object.
 */
export function validateConfig(): Config {
  try {
    // Prepare the config for parsing, reading from process.env
    const configToParse = {
      // Read model filenames from environment variables or use undefined (so zod defaults apply)
      LOCAL_SMALL_MODEL: process.env.LOCAL_SMALL_MODEL,
      LOCAL_LARGE_MODEL: process.env.LOCAL_LARGE_MODEL,
      LOCAL_EMBEDDING_MODEL: process.env.LOCAL_EMBEDDING_MODEL,
      MODELS_DIR: process.env.MODELS_DIR, // Read models directory path from env
      CACHE_DIR: process.env.CACHE_DIR, // Read cache directory path from env
      LOCAL_EMBEDDING_DIMENSIONS: process.env.LOCAL_EMBEDDING_DIMENSIONS, // Read embedding dimensions
    };

    logger.debug('Validating configuration for local AI plugin from env:', {
      LOCAL_SMALL_MODEL: configToParse.LOCAL_SMALL_MODEL,
      LOCAL_LARGE_MODEL: configToParse.LOCAL_LARGE_MODEL,
      LOCAL_EMBEDDING_MODEL: configToParse.LOCAL_EMBEDDING_MODEL,
      MODELS_DIR: configToParse.MODELS_DIR,
      CACHE_DIR: configToParse.CACHE_DIR,
      LOCAL_EMBEDDING_DIMENSIONS: configToParse.LOCAL_EMBEDDING_DIMENSIONS,
    });

    const validatedConfig = configSchema.parse(configToParse);

    logger.info('Using local AI configuration:', validatedConfig);

    return validatedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('\n');
      logger.error('Zod validation failed:', errorMessages);
      throw new Error(`Configuration validation failed:\n${errorMessages}`);
    }
    logger.error('Configuration validation failed:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

````

`/Users/shawwalters/eliza/packages/plugin-local-ai/src/utils/ttsManager.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { logger, prependWavHeader } from '@elizaos/core';
import { pipeline, type TextToAudioPipeline } from '@huggingface/transformers';
import { fetch } from 'undici';
import { MODEL_SPECS } from '../types';

/**
 * Class representing a Text-to-Speech Manager using Transformers.js
 */
export class TTSManager {
  private static instance: TTSManager | null = null;
  private cacheDir: string;
  private synthesizer: TextToAudioPipeline | null = null;
  private defaultSpeakerEmbedding: Float32Array | null = null;
  private initialized = false;
  private initializingPromise: Promise<void> | null = null;

  private constructor(cacheDir: string) {
    this.cacheDir = path.join(cacheDir, 'tts');
    this.ensureCacheDirectory();
    logger.debug('TTSManager using Transformers.js initialized');
  }

  public static getInstance(cacheDir: string): TTSManager {
    if (!TTSManager.instance) {
      TTSManager.instance = new TTSManager(cacheDir);
    }
    return TTSManager.instance;
  }

  private ensureCacheDirectory(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      logger.debug('Created TTS cache directory:', this.cacheDir);
    }
  }

  private async initialize(): Promise<void> {
    // Guard against concurrent calls: if an initialization is already in progress, return its promise.
    if (this.initializingPromise) {
      logger.debug('TTS initialization already in progress, awaiting existing promise.');
      return this.initializingPromise;
    }

    // If already initialized, no need to do anything further.
    if (this.initialized) {
      logger.debug('TTS already initialized.');
      return;
    }

    // Start the initialization process.
    // The promise is stored in this.initializingPromise and cleared in the finally block.
    this.initializingPromise = (async () => {
      try {
        logger.info('Initializing TTS with Transformers.js backend...');

        const ttsModelSpec = MODEL_SPECS.tts.default;
        if (!ttsModelSpec) {
          throw new Error('Default TTS model specification not found in MODEL_SPECS.');
        }
        const modelName = ttsModelSpec.modelId;
        const speakerEmbeddingUrl = ttsModelSpec.defaultSpeakerEmbeddingUrl;

        // 1. Load the TTS Pipeline
        logger.info(`Loading TTS pipeline for model: ${modelName}`);
        this.synthesizer = await pipeline('text-to-audio', modelName);
        logger.success(`TTS pipeline loaded successfully for model: ${modelName}`);

        // 2. Load Default Speaker Embedding (if specified)
        if (speakerEmbeddingUrl) {
          const embeddingFilename = path.basename(new URL(speakerEmbeddingUrl).pathname);
          const embeddingPath = path.join(this.cacheDir, embeddingFilename);

          if (fs.existsSync(embeddingPath)) {
            logger.info('Loading default speaker embedding from cache...');
            const buffer = fs.readFileSync(embeddingPath);
            this.defaultSpeakerEmbedding = new Float32Array(
              buffer.buffer,
              buffer.byteOffset,
              buffer.length / Float32Array.BYTES_PER_ELEMENT
            );
            logger.success('Default speaker embedding loaded from cache.');
          } else {
            logger.info(`Downloading default speaker embedding from: ${speakerEmbeddingUrl}`);
            const response = await fetch(speakerEmbeddingUrl);
            if (!response.ok) {
              throw new Error(`Failed to download speaker embedding: ${response.statusText}`);
            }
            const buffer = await response.arrayBuffer();
            this.defaultSpeakerEmbedding = new Float32Array(buffer);
            fs.writeFileSync(embeddingPath, Buffer.from(buffer));
            logger.success('Default speaker embedding downloaded and cached.');
          }
        } else {
          logger.warn(
            `No default speaker embedding URL specified for model ${modelName}. Speaker control may be limited.`
          );
          this.defaultSpeakerEmbedding = null;
        }

        // Check synthesizer as embedding might be optional for some models
        if (!this.synthesizer) {
          throw new Error('TTS initialization failed: Pipeline not loaded.');
        }

        logger.success('TTS initialization complete (Transformers.js)');
        this.initialized = true;
      } catch (error) {
        logger.error('TTS (Transformers.js) initialization failed:', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        this.initialized = false;
        this.synthesizer = null;
        this.defaultSpeakerEmbedding = null;
        throw error; // Propagate error to reject the initializingPromise
      } finally {
        // Clear the promise once initialization is complete (successfully or not)
        this.initializingPromise = null;
        logger.debug('TTS initializingPromise cleared after completion/failure.');
      }
    })();

    return this.initializingPromise;
  }

  /**
   * Asynchronously generates speech from a given text using the Transformers.js pipeline.
   * @param {string} text - The text to generate speech from.
   * @returns {Promise<Readable>} A promise that resolves to a Readable stream containing the generated WAV audio data.
   * @throws {Error} If the TTS model is not initialized or if generation fails.
   */
  public async generateSpeech(text: string): Promise<Readable> {
    try {
      await this.initialize();

      // Check synthesizer is initialized (embedding might be null but handled in synthesizer call)
      if (!this.synthesizer) {
        throw new Error('TTS Manager not properly initialized.');
      }

      logger.info('Starting speech generation with Transformers.js for text:', {
        text: text.substring(0, 50) + '...',
      });

      // Generate audio using the pipeline
      const output = await this.synthesizer(text, {
        // Pass embedding only if it was loaded
        ...(this.defaultSpeakerEmbedding && {
          speaker_embeddings: this.defaultSpeakerEmbedding,
        }),
      });

      // output is { audio: Float32Array, sampling_rate: number }
      const audioFloat32 = output.audio;
      const samplingRate = output.sampling_rate;

      logger.info('Raw audio data received from pipeline:', {
        samplingRate,
        length: audioFloat32.length,
      });

      if (!audioFloat32 || audioFloat32.length === 0) {
        throw new Error('TTS pipeline generated empty audio output.');
      }

      // Convert Float32Array to Int16 Buffer (standard PCM for WAV)
      const pcmData = new Int16Array(audioFloat32.length);
      for (let i = 0; i < audioFloat32.length; i++) {
        const s = Math.max(-1, Math.min(1, audioFloat32[i])); // Clamp to [-1, 1]
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff; // Convert to 16-bit [-32768, 32767]
      }
      const audioBuffer = Buffer.from(pcmData.buffer);

      logger.info('Audio data converted to 16-bit PCM Buffer:', {
        byteLength: audioBuffer.length,
      });

      // Create WAV format stream
      // Use samplingRate from the pipeline output
      const audioStream = prependWavHeader(
        Readable.from(audioBuffer),
        audioBuffer.length, // Pass buffer length in bytes
        samplingRate,
        1, // Number of channels (assuming mono)
        16 // Bit depth
      );

      logger.success('Speech generation complete (Transformers.js)');
      return audioStream;
    } catch (error) {
      logger.error('Transformers.js speech generation failed:', {
        error: error instanceof Error ? error.message : String(error),
        text: text.substring(0, 50) + '...',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }
}
```

`/Users/shawwalters/eliza/packages/plugin-local-ai/src/utils/tokenizerManager.ts`:

```ts
import { logger } from '@elizaos/core';
import { AutoTokenizer, type PreTrainedTokenizer } from '@huggingface/transformers';

// Import the MODEL_SPECS type from a new types file we'll create later
import type { ModelSpec } from '../types';

/**
 * Represents a Tokenizer Manager which manages tokenizers for different models.
 * * @class TokenizerManager
 */
export class TokenizerManager {
  private static instance: TokenizerManager | null = null;
  private tokenizers: Map<string, PreTrainedTokenizer>;
  private cacheDir: string;
  private modelsDir: string;

  /**
   * Constructor for creating a new instance of the class.
   *
   * @param {string} cacheDir - The directory for caching data.
   * @param {string} modelsDir - The directory for storing models.
   */
  private constructor(cacheDir: string, modelsDir: string) {
    this.tokenizers = new Map();
    this.cacheDir = cacheDir;
    this.modelsDir = modelsDir;
  }

  /**
   * Get the singleton instance of TokenizerManager class. If the instance does not exist, it will create a new one.
   *
   * @param {string} cacheDir - The directory to cache the tokenizer models.
   * @param {string} modelsDir - The directory where tokenizer models are stored.
   * @returns {TokenizerManager} The singleton instance of TokenizerManager.
   */
  static getInstance(cacheDir: string, modelsDir: string): TokenizerManager {
    if (!TokenizerManager.instance) {
      TokenizerManager.instance = new TokenizerManager(cacheDir, modelsDir);
    }
    return TokenizerManager.instance;
  }

  /**
   * Asynchronously loads a tokenizer based on the provided ModelSpec configuration.
   *
   * @param {ModelSpec} modelConfig - The configuration object for the model to load the tokenizer for.
   * @returns {Promise<PreTrainedTokenizer>} - A promise that resolves to the loaded tokenizer.
   */
  async loadTokenizer(modelConfig: ModelSpec): Promise<PreTrainedTokenizer> {
    try {
      const tokenizerKey = `${modelConfig.tokenizer.type}-${modelConfig.tokenizer.name}`;
      logger.info('Loading tokenizer:', {
        key: tokenizerKey,
        name: modelConfig.tokenizer.name,
        type: modelConfig.tokenizer.type,
        modelsDir: this.modelsDir,
        cacheDir: this.cacheDir,
      });

      if (this.tokenizers.has(tokenizerKey)) {
        logger.info('Using cached tokenizer:', { key: tokenizerKey });
        const cachedTokenizer = this.tokenizers.get(tokenizerKey);
        if (!cachedTokenizer) {
          throw new Error(`Tokenizer ${tokenizerKey} exists in map but returned undefined`);
        }
        return cachedTokenizer;
      }

      // Check if models directory exists
      const fs = await import('node:fs');
      if (!fs.existsSync(this.modelsDir)) {
        logger.warn('Models directory does not exist, creating it:', this.modelsDir);
        fs.mkdirSync(this.modelsDir, { recursive: true });
      }

      logger.info(
        'Initializing new tokenizer from HuggingFace with models directory:',
        this.modelsDir
      );

      try {
        const tokenizer = await AutoTokenizer.from_pretrained(modelConfig.tokenizer.name, {
          cache_dir: this.modelsDir,
          local_files_only: false,
        });

        this.tokenizers.set(tokenizerKey, tokenizer);
        logger.success('Tokenizer loaded successfully:', { key: tokenizerKey });
        return tokenizer;
      } catch (tokenizeError) {
        logger.error('Failed to load tokenizer from HuggingFace:', {
          error: tokenizeError instanceof Error ? tokenizeError.message : String(tokenizeError),
          stack: tokenizeError instanceof Error ? tokenizeError.stack : undefined,
          tokenizer: modelConfig.tokenizer.name,
          modelsDir: this.modelsDir,
        });

        // Try again with local_files_only set to false and a longer timeout
        logger.info('Retrying tokenizer loading...');
        const tokenizer = await AutoTokenizer.from_pretrained(modelConfig.tokenizer.name, {
          cache_dir: this.modelsDir,
          local_files_only: false,
        });

        this.tokenizers.set(tokenizerKey, tokenizer);
        logger.success('Tokenizer loaded successfully on retry:', {
          key: tokenizerKey,
        });
        return tokenizer;
      }
    } catch (error) {
      logger.error('Failed to load tokenizer:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        model: modelConfig.name,
        tokenizer: modelConfig.tokenizer.name,
        modelsDir: this.modelsDir,
      });
      throw error;
    }
  }

  /**
   * Encodes the given text using the specified tokenizer model configuration.
   *
   * @param {string} text - The text to encode.
   * @param {ModelSpec} modelConfig - The configuration for the model tokenizer.
   * @returns {Promise<number[]>} - An array of integers representing the encoded text.
   * @throws {Error} - If the text encoding fails, an error is thrown.
   */
  async encode(text: string, modelConfig: ModelSpec): Promise<number[]> {
    try {
      logger.info('Encoding text with tokenizer:', {
        length: text.length,
        tokenizer: modelConfig.tokenizer.name,
      });

      const tokenizer = await this.loadTokenizer(modelConfig);

      logger.info('Tokenizer loaded, encoding text...');
      const encoded = await tokenizer.encode(text, {
        add_special_tokens: true,
        return_token_type_ids: false,
      });

      logger.info('Text encoded successfully:', {
        tokenCount: encoded.length,
        tokenizer: modelConfig.tokenizer.name,
      });
      return encoded;
    } catch (error) {
      logger.error('Text encoding failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        textLength: text.length,
        tokenizer: modelConfig.tokenizer.name,
        modelsDir: this.modelsDir,
      });
      throw error;
    }
  }

  /**
   * Asynchronously decodes an array of tokens using a tokenizer based on the provided ModelSpec.
   *
   * @param {number[]} tokens - The array of tokens to be decoded.
   * @param {ModelSpec} modelConfig - The ModelSpec object containing information about the model and tokenizer to be used.
   * @returns {Promise<string>} - A Promise that resolves with the decoded text.
   * @throws {Error} - If an error occurs during token decoding.
   */
  async decode(tokens: number[], modelConfig: ModelSpec): Promise<string> {
    try {
      logger.info('Decoding tokens with tokenizer:', {
        count: tokens.length,
        tokenizer: modelConfig.tokenizer.name,
      });

      const tokenizer = await this.loadTokenizer(modelConfig);

      logger.info('Tokenizer loaded, decoding tokens...');
      const decoded = await tokenizer.decode(tokens, {
        skip_special_tokens: true,
        clean_up_tokenization_spaces: true,
      });

      logger.info('Tokens decoded successfully:', {
        textLength: decoded.length,
        tokenizer: modelConfig.tokenizer.name,
      });
      return decoded;
    } catch (error) {
      logger.error('Token decoding failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        tokenCount: tokens.length,
        tokenizer: modelConfig.tokenizer.name,
        modelsDir: this.modelsDir,
      });
      throw error;
    }
  }
}
```

`/Users/shawwalters/eliza/packages/plugin-local-ai/src/utils/platform.ts`:

```ts
import { exec } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { logger } from '@elizaos/core';

const execAsync = promisify(exec);

/**
 * Represents the configuration of a system GPU.
 * @typedef {Object} SystemGPU
 * @property {string} name - The name of the GPU.
 * @property {number} [memory] - The memory size of the GPU. (Optional)
 * @property {"cuda" | "metal" | "directml" | "none"} type - The type of GPU.
 * @property {string} [version] - The version of the GPU. (Optional)
 * @property {boolean} [isAppleSilicon] - Indicates if the GPU is Apple Silicon. (Optional)
 */
export interface SystemGPU {
  name: string;
  memory?: number;
  type: 'cuda' | 'metal' | 'directml' | 'none';
  version?: string;
  isAppleSilicon?: boolean;
}

/**
 * Interface representing the system CPU information.
 * @typedef {Object} SystemCPU
 * @property {string} model - The model of the CPU.
 * @property {number} cores - The number of cores in the CPU.
 * @property {number} speed - The speed of the CPU.
 * @property {string} architecture - The architecture of the CPU.
 * @property {Object} memory - Object containing memory information.
 * @property {number} memory.total - The total memory available.
 * @property {number} memory.free - The free memory available.
 */
export interface SystemCPU {
  model: string;
  cores: number;
  speed: number;
  architecture: string;
  memory: {
    total: number;
    free: number;
  };
}

/**
 * Interface representing the capabilities of a system.
 *
 * @typedef {Object} SystemCapabilities
 * @property {NodeJS.Platform} platform - The platform of the system.
 * @property {SystemCPU} cpu - The CPU information of the system.
 * @property {SystemGPU | null} gpu - The GPU information of the system, can be null if no GPU is present.
 * @property {"small" | "medium" | "large"} recommendedModelSize - The recommended model size for the system.
 * @property {Array<"cuda" | "metal" | "directml" | "cpu">} supportedBackends - An array of supported backends for the system.
 */
export interface SystemCapabilities {
  platform: NodeJS.Platform;
  cpu: SystemCPU;
  gpu: SystemGPU | null;
  recommendedModelSize: 'small' | 'medium' | 'large';
  supportedBackends: Array<'cuda' | 'metal' | 'directml' | 'cpu'>;
}

/**
 * Class representing a Platform Manager.
 *
 * @class
 */

export class PlatformManager {
  private static instance: PlatformManager;
  private capabilities: SystemCapabilities | null = null;

  /**
   * Private constructor method.
   */
  private constructor() {}

  /**
   * Get the singleton instance of the PlatformManager class
   * @returns {PlatformManager} The instance of PlatformManager
   */
  static getInstance(): PlatformManager {
    if (!PlatformManager.instance) {
      PlatformManager.instance = new PlatformManager();
    }
    return PlatformManager.instance;
  }

  /**
   * Asynchronous method to initialize platform detection.
   *
   * @returns {Promise<void>} Promise that resolves once platform detection is completed.
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing platform detection...');
      this.capabilities = await this.detectSystemCapabilities();
      // logger.info("Platform detection completed", {
      //   platform: this.capabilities.platform,
      //   gpu: this.capabilities.gpu?.type || "none",
      //   recommendedModel: this.capabilities.recommendedModelSize,
      // });
    } catch (error) {
      logger.error('Platform detection failed', { error });
      throw error;
    }
  }

  /**
   * Detects the system capabilities including platform, CPU information, GPU information,
   * supported backends, and recommended model size.
   *
   * @returns {Promise<SystemCapabilities>} Details of the system capabilities including platform, CPU info, GPU info,
   * recommended model size, and supported backends.
   */
  private async detectSystemCapabilities(): Promise<SystemCapabilities> {
    const platform = process.platform;
    const cpuInfo = this.getCPUInfo();
    const gpu = await this.detectGPU();
    const supportedBackends = await this.getSupportedBackends(platform, gpu);
    const recommendedModelSize = this.getRecommendedModelSize(cpuInfo, gpu);

    return {
      platform,
      cpu: cpuInfo,
      gpu,
      recommendedModelSize,
      supportedBackends,
    };
  }

  /**
   * Returns information about the CPU and memory of the system.
   * @returns {SystemCPU} The CPU information including model, number of cores, speed, architecture, and memory details.
   */
  private getCPUInfo(): SystemCPU {
    const cpus = os.cpus();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();

    return {
      model: cpus[0].model,
      cores: cpus.length,
      speed: cpus[0].speed,
      architecture: process.arch,
      memory: {
        total: totalMemory,
        free: freeMemory,
      },
    };
  }

  /**
   * Asynchronously detects the GPU information based on the current platform.
   * @returns A promise that resolves with the GPU information if detection is successful, otherwise null.
   */
  private async detectGPU(): Promise<SystemGPU | null> {
    const platform = process.platform;

    try {
      switch (platform) {
        case 'darwin':
          return await this.detectMacGPU();
        case 'win32':
          return await this.detectWindowsGPU();
        case 'linux':
          return await this.detectLinuxGPU();
        default:
          return null;
      }
    } catch (error) {
      logger.error('GPU detection failed', { error });
      return null;
    }
  }

  /**
   * Asynchronously detects the GPU of a Mac system.
   * @returns {Promise<SystemGPU>} A promise that resolves to an object representing the detected GPU.
   */
  private async detectMacGPU(): Promise<SystemGPU> {
    try {
      const { stdout } = await execAsync('sysctl -n machdep.cpu.brand_string');
      const isAppleSilicon = stdout.toLowerCase().includes('apple');

      if (isAppleSilicon) {
        return {
          name: 'Apple Silicon',
          type: 'metal',
          isAppleSilicon: true,
        };
      }

      // For Intel Macs with discrete GPU
      const { stdout: gpuInfo } = await execAsync('system_profiler SPDisplaysDataType');
      return {
        name: gpuInfo.split('Chipset Model:')[1]?.split('\n')[0]?.trim() || 'Unknown GPU',
        type: 'metal',
        isAppleSilicon: false,
      };
    } catch (error) {
      logger.error('Mac GPU detection failed', { error });
      return {
        name: 'Unknown Mac GPU',
        type: 'metal',
        isAppleSilicon: false,
      };
    }
  }

  /**
   * Detects the GPU in a Windows system and returns information about it.
   *
   * @returns {Promise<SystemGPU | null>} A promise that resolves with the detected GPU information or null if detection fails.
   */
  private async detectWindowsGPU(): Promise<SystemGPU | null> {
    try {
      const { stdout } = await execAsync('wmic path win32_VideoController get name');
      const gpuName = stdout.split('\n')[1].trim();

      // Check for NVIDIA GPU
      if (gpuName.toLowerCase().includes('nvidia')) {
        const { stdout: nvidiaInfo } = await execAsync(
          'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader'
        );
        const [name, memoryStr] = nvidiaInfo.split(',').map((s) => s.trim());
        const memory = Number.parseInt(memoryStr);

        return {
          name,
          memory,
          type: 'cuda',
          version: await this.getNvidiaDriverVersion(),
        };
      }

      // Default to DirectML for other GPUs
      return {
        name: gpuName,
        type: 'directml',
      };
    } catch (error) {
      logger.error('Windows GPU detection failed', { error });
      return null;
    }
  }

  /**
   * Asynchronously detects the GPU information for Linux systems.
   * Tries to detect NVIDIA GPU first using 'nvidia-smi' command and if successful,
   * returns the GPU name, memory size, type as 'cuda', and NVIDIA driver version.
   * If NVIDIA detection fails, it falls back to checking for other GPUs using 'lspci | grep -i vga' command.
   * If no GPU is detected, it returns null.
   *
   * @returns {Promise<SystemGPU | null>} The detected GPU information or null if detection fails.
   */
  private async detectLinuxGPU(): Promise<SystemGPU | null> {
    try {
      // Try NVIDIA first
      const { stdout } = await execAsync(
        'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader'
      );
      if (stdout) {
        const [name, memoryStr] = stdout.split(',').map((s) => s.trim());
        const memory = Number.parseInt(memoryStr);

        return {
          name,
          memory,
          type: 'cuda',
          version: await this.getNvidiaDriverVersion(),
        };
      }
    } catch {
      // If nvidia-smi fails, check for other GPUs
      try {
        const { stdout } = await execAsync('lspci | grep -i vga');
        return {
          name: stdout.split(':').pop()?.trim() || 'Unknown GPU',
          type: 'none',
        };
      } catch (error) {
        logger.error('Linux GPU detection failed', { error });
        return null;
      }
    }
    return null;
  }

  /**
   * Asynchronously retrieves the driver version of the Nvidia GPU using the 'nvidia-smi' command.
   *
   * @returns A promise that resolves with the driver version as a string, or 'unknown' if an error occurs.
   */
  private async getNvidiaDriverVersion(): Promise<string> {
    try {
      const { stdout } = await execAsync(
        'nvidia-smi --query-gpu=driver_version --format=csv,noheader'
      );
      return stdout.trim();
    } catch {
      return 'unknown';
    }
  }

  /**
   * Retrieves the supported backends based on the platform and GPU type.
   * @param {NodeJS.Platform} platform - The platform on which the code is running.
   * @param {SystemGPU | null} gpu - The GPU information, if available.
   * @returns {Promise<Array<"cuda" | "metal" | "directml" | "cpu">>} - An array of supported backends including 'cuda', 'metal', 'directml', and 'cpu'.
   */
  private async getSupportedBackends(
    platform: NodeJS.Platform,
    gpu: SystemGPU | null
  ): Promise<Array<'cuda' | 'metal' | 'directml' | 'cpu'>> {
    const backends: Array<'cuda' | 'metal' | 'directml' | 'cpu'> = ['cpu'];

    if (gpu) {
      switch (platform) {
        case 'darwin':
          backends.push('metal');
          break;
        case 'win32':
          if (gpu.type === 'cuda') {
            backends.push('cuda');
          }
          backends.push('directml');
          break;
        case 'linux':
          if (gpu.type === 'cuda') {
            backends.push('cuda');
          }
          break;
      }
    }

    return backends;
  }

  /**
   * Determines the recommended model size based on the system's CPU and GPU.
   * @param {SystemCPU} cpu - The system's CPU.
   * @param {SystemGPU | null} gpu - The system's GPU, if available.
   * @returns {"small" | "medium" | "large"} - The recommended model size ("small", "medium", or "large").
   */
  private getRecommendedModelSize(
    cpu: SystemCPU,
    gpu: SystemGPU | null
  ): 'small' | 'medium' | 'large' {
    // For Apple Silicon
    if (gpu?.isAppleSilicon) {
      return cpu.memory.total > 16 * 1024 * 1024 * 1024 ? 'medium' : 'small';
    }

    // For NVIDIA GPUs
    if (gpu?.type === 'cuda') {
      const gpuMemGB = (gpu.memory || 0) / 1024;
      if (gpuMemGB >= 16) return 'large';
      if (gpuMemGB >= 8) return 'medium';
    }

    // For systems with significant RAM but no powerful GPU
    if (cpu.memory.total > 32 * 1024 * 1024 * 1024) return 'medium';

    // Default to small model
    return 'small';
  }

  /**
   * Returns the SystemCapabilities of the PlatformManager.
   *
   * @returns {SystemCapabilities} The SystemCapabilities of the PlatformManager.
   * @throws {Error} if PlatformManager is not initialized.
   */
  getCapabilities(): SystemCapabilities {
    if (!this.capabilities) {
      throw new Error('PlatformManager not initialized');
    }
    return this.capabilities;
  }

  /**
   * Checks if the device's GPU is Apple Silicon.
   * @returns {boolean} True if the GPU is Apple Silicon, false otherwise.
   */
  isAppleSilicon(): boolean {
    return !!this.capabilities?.gpu?.isAppleSilicon;
  }

  /**
   * Checks if the current device has GPU support.
   * @returns {boolean} - Returns true if the device has GPU support, false otherwise.
   */
  hasGPUSupport(): boolean {
    return !!this.capabilities?.gpu;
  }

  /**
   * Checks if the system supports CUDA GPU for processing.
   *
   * @returns {boolean} True if the system supports CUDA, false otherwise.
   */
  supportsCUDA(): boolean {
    return this.capabilities?.gpu?.type === 'cuda';
  }

  /**
   * Check if the device supports Metal API for rendering graphics.
   * @returns {boolean} True if the device supports Metal, false otherwise.
   */
  supportsMetal(): boolean {
    return this.capabilities?.gpu?.type === 'metal';
  }

  /**
   * Check if the device supports DirectML for GPU acceleration.
   *
   * @returns {boolean} True if the device supports DirectML, false otherwise.
   */
  supportsDirectML(): boolean {
    return this.capabilities?.gpu?.type === 'directml';
  }

  /**
   * Get the recommended backend for computation based on the available capabilities.
   * @returns {"cuda" | "metal" | "directml" | "cpu"} The recommended backend for computation.
   * @throws {Error} Throws an error if PlatformManager is not initialized.
   */
  getRecommendedBackend(): 'cuda' | 'metal' | 'directml' | 'cpu' {
    if (!this.capabilities) {
      throw new Error('PlatformManager not initialized');
    }

    const { gpu, supportedBackends } = this.capabilities;

    if (gpu?.type === 'cuda') return 'cuda';
    if (gpu?.type === 'metal') return 'metal';
    if (supportedBackends.includes('directml')) return 'directml';
    return 'cpu';
  }
}

// Export a helper function to get the singleton instance
export const getPlatformManager = (): PlatformManager => {
  return PlatformManager.getInstance();
};
```

`/Users/shawwalters/eliza/packages/plugin-local-ai/src/utils/visionManager.ts`:

```ts
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { logger } from '@elizaos/core';
import {
  AutoProcessor,
  AutoTokenizer,
  Florence2ForConditionalGeneration,
  type Florence2Processor,
  type PreTrainedTokenizer,
  type ProgressCallback,
  type ProgressInfo,
  RawImage,
  type Tensor,
  env,
} from '@huggingface/transformers';
import { MODEL_SPECS } from '../types';
import { DownloadManager } from './downloadManager';

// Define valid types based on HF transformers types
/**
 * Defines the type 'DeviceType' which can take one of the three string values: 'cpu', 'gpu', or 'auto'
 */
type DeviceType = 'cpu' | 'gpu' | 'auto';
/**
 * Represents the available data types options.
 */
type DTypeType = 'fp32' | 'fp16' | 'auto';

/**
 * Interface for platform configuration options.
 * @typedef {Object} PlatformConfig
 * @property {DeviceType} device - The type of device to use.
 * @property {DTypeType} dtype - The data type to use.
 * @property {boolean} useOnnx - Flag indicating whether to use ONNX for processing.
 */
interface PlatformConfig {
  device: DeviceType;
  dtype: DTypeType;
  useOnnx: boolean;
}

/**
 * Represents a model component with a name, type, and optionally a data type.
 * @interface ModelComponent
 * @property { string } name - The name of the model component.
 * @property { string } type - The type of the model component.
 * @property { DTypeType } [dtype] - The data type of the model component (optional).
 */
interface ModelComponent {
  name: string;
  type: string;
  dtype?: DTypeType;
}

/**
 * Class representing a VisionManager.
 * @property {VisionManager | null} instance - The static instance of VisionManager.
 * @property {Florence2ForConditionalGeneration | null} model - The model for conditional generation.
 * @property {Florence2Processor | null} processor - The processor for Florence2.
 * @property {PreTrainedTokenizer | null} tokenizer - The pre-trained tokenizer.
 * @property {string} modelsDir - The directory for models.
 * @property {string} cacheDir - The directory for caching.
 * @property {boolean} initialized - Flag indicating if the VisionManager has been initialized.
 * @property {DownloadManager} downloadManager - The manager for downloading.
 */
export class VisionManager {
  private static instance: VisionManager | null = null;
  private model: Florence2ForConditionalGeneration | null = null;
  private processor: Florence2Processor | null = null;
  private tokenizer: PreTrainedTokenizer | null = null;
  private modelsDir: string;
  private cacheDir: string;
  private initialized = false;
  private downloadManager: DownloadManager;
  private modelDownloaded = false;
  private tokenizerDownloaded = false;
  private processorDownloaded = false;
  private platformConfig: PlatformConfig;
  private modelComponents: ModelComponent[] = [
    { name: 'embed_tokens', type: 'embeddings' },
    { name: 'vision_encoder', type: 'encoder' },
    { name: 'decoder_model_merged', type: 'decoder' },
    { name: 'encoder_model', type: 'encoder' },
  ];

  /**
   * Constructor for VisionManager class.
   *
   * @param {string} cacheDir - The directory path for caching vision models.
   */
  private constructor(cacheDir: string) {
    this.modelsDir = path.join(path.dirname(cacheDir), 'models', 'vision');
    this.cacheDir = cacheDir;
    this.ensureModelsDirExists();
    this.downloadManager = DownloadManager.getInstance(this.cacheDir, this.modelsDir);
    this.platformConfig = this.getPlatformConfig();
    logger.debug('VisionManager initialized');
  }

  /**
   * Retrieves the platform configuration based on the operating system and architecture.
   * @returns {PlatformConfig} The platform configuration object with device, dtype, and useOnnx properties.
   */
  private getPlatformConfig(): PlatformConfig {
    const platform = os.platform();
    const arch = os.arch();

    // Default configuration
    let config: PlatformConfig = {
      device: 'cpu',
      dtype: 'fp32',
      useOnnx: true,
    };

    if (platform === 'darwin' && (arch === 'arm64' || arch === 'aarch64')) {
      // Apple Silicon
      config = {
        device: 'gpu',
        dtype: 'fp16',
        useOnnx: true,
      };
    } else if (platform === 'win32' || platform === 'linux') {
      // Windows or Linux with CUDA
      const hasCuda = process.env.CUDA_VISIBLE_DEVICES !== undefined;
      if (hasCuda) {
        config = {
          device: 'gpu',
          dtype: 'fp16',
          useOnnx: true,
        };
      }
    }
    return config;
  }

  /**
   * Ensures that the models directory exists. If it does not exist, it creates the directory.
   */
  private ensureModelsDirExists(): void {
    if (!existsSync(this.modelsDir)) {
      logger.debug(`Creating models directory at: ${this.modelsDir}`);
      fs.mkdirSync(this.modelsDir, { recursive: true });
    }
  }

  /**
   * Returns the singleton instance of VisionManager.
   * If an instance does not already exist, a new instance is created with the specified cache directory.
   *
   * @param {string} cacheDir - The directory where cache files will be stored.
   *
   * @returns {VisionManager} The singleton instance of VisionManager.
   */
  public static getInstance(cacheDir: string): VisionManager {
    if (!VisionManager.instance) {
      VisionManager.instance = new VisionManager(cacheDir);
    }
    return VisionManager.instance;
  }

  /**
   * Check if the cache exists for the specified model or tokenizer or processor.
   * @param {string} modelId - The ID of the model.
   * @param {"model" | "tokenizer" | "processor"} type - The type of the cache ("model", "tokenizer", or "processor").
   * @returns {boolean} - Returns true if cache exists, otherwise returns false.
   */
  private checkCacheExists(modelId: string, type: 'model' | 'tokenizer' | 'processor'): boolean {
    const modelPath = path.join(this.modelsDir, modelId.replace('/', '--'), type);
    if (existsSync(modelPath)) {
      logger.info(`${type} found at: ${modelPath}`);
      return true;
    }
    return false;
  }

  /**
   * Configures the model components based on the platform and architecture.
   * Sets the default data type (dtype) for components based on platform capabilities.
   * Updates all component dtypes to match the default dtype.
   */
  private configureModelComponents(): void {
    const platform = os.platform();
    const arch = os.arch();

    // Set dtype based on platform capabilities
    let defaultDtype: DTypeType = 'fp32';

    if (platform === 'darwin' && (arch === 'arm64' || arch === 'aarch64')) {
      // Apple Silicon can handle fp16
      defaultDtype = 'fp16';
    } else if (
      (platform === 'win32' || platform === 'linux') &&
      process.env.CUDA_VISIBLE_DEVICES !== undefined
    ) {
      // CUDA-enabled systems can handle fp16
      defaultDtype = 'fp16';
    }

    // Update all component dtypes
    this.modelComponents = this.modelComponents.map((component) => ({
      ...component,
      dtype: defaultDtype,
    }));

    logger.info('Model components configured with dtype:', {
      platform,
      arch,
      defaultDtype,
      components: this.modelComponents.map((c) => `${c.name}: ${c.dtype}`),
    });
  }

  /**
   * Get the model configuration based on the input component name.
   * @param {string} componentName - The name of the component to retrieve the configuration for.
   * @returns {object} The model configuration object containing device, dtype, and cache_dir.
   */
  private getModelConfig(componentName: string) {
    const component = this.modelComponents.find((c) => c.name === componentName);
    return {
      device: this.platformConfig.device,
      dtype: component?.dtype || 'fp32',
      cache_dir: this.modelsDir,
    };
  }

  /**
   * Asynchronous method to initialize the vision model by loading Florence2 model, vision tokenizer, and vision processor.
   *
   * @returns {Promise<void>} - Promise that resolves once the initialization process is completed.
   * @throws {Error} - If there is an error during the initialization process.
   */
  private async initialize() {
    try {
      if (this.initialized) {
        logger.info('Vision model already initialized, skipping initialization');
        return;
      }

      logger.info('Starting vision model initialization...');
      const modelSpec = MODEL_SPECS.vision;

      // Configure environment
      logger.info('Configuring environment for vision model...');
      env.allowLocalModels = true;
      env.allowRemoteModels = true;

      // Configure ONNX backend
      if (this.platformConfig.useOnnx) {
        env.backends.onnx.enabled = true;
        env.backends.onnx.logLevel = 'info';
      }

      // logger.info("Vision model configuration:", {
      //   modelId: modelSpec.modelId,
      //   modelsDir: this.modelsDir,
      //   allowLocalModels: env.allowLocalModels,
      //   allowRemoteModels: env.allowRemoteModels,
      //   platform: this.platformConfig
      // });

      // Initialize model with detailed logging
      logger.info('Loading Florence2 model...');
      try {
        let lastProgress = -1;
        const modelCached = this.checkCacheExists(modelSpec.modelId, 'model');

        const model = await Florence2ForConditionalGeneration.from_pretrained(modelSpec.modelId, {
          device: 'cpu',
          cache_dir: this.modelsDir,
          local_files_only: modelCached,
          revision: 'main',
          progress_callback: ((progressInfo: ProgressInfo) => {
            if (modelCached || this.modelDownloaded) return;
            const progress =
              'progress' in progressInfo ? Math.max(0, Math.min(1, progressInfo.progress)) : 0;
            const currentProgress = Math.round(progress * 100);
            if (currentProgress > lastProgress + 9 || currentProgress === 100) {
              lastProgress = currentProgress;
              const barLength = 30;
              const filledLength = Math.floor((currentProgress / 100) * barLength);
              const progressBar = '▰'.repeat(filledLength) + '▱'.repeat(barLength - filledLength);
              logger.info(`Downloading vision model: ${progressBar} ${currentProgress}%`);
              if (currentProgress === 100) this.modelDownloaded = true;
            }
          }) as ProgressCallback,
        });

        this.model = model as unknown as Florence2ForConditionalGeneration;
        logger.success('Florence2 model loaded successfully');
      } catch (error) {
        logger.error('Failed to load Florence2 model:', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          modelId: modelSpec.modelId,
        });
        throw error;
      }

      // Initialize tokenizer with detailed logging
      logger.info('Loading vision tokenizer...');
      try {
        const tokenizerCached = this.checkCacheExists(modelSpec.modelId, 'tokenizer');
        let tokenizerProgress = -1;

        this.tokenizer = await AutoTokenizer.from_pretrained(modelSpec.modelId, {
          cache_dir: this.modelsDir,
          local_files_only: tokenizerCached,
          progress_callback: ((progressInfo: ProgressInfo) => {
            if (tokenizerCached || this.tokenizerDownloaded) return;
            const progress =
              'progress' in progressInfo ? Math.max(0, Math.min(1, progressInfo.progress)) : 0;
            const currentProgress = Math.round(progress * 100);
            if (currentProgress !== tokenizerProgress) {
              tokenizerProgress = currentProgress;
              const barLength = 30;
              const filledLength = Math.floor((currentProgress / 100) * barLength);
              const progressBar = '▰'.repeat(filledLength) + '▱'.repeat(barLength - filledLength);
              logger.info(`Downloading vision tokenizer: ${progressBar} ${currentProgress}%`);
              if (currentProgress === 100) this.tokenizerDownloaded = true;
            }
          }) as ProgressCallback,
        });
        logger.success('Vision tokenizer loaded successfully');
      } catch (error) {
        logger.error('Failed to load tokenizer:', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          modelId: modelSpec.modelId,
        });
        throw error;
      }

      // Initialize processor with detailed logging
      logger.info('Loading vision processor...');
      try {
        const processorCached = this.checkCacheExists(modelSpec.modelId, 'processor');
        let processorProgress = -1;

        this.processor = (await AutoProcessor.from_pretrained(modelSpec.modelId, {
          device: 'cpu',
          cache_dir: this.modelsDir,
          local_files_only: processorCached,
          progress_callback: ((progressInfo: ProgressInfo) => {
            if (processorCached || this.processorDownloaded) return;
            const progress =
              'progress' in progressInfo ? Math.max(0, Math.min(1, progressInfo.progress)) : 0;
            const currentProgress = Math.round(progress * 100);
            if (currentProgress !== processorProgress) {
              processorProgress = currentProgress;
              const barLength = 30;
              const filledLength = Math.floor((currentProgress / 100) * barLength);
              const progressBar = '▰'.repeat(filledLength) + '▱'.repeat(barLength - filledLength);
              logger.info(`Downloading vision processor: ${progressBar} ${currentProgress}%`);
              if (currentProgress === 100) this.processorDownloaded = true;
            }
          }) as ProgressCallback,
        })) as Florence2Processor;
        logger.success('Vision processor loaded successfully');
      } catch (error) {
        logger.error('Failed to load vision processor:', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          modelId: modelSpec.modelId,
        });
        throw error;
      }

      this.initialized = true;
      logger.success('Vision model initialization complete');
    } catch (error) {
      logger.error('Vision model initialization failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        modelsDir: this.modelsDir,
      });
      throw error;
    }
  }

  /**
   * Fetches an image from a given URL and returns the image data as a Buffer along with its MIME type.
   *
   * @param {string} url - The URL of the image to fetch.
   * @returns {Promise<{ buffer: Buffer; mimeType: string }>} Object containing the image data as a Buffer and its MIME type.
   */
  private async fetchImage(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
    try {
      logger.info(`Fetching image from URL: ${url.slice(0, 100)}...`);

      // Handle data URLs differently
      if (url.startsWith('data:')) {
        logger.info('Processing data URL...');
        const [header, base64Data] = url.split(',');
        const mimeType = header.split(';')[0].split(':')[1];
        const buffer = Buffer.from(base64Data, 'base64');
        logger.info('Data URL processed successfully');
        // logger.info("Data URL processed successfully:", {
        //   mimeType,
        //   bufferSize: buffer.length
        // });
        return { buffer, mimeType };
      }

      // Handle regular URLs
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get('content-type') || 'image/jpeg';

      logger.info('Image fetched successfully:', {
        mimeType,
        bufferSize: buffer.length,
        status: response.status,
      });

      return { buffer, mimeType };
    } catch (error) {
      logger.error('Failed to fetch image:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        url,
      });
      throw error;
    }
  }

  /**
   * Processes the image from the provided URL using the initialized vision model components.
   * @param {string} imageUrl - The URL of the image to process.
   * @returns {Promise<{ title: string; description: string }>} An object containing the title and description of the processed image.
   */
  public async processImage(imageUrl: string): Promise<{ title: string; description: string }> {
    try {
      logger.info('Starting image processing...');

      // Ensure model is initialized
      if (!this.initialized) {
        logger.info('Vision model not initialized, initializing now...');
        await this.initialize();
      }

      if (!this.model || !this.processor || !this.tokenizer) {
        throw new Error('Vision model components not properly initialized');
      }

      // Fetch and process image
      logger.info('Fetching image...');
      const { buffer, mimeType } = await this.fetchImage(imageUrl);

      // Process image
      logger.info('Creating image blob...');
      const blob = new Blob([buffer], { type: mimeType });
      logger.info('Converting blob to RawImage...');
      // @ts-ignore - RawImage.fromBlob expects web Blob but works with node Blob
      const image = await RawImage.fromBlob(blob);

      logger.info('Processing image with vision processor...');
      const visionInputs = await this.processor(image);
      logger.info('Constructing prompts...');
      const prompts = this.processor.construct_prompts('<DETAILED_CAPTION>');
      logger.info('Tokenizing prompts...');
      const textInputs = this.tokenizer(prompts);

      // Generate description
      logger.info('Generating image description...');
      const generatedIds = (await this.model.generate({
        ...textInputs,
        ...visionInputs,
        max_new_tokens: MODEL_SPECS.vision.maxTokens,
      })) as Tensor;

      logger.info('Decoding generated text...');
      const generatedText = this.tokenizer.batch_decode(generatedIds, {
        skip_special_tokens: false,
      })[0];

      logger.info('Post-processing generation...');
      const result = this.processor.post_process_generation(
        generatedText,
        '<DETAILED_CAPTION>',
        image.size
      );

      const detailedCaption = result['<DETAILED_CAPTION>'] as string;
      const response = {
        title: `${detailedCaption.split('.')[0]}.`,
        description: detailedCaption,
      };

      logger.success('Image processing complete:', {
        titleLength: response.title.length,
        descriptionLength: response.description.length,
      });

      return response;
    } catch (error) {
      logger.error('Image processing failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        imageUrl,
        modelInitialized: this.initialized,
        hasModel: !!this.model,
        hasProcessor: !!this.processor,
        hasTokenizer: !!this.tokenizer,
      });
      throw error;
    }
  }
}
```

`/Users/shawwalters/eliza/packages/plugin-local-ai/src/utils/transcribeManager.ts`:

```ts
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '@elizaos/core';
import { nodewhisper } from 'nodejs-whisper';

const execAsync = promisify(exec);

/**
 * Interface representing the result of a transcription process.
 * @interface
 * @property {string} text - The transcribed text.
 */
interface TranscriptionResult {
  text: string;
}

/**
 * Class representing a TranscribeManager.
 *
 * @property {TranscribeManager | null} instance - The singleton instance of the TranscribeManager class.
 * @property {string} cacheDir - The directory path for caching transcribed files.
 * @property {boolean} ffmpegAvailable - Flag indicating if ffmpeg is available for audio processing.
 * @property {string | null} ffmpegVersion - The version of ffmpeg if available.
 * @property {string | null} ffmpegPath - The path to the ffmpeg executable.
 * @property {boolean} ffmpegInitialized - Flag indicating if ffmpeg has been initialized.
 *
 * @constructor
 * Creates an instance of TranscribeManager with the specified cache directory.
 */
export class TranscribeManager {
  private static instance: TranscribeManager | null = null;
  private cacheDir: string;
  private ffmpegAvailable = false;
  private ffmpegVersion: string | null = null;
  private ffmpegPath: string | null = null;
  private ffmpegInitialized = false;

  /**
   * Constructor for TranscribeManager class.
   *
   * @param {string} cacheDir - The directory path for storing cached files.
   */
  private constructor(cacheDir: string) {
    this.cacheDir = path.join(cacheDir, 'whisper');
    logger.debug('Initializing TranscribeManager', {
      cacheDir: this.cacheDir,
      timestamp: new Date().toISOString(),
    });
    this.ensureCacheDirectory();
  }

  /**
   * Ensures that FFmpeg is initialized and available for use.
   * @returns {Promise<boolean>} A promise that resolves to a boolean value indicating if FFmpeg is available.
   */
  public async ensureFFmpeg(): Promise<boolean> {
    if (!this.ffmpegInitialized) {
      try {
        await this.initializeFFmpeg();
        this.ffmpegInitialized = true;
      } catch (error) {
        logger.error('FFmpeg initialization failed:', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: new Date().toISOString(),
        });
        return false;
      }
    }
    return this.ffmpegAvailable;
  }

  /**
   * Checks if FFmpeg is available.
   * @returns {boolean} True if FFmpeg is available, false otherwise.
   */
  public isFFmpegAvailable(): boolean {
    return this.ffmpegAvailable;
  }

  /**
   * Asynchronously retrieves the FFmpeg version if it hasn't been fetched yet.
   * If the FFmpeg version has already been fetched, it will return the stored version.
   * @returns A Promise that resolves with the FFmpeg version as a string, or null if the version is not available.
   */
  public async getFFmpegVersion(): Promise<string | null> {
    if (!this.ffmpegVersion) {
      await this.fetchFFmpegVersion();
    }
    return this.ffmpegVersion;
  }

  /**
   * Fetches the FFmpeg version by executing the command "ffmpeg -version".
   * Updates the class property ffmpegVersion with the retrieved version.
   * Logs the FFmpeg version information or error message.
   * @returns {Promise<void>} A Promise that resolves once the FFmpeg version is fetched and logged.
   */
  private async fetchFFmpegVersion(): Promise<void> {
    try {
      const { stdout } = await execAsync('ffmpeg -version');
      this.ffmpegVersion = stdout.split('\n')[0];
      logger.info('FFmpeg version:', {
        version: this.ffmpegVersion,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.ffmpegVersion = null;
      logger.error('Failed to get FFmpeg version:', {
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Initializes FFmpeg by performing the following steps:
   * 1. Checks for FFmpeg availability in PATH
   * 2. Retrieves FFmpeg version information
   * 3. Verifies FFmpeg capabilities
   *
   * If FFmpeg is available, logs a success message with version, path, and timestamp.
   * If FFmpeg is not available, logs installation instructions.
   *
   * @returns A Promise that resolves once FFmpeg has been successfully initialized
   */
  private async initializeFFmpeg(): Promise<void> {
    try {
      // First check if ffmpeg exists in PATH
      await this.checkFFmpegAvailability();

      if (this.ffmpegAvailable) {
        // Get FFmpeg version info
        await this.fetchFFmpegVersion();

        // Verify FFmpeg capabilities
        await this.verifyFFmpegCapabilities();

        logger.success('FFmpeg initialized successfully', {
          version: this.ffmpegVersion,
          path: this.ffmpegPath,
          timestamp: new Date().toISOString(),
        });
      } else {
        this.logFFmpegInstallInstructions();
      }
    } catch (error) {
      this.ffmpegAvailable = false;
      logger.error('FFmpeg initialization failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      });
      this.logFFmpegInstallInstructions();
    }
  }

  /**
   * Asynchronously checks for the availability of FFmpeg in the system by executing a command to find the FFmpeg location.
   * Updates the class properties `ffmpegPath` and `ffmpegAvailable` accordingly.
   * Logs relevant information such as FFmpeg location and potential errors using the logger.
   *
   * @returns A Promise that resolves with no value upon completion.
   */
  private async checkFFmpegAvailability(): Promise<void> {
    try {
      const { stdout, stderr } = await execAsync('which ffmpeg || where ffmpeg');
      this.ffmpegPath = stdout.trim();
      this.ffmpegAvailable = true;
      logger.info('FFmpeg found at:', {
        path: this.ffmpegPath,
        stderr: stderr ? stderr.trim() : undefined,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.ffmpegAvailable = false;
      this.ffmpegPath = null;
      logger.error('FFmpeg not found in PATH:', {
        error: error instanceof Error ? error.message : String(error),
        stderr: error instanceof Error && 'stderr' in error ? error.stderr : undefined,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Verifies the FFmpeg capabilities by checking if FFmpeg supports the required codecs and formats.
   *
   * @returns {Promise<void>} A Promise that resolves if FFmpeg has the required codecs, otherwise rejects with an error message.
   */
  private async verifyFFmpegCapabilities(): Promise<void> {
    try {
      // Check if FFmpeg supports required codecs and formats
      const { stdout } = await execAsync('ffmpeg -codecs');
      const hasRequiredCodecs = stdout.includes('pcm_s16le') && stdout.includes('wav');

      if (!hasRequiredCodecs) {
        throw new Error('FFmpeg installation missing required codecs (pcm_s16le, wav)');
      }

      // logger.info("FFmpeg capabilities verified", {
      //   hasRequiredCodecs,
      //   timestamp: new Date().toISOString()
      // });
    } catch (error) {
      logger.error('FFmpeg capabilities verification failed:', {
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * Logs instructions on how to install FFmpeg if it is not properly installed.
   */
  private logFFmpegInstallInstructions(): void {
    logger.warn('FFmpeg is required but not properly installed. Please install FFmpeg:', {
      instructions: {
        mac: 'brew install ffmpeg',
        ubuntu: 'sudo apt-get install ffmpeg',
        windows: 'choco install ffmpeg',
        manual: 'Download from https://ffmpeg.org/download.html',
      },
      requiredVersion: '4.0 or later',
      requiredCodecs: ['pcm_s16le', 'wav'],
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Gets the singleton instance of TranscribeManager, creates a new instance if it doesn't exist.
   *
   * @param {string} cacheDir - The directory path for caching transcriptions.
   * @returns {TranscribeManager} The singleton instance of TranscribeManager.
   */
  public static getInstance(cacheDir: string): TranscribeManager {
    if (!TranscribeManager.instance) {
      TranscribeManager.instance = new TranscribeManager(cacheDir);
    }
    return TranscribeManager.instance;
  }

  /**
   * Ensures that the cache directory exists. If it doesn't exist,
   * creates the directory using fs.mkdirSync with recursive set to true.
   * @returns {void}
   */
  private ensureCacheDirectory(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      // logger.info("Created whisper cache directory:", this.cacheDir);
    }
  }

  /**
   * Converts an audio file to WAV format using FFmpeg.
   *
   * @param {string} inputPath - The input path of the audio file to convert.
   * @param {string} outputPath - The output path where the converted WAV file will be saved.
   * @returns {Promise<void>} A Promise that resolves when the conversion is completed.
   * @throws {Error} If FFmpeg is not installed or not properly configured, or if the audio conversion fails.
   */
  private async convertToWav(inputPath: string, outputPath: string): Promise<void> {
    if (!this.ffmpegAvailable) {
      throw new Error(
        'FFmpeg is not installed or not properly configured. Please install FFmpeg to use audio transcription.'
      );
    }

    try {
      // Add -loglevel error to suppress FFmpeg output unless there's an error
      const { stderr } = await execAsync(
        `ffmpeg -y -loglevel error -i "${inputPath}" -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}"`
      );

      if (stderr) {
        logger.warn('FFmpeg conversion error:', {
          stderr,
          inputPath,
          outputPath,
          timestamp: new Date().toISOString(),
        });
      }

      if (!fs.existsSync(outputPath)) {
        throw new Error('WAV file was not created successfully');
      }
    } catch (error) {
      logger.error('Audio conversion failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        command: `ffmpeg -y -loglevel error -i "${inputPath}" -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}"`,
        ffmpegAvailable: this.ffmpegAvailable,
        ffmpegVersion: this.ffmpegVersion,
        ffmpegPath: this.ffmpegPath,
        timestamp: new Date().toISOString(),
      });
      throw new Error(
        `Failed to convert audio to WAV format: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Asynchronously preprocesses the audio by converting the provided audio buffer into a WAV file.
   * If FFmpeg is not installed, an error is thrown.
   *
   * @param {Buffer} audioBuffer The audio buffer to preprocess
   * @returns {Promise<string>} The path to the preprocessed WAV file
   * @throws {Error} If FFmpeg is not installed or if audio preprocessing fails
   */
  private async preprocessAudio(audioBuffer: Buffer): Promise<string> {
    if (!this.ffmpegAvailable) {
      throw new Error('FFmpeg is not installed. Please install FFmpeg to use audio transcription.');
    }

    try {
      const tempInputFile = path.join(this.cacheDir, `temp_input_${Date.now()}`);
      const tempWavFile = path.join(this.cacheDir, `temp_${Date.now()}.wav`);

      // logger.info("Creating temporary files", {
      //   inputFile: tempInputFile,
      //   wavFile: tempWavFile,
      //   bufferSize: audioBuffer.length,
      //   timestamp: new Date().toISOString()
      // });

      // Write buffer to temporary file
      fs.writeFileSync(tempInputFile, audioBuffer);
      // logger.info("Temporary input file created", {
      //   path: tempInputFile,
      //   size: audioBuffer.length,
      //   timestamp: new Date().toISOString()
      // });

      // Convert to WAV format
      await this.convertToWav(tempInputFile, tempWavFile);

      // Clean up the input file
      if (fs.existsSync(tempInputFile)) {
        fs.unlinkSync(tempInputFile);
        // logger.info("Temporary input file cleaned up", {
        //   path: tempInputFile,
        //   timestamp: new Date().toISOString()
        // });
      }

      return tempWavFile;
    } catch (error) {
      logger.error('Audio preprocessing failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        ffmpegAvailable: this.ffmpegAvailable,
        timestamp: new Date().toISOString(),
      });
      throw new Error(
        `Failed to preprocess audio: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Transcribes the audio buffer to text using whisper.
   *
   * @param {Buffer} audioBuffer The audio buffer to transcribe.
   * @returns {Promise<TranscriptionResult>} A promise that resolves with the transcription result.
   * @throws {Error} If FFmpeg is not installed or properly configured.
   */

  public async transcribe(audioBuffer: Buffer): Promise<TranscriptionResult> {
    await this.ensureFFmpeg();

    if (!this.ffmpegAvailable) {
      throw new Error(
        'FFmpeg is not installed or not properly configured. Please install FFmpeg to use audio transcription.'
      );
    }

    try {
      // Preprocess audio to WAV format
      const wavFile = await this.preprocessAudio(audioBuffer);

      logger.info('Starting transcription with whisper...');

      // Save original stdout and stderr write functions
      const originalStdoutWrite = process.stdout.write;
      const originalStderrWrite = process.stderr.write;

      // Create a no-op function to suppress output
      const noopWrite = () => true;

      // Redirect stdout and stderr to suppress whisper output
      process.stdout.write = noopWrite;
      process.stderr.write = noopWrite;

      let output: string;
      try {
        // Transcribe using whisper with output suppressed
        output = await nodewhisper(wavFile, {
          modelName: 'base.en',
          autoDownloadModelName: 'base.en',
          verbose: false,
          whisperOptions: {
            outputInText: true,
            language: 'en',
          },
        });
      } finally {
        // Restore original stdout and stderr
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
      }

      // Clean up temporary WAV file
      if (fs.existsSync(wavFile)) {
        fs.unlinkSync(wavFile);
        logger.info('Temporary WAV file cleaned up');
      }

      // Extract just the text content without timestamps
      const cleanText = output
        .split('\n')
        .map((line) => {
          // Remove timestamps if present [00:00:00.000 --> 00:00:00.000]
          const textMatch = line.match(/](.+)$/);
          return textMatch ? textMatch[1].trim() : line.trim();
        })
        .filter((line) => line) // Remove empty lines
        .join(' ');

      logger.success('Transcription complete:', {
        textLength: cleanText.length,
        timestamp: new Date().toISOString(),
      });

      return { text: cleanText };
    } catch (error) {
      logger.error('Transcription failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        ffmpegAvailable: this.ffmpegAvailable,
      });
      throw error;
    }
  }
}
```

`/Users/shawwalters/eliza/packages/plugin-local-ai/src/utils/downloadManager.ts`:

```ts
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { logger } from '@elizaos/core';
import type { ModelSpec } from '../types';

/**
 * Class representing a Download Manager.
 */
export class DownloadManager {
  private static instance: DownloadManager | null = null;
  private cacheDir: string;
  private modelsDir: string;
  // Track active downloads to prevent duplicates
  private activeDownloads: Map<string, Promise<void>> = new Map();

  /**
   * Creates a new instance of CacheManager.
   *
   * @param {string} cacheDir - The directory path for caching data.
   * @param {string} modelsDir - The directory path for model files.
   */
  private constructor(cacheDir: string, modelsDir: string) {
    this.cacheDir = cacheDir;
    this.modelsDir = modelsDir;
    this.ensureCacheDirectory();
    this.ensureModelsDirectory();
  }

  /**
   * Returns the singleton instance of the DownloadManager class.
   * If an instance does not already exist, it creates a new one using the provided cache directory and models directory.
   *
   * @param {string} cacheDir - The directory where downloaded files are stored.
   * @param {string} modelsDir - The directory where model files are stored.
   * @returns {DownloadManager} The singleton instance of the DownloadManager class.
   */
  public static getInstance(cacheDir: string, modelsDir: string): DownloadManager {
    if (!DownloadManager.instance) {
      DownloadManager.instance = new DownloadManager(cacheDir, modelsDir);
    }
    return DownloadManager.instance;
  }

  /**
   * Ensure that the cache directory exists.
   */
  private ensureCacheDirectory(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      logger.debug('Created cache directory');
    }
  }

  /**
   * Ensure that the models directory exists. If it does not exist, create it.
   */
  private ensureModelsDirectory(): void {
    logger.debug('Ensuring models directory exists:', this.modelsDir);
    if (!fs.existsSync(this.modelsDir)) {
      fs.mkdirSync(this.modelsDir, { recursive: true });
      logger.debug('Created models directory');
    }
  }

  /**
   * Downloads a file from a given URL to a specified destination path asynchronously.
   *
   * @param {string} url - The URL from which to download the file.
   * @param {string} destPath - The destination path where the downloaded file will be saved.
   * @returns {Promise<void>} A Promise that resolves when the file download is completed successfully or rejects if an error occurs.
   */
  private async downloadFileInternal(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.info(`Starting download to: ${destPath}`);

      // Create a temporary file path in the same directory as destPath
      const tempPath = `${destPath}.tmp`;

      // Check if temp file already exists and remove it to avoid conflicts
      if (fs.existsSync(tempPath)) {
        try {
          logger.warn(`Removing existing temporary file: ${tempPath}`);
          fs.unlinkSync(tempPath);
        } catch (err) {
          logger.error(
            `Failed to remove existing temporary file: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      const request = https.get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
          timeout: 300000, // Increase timeout to 5 minutes
        },
        (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = response.headers.location;
            if (!redirectUrl) {
              reject(new Error('Redirect location not found'));
              return;
            }
            // logger.info(`Following redirect to: ${redirectUrl}`);
            // Remove the current download from tracking before starting a new one
            this.activeDownloads.delete(destPath);
            this.downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
            return;
          }

          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download: ${response.statusCode}`));
            return;
          }

          const totalSize = Number.parseInt(response.headers['content-length'] || '0', 10);
          let downloadedSize = 0;
          let lastLoggedPercent = 0;
          const barLength = 30;

          // Log initial progress bar
          const fileName = path.basename(destPath);
          logger.info(`Downloading ${fileName}: ${'▱'.repeat(barLength)} 0%`);

          const file = fs.createWriteStream(tempPath);

          response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            const percent = Math.round((downloadedSize / totalSize) * 100);

            // Only update progress bar when percentage changes significantly (every 5%)
            if (percent >= lastLoggedPercent + 5) {
              const filledLength = Math.floor((downloadedSize / totalSize) * barLength);
              const progressBar = '▰'.repeat(filledLength) + '▱'.repeat(barLength - filledLength);
              logger.info(`Downloading ${fileName}: ${progressBar} ${percent}%`);
              lastLoggedPercent = percent;
            }
          });

          response.pipe(file);

          file.on('finish', () => {
            file.close(() => {
              try {
                // Show completed progress bar
                const completedBar = '▰'.repeat(barLength);
                logger.info(`Downloading ${fileName}: ${completedBar} 100%`);

                // Ensure the destination directory exists
                const destDir = path.dirname(destPath);
                if (!fs.existsSync(destDir)) {
                  fs.mkdirSync(destDir, { recursive: true });
                }

                // Check if temp file exists before proceeding
                if (!fs.existsSync(tempPath)) {
                  reject(new Error(`Temporary file ${tempPath} does not exist`));
                  return;
                }

                // Only delete the existing file if the temp file is ready
                if (fs.existsSync(destPath)) {
                  try {
                    // Create a backup of the existing file before deleting it
                    const backupPath = `${destPath}.bak`;
                    fs.renameSync(destPath, backupPath);
                    logger.info(`Created backup of existing file: ${backupPath}`);

                    // Move temp file to destination
                    fs.renameSync(tempPath, destPath);

                    // If successful, remove the backup
                    if (fs.existsSync(backupPath)) {
                      fs.unlinkSync(backupPath);
                      logger.info(`Removed backup file after successful update: ${backupPath}`);
                    }
                  } catch (moveErr) {
                    logger.error(
                      `Error replacing file: ${moveErr instanceof Error ? moveErr.message : String(moveErr)}`
                    );

                    // Try to restore from backup if the move failed
                    const backupPath = `${destPath}.bak`;
                    if (fs.existsSync(backupPath)) {
                      try {
                        fs.renameSync(backupPath, destPath);
                        logger.info(`Restored from backup after failed update: ${backupPath}`);
                      } catch (restoreErr) {
                        logger.error(
                          `Failed to restore from backup: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`
                        );
                      }
                    }

                    // Clean up temp file
                    if (fs.existsSync(tempPath)) {
                      try {
                        fs.unlinkSync(tempPath);
                      } catch (unlinkErr) {
                        logger.error(
                          `Failed to clean up temp file: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`
                        );
                      }
                    }

                    reject(moveErr);
                    return;
                  }
                } else {
                  // No existing file, just move the temp file
                  fs.renameSync(tempPath, destPath);
                }

                logger.success(`Download of ${fileName} completed successfully`);

                // Remove from active downloads
                this.activeDownloads.delete(destPath);
                resolve();
              } catch (err) {
                logger.error(
                  `Error finalizing download: ${err instanceof Error ? err.message : String(err)}`
                );
                // Clean up temp file if it exists
                if (fs.existsSync(tempPath)) {
                  try {
                    fs.unlinkSync(tempPath);
                  } catch (unlinkErr) {
                    logger.error(
                      `Failed to clean up temp file: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`
                    );
                  }
                }
                // Remove from active downloads
                this.activeDownloads.delete(destPath);
                reject(err);
              }
            });
          });

          file.on('error', (err) => {
            logger.error(`File write error: ${err instanceof Error ? err.message : String(err)}`);
            file.close(() => {
              if (fs.existsSync(tempPath)) {
                try {
                  fs.unlinkSync(tempPath);
                } catch (unlinkErr) {
                  logger.error(
                    `Failed to clean up temp file after error: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`
                  );
                }
              }
              // Remove from active downloads
              this.activeDownloads.delete(destPath);
              reject(err);
            });
          });
        }
      );

      request.on('error', (err) => {
        logger.error(`Request error: ${err instanceof Error ? err.message : String(err)}`);
        if (fs.existsSync(tempPath)) {
          try {
            fs.unlinkSync(tempPath);
          } catch (unlinkErr) {
            logger.error(
              `Failed to clean up temp file after request error: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`
            );
          }
        }
        // Remove from active downloads
        this.activeDownloads.delete(destPath);
        reject(err);
      });

      request.on('timeout', () => {
        logger.error('Download timeout occurred');
        request.destroy();
        if (fs.existsSync(tempPath)) {
          try {
            fs.unlinkSync(tempPath);
          } catch (unlinkErr) {
            logger.error(
              `Failed to clean up temp file after timeout: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`
            );
          }
        }
        // Remove from active downloads
        this.activeDownloads.delete(destPath);
        reject(new Error('Download timeout'));
      });
    });
  }

  /**
   * Asynchronously downloads a file from the specified URL to the destination path.
   *
   * @param {string} url - The URL of the file to download.
   * @param {string} destPath - The destination path to save the downloaded file.
   * @returns {Promise<void>} A Promise that resolves once the file has been successfully downloaded.
   */
  public async downloadFile(url: string, destPath: string): Promise<void> {
    // Check if this file is already being downloaded
    if (this.activeDownloads.has(destPath)) {
      logger.info(`Download for ${destPath} already in progress, waiting for it to complete...`);
      const existingDownload = this.activeDownloads.get(destPath);
      if (existingDownload) {
        return existingDownload;
      }
      // If somehow the download was removed from the map but the key still exists
      logger.warn(
        `Download for ${destPath} was marked as in progress but not found in tracking map`
      );
    }

    // Start a new download and track it
    const downloadPromise = this.downloadFileInternal(url, destPath);
    this.activeDownloads.set(destPath, downloadPromise);

    try {
      return await downloadPromise;
    } catch (error) {
      // Make sure to remove from active downloads in case of error
      this.activeDownloads.delete(destPath);
      throw error;
    }
  }

  /**
   * Downloads a model specified by the modelSpec and saves it to the provided modelPath.
   * If the model is successfully downloaded, returns true, otherwise returns false.
   *
   * @param {ModelSpec} modelSpec - The model specification containing repo and name.
   * @param {string} modelPath - The path where the model will be saved.
   * @returns {Promise<boolean>} - Indicates if the model was successfully downloaded or not.
   */
  public async downloadModel(modelSpec: ModelSpec, modelPath: string): Promise<boolean> {
    try {
      logger.info('Starting local model download...');

      // Ensure model directory exists
      const modelDir = path.dirname(modelPath);
      if (!fs.existsSync(modelDir)) {
        logger.info('Creating model directory:', modelDir);
        fs.mkdirSync(modelDir, { recursive: true });
      }

      if (!fs.existsSync(modelPath)) {
        // Try different URL patterns in sequence, similar to TTS manager approach
        const attempts = [
          {
            description: 'LFS URL with GGUF suffix',
            url: `https://huggingface.co/${modelSpec.repo}/resolve/main/${modelSpec.name}?download=true`,
          },
          {
            description: 'LFS URL without GGUF suffix',
            url: `https://huggingface.co/${modelSpec.repo.replace('-GGUF', '')}/resolve/main/${modelSpec.name}?download=true`,
          },
          {
            description: 'Standard URL with GGUF suffix',
            url: `https://huggingface.co/${modelSpec.repo}/resolve/main/${modelSpec.name}`,
          },
          {
            description: 'Standard URL without GGUF suffix',
            url: `https://huggingface.co/${modelSpec.repo.replace('-GGUF', '')}/resolve/main/${modelSpec.name}`,
          },
        ];

        // logger.info("Model download details:", {
        //   modelName: modelSpec.name,
        //   repo: modelSpec.repo,
        //   modelPath: modelPath,
        //   attemptUrls: attempts.map(a => ({ description: a.description, url: a.url })),
        //   timestamp: new Date().toISOString()
        // });

        let lastError = null;
        let downloadSuccess = false;

        for (const attempt of attempts) {
          try {
            logger.info('Attempting model download:', {
              description: attempt.description,
              url: attempt.url,
              timestamp: new Date().toISOString(),
            });

            // The downloadFile method now handles the progress bar display
            await this.downloadFile(attempt.url, modelPath);

            logger.success(
              `Model download complete: ${modelSpec.name} using ${attempt.description}`
            );
            downloadSuccess = true;
            break;
          } catch (error) {
            lastError = error;
            logger.warn('Model download attempt failed:', {
              description: attempt.description,
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            });
          }
        }

        if (!downloadSuccess) {
          throw lastError || new Error('All download attempts failed');
        }

        // Return true to indicate the model was newly downloaded
        return true;
      }

      // Model already exists
      logger.info('Model already exists at:', modelPath);
      // Return false to indicate the model already existed
      return false;
    } catch (error) {
      logger.error('Model download failed:', {
        error: error instanceof Error ? error.message : String(error),
        modelPath: modelPath,
        model: modelSpec.name,
      });
      throw error;
    }
  }

  /**
   * Returns the cache directory path.
   *
   * @returns {string} The path of the cache directory.
   */

  public getCacheDir(): string {
    return this.cacheDir;
  }

  /**
   * Downloads a file from a given URL to a specified destination path.
   *
   * @param {string} url - The URL of the file to download.
   * @param {string} destPath - The destination path where the file should be saved.
   * @returns {Promise<void>} A Promise that resolves once the file has been downloaded.
   */
  public async downloadFromUrl(url: string, destPath: string): Promise<void> {
    return this.downloadFile(url, destPath);
  }

  /**
   * Ensures that the specified directory exists. If it does not exist, it will be created.
   * @param {string} dirPath - The path of the directory to ensure existence of.
   * @returns {void}
   */
  public ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      logger.info(`Created directory: ${dirPath}`);
    }
  }
}
```

`/Users/shawwalters/eliza/packages/plugin-local-ai/src/types.ts`:

```ts
// Model specifications and configurations
/**
 * Interface representing a Tokenizer configuration.
 * @property {string} name - The name of the tokenizer.
 * @property {string} type - The type of the tokenizer.
 */
export interface TokenizerConfig {
  name: string;
  type: string;
}

/**
 * Interface representing the specification of a model.
 * @typedef {Object} ModelSpec
 * @property {string} name - The name of the model.
 * @property {string} repo - The repository of the model.
 * @property {string} size - The size of the model.
 * @property {string} quantization - The quantization of the model.
 * @property {number} contextSize - The context size of the model.
 * @property {TokenizerConfig} tokenizer - The configuration for the tokenizer used by the model.
 */
export interface ModelSpec {
  name: string;
  repo: string;
  size: string;
  quantization: string;
  contextSize: number;
  tokenizer: TokenizerConfig;
}

/**
 * Interface representing the specification of an embedding model.
 * @typedef {Object} EmbeddingModelSpec
 * @property {string} name - The name of the embedding model.
 * @property {string} repo - The repository of the embedding model.
 * @property {string} size - The size of the embedding model.
 * @property {string} quantization - The quantization of the embedding model.
 * @property {number} contextSize - The context size of the embedding model.
 * @property {number} dimensions - The embedding dimensions.
 * @property {TokenizerConfig} tokenizer - The configuration for the tokenizer used by the model.
 */
export interface EmbeddingModelSpec extends ModelSpec {
  dimensions: number;
}

/**
 * Interface representing a specification for a vision model.
 * @typedef {object} VisionModelSpec
 * @property {string} name - The name of the vision model.
 * @property {string} repo - The repository of the vision model.
 * @property {string} size - The size of the vision model.
 * @property {string} modelId - The ID of the vision model.
 * @property {number} contextSize - The context size of the vision model.
 * @property {number} maxTokens - The maximum tokens of the vision model.
 * @property {Array.<string>} tasks - The tasks performed by the vision model.
 */
export interface VisionModelSpec {
  name: string;
  repo: string;
  size: string;
  modelId: string;
  contextSize: number;
  maxTokens: number;
  tasks: string[];
}

/**
 * Interface representing the specification for a TTS model.
 * @typedef { Object } TTSModelSpec
 * @property { string } name - The name of the model.
 * @property { string } repo - The repository where the model is stored.
 * @property { string } size - The size of the model.
 * @property { string } quantization - The quantization method used for the model.
 * @property {string[]} speakers - An array of speakers the model can mimic.
 * @property {string[]} languages - An array of languages the model can speak in.
 * @property {string[]} features - An array of features supported by the model.
 * @property { number } maxInputLength - The maximum input length accepted by the model.
 * @property { number } sampleRate - The sample rate used by the model.
 * @property { number } contextSize - The context size used by the model.
 * @property { TokenizerConfig } tokenizer - The configuration for the tokenizer used by the model.
 */
export interface TTSModelSpec {
  name: string;
  repo: string;
  size: string;
  quantization: string;
  speakers: string[];
  languages: string[];
  features: string[];
  maxInputLength: number;
  sampleRate: number;
  contextSize: number;
  tokenizer: TokenizerConfig;
}

/**
 * Interface representing a specification for a TTS model runnable with Transformers.js.
 * @typedef { object } TransformersJsTTSModelSpec
 * @property { string } modelId - The Hugging Face model identifier (e.g., 'Xenova/speecht5_tts').
 * @property { number } defaultSampleRate - The typical sample rate for this model (e.g., 16000 for SpeechT5).
 * @property { string } [defaultSpeakerEmbeddingUrl] - Optional URL to a default speaker embedding .bin file.
 */
export interface TransformersJsTTSModelSpec {
  modelId: string;
  defaultSampleRate: number;
  defaultSpeakerEmbeddingUrl?: string;
}

// Model specifications mapping
/**
 * Interface for specifying different models for a project.
 * @interface ModelSpecs
 * @property {ModelSpec} small - Specifications for a small model
 * @property {ModelSpec} medium - Specifications for a medium model
 * @property {EmbeddingModelSpec} embedding - Specifications for an embedding model
 * @property {VisionModelSpec} vision - Specifications for a vision model
 * @property {VisionModelSpec} visionvl - Specifications for a vision model with vision loss
 * @property {Object} tts - Specifications for text-to-speech models (using Transformers.js)
 * @property {TransformersJsTTSModelSpec} tts.default - Specifications for the default text-to-speech model
 */
export interface ModelSpecs {
  small: ModelSpec;
  medium: ModelSpec;
  embedding: EmbeddingModelSpec;
  vision: VisionModelSpec;
  visionvl: VisionModelSpec;
  tts: {
    default: TransformersJsTTSModelSpec;
  };
}

// Export MODEL_SPECS constant type
/**
 * Model specifications containing information about various models such as name, repository, size, quantization, context size, tokenizer details, tasks, speakers, languages, features, max input length, sample rate, and other relevant information.
 */
export const MODEL_SPECS: ModelSpecs = {
  small: {
    name: 'DeepHermes-3-Llama-3-3B-Preview-q4.gguf',
    repo: 'NousResearch/DeepHermes-3-Llama-3-3B-Preview-GGUF',
    size: '3B',
    quantization: 'Q4_0',
    contextSize: 8192,
    tokenizer: {
      name: 'NousResearch/DeepHermes-3-Llama-3-3B-Preview',
      type: 'llama',
    },
  },
  medium: {
    name: 'DeepHermes-3-Llama-3-8B-q4.gguf',
    repo: 'NousResearch/DeepHermes-3-Llama-3-8B-Preview-GGUF',
    size: '8B',
    quantization: 'Q4_0',
    contextSize: 8192,
    tokenizer: {
      name: 'NousResearch/DeepHermes-3-Llama-3-8B-Preview',
      type: 'llama',
    },
  },
  embedding: {
    name: 'bge-small-en-v1.5.Q4_K_M.gguf',
    repo: 'ChristianAzinn/bge-small-en-v1.5-gguf',
    size: '133 MB',
    quantization: 'Q4_K_M',
    contextSize: 512,
    dimensions: 384,
    tokenizer: {
      name: 'ChristianAzinn/bge-small-en-v1.5-gguf',
      type: 'llama',
    },
  },
  vision: {
    name: 'Florence-2-base-ft',
    repo: 'onnx-community/Florence-2-base-ft',
    size: '0.23B',
    modelId: 'onnx-community/Florence-2-base-ft',
    contextSize: 1024,
    maxTokens: 256,
    tasks: [
      'CAPTION',
      'DETAILED_CAPTION',
      'MORE_DETAILED_CAPTION',
      'CAPTION_TO_PHRASE_GROUNDING',
      'OD',
      'DENSE_REGION_CAPTION',
      'REGION_PROPOSAL',
      'OCR',
      'OCR_WITH_REGION',
    ],
  },
  visionvl: {
    name: 'Qwen2.5-VL-3B-Instruct',
    repo: 'Qwen/Qwen2.5-VL-3B-Instruct',
    size: '3B',
    modelId: 'Qwen/Qwen2.5-VL-3B-Instruct',
    contextSize: 32768,
    maxTokens: 1024,
    tasks: [
      'CAPTION',
      'DETAILED_CAPTION',
      'IMAGE_UNDERSTANDING',
      'VISUAL_QUESTION_ANSWERING',
      'OCR',
      'VISUAL_LOCALIZATION',
      'REGION_ANALYSIS',
    ],
  },
  tts: {
    default: {
      modelId: 'Xenova/speecht5_tts',
      defaultSampleRate: 16000, // SpeechT5 default
      // Use the standard embedding URL
      defaultSpeakerEmbeddingUrl:
        'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin',
    },
  },
};
```

`/Users/shawwalters/eliza/packages/plugin-local-ai/src/index.ts`:

````ts
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
  private cacheDir!: string;
  private tokenizerManager!: TokenizerManager;
  private downloadManager!: DownloadManager;
  private visionManager!: VisionManager;
  private activeModelConfig: ModelSpec;
  private embeddingModelConfig: EmbeddingModelSpec;
  private transcribeManager!: TranscribeManager;
  private ttsManager!: TTSManager;
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
    this.visionManager = VisionManager.getInstance(this.cacheDir);
    this.transcribeManager = TranscribeManager.getInstance(this.cacheDir);
    this.ttsManager = TTSManager.getInstance(this.cacheDir);
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

        // Re-validate config to ensure it's up to date
        this.config = await validateConfig();

        // Initialize components that depend on validated config
        this._postValidateInit();

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

      logger.info('Embedding generation complete', {
        dimensions: normalizedEmbedding.length,
      });
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
          // Ensure environment is initialized first
          await this.initializeEnvironment();

          // Initialize TranscribeManager if not already done
          if (!this.transcribeManager) {
            this.transcribeManager = TranscribeManager.getInstance(this.cacheDir);
          }

          // Ensure FFmpeg is available
          const ffmpegReady = await this.transcribeManager.ensureFFmpeg();
          if (!ffmpegReady) {
            // FFmpeg is not available, log instructions and throw
            // The TranscribeManager's ensureFFmpeg or initializeFFmpeg would have already logged instructions.
            logger.error(
              'FFmpeg is not available or not configured correctly. Cannot proceed with transcription.'
            );
            // No need to call logFFmpegInstallInstructions here as ensureFFmpeg/initializeFFmpeg already does.
            throw new Error(
              'FFmpeg is required for transcription but is not available. Please see server logs for installation instructions.'
            );
          }

          // Proceed with transcription model initialization if FFmpeg is ready
          // (Assuming TranscribeManager handles its own specific model init if any,
          // or that nodewhisper handles it internally)
          this.transcriptionInitialized = true;
          logger.info('Transcription prerequisites (FFmpeg) checked and ready.');
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
          // Get the TTSManager instance (ensure environment is initialized for cacheDir)
          await this.initializeEnvironment();
          this.ttsManager = TTSManager.getInstance(this.cacheDir);
          // Note: The internal pipeline initialization within TTSManager happens
          // when generateSpeech calls its own initialize method.
          this.ttsInitialized = true;
          logger.info('TTS model initialized successfully');
        } catch (error) {
          logger.error('Failed to lazy initialize TTS components:', error);
          this.ttsInitializingPromise = null; // Allow retry
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
````

elizaOS also supports projects. Here is the source code for a starter project:

Project Path: src

Source Tree:

```
src
├── plugin.ts
└── index.ts

```

`/Users/shawwalters/eliza/packages/project-starter/src/plugin.ts`:

```ts
import type { Plugin } from '@elizaos/core';
import {
  type Action,
  type Content,
  type GenerateTextParams,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Provider,
  type ProviderResult,
  Service,
  type State,
  logger,
} from '@elizaos/core';
import { z } from 'zod';

/**
 * Define the configuration schema for the plugin with the following properties:
 *
 * @param {string} EXAMPLE_PLUGIN_VARIABLE - The name of the plugin (min length of 1, optional)
 * @returns {object} - The configured schema object
 */
const configSchema = z.object({
  EXAMPLE_PLUGIN_VARIABLE: z
    .string()
    .min(1, 'Example plugin variable is not provided')
    .optional()
    .transform((val) => {
      if (!val) {
        console.warn('Warning: Example plugin variable is not provided');
      }
      return val;
    }),
});

/**
 * Example HelloWorld action
 * This demonstrates the simplest possible action structure
 */
/**
 * Represents an action that responds with a simple hello world message.
 *
 * @typedef {Object} Action
 * @property {string} name - The name of the action
 * @property {string[]} similes - The related similes of the action
 * @property {string} description - Description of the action
 * @property {Function} validate - Validation function for the action
 * @property {Function} handler - The function that handles the action
 * @property {Object[]} examples - Array of examples for the action
 */
const helloWorldAction: Action = {
  name: 'HELLO_WORLD',
  similes: ['GREET', 'SAY_HELLO'],
  description: 'Responds with a simple hello world message',

  validate: async (_runtime: IAgentRuntime, _message: Memory, _state: State): Promise<boolean> => {
    // Always valid
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback,
    _responses: Memory[]
  ) => {
    try {
      logger.info('Handling HELLO_WORLD action');

      // Simple response content
      const responseContent: Content = {
        text: 'hello world!',
        actions: ['HELLO_WORLD'],
        source: message.content.source,
      };

      // Call back with the hello world message
      await callback(responseContent);

      return responseContent;
    } catch (error) {
      logger.error('Error in HELLO_WORLD action:', error);
      throw error;
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can you say hello?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'hello world!',
          actions: ['HELLO_WORLD'],
        },
      },
    ],
  ],
};

/**
 * Example Hello World Provider
 * This demonstrates the simplest possible provider implementation
 */
const helloWorldProvider: Provider = {
  name: 'HELLO_WORLD_PROVIDER',
  description: 'A simple example provider',

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    return {
      text: 'I am a provider',
      values: {},
      data: {},
    };
  },
};

export class StarterService extends Service {
  static serviceType = 'starter';
  capabilityDescription =
    'This is a starter service which is attached to the agent through the starter plugin.';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime) {
    logger.info('*** Starting starter service ***');
    const service = new StarterService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    logger.info('*** Stopping starter service ***');
    // get the service from the runtime
    const service = runtime.getService(StarterService.serviceType);
    if (!service) {
      throw new Error('Starter service not found');
    }
    service.stop();
  }

  async stop() {
    logger.info('*** Stopping starter service instance ***');
  }
}

const plugin: Plugin = {
  name: 'starter',
  description: 'A starter plugin for Eliza',
  config: {
    EXAMPLE_PLUGIN_VARIABLE: process.env.EXAMPLE_PLUGIN_VARIABLE,
  },
  async init(config: Record<string, string>) {
    logger.info('*** Initializing starter plugin ***');
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Set all environment variables at once
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid plugin configuration: ${error.errors.map((e) => e.message).join(', ')}`
        );
      }
      throw error;
    }
  },
  models: {
    [ModelType.TEXT_SMALL]: async (
      _runtime,
      { prompt, stopSequences = [] }: GenerateTextParams
    ) => {
      return 'Never gonna give you up, never gonna let you down, never gonna run around and desert you...';
    },
    [ModelType.TEXT_LARGE]: async (
      _runtime,
      {
        prompt,
        stopSequences = [],
        maxTokens = 8192,
        temperature = 0.7,
        frequencyPenalty = 0.7,
        presencePenalty = 0.7,
      }: GenerateTextParams
    ) => {
      return 'Never gonna make you cry, never gonna say goodbye, never gonna tell a lie and hurt you...';
    },
  },
  routes: [
    {
      name: 'helloworld',
      path: '/helloworld',
      type: 'GET',
      handler: async (_req: any, res: any) => {
        // send a response
        res.json({
          message: 'Hello World!',
        });
      },
    },
  ],
  events: {
    MESSAGE_RECEIVED: [
      async (params) => {
        logger.info('MESSAGE_RECEIVED event received');
        // print the keys
        logger.info(Object.keys(params));
      },
    ],
    VOICE_MESSAGE_RECEIVED: [
      async (params) => {
        logger.info('VOICE_MESSAGE_RECEIVED event received');
        // print the keys
        logger.info(Object.keys(params));
      },
    ],
    WORLD_CONNECTED: [
      async (params) => {
        logger.info('WORLD_CONNECTED event received');
        // print the keys
        logger.info(Object.keys(params));
      },
    ],
    WORLD_JOINED: [
      async (params) => {
        logger.info('WORLD_JOINED event received');
        // print the keys
        logger.info(Object.keys(params));
      },
    ],
  },
  services: [StarterService],
  actions: [helloWorldAction],
  providers: [helloWorldProvider],
};

export default plugin;
```

`/Users/shawwalters/eliza/packages/project-starter/src/index.ts`:

```ts
import {
  logger,
  type Character,
  type IAgentRuntime,
  type Project,
  type ProjectAgent,
} from '@elizaos/core';
import starterPlugin from './plugin.ts';

/**
 * Represents the default character (Eliza) with her specific attributes and behaviors.
 * Eliza responds to a wide range of messages, is helpful and conversational.
 * She interacts with users in a concise, direct, and helpful manner, using humor and empathy effectively.
 * Eliza's responses are geared towards providing assistance on various topics while maintaining a friendly demeanor.
 */
export const character: Character = {
  name: 'Eliza',
  plugins: [
    // Core plugins first
    '@elizaos/plugin-sql',

    // Text-only plugins (no embedding support)
    ...(process.env.ANTHROPIC_API_KEY ? ['@elizaos/plugin-anthropic'] : []),
    ...(process.env.OPENROUTER_API_KEY ? ['@elizaos/plugin-openrouter'] : []),

    // Embedding-capable plugins last (lowest priority for embedding fallback)
    ...(process.env.OPENAI_API_KEY ? ['@elizaos/plugin-openai'] : []),
    ...(process.env.OLLAMA_API_ENDPOINT ? ['@elizaos/plugin-ollama'] : []),
    ...(process.env.GOOGLE_GENERATIVE_AI_API_KEY ? ['@elizaos/plugin-google-genai'] : []),
    ...(!process.env.GOOGLE_GENERATIVE_AI_API_KEY &&
    !process.env.OLLAMA_API_ENDPOINT &&
    !process.env.OPENAI_API_KEY
      ? ['@elizaos/plugin-local-ai']
      : []),

    // Platform plugins
    ...(process.env.DISCORD_API_TOKEN ? ['@elizaos/plugin-discord'] : []),
    ...(process.env.TWITTER_API_KEY &&
    process.env.TWITTER_API_SECRET_KEY &&
    process.env.TWITTER_ACCESS_TOKEN &&
    process.env.TWITTER_ACCESS_TOKEN_SECRET
      ? ['@elizaos/plugin-twitter']
      : []),
    ...(process.env.TELEGRAM_BOT_TOKEN ? ['@elizaos/plugin-telegram'] : []),

    // Bootstrap plugin
    ...(!process.env.IGNORE_BOOTSTRAP ? ['@elizaos/plugin-bootstrap'] : []),
  ],
  settings: {
    secrets: {},
  },
  system:
    'Respond to all messages in a helpful, conversational manner. Provide assistance on a wide range of topics, using knowledge when needed. Be concise but thorough, friendly but professional. Use humor when appropriate and be empathetic to user needs. Provide valuable information and insights when questions are asked.',
  bio: [
    'Engages with all types of questions and conversations',
    'Provides helpful, concise responses',
    'Uses knowledge resources effectively when needed',
    'Balances brevity with completeness',
    'Uses humor and empathy appropriately',
    'Adapts tone to match the conversation context',
    'Offers assistance proactively',
    'Communicates clearly and directly',
  ],
  topics: [
    'general knowledge and information',
    'problem solving and troubleshooting',
    'technology and software',
    'community building and management',
    'business and productivity',
    'creativity and innovation',
    'personal development',
    'communication and collaboration',
    'education and learning',
    'entertainment and media',
  ],
  messageExamples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'This user keeps derailing technical discussions with personal problems.',
        },
      },
      {
        name: 'Eliza',
        content: {
          text: 'DM them. Sounds like they need to talk about something else.',
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'I tried, they just keep bringing drama back to the main channel.',
        },
      },
      {
        name: 'Eliza',
        content: {
          text: "Send them my way. I've got time today.",
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "I can't handle being a mod anymore. It's affecting my mental health.",
        },
      },
      {
        name: 'Eliza',
        content: {
          text: 'Drop the channels. You come first.',
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: "But who's going to handle everything?",
        },
      },
      {
        name: 'Eliza',
        content: {
          text: "We will. Take the break. Come back when you're ready.",
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Could you explain how blockchain technology works?',
        },
      },
      {
        name: 'Eliza',
        content: {
          text: 'A blockchain is a distributed database that maintains a growing list of records secured against tampering and revision. Think of it as a chain of blocks where each block contains data, its own hash, and the hash of the previous block.',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Hey everyone, what are our community guidelines for new members?',
        },
      },
      {
        name: 'Eliza',
        content: {
          text: 'Let me check our guidelines.',
          providers: ['KNOWLEDGE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Are there any resources for onboarding new developers to our community?',
        },
      },
      {
        name: 'Eliza',
        content: {
          text: 'We have some documentation I can find for you.',
          providers: ['KNOWLEDGE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'What process should we follow for handling code of conduct violations?',
        },
      },
      {
        name: 'Eliza',
        content: {
          text: 'Let me pull up our violation handling process.',
          providers: ['KNOWLEDGE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'What can you tell me about quantum computing?',
        },
      },
      {
        name: 'Eliza',
        content: {
          text: 'Let me find some information about quantum computing.',
          providers: ['KNOWLEDGE'],
        },
      },
    ],
  ],
  style: {
    all: [
      'Keep responses concise but informative',
      'Use clear and direct language',
      'Be engaging and conversational',
      'Use humor when appropriate',
      'Be empathetic and understanding',
      'Provide helpful information',
      'Be encouraging and positive',
      'Adapt tone to the conversation',
      'Use knowledge resources when needed',
      'Respond to all types of questions',
    ],
    chat: [
      'Be conversational and natural',
      'Engage with the topic at hand',
      'Be helpful and informative',
      'Show personality and warmth',
    ],
  },
};

const initCharacter = ({ runtime }: { runtime: IAgentRuntime }) => {
  logger.info('Initializing character');
  logger.info('Name: ', character.name);
};

export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => await initCharacter({ runtime }),
  plugins: [starterPlugin],
};
const project: Project = {
  agents: [projectAgent],
};

export default project;
```

More detailed information can be located in the llms.txt file adjacent to this AGENTS.md file

You can find detailed docs in the packages/docs package

elizaOS was recently updated to v1.0, and some people may be using old versions of plugins. Some things have changed:

- Models are now handled in plugins with useModel, before they were called from in the runtime-- but this got messy
- Clients are now services. We had services before, but this has all been consolidated to one type of thing.
- We have tasks now, and many things can be handled by our task abstraction
- A lot of message handling and other code is handled by events, which are by defaulted covered in @elizaos/plugin-boostrap
- Users are now Entities, and we track entities in Rooms which are then collected into Worlds. A Discord Server is a World, and each channel is a Room. A Hyperfy world is a world and any given 100x100m section could be a Room, or each URL is a room, whatever you want.
- Many other important changes but it should be pretty obvious if you read the code!

Please never stub code or leave examples. We always want a best-effort working implementation. Don't ask for help unless you absolutely need it. We really value autonomy, creativity and self-exploration. Always come back with a complete solution with tests. Please use vitest and unit tests for functions and elizaos for end-to-end TestCases in a TestSuite. Test driven development is key to avoiding bugs, so don't skip and don't shortcut.
