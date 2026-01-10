/**
 * Configuration utilities for OpenAI plugin
 *
 * Provides type-safe access to runtime settings with proper defaults.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

// ============================================================================
// Setting Retrieval
// ============================================================================

/**
 * Retrieves a configuration setting from the runtime.
 *
 * Resolution order:
 * 1. Runtime settings (runtime.getSetting)
 * 2. Environment variables (process.env)
 * 3. Default value
 *
 * @param runtime - The agent runtime
 * @param key - The setting key
 * @param defaultValue - Optional default value
 * @returns The resolved setting value
 */
export function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue?: string
): string | undefined {
  const value = runtime.getSetting(key);
  if (value !== undefined && value !== null) {
    return String(value);
  }
  return process.env[key] ?? defaultValue;
}

/**
 * Retrieves a required configuration setting.
 *
 * @param runtime - The agent runtime
 * @param key - The setting key
 * @param errorMessage - Error message if setting is missing
 * @returns The setting value (guaranteed non-undefined)
 * @throws Error if the setting is not configured
 */
export function getRequiredSetting(
  runtime: IAgentRuntime,
  key: string,
  errorMessage?: string
): string {
  const value = getSetting(runtime, key);
  if (value === undefined || value.trim() === "") {
    throw new Error(
      errorMessage ?? `Required setting '${key}' is not configured`
    );
  }
  return value;
}

/**
 * Retrieves a numeric setting with validation.
 *
 * @param runtime - The agent runtime
 * @param key - The setting key
 * @param defaultValue - Default value if not set
 * @returns The parsed integer value
 * @throws Error if the value is not a valid integer
 */
