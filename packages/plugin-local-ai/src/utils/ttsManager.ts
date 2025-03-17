import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { logger } from '@elizaos/core';
import {
  type LlamaContext,
  type LlamaContextSequence,
  type LlamaModel,
  type Token,
  getLlama,
} from 'node-llama-cpp';
import { MODEL_SPECS } from '../types';
import { prependWavHeader } from './audioUtils';
import { DownloadManager } from './downloadManager';

/**
 * Interface representing the response from a Text-to-Speech (TTS) service.
 * @typedef { Object } TTSResponse
 * @property {number[]} tokens - The array of token ids representing the text to be converted to speech.
 * @property { Float32Array } [audio] - Optional Float32Array representing the audio data output from the TTS service.
 */
interface TTSResponse {
  tokens: number[];
  audio?: Float32Array;
}

/**
 * Class representing a Text-to-Speech Manager
 */
export class TTSManager {
  private static instance: TTSManager | null = null;
  private cacheDir: string;
  private model: LlamaModel | null = null;
  private ctx: LlamaContext | null = null;
  private sequence: LlamaContextSequence | null = null;
  private initialized = false;
  private downloadManager: DownloadManager;
  private modelsDir: string;

  /**
   * Creates a new instance of TTSManager with the provided cache directory.
   *
   * @param {string} cacheDir - The directory where cached data will be stored.
   */
  private constructor(cacheDir: string) {
    this.cacheDir = path.join(cacheDir, 'tts');
    this.modelsDir = process.env.LLAMALOCAL_PATH?.trim()
      ? path.resolve(process.env.LLAMALOCAL_PATH.trim())
      : path.join(process.cwd(), 'models');
    this.downloadManager = DownloadManager.getInstance(this.cacheDir, this.modelsDir);
    this.ensureCacheDirectory();
    logger.debug('TTSManager initialized');
  }

  /**
   * Returns an instance of TTSManager, creating a new one if none exist.
   *
   * @param {string} cacheDir - The directory path to store cached audio files.
   * @returns {TTSManager} An instance of TTSManager.
   */
  public static getInstance(cacheDir: string): TTSManager {
    if (!TTSManager.instance) {
      TTSManager.instance = new TTSManager(cacheDir);
    }
    return TTSManager.instance;
  }

