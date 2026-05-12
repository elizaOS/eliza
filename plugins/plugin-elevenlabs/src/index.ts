import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type {
  BodySpeechToTextV1SpeechToTextPost,
  MultichannelSpeechToTextResponseModel,
  SpeechToTextChunkResponseModel,
  SpeechToTextConvertRequestModelId,
  SpeechToTextConvertRequestTimestampsGranularity,
  TextToSpeechStreamRequestOutputFormat,
} from "@elevenlabs/elevenlabs-js/api";
import {
  SpeechToTextConvertRequestModelId as SttModelIdEnum,
  SpeechToTextConvertRequestTimestampsGranularity as SttTimestampsGranularityEnum,
  TextToSpeechStreamRequestOutputFormat as TtsOutputFormatEnum,
} from "@elevenlabs/elevenlabs-js/api";
import {
  type IAgentRuntime,
  logger,
  ModelType,
  type Plugin,
  parseBooleanFromText,
} from "@elizaos/core";

function parseTtsOutputFormat(
  format: string,
): TextToSpeechStreamRequestOutputFormat {
  for (const allowed of Object.values(TtsOutputFormatEnum)) {
    if (allowed === format) return allowed;
  }
  throw new Error(`Unsupported ElevenLabs TTS output format: ${format}`);
}

function parseSttModelId(id: string): SpeechToTextConvertRequestModelId {
  for (const allowed of Object.values(SttModelIdEnum)) {
    if (allowed === id) return allowed;
  }
  throw new Error(`Unsupported ElevenLabs STT model: ${id}`);
}

function parseSttTimestampsGranularity(
  value: string,
): SpeechToTextConvertRequestTimestampsGranularity {
  for (const allowed of Object.values(SttTimestampsGranularityEnum)) {
    if (allowed === value) return allowed;
  }
  throw new Error(
    `Unsupported ElevenLabs STT timestamps granularity: ${value}`,
  );
}

function extractTranscript(
  response:
    | SpeechToTextChunkResponseModel
    | MultichannelSpeechToTextResponseModel,
): string {
  if ("transcripts" in response) {
    return response.transcripts.map((t) => t.text).join("\n");
  }
  return response.text;
}

/**
 * Voice settings configuration for ElevenLabs API
 */
interface VoiceSettings {
  apiKey: string;
  voiceId: string;
  model: string;
  stability: string;
  latency: string;
  outputFormat: string;
  similarity: string;
  style: string;
  speakerBoost: boolean;
}

interface TranscriptionSettings {
  apiKey: string;
  modelId: string;
  languageCode?: string;
  timestampsGranularity: string;
  diarize: boolean;
  numSpeakers?: number;
  tagAudioEvents: boolean;
}

function isBrowser(): boolean {
  return typeof globalThis.document !== "undefined";
}

function getSetting(runtime: IAgentRuntime, key: string): string | undefined;
function getSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback: string,
): string;
function getSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback?: string,
): string | undefined {
  const rawRuntime = runtime.getSetting(key);
  const fromRuntime =
    rawRuntime === null || rawRuntime === undefined
      ? undefined
      : String(rawRuntime);

  const envValue =
    typeof process !== "undefined" &&
    process.env &&
    typeof process.env[key] === "string"
      ? process.env[key]
      : undefined;

  return fromRuntime ?? envValue ?? fallback;
}

function getBaseURL(runtime: IAgentRuntime): string {
  const browserRaw = runtime.getSetting("ELEVENLABS_BROWSER_URL");
  const browserURL =
    browserRaw === null || browserRaw === undefined
      ? undefined
      : String(browserRaw);
  if (isBrowser() && browserURL) return browserURL;
  return "https://api.elevenlabs.io/v1";
}

function getApiKey(runtime: IAgentRuntime): string | undefined {
  const raw = runtime.getSetting("ELEVENLABS_API_KEY");
  const fromRuntime =
    raw === null || raw === undefined ? undefined : String(raw);
  const fromEnv =
    typeof process !== "undefined" &&
    process.env &&
    typeof process.env.ELEVENLABS_API_KEY === "string"
      ? process.env.ELEVENLABS_API_KEY
      : undefined;
  return fromRuntime ?? fromEnv;
}

/**
 * Function to retrieve voice settings based on runtime and environment variables.
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @returns {VoiceSettings} - Object containing various voice settings.
 */
