import { logger } from "@elizaos/core";
import fs from "node:fs";
import path from "node:path";
import { getLlama, type LlamaModel, type LlamaContext, type LlamaContextSequence, type Token } from "node-llama-cpp";
import { MODEL_SPECS } from "../types";
import { Readable } from "node:stream";
import { prependWavHeader } from "./audioUtils";
import { DownloadManager } from "./downloadManager";

interface TTSResponse {
  tokens: number[];
  audio?: Float32Array;
}

export class TTSManager {
  private static instance: TTSManager | null = null;
  private cacheDir: string;
  private model: LlamaModel | null = null;
  private ctx: LlamaContext | null = null;
  private sequence: LlamaContextSequence | null = null;
  private initialized = false;
  private downloadManager: DownloadManager;
  private modelsDir: string;

  private constructor(cacheDir: string) {
    this.cacheDir = path.join(cacheDir, 'tts');
    this.modelsDir = process.env.LLAMALOCAL_PATH?.trim() 
      ? path.resolve(process.env.LLAMALOCAL_PATH.trim())
      : path.join(process.cwd(), "models");
    this.downloadManager = DownloadManager.getInstance(this.cacheDir);
    this.ensureCacheDirectory();
    logger.info("TTSManager initialized with configuration:", {
      cacheDir: this.cacheDir,
      modelsDir: this.modelsDir,
      timestamp: new Date().toISOString()
    });
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
      logger.info("Created TTS cache directory:", this.cacheDir);
    }
  }

  private async initialize(): Promise<void> {
    try {
      if (this.initialized && this.model && this.ctx) {
        return;
      }

      logger.info("Initializing TTS with GGUF backend...");
      
      const modelSpec = MODEL_SPECS.tts.base;
      const modelPath = path.join(this.modelsDir, modelSpec.name);
      
      // Log detailed model configuration and paths
      logger.info("TTS model configuration:", {
        name: modelSpec.name,
        repo: modelSpec.repo,
        modelPath,
        timestamp: new Date().toISOString()
      });

      if (!fs.existsSync(modelPath)) {
        // Try different URL patterns in sequence
        const attempts = [
          {
            spec: { ...modelSpec },
            description: "Standard URL with GGUF",
            url: `https://huggingface.co/${modelSpec.repo}/resolve/main/${modelSpec.name}?download=true`
          },
          {
            spec: { ...modelSpec, repo: modelSpec.repo.replace('-GGUF', '') },
            description: "URL without GGUF suffix",
            url: `https://huggingface.co/${modelSpec.repo.replace('-GGUF', '')}/resolve/main/${modelSpec.name}?download=true`
          },
          {
            spec: { ...modelSpec, name: modelSpec.name.replace('-Q8_0', '') },
            description: "URL without quantization suffix",
            url: `https://huggingface.co/${modelSpec.repo}/resolve/main/${modelSpec.name.replace('-Q8_0', '')}.gguf?download=true`
          }
        ];

        let lastError = null;
        for (const attempt of attempts) {
          try {
            logger.info("Attempting TTS model download:", {
              description: attempt.description,
              repo: attempt.spec.repo,
              name: attempt.spec.name,
              url: attempt.url,
              timestamp: new Date().toISOString()
            });

            const barLength = 20;
            const progressBar = '█'.repeat(barLength);
            logger.info(`TTS model download: ${progressBar} Starting...`);
            
            await this.downloadManager.downloadFromUrl(attempt.url, modelPath);
            
            logger.info(`TTS model download: ${progressBar} 100%`);
            logger.success("TTS model download successful with:", attempt.description);
            break;
          } catch (error) {
            lastError = error;
            logger.warn("TTS model download attempt failed:", {
              description: attempt.description,
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString()
            });
          }
        }

        if (!fs.existsSync(modelPath)) {
          throw lastError || new Error("All download attempts failed");
        }
      }

      logger.info("Loading TTS model...");
      const llama = await getLlama();
      this.model = await llama.loadModel({
        modelPath,
        gpuLayers: 0  // Force CPU for now until we add GPU support
      });

      this.ctx = await this.model.createContext({
        contextSize: modelSpec.contextSize
      });

      this.sequence = this.ctx.getSequence();
      
      logger.success("TTS initialization complete", {
        modelPath,
        contextSize: modelSpec.contextSize,
        timestamp: new Date().toISOString()
      });
      this.initialized = true;
    } catch (error) {
      logger.error("TTS initialization failed:", {
        error: error instanceof Error ? error.message : String(error),
        model: MODEL_SPECS.tts.base.name,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  public async generateSpeech(text: string): Promise<Readable> {
    try {
      await this.initialize();
      
      if (!this.model || !this.ctx || !this.sequence) {
        throw new Error("TTS model not initialized");
      }
      
      logger.info("Starting speech generation for text:", { text });

      // Format prompt for TTS generation
      const prompt = `[SPEAKER=female_1][LANGUAGE=en]${text}`;
      logger.info("Formatted prompt:", { prompt });
      
      // Tokenize input
      logger.info("Tokenizing input...");
      const inputTokens = this.model.tokenize(prompt);
      logger.info("Input tokenized:", { tokenCount: inputTokens.length });

      // Generate audio tokens with optimized limit (2x input)
      const maxTokens = inputTokens.length * 2;
      logger.info("Starting token generation with optimized limit:", { maxTokens });
      const responseTokens: Token[] = [];
      const startTime = Date.now();

      try {
        for await (const token of this.sequence.evaluate(inputTokens, {
          temperature: 0.1,
          
        })) {
          responseTokens.push(token);
          
          // Update progress bar
          const progress = Math.round((responseTokens.length / maxTokens) * 100);
          const barLength = 20;
          const filledLength = Math.floor((progress / 100) * barLength);
          const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
          logger.info(`Token generation: ${bar} ${progress}% (${responseTokens.length}/${maxTokens})`);

          // Stop if we hit our token limit
          if (responseTokens.length >= maxTokens) {
            logger.info("Token generation complete");
            break;
          }
        }
      } catch (error) {
        logger.error("Token generation error:", error);
        throw error;
      }

      logger.info("Token generation stats:", { 
        inputTokens: inputTokens.length,
        outputTokens: responseTokens.length,
        timeMs: Date.now() - startTime 
      });

      if (responseTokens.length === 0) {
        throw new Error("No audio tokens generated");
      }

      // Convert tokens to audio data
      logger.info("Converting tokens to audio data...");
      const audioData = this.processAudioResponse({
        tokens: responseTokens.map(t => Number.parseInt(this.model.detokenize([t]), 10))
      });
      
      logger.info("Audio data generated:", {
        byteLength: audioData.length,
        sampleRate: MODEL_SPECS.tts.base.sampleRate
      });

      // Create WAV format
      const audioStream = prependWavHeader(
        Readable.from(audioData),
        audioData.length,
        MODEL_SPECS.tts.base.sampleRate,
        1,
        16
      );

      logger.success("Speech generation complete");
      return audioStream;
    } catch (error) {
      logger.error("Speech generation failed:", {
        error: error instanceof Error ? error.message : String(error),
        text
      });
      throw error;
    }
  }

  private processAudioResponse(response: TTSResponse): Buffer {
    if (response.audio) {
      // If we have direct audio data, convert Float32Array to 16-bit PCM
      const pcmData = new Int16Array(response.audio.length);
      for (let i = 0; i < response.audio.length; i++) {
        // Convert float to 16-bit PCM
        const s = Math.max(-1, Math.min(1, response.audio[i]));
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      return Buffer.from(pcmData.buffer);
    }
    
    // If we only have tokens, convert them to PCM data
    // This is a placeholder implementation - actual conversion depends on model
    const pcmData = new Int16Array(response.tokens.length * 2);
    for (let i = 0; i < response.tokens.length; i++) {
      // Simple conversion for testing - replace with actual model-specific conversion
      pcmData[i * 2] = response.tokens[i] & 0xFFFF;
      pcmData[i * 2 + 1] = (response.tokens[i] >> 16) & 0xFFFF;
    }
    return Buffer.from(pcmData.buffer);
  }
}
