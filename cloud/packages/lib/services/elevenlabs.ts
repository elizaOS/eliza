/**
 * ElevenLabs Service
 *
 * Provides text-to-speech and speech-to-text functionality using ElevenLabs API.
 * Follows the configuration patterns from @elizaos/plugin-elevenlabs
 *
 * Note: The @elizaos/plugin-elevenlabs only supports TTS through agent runtime.
 * This service provides both TTS and STT for standalone API usage.
 */

import type { ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { logger } from "@/lib/utils/logger";

/**
 * Configuration for ElevenLabs service.
 */
export interface ElevenLabsConfig {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  voiceStability?: number;
  voiceSimilarityBoost?: number;
  voiceStyle?: number;
  voiceUseSpeakerBoost?: boolean;
  optimizeStreamingLatency?: number;
  outputFormat?: string;
}

/**
 * Options for text-to-speech conversion.
 */
export interface TTSOptions {
  text: string;
  voiceId?: string;
  modelId?: string;
}

/**
 * Options for speech-to-text conversion.
 */
export interface STTOptions {
  audioFile: File | Blob;
  modelId?: ElevenLabs.SpeechToTextConvertRequestModelId;
  languageCode?: string;
}

/**
 * Service for ElevenLabs TTS and STT functionality.
 */
export class ElevenLabsService {
  private client: ElevenLabsClient;
  private config: ElevenLabsConfig;

  constructor(config: ElevenLabsConfig) {
    this.config = config;
    this.client = new ElevenLabsClient({ apiKey: config.apiKey });
  }

  /**
   * Initialize service with environment variables (following plugin patterns)
   */
  static fromEnv(): ElevenLabsService {
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY environment variable is required");
    }

    const config: ElevenLabsConfig = {
      apiKey,
      voiceId: process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL",
      modelId: process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5",
      voiceStability: Number.parseFloat(process.env.ELEVENLABS_VOICE_STABILITY || "0.5"),
      voiceSimilarityBoost: Number.parseFloat(
        process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST || "0.75",
      ),
      voiceStyle: Number.parseFloat(process.env.ELEVENLABS_VOICE_STYLE || "0"),
      voiceUseSpeakerBoost: process.env.ELEVENLABS_VOICE_USE_SPEAKER_BOOST !== "false",
      optimizeStreamingLatency: Number.parseInt(
        process.env.ELEVENLABS_OPTIMIZE_STREAMING_LATENCY || "4",
      ),
      outputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128",
    };

    return new ElevenLabsService(config);
  }

  /**
   * Convert text to speech (streaming)
   */
  async textToSpeech(options: TTSOptions): Promise<ReadableStream<Uint8Array>> {
    const voiceId = options.voiceId || this.config.voiceId || "EXAVITQu4vr4xnSDxMaL";
    const modelId = options.modelId || this.config.modelId || "eleven_flash_v2_5";

    logger.info(
      `[ElevenLabs TTS] Generating speech: voice=${voiceId}, model=${modelId}, length=${options.text.length}`,
    );

    const audioStream = await this.client.textToSpeech.stream(voiceId, {
      text: options.text,
      modelId,
      outputFormat: this.config.outputFormat as "mp3_44100_128" | "pcm_16000",
      optimizeStreamingLatency: this.config.optimizeStreamingLatency,
      voiceSettings: {
        stability: this.config.voiceStability,
        similarityBoost: this.config.voiceSimilarityBoost,
        style: this.config.voiceStyle,
        useSpeakerBoost: this.config.voiceUseSpeakerBoost,
      },
    });

    return audioStream;
  }

  /**
   * Convert speech to text
   */
  async speechToText(options: STTOptions): Promise<string> {
    const modelId: ElevenLabs.SpeechToTextConvertRequestModelId =
      options.modelId === "scribe_v2" ? "scribe_v2" : "scribe_v1";

    const FileConstructor = globalThis.File;
    if (!FileConstructor) {
      throw new Error("File is not available in this environment");
    }
    const audioFile =
      options.audioFile instanceof FileConstructor
        ? options.audioFile
        : new FileConstructor([options.audioFile], "audio");

    logger.info(`[ElevenLabs STT] Transcribing audio: model=${modelId}`);

    const result = await this.client.speechToText.convert({
      file: audioFile,
      modelId,
      languageCode: options.languageCode,
    });

    // Handle response type (union of single/multichannel/webhook)
    let transcript = "";

    if ("text" in result) {
      // Single channel response
      transcript = result.text || "";
    } else if ("transcripts" in result) {
      // Multi-channel response - combine all channels
      const transcripts =
        (
          result as {
            transcripts?: Record<string, { text?: string }>;
          }
        ).transcripts || {};
      transcript = Object.values(transcripts)
        .map((t: { text?: string }) => t?.text || "")
        .filter(Boolean)
        .join(" ");
    }

    return transcript;
  }

  /**
   * Get available voices
   */
  async getVoices() {
    const response = await this.client.voices.search();
    return response.voices || [];
  }

  /**
   * Create an instant voice clone
   */
  async createInstantVoiceClone(options: {
    name: string;
    description?: string;
    files: File[];
    language?: string;
  }): Promise<{ voiceId: string; name: string }> {
    logger.info(`[ElevenLabs] Creating instant voice clone: ${options.name}`);

    // Use IVC (Instant Voice Cloning) endpoint
    // Language parameter is required by ElevenLabs API (SDK types are outdated)
    const voice = await this.client.voices.ivc.create({
      name: options.name,
      description: options.description,
      language: options.language || "en",
      files: options.files,
    } as Parameters<typeof this.client.voices.ivc.create>[0]);

    return {
      voiceId: voice.voiceId, // Response uses camelCase
      name: options.name, // Name not returned, use the input name
    };
  }

  /**
   * Create a professional voice clone
   * Note: This may be async on ElevenLabs side depending on their API
   */
  async createProfessionalVoiceClone(options: {
    name: string;
    description?: string;
    files: File[];
    language?: string;
  }): Promise<{ voiceId: string; name: string }> {
    logger.info(`[ElevenLabs] Creating professional voice clone: ${options.name}`);

    // Use PVC (Professional Voice Cloning) endpoint
    // Language parameter is required by ElevenLabs API (SDK types are outdated)
    const voice = await this.client.voices.pvc.create({
      name: options.name,
      description: options.description,
      language: options.language || "en",
      files: options.files,
    } as Parameters<typeof this.client.voices.pvc.create>[0]);

    return {
      voiceId: voice.voiceId, // Response uses camelCase
      name: options.name, // Name not returned, use the input name
    };
  }

  /**
   * Delete a voice by ID
   */
  async deleteVoice(voiceId: string): Promise<void> {
    logger.info(`[ElevenLabs] Deleting voice: ${voiceId}`);

    await this.client.voices.delete(voiceId);
  }

  /**
   * Get voice details from ElevenLabs
   */
  async getVoiceById(voiceId: string) {
    return await this.client.voices.get(voiceId);
  }

  /**
   * Update voice settings
   */
  async updateVoiceSettings(
    voiceId: string,
    settings: {
      name?: string;
      description?: string;
      stability?: number;
      similarityBoost?: number;
    },
  ) {
    logger.info(`[ElevenLabs] Updating voice settings: ${voiceId}`);

    // Use update method to modify voice settings
    return await this.client.voices.update(voiceId, {
      ...settings,
      name: settings.name || undefined,
    } as Parameters<typeof this.client.voices.update>[1]);
  }
}

// Export singleton instance
let serviceInstance: ElevenLabsService | null = null;

export function getElevenLabsService(): ElevenLabsService {
  if (!serviceInstance) {
    serviceInstance = ElevenLabsService.fromEnv();
  }
  return serviceInstance;
}