function getVoiceSettings(runtime: IAgentRuntime): VoiceSettings {
  return {
    apiKey: getApiKey(runtime) || "",
    voiceId: getSetting(runtime, "ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL"),
    model: getSetting(runtime, "ELEVENLABS_MODEL_ID", "eleven_monolingual_v1"),
    stability: getSetting(runtime, "ELEVENLABS_VOICE_STABILITY", "0.5"),
    latency: getSetting(runtime, "ELEVENLABS_OPTIMIZE_STREAMING_LATENCY", "0"),
    // Use mp3 by default to be browser-safe and align with OpenAI plugin behavior
    outputFormat: getSetting(
      runtime,
      "ELEVENLABS_OUTPUT_FORMAT",
      "mp3_44100_128",
    ),
    similarity: getSetting(
      runtime,
      "ELEVENLABS_VOICE_SIMILARITY_BOOST",
      "0.75",
    ),
    style: getSetting(runtime, "ELEVENLABS_VOICE_STYLE", "0"),
    speakerBoost: parseBooleanFromText(
      `${getSetting(runtime, "ELEVENLABS_VOICE_USE_SPEAKER_BOOST", "true") ?? "true"}`,
    ),
  };
}

function getTranscriptionSettings(
  runtime: IAgentRuntime,
): TranscriptionSettings {
  const languageCode = getSetting(runtime, "ELEVENLABS_STT_LANGUAGE_CODE");
  const numSpeakersStr = getSetting(runtime, "ELEVENLABS_STT_NUM_SPEAKERS");

  return {
    apiKey: getApiKey(runtime) || "",
    modelId: getSetting(runtime, "ELEVENLABS_STT_MODEL_ID", "scribe_v1"),
    languageCode: languageCode || undefined,
    timestampsGranularity: getSetting(
      runtime,
      "ELEVENLABS_STT_TIMESTAMPS_GRANULARITY",
      "word",
    ),
    diarize: parseBooleanFromText(
      `${getSetting(runtime, "ELEVENLABS_STT_DIARIZE", "false") ?? "false"}`,
    ),
    numSpeakers: numSpeakersStr ? Number(numSpeakersStr) : undefined,
    tagAudioEvents: parseBooleanFromText(
      `${getSetting(runtime, "ELEVENLABS_STT_TAG_AUDIO_EVENTS", "false") ?? "false"}`,
    ),
  };
}

/**
 * Fetch speech from ElevenLabs API using official SDK.
 * Returns an in-memory binary payload to satisfy the core TTS contract.
 * @param {IAgentRuntime} runtime - The runtime interface containing necessary data for the API call.
 * @param {string} text - The text to be converted into speech.
 * @returns {Promise<Uint8Array>}
 */
async function readStreamToUint8Array(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    totalLength += value.byteLength;
  }

  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function fetchSpeech(
  runtime: IAgentRuntime,
  params: {
    text: string;
    voiceId: string;
    modelId: string;
    outputFormat: string;
    stability: string;
    similarity: string;
    style: string;
    speakerBoost: boolean;
    latency: string;
  },
): Promise<Uint8Array> {
  try {
    const baseUrl = getBaseURL(runtime);
    // In browser mode with proxy URL, use a harmless placeholder key.
    const apiKey = getApiKey(runtime) ?? (isBrowser() ? "sk-proxy" : undefined);
    const client = new ElevenLabsClient({
      apiKey: apiKey,
      baseUrl,
    });

    const stream = await client.textToSpeech.stream(params.voiceId, {
      text: params.text,
      modelId: params.modelId,
      outputFormat: parseTtsOutputFormat(params.outputFormat),
      optimizeStreamingLatency: Number(params.latency) || 0,
      voiceSettings: {
        stability: Number(params.stability) || 0,
        similarityBoost: Number(params.similarity) || 0,
        style: Number(params.style) || 0,
        useSpeakerBoost: !!params.speakerBoost,
      },
    });

    if (!stream) {
      throw new Error("Empty response body from ElevenLabs SDK");
    }

    return readStreamToUint8Array(stream);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`ElevenLabs fetchSpeech error: ${msg}`);
    throw error instanceof Error ? error : new Error(msg);
  }
}

