import fs from "node:fs";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { logger } from "@elizaos/core";
import { pipeline, type TextToAudioPipeline } from "@huggingface/transformers";
import { fetch } from "undici";
import { MODEL_SPECS } from "../types";

function getWavHeader(
  audioLength: number,
  sampleRate: number,
  channelCount = 1,
  bitsPerSample = 16
): Buffer {
  const wavHeader = Buffer.alloc(44);
  wavHeader.write("RIFF", 0);
  wavHeader.writeUInt32LE(36 + audioLength, 4);
  wavHeader.write("WAVE", 8);
  wavHeader.write("fmt ", 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(channelCount, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE((sampleRate * bitsPerSample * channelCount) / 8, 28);
  wavHeader.writeUInt16LE((bitsPerSample * channelCount) / 8, 32);
  wavHeader.writeUInt16LE(bitsPerSample, 34);
  wavHeader.write("data", 36);
  wavHeader.writeUInt32LE(audioLength, 40);
  return wavHeader;
}

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
  readable.on("data", (data: Buffer) => {
    if (!pushedHeader) {
      passThrough.push(wavHeader);
      pushedHeader = true;
    }
    passThrough.push(data);
  });
  readable.on("end", () => {
    passThrough.end();
  });
  return passThrough;
}

export class TTSManager {
  private static instance: TTSManager | null = null;
  private cacheDir: string;
  private synthesizer: TextToAudioPipeline | null = null;
  private defaultSpeakerEmbedding: Float32Array | null = null;
  private initialized = false;
  private initializingPromise: Promise<void> | null = null;

  private constructor(cacheDir: string) {
    this.cacheDir = path.join(cacheDir, "tts");
    this.ensureCacheDirectory();
    logger.debug("TTSManager using Transformers.js initialized");
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
      logger.debug("Created TTS cache directory:", this.cacheDir);
    }
  }

  private async initialize(): Promise<void> {
    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    if (this.initialized) {
      return;
    }

    this.initializingPromise = (async () => {
      try {
        logger.info("Initializing TTS with Transformers.js backend...");

        const ttsModelSpec = MODEL_SPECS.tts.default;
        if (!ttsModelSpec) {
          throw new Error("Default TTS model specification not found in MODEL_SPECS.");
        }
        const modelName = ttsModelSpec.modelId;
        const speakerEmbeddingUrl = ttsModelSpec.defaultSpeakerEmbeddingUrl;

        logger.info(`Loading TTS pipeline for model: ${modelName}`);
        this.synthesizer = await pipeline("text-to-audio", modelName);
        logger.success(`TTS pipeline loaded successfully for model: ${modelName}`);

        if (speakerEmbeddingUrl) {
          const embeddingFilename = path.basename(new URL(speakerEmbeddingUrl).pathname);
          const embeddingPath = path.join(this.cacheDir, embeddingFilename);

          if (fs.existsSync(embeddingPath)) {
            logger.info("Loading default speaker embedding from cache...");
            const buffer = fs.readFileSync(embeddingPath);
            this.defaultSpeakerEmbedding = new Float32Array(
              buffer.buffer,
              buffer.byteOffset,
              buffer.length / Float32Array.BYTES_PER_ELEMENT
            );
            logger.success("Default speaker embedding loaded from cache.");
          } else {
            logger.info(`Downloading default speaker embedding from: ${speakerEmbeddingUrl}`);
            const response = await fetch(speakerEmbeddingUrl);
            if (!response.ok) {
              throw new Error(`Failed to download speaker embedding: ${response.statusText}`);
            }
            const buffer = await response.arrayBuffer();
            this.defaultSpeakerEmbedding = new Float32Array(buffer);
            fs.writeFileSync(embeddingPath, Buffer.from(buffer));
            logger.success("Default speaker embedding downloaded and cached.");
          }
        } else {
          logger.warn(
            `No default speaker embedding URL specified for model ${modelName}. Speaker control may be limited.`
          );
          this.defaultSpeakerEmbedding = null;
        }

        if (!this.synthesizer) {
          throw new Error("TTS initialization failed: Pipeline not loaded.");
        }

        logger.success("TTS initialization complete (Transformers.js)");
        this.initialized = true;
      } catch (error) {
        logger.error("TTS (Transformers.js) initialization failed:", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        this.initialized = false;
        this.synthesizer = null;
        this.defaultSpeakerEmbedding = null;
        throw error;
      } finally {
        this.initializingPromise = null;
      }
    })();

    return this.initializingPromise;
  }

  public async generateSpeech(text: string): Promise<Readable> {
    try {
      await this.initialize();

      if (!this.synthesizer) {
        throw new Error("TTS Manager not properly initialized.");
      }

      logger.info("Starting speech generation with Transformers.js for text:", {
        text: `${text.substring(0, 50)}...`,
      });

      const output = await this.synthesizer(text, {
        ...(this.defaultSpeakerEmbedding && {
          speaker_embeddings: this.defaultSpeakerEmbedding,
        }),
      });

      const audioFloat32 = output.audio;
      const samplingRate = output.sampling_rate;

      logger.info("Raw audio data received from pipeline:", {
        samplingRate,
        length: audioFloat32.length,
      });

      if (!audioFloat32 || audioFloat32.length === 0) {
        throw new Error("TTS pipeline generated empty audio output.");
      }

      const pcmData = new Int16Array(audioFloat32.length);
      for (let i = 0; i < audioFloat32.length; i++) {
        const s = Math.max(-1, Math.min(1, audioFloat32[i]));
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const audioBuffer = Buffer.from(pcmData.buffer);

      logger.info("Audio data converted to 16-bit PCM Buffer:", {
        byteLength: audioBuffer.length,
      });

      const audioStream = prependWavHeader(
        Readable.from(audioBuffer),
        audioBuffer.length,
        samplingRate,
        1,
        16
      );

      logger.success("Speech generation complete (Transformers.js)");
      return audioStream;
    } catch (error) {
      logger.error("Transformers.js speech generation failed:", {
        error: error instanceof Error ? error.message : String(error),
        text: `${text.substring(0, 50)}...`,
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }
}
