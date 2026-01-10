import { logger } from '@elizaos/core';
import { pipeline, type TextToAudioPipeline } from '@huggingface/transformers';
import fs from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';
import { MODEL_SPECS } from '../types';
import { PassThrough, Readable } from 'node:stream';

// Audio Utils

/**
 * Generates a WAV file header based on the provided audio parameters.
 * @param {number} audioLength - The length of the audio data in bytes.
 * @param {number} sampleRate - The sample rate of the audio.
 * @param {number} [channelCount=1] - The number of channels (default is 1).
 * @param {number} [bitsPerSample=16] - The number of bits per sample (default is 16).
 * @returns {Buffer} The WAV file header as a Buffer object.
 */
function getWavHeader(
  audioLength: number,
  sampleRate: number,
  channelCount = 1,
  bitsPerSample = 16
): Buffer {
  const wavHeader = Buffer.alloc(44);
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + audioLength, 4); // Length of entire file in bytes minus 8
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16); // Length of format data
  wavHeader.writeUInt16LE(1, 20); // Type of format (1 is PCM)
  wavHeader.writeUInt16LE(channelCount, 22); // Number of channels
  wavHeader.writeUInt32LE(sampleRate, 24); // Sample rate
  wavHeader.writeUInt32LE((sampleRate * bitsPerSample * channelCount) / 8, 28); // Byte rate
  wavHeader.writeUInt16LE((bitsPerSample * channelCount) / 8, 32); // Block align ((BitsPerSample * Channels) / 8)
  wavHeader.writeUInt16LE(bitsPerSample, 34); // Bits per sample
  wavHeader.write('data', 36); // Data chunk header
  wavHeader.writeUInt32LE(audioLength, 40); // Data chunk size
  return wavHeader;
}

/**
 * Prepends a WAV header to a readable stream of audio data.
 *
 * @param {Readable} readable - The readable stream containing the audio data.
 * @param {number} audioLength - The length of the audio data in bytes.
 * @param {number} sampleRate - The sample rate of the audio data.
 * @param {number} [channelCount=1] - The number of channels in the audio data (default is 1).
 * @param {number} [bitsPerSample=16] - The number of bits per sample in the audio data (default is 16).
 * @returns {PassThrough} A new pass-through stream with the WAV header prepended to the audio data.
 */
function prependWavHeader(
  readable: Readable,
  audioLength: number,
  sampleRate: number,
  channelCount = 1,
  bitsPerSample = 16
): PassThrough {
  const wavHeader = getWavHeader(audioLength, sampleRate, channelCount, bitsPerSample);
  let pushedHeader = false;
  const passThrough = new PassThrough();
  readable.on('data', (data: Buffer) => {
    if (!pushedHeader) {
      passThrough.push(wavHeader);
      pushedHeader = true;
    }
    passThrough.push(data);
  });
  readable.on('end', () => {
    passThrough.end();
  });
  return passThrough;
}

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