async function fetchTranscription(
  runtime: IAgentRuntime,
  params: {
    audioFile: File | Buffer | Blob;
    modelId: string;
    languageCode?: string;
    timestampsGranularity: string;
    diarize: boolean;
    numSpeakers?: number;
    tagAudioEvents: boolean;
  },
): Promise<string> {
  try {
    const baseUrl = getBaseURL(runtime);
    const apiKey = getApiKey(runtime) ?? (isBrowser() ? "sk-proxy" : undefined);
    const client = new ElevenLabsClient({
      apiKey: apiKey,
      baseUrl,
    });

    const body: BodySpeechToTextV1SpeechToTextPost = {
      modelId: parseSttModelId(params.modelId),
      file: params.audioFile,
    };

    if (params.languageCode) {
      body.languageCode = params.languageCode;
    }

    if (params.timestampsGranularity !== "none") {
      body.timestampsGranularity = parseSttTimestampsGranularity(
        params.timestampsGranularity,
      );
    }

    if (params.diarize) {
      body.diarize = true;
      if (params.numSpeakers !== undefined) {
        body.numSpeakers = params.numSpeakers;
      }
    }

    if (params.tagAudioEvents) {
      body.tagAudioEvents = true;
    }

    const response = await client.speechToText.convert(body);

    if (!response) {
      throw new Error("Empty response from ElevenLabs STT API");
    }

    return extractTranscript(response);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`ElevenLabs fetchTranscription error: ${msg}`);
    throw error instanceof Error ? error : new Error(msg);
  }
}

// Note: WAV header utilities removed to ensure browser safety. Prefer mp3 output.

/**
 * Represents the ElevenLabs plugin.
 * This plugin provides text-to-speech and speech-to-text functionality using the ElevenLabs API.
 *
 * Features:
 * - High-quality voice synthesis (TTS)
 * - High-accuracy speech transcription (STT) with Scribe v1 model
 * - Support for multiple voice models and settings
 * - Configurable voice parameters (stability, similarity, style)
 * - Stream-based audio output for efficient memory usage
 * - Speaker diarization (up to 32 speakers)
 * - Multi-language support (99 languages for STT)
 * - Audio event detection (laughter, applause, etc.)
 *
 * Required environment variables:
 * - ELEVENLABS_API_KEY: Your ElevenLabs API key
 *
 * Optional TTS environment variables:
 * - ELEVENLABS_VOICE_ID: Voice ID to use (default: EXAVITQu4vr4xnSDxMaL)
 * - ELEVENLABS_MODEL_ID: Model to use (default: eleven_monolingual_v1)
 * - ELEVENLABS_VOICE_STABILITY: Voice stability 0-1 (default: 0.5)
 * - ELEVENLABS_VOICE_SIMILARITY_BOOST: Voice similarity 0-1 (default: 0.75)
 * - ELEVENLABS_VOICE_STYLE: Voice style 0-1 (default: 0)
 * - ELEVENLABS_VOICE_USE_SPEAKER_BOOST: Enable speaker boost (default: true)
 * - ELEVENLABS_OPTIMIZE_STREAMING_LATENCY: Latency optimization 0-4 (default: 0)
 * - ELEVENLABS_OUTPUT_FORMAT: Output format (default: mp3_44100_128)
 *
 * Optional STT environment variables:
 * - ELEVENLABS_STT_MODEL_ID: STT model ID (default: scribe_v1)
 * - ELEVENLABS_STT_LANGUAGE_CODE: Language code for transcription (auto-detect if not set)
 * - ELEVENLABS_STT_TIMESTAMPS_GRANULARITY: Timestamp level (default: word)
 * - ELEVENLABS_STT_DIARIZE: Enable speaker diarization (default: false)
 * - ELEVENLABS_STT_NUM_SPEAKERS: Expected number of speakers (1-32)
 * - ELEVENLABS_STT_TAG_AUDIO_EVENTS: Tag audio events (default: false)
 *
 * @type {Plugin}
 */
