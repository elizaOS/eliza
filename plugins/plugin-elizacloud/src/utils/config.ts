import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { DEFAULT_ELIZA_CLOUD_TEXT_MODEL } from "@elizaos/core";

export const DEFAULT_ELIZA_CLOUD_LARGE_MODEL = "deepseek/deepseek-v4-pro";

function getEnvValue(key: string): string | undefined {
  if (typeof process === "undefined") {
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

export function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  );
}

export function isProxyMode(runtime: IAgentRuntime): boolean {
  return isBrowser() && !!getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_BASE_URL");
}

export function getBaseURL(runtime: IAgentRuntime): string {
  const browserURL = getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_BASE_URL");
  const baseURL = (
    isBrowser() && browserURL
      ? browserURL
      : getSetting(runtime, "ELIZAOS_CLOUD_BASE_URL", "https://www.elizacloud.ai/api/v1")
  ) as string;
  return baseURL;
}

export function getEmbeddingBaseURL(runtime: IAgentRuntime): string {
  const embeddingURL = isBrowser()
    ? getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_EMBEDDING_URL") ||
      getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_BASE_URL")
    : getSetting(runtime, "ELIZAOS_CLOUD_EMBEDDING_URL");
  if (embeddingURL) {
    logger.debug(`[ELIZAOS_CLOUD] Using specific embedding base URL: ${embeddingURL}`);
    return embeddingURL;
  }
  logger.debug("[ELIZAOS_CLOUD] Falling back to general base URL for embeddings.");
  return getBaseURL(runtime);
}

export function getApiKey(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, "ELIZAOS_CLOUD_API_KEY");
}

export function getEmbeddingApiKey(runtime: IAgentRuntime): string | undefined {
  const embeddingApiKey = getSetting(runtime, "ELIZAOS_CLOUD_EMBEDDING_API_KEY");
  if (embeddingApiKey) {
    logger.debug("[ELIZAOS_CLOUD] Using specific embedding API key (present)");
    return embeddingApiKey;
  }
  logger.debug("[ELIZAOS_CLOUD] Falling back to general API key for embeddings.");
  return getApiKey(runtime);
}

export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_SMALL_MODEL") ??
    (getSetting(runtime, "SMALL_MODEL", DEFAULT_ELIZA_CLOUD_TEXT_MODEL) as string)
  );
}

export function getNanoModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_NANO_MODEL") ??
    getSetting(runtime, "NANO_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getMediumModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_MEDIUM_MODEL") ??
    getSetting(runtime, "MEDIUM_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_LARGE_MODEL") ??
    (getSetting(runtime, "LARGE_MODEL", DEFAULT_ELIZA_CLOUD_LARGE_MODEL) as string)
  );
}

export function getMegaModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_MEGA_MODEL") ??
    getSetting(runtime, "MEGA_MODEL") ??
    getLargeModel(runtime)
  );
}

export function getResponseHandlerModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL") ??
    getSetting(runtime, "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL") ??
    getSetting(runtime, "RESPONSE_HANDLER_MODEL") ??
    getSetting(runtime, "SHOULD_RESPOND_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getActionPlannerModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL") ??
    getSetting(runtime, "ELIZAOS_CLOUD_PLANNER_MODEL") ??
    getSetting(runtime, "ACTION_PLANNER_MODEL") ??
    getSetting(runtime, "PLANNER_MODEL") ??
    getLargeModel(runtime)
  );
}

export function getResponseModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_RESPONSE_MODEL") ??
    getSetting(runtime, "RESPONSE_MODEL") ??
    getLargeModel(runtime)
  );
}

export function getImageDescriptionModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL", "gpt-5.4-mini") as string;
}

export function getImageGenerationModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL", "google/gemini-2.5-flash-image") ??
    "google/gemini-2.5-flash-image"
  );
}

export function getResearchModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_RESEARCH_MODEL") ??
    (getSetting(runtime, "RESEARCH_MODEL", "o3-deep-research") as string)
  );
}

export function getTTSModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "ELIZAOS_CLOUD_TTS_MODEL", "gpt-5-mini-tts") as string;
}

export function getTranscriptionModel(runtime: IAgentRuntime): string {
  return getSetting(
    runtime,
    "ELIZAOS_CLOUD_TRANSCRIPTION_MODEL",
    "gpt-5-mini-transcribe"
  ) as string;
}

export function getExperimentalTelemetry(runtime: IAgentRuntime): boolean {
  const setting = getSetting(runtime, "ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY", "false");
  return String(setting).toLowerCase() === "true";
}
