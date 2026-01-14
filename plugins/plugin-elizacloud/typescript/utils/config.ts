import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

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
  defaultValue?: string,
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

export function getAuthHeader(
  runtime: IAgentRuntime,
  forEmbedding = false,
): Record<string, string> {
  if (isBrowser()) return {};
  const key = forEmbedding ? getEmbeddingApiKey(runtime) : getApiKey(runtime);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export function getBaseURL(runtime: IAgentRuntime): string {
  const browserURL = getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_BASE_URL");
  const baseURL = (
    isBrowser() && browserURL
      ? browserURL
      : getSetting(
          runtime,
          "ELIZAOS_CLOUD_BASE_URL",
          "https://www.elizacloud.ai/api/v1",
        )
  ) as string;
  return baseURL;
}

export function getEmbeddingBaseURL(runtime: IAgentRuntime): string {
  const embeddingURL = isBrowser()
    ? getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_EMBEDDING_URL") ||
      getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_BASE_URL")
    : getSetting(runtime, "ELIZAOS_CLOUD_EMBEDDING_URL");
  if (embeddingURL) {
    logger.debug(
      `[ELIZAOS_CLOUD] Using specific embedding base URL: ${embeddingURL}`,
    );
    return embeddingURL;
  }
  logger.debug(
    "[ELIZAOS_CLOUD] Falling back to general base URL for embeddings.",
  );
  return getBaseURL(runtime);
}

export function getApiKey(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, "ELIZAOS_CLOUD_API_KEY");
}

export function getEmbeddingApiKey(runtime: IAgentRuntime): string | undefined {
  const embeddingApiKey = getSetting(
    runtime,
    "ELIZAOS_CLOUD_EMBEDDING_API_KEY",
  );
  if (embeddingApiKey) {
    logger.debug("[ELIZAOS_CLOUD] Using specific embedding API key (present)");
    return embeddingApiKey;
  }
  logger.debug(
    "[ELIZAOS_CLOUD] Falling back to general API key for embeddings.",
  );
  return getApiKey(runtime);
}

export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_SMALL_MODEL") ??
    (getSetting(runtime, "SMALL_MODEL", "gpt-5-mini") as string)
  );
}

export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_LARGE_MODEL") ??
    (getSetting(runtime, "LARGE_MODEL", "gpt-5") as string)
  );
}

export function getImageDescriptionModel(runtime: IAgentRuntime): string {
  return (
    getSetting(
      runtime,
      "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL",
      "gpt-5-mini",
    ) ?? "gpt-5-mini"
  );
}

export function getImageGenerationModel(runtime: IAgentRuntime): string {
  return (
    getSetting(
      runtime,
      "ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL",
      "google/gemini-2.5-flash-image",
    ) ?? "google/gemini-2.5-flash-image"
  );
}

export function getExperimentalTelemetry(runtime: IAgentRuntime): boolean {
  const setting = getSetting(
    runtime,
    "ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY",
    "false",
  );
  return String(setting).toLowerCase() === "true";
}
