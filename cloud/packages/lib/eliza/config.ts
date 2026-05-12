/**
 * elizaOS Cloud Configuration
 * Determines API URL based on environment
 */

import { FALLBACK_TEXT_SELECTOR_MODELS, OPENROUTER_DEFAULT_TEXT_MODEL } from "@/lib/models";
import { expandOpenRouterModelIdCandidates } from "@/lib/providers/model-id-translation";

/**
 * Get the elizaOS Cloud API base URL based on environment
 * - Local: http://localhost:3000/api/v1
 * - Test: http://localhost:3000/api/v1 (same as local)
 * - Development: https://dev.elizacloud.ai/api/v1
 * - Production: https://www.elizacloud.ai/api/v1
 */
export function getElizaCloudApiUrl(): string {
  // Allow explicit override via environment variable
  if (process.env.ELIZAOS_CLOUD_BASE_URL) {
    return process.env.ELIZAOS_CLOUD_BASE_URL;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const nodeEnv = process.env.NODE_ENV;

  // Local development OR test environment - MUST use localhost
  if (
    appUrl?.includes("localhost") ||
    appUrl?.includes("127.0.0.1") ||
    nodeEnv === "development" ||
    nodeEnv === "test"
  ) {
    return `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/v1`;
  }

  // Development environment
  if (appUrl?.includes("dev.elizacloud.ai")) {
    return "https://dev.elizacloud.ai/api/v1";
  }

  // Production (default)
  return "https://www.elizacloud.ai/api/v1";
}

/**
 * Get default models configuration
 */
export function getDefaultModels() {
  return {
    small: process.env.ELIZAOS_CLOUD_SMALL_MODEL || OPENROUTER_DEFAULT_TEXT_MODEL,
    large: process.env.ELIZAOS_CLOUD_LARGE_MODEL || OPENROUTER_DEFAULT_TEXT_MODEL,
    embedding: process.env.ELIZAOS_CLOUD_EMBEDDING_MODEL || "text-embedding-3-small",
  };
}

/**
 * Allowed models for chat interface (curated list). Entries use **OpenRouter**
 * ids where the provider prefix differs from legacy gateway style (`x-ai/`,
 * `mistralai/`). **Why:** The runtime and catalog speak OpenRouter; legacy ids
 * are still accepted via `isAllowedChatModel`, not by duplicating every row here.
 */
export const ALLOWED_CHAT_MODELS: readonly string[] = [
  ...FALLBACK_TEXT_SELECTOR_MODELS.map((model) => model.modelId),
  "minimax/minimax-m2.7",
  "anthropic/claude-sonnet-4.6",
  "deepseek/deepseek-v3.2-exp",
  "deepseek/deepseek-r1",
];

const ALLOWED_CHAT_MODEL_CANDIDATES = new Set<string>(
  ALLOWED_CHAT_MODELS.flatMap((id) => expandOpenRouterModelIdCandidates(id)),
);

/**
 * Membership check that accepts both gateway-style (`xai/`, `mistral/`) and
 * OpenRouter (`x-ai/`, `mistralai/`) spellings of allowed chat model ids.
 *
 * **Why not `ALLOWED_CHAT_MODELS.includes(modelId)` alone:** Stored characters,
 * imports, and older API clients may still send legacy prefixes; rejecting them
 * would break chat for valid models. Use this helper (or equivalent candidate
 * expansion) at enforcement sites.
 */
export function isAllowedChatModel(modelId: string): boolean {
  return expandOpenRouterModelIdCandidates(modelId).some((candidate) =>
    ALLOWED_CHAT_MODEL_CANDIDATES.has(candidate),
  );
}

/**
 * ElevenLabs Settings Configuration
 * Centralized settings for TTS and STT to avoid duplication across modules
 */
export interface ElevenLabsSettings {
  // TTS Settings
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_VOICE_ID: string;
  ELEVENLABS_MODEL_ID: string;
  ELEVENLABS_VOICE_STABILITY: string;
  ELEVENLABS_VOICE_SIMILARITY_BOOST: string;
  ELEVENLABS_VOICE_STYLE: string;
  ELEVENLABS_VOICE_USE_SPEAKER_BOOST: string;
  ELEVENLABS_OPTIMIZE_STREAMING_LATENCY: string;
  ELEVENLABS_OUTPUT_FORMAT: string;
  ELEVENLABS_LANGUAGE_CODE: string;
  // STT Settings
  ELEVENLABS_STT_MODEL_ID: string;
  ELEVENLABS_STT_LANGUAGE_CODE: string;
  ELEVENLABS_STT_TIMESTAMPS_GRANULARITY: string;
  ELEVENLABS_STT_DIARIZE: string;
  ELEVENLABS_STT_NUM_SPEAKERS?: string;
  ELEVENLABS_STT_TAG_AUDIO_EVENTS: string;
}

/**
 * Build ElevenLabs settings from character settings with env fallbacks
 * @param charSettings - Character-specific settings
 * @returns Complete ElevenLabs configuration
 */
export function buildElevenLabsSettings(
  charSettings: Record<string, unknown> = {},
): ElevenLabsSettings {
  const getSetting = (key: string, fallback: string): string =>
    (charSettings[key] as string) || process.env[key] || fallback;

  const settings: ElevenLabsSettings = {
    // TTS
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || "",
    ELEVENLABS_VOICE_ID: getSetting("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL"),
    ELEVENLABS_MODEL_ID: getSetting("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"),
    ELEVENLABS_VOICE_STABILITY: getSetting("ELEVENLABS_VOICE_STABILITY", "0.5"),
    ELEVENLABS_VOICE_SIMILARITY_BOOST: getSetting("ELEVENLABS_VOICE_SIMILARITY_BOOST", "0.75"),
    ELEVENLABS_VOICE_STYLE: getSetting("ELEVENLABS_VOICE_STYLE", "0"),
    ELEVENLABS_VOICE_USE_SPEAKER_BOOST: getSetting("ELEVENLABS_VOICE_USE_SPEAKER_BOOST", "true"),
    ELEVENLABS_OPTIMIZE_STREAMING_LATENCY: getSetting("ELEVENLABS_OPTIMIZE_STREAMING_LATENCY", "0"),
    ELEVENLABS_OUTPUT_FORMAT: getSetting("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128"),
    ELEVENLABS_LANGUAGE_CODE: getSetting("ELEVENLABS_LANGUAGE_CODE", "en"),
    // STT
    ELEVENLABS_STT_MODEL_ID: getSetting("ELEVENLABS_STT_MODEL_ID", "scribe_v1"),
    ELEVENLABS_STT_LANGUAGE_CODE: getSetting("ELEVENLABS_STT_LANGUAGE_CODE", "en"),
    ELEVENLABS_STT_TIMESTAMPS_GRANULARITY: getSetting(
      "ELEVENLABS_STT_TIMESTAMPS_GRANULARITY",
      "word",
    ),
    ELEVENLABS_STT_DIARIZE: getSetting("ELEVENLABS_STT_DIARIZE", "false"),
    ELEVENLABS_STT_TAG_AUDIO_EVENTS: getSetting("ELEVENLABS_STT_TAG_AUDIO_EVENTS", "false"),
  };

  // Optional: ELEVENLABS_STT_NUM_SPEAKERS
  const numSpeakers =
    charSettings.ELEVENLABS_STT_NUM_SPEAKERS || process.env.ELEVENLABS_STT_NUM_SPEAKERS;
  if (numSpeakers) {
    settings.ELEVENLABS_STT_NUM_SPEAKERS = String(numSpeakers);
  }

  return settings;
}
