import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

/**
 * Retrieves a configuration setting from the runtime, falling back to environment variables or a default value if not found.
 *
 * @param key - The name of the setting to retrieve.
 * @param defaultValue - The value to return if the setting is not found in the runtime or environment.
 * @returns The resolved setting value, or {@link defaultValue} if not found.
 */
export function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue?: string,
): string | undefined {
  const value = runtime.getSetting(key);
  // Convert to string if value is a number or boolean
  if (value !== undefined && value !== null) {
    return String(value);
  }
  return process.env[key] ?? defaultValue;
}

export function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as Record<string, unknown>).document !== "undefined"
  );
}

/**
 * Determines whether we're running in a browser with a server-hosted proxy configured.
 * In this mode, we do not require a real API key on the client and rely on the proxy to inject it.
 */
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

/**
 * Retrieves the ElizaOS Cloud API base URL from runtime settings, environment variables, or defaults.
 *
 * @returns The resolved base URL for ElizaOS Cloud API requests.
 */
export function getBaseURL(runtime: IAgentRuntime): string {
  const browserURL = getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_BASE_URL");
  const baseURL = (
    isBrowser() && browserURL
      ? browserURL
      : getSetting(runtime, "ELIZAOS_CLOUD_BASE_URL", "https://www.elizacloud.ai/api/v1")
  ) as string;
  return baseURL;
}

/**
 * Retrieves the ElizaOS Cloud API base URL for embeddings, falling back to the general base URL.
 *
 * @returns The resolved base URL for ElizaOS Cloud embedding requests.
 */
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

/**
 * Helper function to get the API key for ElizaOS Cloud
 * Expected format: eliza_<random_32_chars>
 *
 * @param runtime The runtime context
 * @returns The configured API key
 */
export function getApiKey(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, "ELIZAOS_CLOUD_API_KEY");
}

/**
 * Helper function to get the embedding API key for ElizaOS Cloud, falling back to the general API key if not set.
 *
 * @param runtime The runtime context
 * @returns The configured API key
 */
export function getEmbeddingApiKey(runtime: IAgentRuntime): string | undefined {
  const embeddingApiKey = getSetting(runtime, "ELIZAOS_CLOUD_EMBEDDING_API_KEY");
  if (embeddingApiKey) {
    logger.debug("[ELIZAOS_CLOUD] Using specific embedding API key (present)");
    return embeddingApiKey;
  }
  logger.debug(
    "[ELIZAOS_CLOUD] Falling back to general API key for embeddings.",
  );
  return getApiKey(runtime);
}

/**
 * Helper function to get the small model name with fallbacks
 * Available models on ElizaOS Cloud: gpt-4o-mini, gpt-4o, claude-3-5-sonnet, gemini-2.0-flash
 *
 * @param runtime The runtime context
 * @returns The configured small model name
 */
export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_SMALL_MODEL") ??
    (getSetting(runtime, "SMALL_MODEL", "gpt-4o-mini") as string)
  );
}

/**
 * Helper function to get the large model name with fallbacks
 * Available models on ElizaOS Cloud: gpt-4o-mini, gpt-4o, claude-3-5-sonnet, gemini-2.0-flash
 *
 * @param runtime The runtime context
 * @returns The configured large model name
 */
export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_LARGE_MODEL") ??
    (getSetting(runtime, "LARGE_MODEL", "gpt-4o") as string)
  );
}

/**
 * Helper function to get the image description model name with fallbacks
 *
 * @param runtime The runtime context
 * @returns The configured image description model name
 */
export function getImageDescriptionModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL", "gpt-4o-mini") ??
    "gpt-4o-mini"
  );
}

/**
 * Helper function to get the image generation model name with fallbacks
 *
 * @param runtime The runtime context
 * @returns The configured image generation model name
 */
export function getImageGenerationModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL", "google/gemini-2.5-flash-image") ??
    "google/gemini-2.5-flash-image"
  );
}

/**
 * Helper function to get experimental telemetry setting
 *
 * @param runtime The runtime context
 * @returns Whether experimental telemetry is enabled
 */
export function getExperimentalTelemetry(runtime: IAgentRuntime): boolean {
  const setting = getSetting(
    runtime,
    "ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY",
    "false",
  );
  // Convert to string and check for truthy values
  const normalizedSetting = String(setting).toLowerCase();
  const result = normalizedSetting === "true";
  logger.debug(
    `[ELIZAOS_CLOUD] Experimental telemetry in function: "${setting}" (type: ${typeof setting}, normalized: "${normalizedSetting}", result: ${result})`,
  );
  return result;
}