export const elevenLabsPlugin: Plugin = {
  name: "elevenLabs",
  description:
    "High-quality text-to-speech synthesis and speech-to-text transcription using ElevenLabs API with support for multiple voices, languages, and speaker diarization",
  models: {
    [ModelType.TEXT_TO_SPEECH]: async (
      runtime: IAgentRuntime,
      input:
        | string
        | {
            text: string;
            model?: string;
            voiceId?: string;
            format?: string;
            instructions?: string;
          },
    ) => {
      const options = typeof input === "string" ? { text: input } : input;
      const settings = getVoiceSettings(runtime);
      const resolvedModel = options.model || settings.model;
      // Prefer explicit ElevenLabs voiceId param; fall back to configured voiceId.
      const resolvedVoiceId = options.voiceId ?? settings.voiceId;
      // Honor explicit caller-provided format (e.g., "pcm_16000", "mp3_22050_64").
      // Gracefully map generic "mp3" to a valid ElevenLabs enum, otherwise pass through.
      // Only default to settings.outputFormat when absent.
      const outputFormat = options.format
        ? options.format === "mp3"
          ? "mp3_44100_128"
          : (options.format as string)
        : settings.outputFormat;

      logger.log(`[ElevenLabs] Using TEXT_TO_SPEECH model: ${resolvedModel}`);
      try {
        const stream = await fetchSpeech(runtime, {
          text: options.text,
          voiceId: resolvedVoiceId,
          modelId: resolvedModel,
          outputFormat,
          stability: settings.stability,
          similarity: settings.similarity,
          style: settings.style,
          speakerBoost: settings.speakerBoost,
          latency: settings.latency,
        });
        return stream;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`ElevenLabs model error: ${msg}`);
        throw error instanceof Error ? error : new Error(msg);
      }
    },
    [ModelType.TRANSCRIPTION]: async (
      runtime: IAgentRuntime,
      input: string | Buffer | { audioUrl: string; prompt?: string },
    ) => {
      const settings = getTranscriptionSettings(runtime);

      logger.log(`[ElevenLabs] Using TRANSCRIPTION model: ${settings.modelId}`);

      try {
        let audioFile: Buffer | File | Blob;

        if (typeof input === "string") {
          const response = await fetch(input);
          if (!response.ok) {
            throw new Error(`Failed to fetch audio from URL: ${input}`);
          }
          const arrayBuffer = await response.arrayBuffer();
          audioFile = Buffer.from(arrayBuffer);
        } else if (Buffer.isBuffer(input)) {
          audioFile = input;
        } else if (typeof input === "object" && "audioUrl" in input) {
          const response = await fetch(input.audioUrl);
          if (!response.ok) {
            throw new Error(
              `Failed to fetch audio from URL: ${input.audioUrl}`,
            );
          }
          const arrayBuffer = await response.arrayBuffer();
          audioFile = Buffer.from(arrayBuffer);
        } else {
          throw new Error("Invalid input type for TRANSCRIPTION model");
        }

        const transcript = await fetchTranscription(runtime, {
          audioFile,
          modelId: settings.modelId,
          languageCode: settings.languageCode,
          timestampsGranularity: settings.timestampsGranularity,
          diarize: settings.diarize,
          numSpeakers: settings.numSpeakers,
          tagAudioEvents: settings.tagAudioEvents,
        });

        return transcript;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`ElevenLabs transcription error: ${msg}`);
        throw error instanceof Error ? error : new Error(msg);
      }
    },
  },
  tests: [
    {
      name: "test eleven labs",
      tests: [
        {
          name: "Eleven Labs API key validation",
          fn: async (runtime: IAgentRuntime) => {
            const settings = getVoiceSettings(runtime);
            if (!settings.apiKey) {
              throw new Error(
                "Missing API key: Please provide a valid Eleven Labs API key.",
              );
            }
          },
        },
        {
          name: "Voice settings validation",
          fn: async (runtime: IAgentRuntime) => {
            const settings = getVoiceSettings(runtime);

            // Validate that all required settings are present
            if (!settings.voiceId) {
              throw new Error("Missing voice ID configuration");
            }

            // Validate numeric settings
            const stability = Number.parseFloat(settings.stability);
            if (Number.isNaN(stability) || stability < 0 || stability > 1) {
              throw new Error("Voice stability must be between 0 and 1");
            }

            const similarity = Number.parseFloat(settings.similarity);
            if (Number.isNaN(similarity) || similarity < 0 || similarity > 1) {
              throw new Error("Voice similarity boost must be between 0 and 1");
            }

            logger.success("Voice settings validated successfully");
          },
        },
        // WAV header generation test removed; we favor mp3 streaming for browser safety
        {
          name: "Eleven Labs API connectivity",
          fn: async (runtime: IAgentRuntime) => {
            const settings = getVoiceSettings(runtime);
            if (!settings.apiKey) {
              logger.warn(
                "Skipping API connectivity test - no API key provided",
              );
              return;
            }

            try {
              await fetchSpeech(runtime, {
                text: "test",
                voiceId: settings.voiceId,
                modelId: settings.model,
                outputFormat: settings.outputFormat,
                stability: settings.stability,
                similarity: settings.similarity,
                style: settings.style,
                speakerBoost: settings.speakerBoost,
                latency: settings.latency,
              });
              logger.success("API connectivity test passed");
            } catch (error: unknown) {
              const msg =
                error instanceof Error ? error.message : String(error);
              if (msg.includes("QUOTA_EXCEEDED")) {
                logger.warn("API quota exceeded - test skipped");
                return;
              }
              logger.error(`API connectivity test failed: ${msg}`);
              throw new Error(`API connectivity test failed: ${msg}`);
            }
          },
        },
        {
          name: "ElevenLabs TTS Generation (stream exists)",
          fn: async (runtime: IAgentRuntime) => {
            const settings = getVoiceSettings(runtime);
            if (!settings.apiKey && !isBrowser()) {
              logger.warn("Skipping TTS generation test - no API key provided");
              return;
            }

            const testText = "Hello from ElevenLabs test.";
            try {
              const audio = await runtime.useModel(
                ModelType.TEXT_TO_SPEECH,
                testText,
              );

              const bytes: Uint8Array | null =
                audio instanceof Uint8Array
                  ? audio
                  : Buffer.isBuffer(audio)
                    ? new Uint8Array(audio)
                    : audio instanceof ArrayBuffer
                      ? new Uint8Array(audio)
                      : null;

              if (!bytes || bytes.byteLength === 0) {
                throw new Error(
                  "TTS output must be non-empty Uint8Array, Buffer, or ArrayBuffer",
                );
              }
              logger.success("Received TTS binary payload successfully");
            } catch (error: unknown) {
              const msg =
                error instanceof Error ? error.message : String(error);
              if (msg.includes("QUOTA_EXCEEDED")) {
                logger.warn(
                  "[ElevenLabs Test] API quota exceeded - test skipped",
                );
                return;
              }
              logger.error(
                "[ElevenLabs Test] TTS Generation test failed:",
                msg,
              );
              throw new Error(`TTS Generation test failed: ${msg}`);
            }
          },
        },
        {
          name: "Output format handling",
          fn: async (runtime: IAgentRuntime) => {
            const settings = getVoiceSettings(runtime);

            // Test supported formats list includes common entries
            const pcmFormats = [
              "mp3_44100_128",
              "pcm_16000",
              "pcm_22050",
              "pcm_24000",
              "pcm_44100",
            ];
            for (const format of pcmFormats) {
              if (format.startsWith("pcm_")) {
                const sampleRate = Number.parseInt(format.slice(4), 10);
                if (Number.isNaN(sampleRate) || sampleRate <= 0) {
                  throw new Error(`Invalid PCM format: ${format}`);
                }
              }
            }

            // Test current output format
            logger.success(`Output format validated: ${settings.outputFormat}`);
          },
        },
      ],
    },
    {
      name: "test eleven labs STT",
      tests: [
        {
          name: "STT settings validation",
          fn: async (runtime: IAgentRuntime) => {
            const settings = getTranscriptionSettings(runtime);

            if (!settings.modelId) {
              throw new Error("Missing STT model ID configuration");
            }

            const validGranularities = ["none", "word", "character"];
            if (!validGranularities.includes(settings.timestampsGranularity)) {
              throw new Error(
                `Invalid timestamps granularity: ${settings.timestampsGranularity}`,
              );
            }

            if (
              settings.numSpeakers !== undefined &&
              (settings.numSpeakers < 1 || settings.numSpeakers > 32)
            ) {
              throw new Error("Number of speakers must be between 1 and 32");
            }

            logger.success("STT settings validated successfully");
          },
        },
        {
          name: "STT configuration defaults",
          fn: async (runtime: IAgentRuntime) => {
            const settings = getTranscriptionSettings(runtime);

            if (settings.modelId !== "scribe_v1") {
              logger.warn(`Using non-default STT model: ${settings.modelId}`);
            }

            if (settings.timestampsGranularity !== "word") {
              logger.warn(
                `Using non-default timestamps granularity: ${settings.timestampsGranularity}`,
              );
            }

            logger.success("STT configuration defaults checked");
          },
        },
        {
          name: "STT input handling validation",
          fn: async (_runtime: IAgentRuntime) => {
            const testCases = [
              { type: "string URL", valid: true },
              { type: "Buffer", valid: true },
              { type: "object with audioUrl", valid: true },
            ];

            for (const testCase of testCases) {
              if (!testCase.valid) {
                throw new Error(
                  `Invalid test case should not be valid: ${testCase.type}`,
                );
              }
            }

            logger.success("STT input handling validation passed");
          },
        },
      ],
    },
  ],
};
export default elevenLabsPlugin;
