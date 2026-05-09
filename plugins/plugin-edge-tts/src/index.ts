import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type IAgentRuntime, logger, ModelType, type Plugin } from "@elizaos/core";
import { EdgeTTS } from "node-edge-tts";

/**
 * Edge TTS voice settings configuration
 */
interface EdgeTTSSettings {
  voice: string;
  lang: string;
  outputFormat: string;
  rate?: string;
  pitch?: string;
  volume?: string;
  proxy?: string;
  timeoutMs: number;
}

/**
 * Extended TTS params with Edge-specific options
 */
interface EdgeTTSParams {
  text: string;
  voice?: string;
  speed?: number;
  /** Edge TTS specific: language code */
  lang?: string;
  /** Edge TTS specific: output format */
  outputFormat?: string;
  /** Edge TTS specific: rate adjustment (e.g., +10%, -5%) */
  rate?: string;
  /** Edge TTS specific: pitch adjustment (e.g., +5Hz, -10Hz) */
  pitch?: string;
  /** Edge TTS specific: volume adjustment (e.g., +20%, -10%) */
  volume?: string;
}

// Default voice configurations
const DEFAULT_VOICE = "en-US-MichelleNeural";
const DEFAULT_LANG = "en-US";
const DEFAULT_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const DEFAULT_TIMEOUT_MS = 30000;

// Voice presets mapping common voice names to Edge TTS voices
const VOICE_PRESETS: Record<string, string> = {
  // Generic voices (map to good defaults)
  alloy: "en-US-GuyNeural",
  echo: "en-US-ChristopherNeural",
  fable: "en-GB-RyanNeural",
  onyx: "en-US-DavisNeural",
  nova: "en-US-JennyNeural",
  shimmer: "en-US-AriaNeural",
  // Direct Edge TTS voice names pass through
};

function getSetting(runtime: IAgentRuntime, key: string, fallback?: string): string | undefined {
  const envValue =
    typeof process !== "undefined" && (process as { env?: Record<string, string> }).env
      ? (process as { env: Record<string, string> }).env[key]
      : undefined;
  return (runtime.getSetting(key) as string | undefined) ?? envValue ?? fallback;
}

