import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

function getEnvValue(key: string): string | undefined {
  if (typeof process === "undefined" || !process.env) {
    return undefined;
  }
  const value = process.env[key];
  return value === undefined ? undefined : String(value);
}

export function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue?: string
): string | undefined {
  const value = runtime.getSetting(key);
  if (value !== undefined && value !== null) {
    return String(value);
  }
  return getEnvValue(key) ?? defaultValue;
}
export function getRequiredSetting(
  runtime: IAgentRuntime,
  key: string,
  errorMessage?: string
): string {
  const value = getSetting(runtime, key);
  if (value === undefined || value.trim() === "") {
    throw new Error(errorMessage ?? `Required setting '${key}' is not configured`);
  }
  return value;
}

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

export function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  );
}

export function isProxyMode(runtime: IAgentRuntime): boolean {
  return isBrowser() && !!getSetting(runtime, "OPENAI_BROWSER_BASE_URL");
}

export function getApiKey(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, "OPENAI_API_KEY");
}

export function getEmbeddingApiKey(runtime: IAgentRuntime): string | undefined {
  const embeddingApiKey = getSetting(runtime, "OPENAI_EMBEDDING_API_KEY");
  if (embeddingApiKey) {
    logger.debug("[OpenAI] Using specific embedding API key");
    return embeddingApiKey;
  }
  logger.debug("[OpenAI] Falling back to general API key for embeddings");
  return getApiKey(runtime);
}

export function getAuthHeader(
  runtime: IAgentRuntime,
  forEmbedding = false
): Record<string, string> {
  // By default this plugin does NOT send auth headers in the browser. This is safer because
  // frontend builds would otherwise expose secrets. For local demos, you can explicitly
  // opt-in to sending the Authorization header by setting OPENAI_ALLOW_BROWSER_API_KEY=true.
  if (isBrowser() && !getBooleanSetting(runtime, "OPENAI_ALLOW_BROWSER_API_KEY", false)) {
    return {};
  }
  const key = forEmbedding ? getEmbeddingApiKey(runtime) : getApiKey(runtime);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export function getBaseURL(runtime: IAgentRuntime): string {
  const browserURL = getSetting(runtime, "OPENAI_BROWSER_BASE_URL");
  const baseURL =
    isBrowser() && browserURL
      ? browserURL
      : (getSetting(runtime, "OPENAI_BASE_URL") ?? "https://api.openai.com/v1");
  logger.debug(`[OpenAI] Base URL: ${baseURL}`);
  return baseURL;
}

export function getEmbeddingBaseURL(runtime: IAgentRuntime): string {
  const embeddingURL = isBrowser()
    ? (getSetting(runtime, "OPENAI_BROWSER_EMBEDDING_URL") ??
      getSetting(runtime, "OPENAI_BROWSER_BASE_URL"))
    : getSetting(runtime, "OPENAI_EMBEDDING_URL");

  if (embeddingURL) {
    logger.debug(`[OpenAI] Using embedding base URL: ${embeddingURL}`);
    return embeddingURL;
  }

  logger.debug("[OpenAI] Falling back to general base URL for embeddings");
  return getBaseURL(runtime);
}

export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENAI_SMALL_MODEL") ?? getSetting(runtime, "SMALL_MODEL") ?? "gpt-5-mini"
  );
}

export function getLargeModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_LARGE_MODEL") ?? getSetting(runtime, "LARGE_MODEL") ?? "gpt-5";
}

export function getEmbeddingModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_EMBEDDING_MODEL") ?? "text-embedding-3-small";
}

export function getImageDescriptionModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_IMAGE_DESCRIPTION_MODEL") ?? "gpt-5-mini";
}

export function getTranscriptionModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_TRANSCRIPTION_MODEL") ?? "gpt-5-mini-transcribe";
}

export function getTTSModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_TTS_MODEL") ?? "tts-1";
}

export function getTTSVoice(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_TTS_VOICE") ?? "nova";
}

export function getTTSInstructions(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_TTS_INSTRUCTIONS") ?? "";
}

export function getImageModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_IMAGE_MODEL") ?? "dall-e-3";
}

export function getExperimentalTelemetry(runtime: IAgentRuntime): boolean {
  return getBooleanSetting(runtime, "OPENAI_EXPERIMENTAL_TELEMETRY", false);
}

export function getEmbeddingDimensions(runtime: IAgentRuntime): number {
  return getNumericSetting(runtime, "OPENAI_EMBEDDING_DIMENSIONS", 1536);
}

export function getImageDescriptionMaxTokens(runtime: IAgentRuntime): number {
  return getNumericSetting(runtime, "OPENAI_IMAGE_DESCRIPTION_MAX_TOKENS", 8192);
}

export function getResearchModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "OPENAI_RESEARCH_MODEL") ?? "o3-deep-research";
}

export function getResearchTimeout(runtime: IAgentRuntime): number {
  return getNumericSetting(runtime, "OPENAI_RESEARCH_TIMEOUT", 3600000);
}
