import { IAgentRuntime } from "@elizaos/core";

/**
 * Helper function to get settings from runtime or environment
 */
export function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue?: string,
): string | undefined {
  return runtime.getSetting(key) ?? process.env[key] ?? defaultValue;
}

/**
 * Get the base URL for AI Gateway
 */
export function getBaseURL(runtime: IAgentRuntime): string {
  const baseURL = getSetting(
    runtime,
    "AIGATEWAY_BASE_URL",
    "https://ai-gateway.vercel.sh/v1",
  ) as string;

  return baseURL;
}

/**
 * Get API key
 */
export function getApiKey(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, "AIGATEWAY_API_KEY");
}

/**
 * Get small model name
 */
export function getSmallModel(runtime: IAgentRuntime): string {
  return getSetting(
    runtime,
    "AIGATEWAY_DEFAULT_MODEL",
    "openai:gpt-4o-mini",
  ) as string;
}

/**
 * Get large model name
 */
export function getLargeModel(runtime: IAgentRuntime): string {
  return getSetting(
    runtime,
    "AIGATEWAY_LARGE_MODEL",
    "openai:gpt-4o",
  ) as string;
}

/**
 * Get embedding model name
 */
export function getEmbeddingModel(runtime: IAgentRuntime): string {
  return getSetting(
    runtime,
    "AIGATEWAY_EMBEDDING_MODEL",
    "openai:text-embedding-3-small",
  ) as string;
}

/**
 * Get cache TTL in seconds
 */
export function getCacheTTL(runtime: IAgentRuntime): number {
  const ttl = getSetting(runtime, "AIGATEWAY_CACHE_TTL", "300");
  return parseInt(ttl || "300", 10);
}

/**
 * Get max retry attempts
 */
export function getMaxRetries(runtime: IAgentRuntime): number {
  const retries = getSetting(runtime, "AIGATEWAY_MAX_RETRIES", "3");
  return parseInt(retries || "3", 10);
}

/**
 * Check if OIDC authentication should be used
 */
export function useOIDC(runtime: IAgentRuntime): boolean {
  return getSetting(runtime, "AIGATEWAY_USE_OIDC") === "true";
}

/**
 * Get app name for Vercel attribution
 */
export function getAppName(runtime: IAgentRuntime): string {
  return getSetting(
    runtime,
    "AIGATEWAY_APP_NAME",
    "elizaos-aigateway",
  ) as string;
}

/**
 * Configuration interface for the plugin
 */
export interface AIGatewayConfig {
  apiKey?: string;
  baseURL: string;
  defaultModel: string;
  largeModel: string;
  embeddingModel: string;
  cacheTTL: number;
  maxRetries: number;
  useOIDC: boolean;
  appName: string;
}

/**
 * Get complete configuration
 */
export function getConfig(runtime: IAgentRuntime): AIGatewayConfig {
  return {
    apiKey: getApiKey(runtime),
    baseURL: getBaseURL(runtime),
    defaultModel: getSmallModel(runtime),
    largeModel: getLargeModel(runtime),
    embeddingModel: getEmbeddingModel(runtime),
    cacheTTL: getCacheTTL(runtime),
    maxRetries: getMaxRetries(runtime),
    useOIDC: useOIDC(runtime),
    appName: getAppName(runtime),
  };
}