function getEdgeTTSSettings(runtime: IAgentRuntime): EdgeTTSSettings {
  const timeoutStr = getSetting(runtime, "EDGE_TTS_TIMEOUT_MS");
  return {
    voice: getSetting(runtime, "EDGE_TTS_VOICE", DEFAULT_VOICE) ?? DEFAULT_VOICE,
    lang: getSetting(runtime, "EDGE_TTS_LANG", DEFAULT_LANG) ?? DEFAULT_LANG,
    outputFormat:
      getSetting(runtime, "EDGE_TTS_OUTPUT_FORMAT", DEFAULT_OUTPUT_FORMAT) ?? DEFAULT_OUTPUT_FORMAT,
    rate: getSetting(runtime, "EDGE_TTS_RATE"),
    pitch: getSetting(runtime, "EDGE_TTS_PITCH"),
    volume: getSetting(runtime, "EDGE_TTS_VOLUME"),
    proxy: getSetting(runtime, "EDGE_TTS_PROXY"),
    timeoutMs: timeoutStr ? Number.parseInt(timeoutStr, 10) : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Resolve voice name - handles OpenAI-style voice names and Edge TTS voice IDs
 */
function resolveVoice(voice: string | undefined, defaultVoice: string): string {
  if (!voice) return defaultVoice;

  // Check if it's a preset name
  const preset = VOICE_PRESETS[voice.toLowerCase()];
  if (preset) return preset;

  // Assume it's a direct Edge TTS voice ID
  return voice;
}

/**
 * Convert speed multiplier to Edge TTS rate string
 * speed: 1.0 = normal, 0.5 = half speed, 2.0 = double speed
 */
function speedToRate(speed: number | undefined): string | undefined {
  if (speed === undefined || speed === 1.0) return undefined;
  const percentage = Math.round((speed - 1) * 100);
  return percentage >= 0 ? `+${percentage}%` : `${percentage}%`;
}

/**
 * Infer file extension from Edge TTS output format
 */
function inferExtension(outputFormat: string): string {
  const normalized = outputFormat.toLowerCase();
  if (normalized.includes("webm")) return ".webm";
  if (normalized.includes("ogg")) return ".ogg";
  if (normalized.includes("opus")) return ".opus";
  if (normalized.includes("wav") || normalized.includes("riff") || normalized.includes("pcm")) {
    return ".wav";
  }
  return ".mp3";
}

/**
 * Generate speech using Microsoft Edge TTS
 */
async function generateSpeech(settings: EdgeTTSSettings, params: EdgeTTSParams): Promise<Buffer> {
  const voice = resolveVoice(params.voice, settings.voice);
  const lang = params.lang ?? settings.lang;
  const outputFormat = params.outputFormat ?? settings.outputFormat;
  const rate = params.rate ?? speedToRate(params.speed) ?? settings.rate;
  const pitch = params.pitch ?? settings.pitch;
  const volume = params.volume ?? settings.volume;

  logger.debug(`[EdgeTTS] Generating speech with voice: ${voice}, lang: ${lang}`);

  const tts = new EdgeTTS({
    voice,
    lang,
    outputFormat,
    saveSubtitles: false,
    proxy: settings.proxy,
    rate,
    pitch,
    volume,
    timeout: settings.timeoutMs,
  });

  // Create temp directory for output
  const tempDir = mkdtempSync(path.join(tmpdir(), "edge-tts-"));
  const extension = inferExtension(outputFormat);
  const outputPath = path.join(tempDir, `speech${extension}`);

  try {
    await tts.ttsPromise(params.text, outputPath);
    const audioBuffer = readFileSync(outputPath);
    return audioBuffer;
  } finally {
    // Cleanup temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Edge TTS Plugin for ElizaOS
 *
 * Provides free text-to-speech synthesis using Microsoft Edge's TTS service.
 * No API key required - uses the same TTS engine as Microsoft Edge browser.
 *
 * Features:
 * - High-quality neural voices
 * - Multiple languages and locales
 * - Adjustable rate, pitch, and volume
 * - No API key or payment required
 *
 * Optional environment variables:
 * - EDGE_TTS_VOICE: Voice ID (default: en-US-MichelleNeural)
 * - EDGE_TTS_LANG: Language code (default: en-US)
 * - EDGE_TTS_OUTPUT_FORMAT: Output format (default: audio-24khz-48kbitrate-mono-mp3)
 * - EDGE_TTS_RATE: Speech rate adjustment (e.g., +10%, -5%)
 * - EDGE_TTS_PITCH: Pitch adjustment (e.g., +5Hz, -10Hz)
 * - EDGE_TTS_VOLUME: Volume adjustment (e.g., +20%, -10%)
 * - EDGE_TTS_PROXY: HTTP proxy URL
 * - EDGE_TTS_TIMEOUT_MS: Request timeout (default: 30000)
 *
 * Popular voices:
 * - en-US-MichelleNeural (female, US English)
 * - en-US-GuyNeural (male, US English)
 * - en-US-JennyNeural (female, US English)
 * - en-US-AriaNeural (female, US English)
 * - en-GB-SoniaNeural (female, UK English)
 * - en-GB-RyanNeural (male, UK English)
 * - de-DE-KatjaNeural (female, German)
 * - fr-FR-DeniseNeural (female, French)
 * - es-ES-ElviraNeural (female, Spanish)
 * - ja-JP-NanamiNeural (female, Japanese)
 * - zh-CN-XiaoxiaoNeural (female, Chinese)
 */
export const edgeTTSPlugin: Plugin = {
  name: "edge-tts",
  description:
    "Free text-to-speech synthesis using Microsoft Edge TTS - no API key required, high-quality neural voices",
  // Self-declared auto-enable: activate when features.tts is enabled OR when
  // running in an Eliza Cloud-provisioned container (cloud voice output).
  autoEnable: {
    shouldEnable: (env, config) => {
      if (env.ELIZA_CLOUD_PROVISIONED === "1") return true;
      const f = (config?.features as Record<string, unknown> | undefined)?.tts;
      return (
        f === true ||
        (typeof f === "object" &&
          f !== null &&
          (f as { enabled?: unknown }).enabled !== false)
      );
    },
  },
  models: {
    [ModelType.TEXT_TO_SPEECH]: async (
      runtime: IAgentRuntime,
      input: string | EdgeTTSParams
    ): Promise<Buffer | ArrayBuffer | Uint8Array> => {
      const params: EdgeTTSParams = typeof input === "string" ? { text: input } : input;
      const settings = getEdgeTTSSettings(runtime);

      logger.log(`[EdgeTTS] Using TEXT_TO_SPEECH with voice: ${settings.voice}`);

      if (params.text.trim().length === 0) {
        throw new Error("TEXT_TO_SPEECH requires non-empty text");
      }

      // Edge TTS has a practical limit around 5000 characters
      if (params.text.length > 5000) {
        throw new Error("TEXT_TO_SPEECH text exceeds 5000 character limit");
      }

      try {
        const audioBuffer = await generateSpeech(settings, params);
        return audioBuffer;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`EdgeTTS model error: ${msg}`);
        throw error instanceof Error ? error : new Error(msg);
      }
    },
  },
  tests: [
    {
      name: "test edge tts",
      tests: [
        {
          name: "Edge TTS settings validation",
          fn: async (runtime: IAgentRuntime) => {
            const settings = getEdgeTTSSettings(runtime);

            if (!settings.voice) {
              throw new Error("Missing voice configuration");
            }

            if (!settings.lang) {
              throw new Error("Missing language configuration");
            }

            if (!settings.outputFormat) {
              throw new Error("Missing output format configuration");
            }

            logger.success("Edge TTS settings validated successfully");
          },
        },
        {
          name: "Edge TTS voice preset mapping",
          fn: async (_runtime: IAgentRuntime) => {
            // Test that OpenAI-style voice names map correctly
            const testCases = [
              { input: "alloy", expected: "en-US-GuyNeural" },
              { input: "nova", expected: "en-US-JennyNeural" },
              { input: "shimmer", expected: "en-US-AriaNeural" },
              {
                input: "en-US-MichelleNeural",
                expected: "en-US-MichelleNeural",
              },
            ];

            for (const tc of testCases) {
              const result = resolveVoice(tc.input, DEFAULT_VOICE);
              if (result !== tc.expected) {
                throw new Error(
                  `Voice preset mapping failed: ${tc.input} -> ${result}, expected ${tc.expected}`
                );
              }
            }

            logger.success("Voice preset mapping validated successfully");
          },
        },
        {
          name: "Edge TTS speed to rate conversion",
          fn: async (_runtime: IAgentRuntime) => {
            const testCases = [
              { speed: 1.0, expected: undefined },
              { speed: 1.5, expected: "+50%" },
              { speed: 0.75, expected: "-25%" },
              { speed: 2.0, expected: "+100%" },
            ];

            for (const tc of testCases) {
              const result = speedToRate(tc.speed);
              if (result !== tc.expected) {
                throw new Error(
                  `Speed conversion failed: ${tc.speed} -> ${result}, expected ${tc.expected}`
                );
              }
            }

            logger.success("Speed to rate conversion validated successfully");
          },
        },
        {
          name: "Edge TTS generation (live test)",
          fn: async (runtime: IAgentRuntime) => {
            const testText = "Hello, this is a test of Edge TTS.";

            try {
              const audioBuffer = (await runtime.useModel(ModelType.TEXT_TO_SPEECH, testText)) as
                | Buffer
                | Uint8Array;

              if (!audioBuffer || audioBuffer.length === 0) {
                throw new Error("Received empty audio buffer");
              }

              logger.success(`Edge TTS generation successful: ${audioBuffer.length} bytes`);
            } catch (error: unknown) {
              const msg = error instanceof Error ? error.message : String(error);
              // Edge TTS might fail in CI environments without network
              if (msg.includes("ENOTFOUND") || msg.includes("network")) {
                logger.warn(`Edge TTS live test skipped (network unavailable): ${msg}`);
                return;
              }
              throw error;
            }
          },
        },
      ],
    },
  ],
};

export default edgeTTSPlugin;

// Re-export types
export type { EdgeTTSParams, EdgeTTSSettings };

// Export helper functions for testing
export const _test = {
  resolveVoice,
  speedToRate,
  inferExtension,
  getEdgeTTSSettings,
};