  /**
   * Ensures that the cache directory exists. If it does not exist, the directory will be created.
   */
  private ensureCacheDirectory(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      logger.debug('Created TTS cache directory:', this.cacheDir);
    }
  }

  /**
   * Asynchronously initializes the TTS module with GGUF backend.
   * If already initialized or missing necessary components (model and context), it returns early.
   * Handles model download using different URL patterns as fallback if model not found locally.
   * Initializes the TTS model, creates context, and sets the sequence for TTS generation.
   * Logs detailed steps and final output of initialization.
   *
   * @returns {Promise<void>} A promise that resolves once the TTS module is fully initialized.
   */
  private async initialize(): Promise<void> {
    try {
      if (this.initialized && this.model && this.ctx) {
        return;
      }

      logger.info('Initializing TTS with GGUF backend...');

      const modelSpec = MODEL_SPECS.tts.base;
      const modelPath = path.join(this.modelsDir, modelSpec.name);

      // Log detailed model configuration and paths
      // logger.info("TTS model configuration:", {
      //   name: modelSpec.name,
      //   repo: modelSpec.repo,
      //   modelPath,
      //   timestamp: new Date().toISOString()
      // });

      if (!fs.existsSync(modelPath)) {
        // Try different URL patterns in sequence
        const attempts = [
          {
            spec: { ...modelSpec },
            description: 'Standard URL with GGUF',
            url: `https://huggingface.co/${modelSpec.repo}/resolve/main/${modelSpec.name}?download=true`,
          },
          {
            spec: { ...modelSpec, repo: modelSpec.repo.replace('-GGUF', '') },
            description: 'URL without GGUF suffix',
            url: `https://huggingface.co/${modelSpec.repo.replace('-GGUF', '')}/resolve/main/${modelSpec.name}?download=true`,
          },
          {
            spec: { ...modelSpec, name: modelSpec.name.replace('-Q8_0', '') },
            description: 'URL without quantization suffix',
            url: `https://huggingface.co/${modelSpec.repo}/resolve/main/${modelSpec.name.replace('-Q8_0', '')}.gguf?download=true`,
          },
        ];

        let lastError = null;
        for (const attempt of attempts) {
          try {
            logger.info('Attempting TTS model download:', {
              description: attempt.description,
              repo: attempt.spec.repo,
              name: attempt.spec.name,
              url: attempt.url,
              timestamp: new Date().toISOString(),
            });

            const barLength = 30;
            const emptyBar = '▱'.repeat(barLength);
            logger.info(`Downloading TTS model: ${emptyBar} 0%`);

            await this.downloadManager.downloadFromUrl(attempt.url, modelPath);

            const completedBar = '▰'.repeat(barLength);
            logger.info(`Downloading TTS model: ${completedBar} 100%`);
            logger.success('TTS model download successful with:', attempt.description);
            break;
          } catch (error) {
            lastError = error;
            logger.warn('TTS model download attempt failed:', {
              description: attempt.description,
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            });
          }
        }

        if (!fs.existsSync(modelPath)) {
          throw lastError || new Error('All download attempts failed');
        }
      }

      logger.info('Loading TTS model...');
      const llama = await getLlama();
      this.model = await llama.loadModel({
        modelPath,
        gpuLayers: 0, // Force CPU for now until we add GPU support
      });

      this.ctx = await this.model.createContext({
        contextSize: modelSpec.contextSize,
      });

      this.sequence = this.ctx.getSequence();

      logger.success('TTS initialization complete', {
        modelPath,
        contextSize: modelSpec.contextSize,
        timestamp: new Date().toISOString(),
      });
      this.initialized = true;
    } catch (error) {
      logger.error('TTS initialization failed:', {
        error: error instanceof Error ? error.message : String(error),
        model: MODEL_SPECS.tts.base.name,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * Asynchronously generates speech from a given text using the initialized TTS model.
   * @param {string} text - The text to generate speech from.
   * @returns {Promise<Readable>} A promise that resolves to a Readable stream containing the generated audio data.
   * @throws {Error} If the TTS model is not initialized or if no audio tokens are generated.
   */
  public async generateSpeech(text: string): Promise<Readable> {
    try {
      await this.initialize();

      if (!this.model || !this.ctx || !this.sequence) {
        throw new Error('TTS model not initialized');
      }

      logger.info('Starting speech generation for text:', { text });

      // Format prompt for TTS generation
      const prompt = `[SPEAKER=female_1][LANGUAGE=en]${text}`;
      logger.info('Formatted prompt:', { prompt });

      // Tokenize input
      logger.info('Tokenizing input...');
      const inputTokens = this.model.tokenize(prompt);
      logger.info('Input tokenized:', { tokenCount: inputTokens.length });

      // Generate audio tokens with optimized limit (2x input)
      const maxTokens = inputTokens.length * 2;
      logger.info('Starting token generation with optimized limit:', {
        maxTokens,
      });
      const responseTokens: Token[] = [];
      const _startTime = Date.now();

      try {
        for await (const token of this.sequence.evaluate(inputTokens, {
          temperature: 0.1,
        })) {
          responseTokens.push(token);

          // Update progress bar
          const percent = Math.round((responseTokens.length / maxTokens) * 100);
          const barLength = 30;
          const filledLength = Math.floor((responseTokens.length / maxTokens) * barLength);
          const progressBar = '▰'.repeat(filledLength) + '▱'.repeat(barLength - filledLength);
          logger.info(
            `Token generation: ${progressBar} ${percent}% (${responseTokens.length}/${maxTokens})`
          );

          // Stop if we hit our token limit
          if (responseTokens.length >= maxTokens) {
            logger.info('Token generation complete');
            break;
          }
        }
      } catch (error) {
        logger.error('Token generation error:', error);
        throw error;
      }

      // logger.info("Token generation stats:", {
      //   inputTokens: inputTokens.length,
      //   outputTokens: responseTokens.length,
      //   timeMs: Date.now() - startTime
      // });

      if (responseTokens.length === 0) {
        throw new Error('No audio tokens generated');
      }

      // Convert tokens to audio data
      logger.info('Converting tokens to audio data...');
      const audioData = this.processAudioResponse({
        tokens: responseTokens.map((t) => Number.parseInt(this.model.detokenize([t]), 10)),
      });

      logger.info('Audio data generated:', {
        byteLength: audioData.length,
        sampleRate: MODEL_SPECS.tts.base.sampleRate,
      });

      // Create WAV format
      const audioStream = prependWavHeader(
        Readable.from(audioData),
        audioData.length,
        MODEL_SPECS.tts.base.sampleRate,
        1,
        16
      );

      logger.success('Speech generation complete');
      return audioStream;
    } catch (error) {
      logger.error('Speech generation failed:', {
        error: error instanceof Error ? error.message : String(error),
        text,
      });
      throw error;
    }
  }

  /**
   * Processes the audio response from the TTS service by converting
   * the data to 16-bit PCM format.
   * If the response contains direct audio data, it converts Float32Array
   * to 16-bit PCM. If the response only contains tokens, it converts
   * them to PCM data. The actual conversion process may vary depending
   * on the model used.
   *
   * @param {TTSResponse} response - The response object from the TTS service
   * @returns {Buffer} The processed audio data in 16-bit PCM format
   */
  private processAudioResponse(response: TTSResponse): Buffer {
    if (response.audio) {
      // If we have direct audio data, convert Float32Array to 16-bit PCM
      const pcmData = new Int16Array(response.audio.length);
      for (let i = 0; i < response.audio.length; i++) {
        // Convert float to 16-bit PCM
        const s = Math.max(-1, Math.min(1, response.audio[i]));
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return Buffer.from(pcmData.buffer);
    }

    // If we only have tokens, convert them to PCM data
    // This is a placeholder implementation - actual conversion depends on model
    const pcmData = new Int16Array(response.tokens.length * 2);
    for (let i = 0; i < response.tokens.length; i++) {
      // Simple conversion for testing - replace with actual model-specific conversion
      pcmData[i * 2] = response.tokens[i] & 0xffff;
      pcmData[i * 2 + 1] = (response.tokens[i] >> 16) & 0xffff;
    }
    return Buffer.from(pcmData.buffer);
  }
}