export function getNumericSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue: number
): number {
  const value = getSetting(runtime, key);
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Setting '${key}' must be a valid integer, got: ${value}`);
  }
  return parsed;
}

/**
 * Retrieves a boolean setting.
 *
 * @param runtime - The agent runtime
 * @param key - The setting key
 * @param defaultValue - Default value if not set
 * @returns The boolean value
 */
export function getBooleanSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue: boolean
): boolean {
  const value = getSetting(runtime, key);
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

// ============================================================================
// Environment Detection
// ============================================================================

/**
 * Checks if code is running in a browser environment.
 */
export function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  );
}

/**
 * Checks if running in browser proxy mode.
 *
 * In proxy mode, we don't require an API key on the client.
 * The server proxy handles authentication.
 */
export function isProxyMode(runtime: IAgentRuntime): boolean {
  return isBrowser() && !!getSetting(runtime, "OPENAI_BROWSER_BASE_URL");
}

// ============================================================================
// API Configuration
// ============================================================================

/**
 * Gets the OpenAI API key.
 *
 * @param runtime - The agent runtime
 * @returns The API key or undefined if not configured
 */
export function getApiKey(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, "OPENAI_API_KEY");
}

/**
 * Gets the API key for embeddings (falls back to main API key).
 *
 * @param runtime - The agent runtime
 * @returns The embedding API key
 */
export function getEmbeddingApiKey(runtime: IAgentRuntime): string | undefined {
  const embeddingApiKey = getSetting(runtime, "OPENAI_EMBEDDING_API_KEY");
  if (embeddingApiKey) {
    logger.debug("[OpenAI] Using specific embedding API key");
    return embeddingApiKey;
  }
  logger.debug("[OpenAI] Falling back to general API key for embeddings");
  return getApiKey(runtime);
}

/**
 * Gets the authorization header for API requests.
 *
 * @param runtime - The agent runtime
 * @param forEmbedding - Whether this is for an embedding request
 * @returns Headers object with Authorization if applicable
 */
export function getAuthHeader(
  runtime: IAgentRuntime,
  forEmbedding = false
): Record<string, string> {
  if (isBrowser()) {
    return {};
  }
  const key = forEmbedding ? getEmbeddingApiKey(runtime) : getApiKey(runtime);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * Gets the base URL for OpenAI API requests.
 *
 * @param runtime - The agent runtime
 * @returns The resolved base URL
 */
export function getBaseURL(runtime: IAgentRuntime): string {
  const browserURL = getSetting(runtime, "OPENAI_BROWSER_BASE_URL");
  const baseURL =
    isBrowser() && browserURL
      ? browserURL
      : getSetting(runtime, "OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
  logger.debug(`[OpenAI] Base URL: ${baseURL}`);
  return baseURL;
}

/**
 * Gets the base URL for embedding requests.
 *
 * @param runtime - The agent runtime
 * @returns The resolved embedding base URL
 */
export function getEmbeddingBaseURL(runtime: IAgentRuntime): string {
  const embeddingURL = isBrowser()
    ? getSetting(runtime, "OPENAI_BROWSER_EMBEDDING_URL") ??
      getSetting(runtime, "OPENAI_BROWSER_BASE_URL")
    : getSetting(runtime, "OPENAI_EMBEDDING_URL");

  if (embeddingURL) {
    logger.debug(`[OpenAI] Using embedding base URL: ${embeddingURL}`);
    return embeddingURL;
  }

  logger.debug("[OpenAI] Falling back to general base URL for embeddings");
  return getBaseURL(runtime);
}

// ============================================================================
// Model Configuration
// ============================================================================

/**
 * Gets the small model identifier.
 *
 * @param runtime - The agent runtime
 * @returns The small model name
 */
export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENAI_SMALL_MODEL") ??
    getSetting(runtime, "SMALL_MODEL") ??
    "gpt-5-mini"
  );
}

/**
 * Gets the large model identifier.
 *
 * @param runtime - The agent runtime
 * @returns The large model name
 */
export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENAI_LARGE_MODEL") ??
    getSetting(runtime, "LARGE_MODEL") ??
    "gpt-5"
  );
}

/**
 * Gets the embedding model identifier.
 *
 * @param runtime - The agent runtime
 * @returns The embedding model name
 */
export function getEmbeddingModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_EMBEDDING_MODEL") ?? "text-embedding-3-small";
}

/**
 * Gets the image description model identifier.
 *
 * @param runtime - The agent runtime
 * @returns The image description model name
 */
export function getImageDescriptionModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_IMAGE_DESCRIPTION_MODEL") ?? "gpt-5-mini";
}

/**
 * Gets the transcription model identifier.
 *
 * @param runtime - The agent runtime
 * @returns The transcription model name
 */
export function getTranscriptionModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENAI_TRANSCRIPTION_MODEL") ?? "gpt-5-mini-transcribe"
  );
}

/**
 * Gets the TTS model identifier.
 *
 * @param runtime - The agent runtime
 * @returns The TTS model name
 */
export function getTTSModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_TTS_MODEL") ?? "gpt-5-mini-tts";
}

/**
 * Gets the TTS voice.
 *
 * @param runtime - The agent runtime
 * @returns The TTS voice name
 */
export function getTTSVoice(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_TTS_VOICE") ?? "nova";
}

/**
 * Gets the TTS instructions.
 *
 * @param runtime - The agent runtime
 * @returns The TTS instructions or empty string
 */
export function getTTSInstructions(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_TTS_INSTRUCTIONS") ?? "";
}

/**
 * Gets the image generation model identifier.
 *
 * @param runtime - The agent runtime
 * @returns The image model name
 */
export function getImageModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_IMAGE_MODEL") ?? "dall-e-3";
}

/**
 * Checks if experimental telemetry is enabled.
 *
 * @param runtime - The agent runtime
 * @returns Whether telemetry is enabled
 */
export function getExperimentalTelemetry(runtime: IAgentRuntime): boolean {
  return getBooleanSetting(runtime, "OPENAI_EXPERIMENTAL_TELEMETRY", false);
}

/**
 * Gets the embedding dimensions.
 *
 * @param runtime - The agent runtime
 * @returns The embedding dimension count
 */
export function getEmbeddingDimensions(runtime: IAgentRuntime): number {
  return getNumericSetting(runtime, "OPENAI_EMBEDDING_DIMENSIONS", 1536);
}

/**
 * Gets the max tokens for image description.
 *
 * @param runtime - The agent runtime
 * @returns The max tokens value
 */
export function getImageDescriptionMaxTokens(runtime: IAgentRuntime): number {
  return getNumericSetting(runtime, "OPENAI_IMAGE_DESCRIPTION_MAX_TOKENS", 8192);
}
