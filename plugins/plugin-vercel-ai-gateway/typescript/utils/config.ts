/**
 * Configuration utilities for Vercel AI Gateway plugin.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { GatewayConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";

/**
 * Get a setting from runtime or environment.
 */
export function getSetting(runtime: IAgentRuntime | undefined, key: string): string | undefined {
  if (runtime) {
    const value = runtime.getSetting(key);
    if (value) return String(value);
  }
  return process.env[key];
}

/**
 * Get the API key from runtime or environment.
 */
export function getApiKey(runtime?: IAgentRuntime): string {
  const apiKey =
    getSetting(runtime, "AI_GATEWAY_API_KEY") ||
    getSetting(runtime, "AIGATEWAY_API_KEY") ||
    getSetting(runtime, "VERCEL_OIDC_TOKEN");

  if (!apiKey) {
    throw new Error("AI_GATEWAY_API_KEY, AIGATEWAY_API_KEY, or VERCEL_OIDC_TOKEN is required");
  }

  return apiKey;
}

/**
 * Get the API key if available, without throwing.
 */
export function getApiKeyOptional(runtime?: IAgentRuntime): string | undefined {
  return (
    getSetting(runtime, "AI_GATEWAY_API_KEY") ||
    getSetting(runtime, "AIGATEWAY_API_KEY") ||
    getSetting(runtime, "VERCEL_OIDC_TOKEN")
  );
}

/**
 * Get the base URL from runtime or environment.
 */
export function getBaseUrl(runtime?: IAgentRuntime): string {
  return getSetting(runtime, "AI_GATEWAY_BASE_URL") || DEFAULT_CONFIG.baseUrl;
}

/**
 * Get the small model from runtime or environment.
 */
export function getSmallModel(runtime?: IAgentRuntime): string {
  return (
    getSetting(runtime, "AI_GATEWAY_SMALL_MODEL") ||
    getSetting(runtime, "SMALL_MODEL") ||
    DEFAULT_CONFIG.smallModel
  );
}

/**
 * Get the large model from runtime or environment.
 */
export function getLargeModel(runtime?: IAgentRuntime): string {
  return (
    getSetting(runtime, "AI_GATEWAY_LARGE_MODEL") ||
    getSetting(runtime, "LARGE_MODEL") ||
    DEFAULT_CONFIG.largeModel
  );
}

/**
 * Get the embedding model from runtime or environment.
 */
export function getEmbeddingModel(runtime?: IAgentRuntime): string {
  return getSetting(runtime, "AI_GATEWAY_EMBEDDING_MODEL") || DEFAULT_CONFIG.embeddingModel;
}

/**
 * Get the embedding dimensions from runtime or environment.
 */
export function getEmbeddingDimensions(runtime?: IAgentRuntime): number {
  const dims = getSetting(runtime, "AI_GATEWAY_EMBEDDING_DIMENSIONS");
  if (dims) {
    const parsed = parseInt(dims, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_CONFIG.embeddingDimensions;
}

/**
 * Get the image model from runtime or environment.
 */
export function getImageModel(runtime?: IAgentRuntime): string {
  return getSetting(runtime, "AI_GATEWAY_IMAGE_MODEL") || DEFAULT_CONFIG.imageModel;
}

/**
 * Get the timeout from runtime or environment.
 */
export function getTimeoutMs(runtime?: IAgentRuntime): number {
  const timeout = getSetting(runtime, "AI_GATEWAY_TIMEOUT_MS");
  if (timeout) {
    const parsed = parseInt(timeout, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_CONFIG.timeoutMs;
}

/**
 * Build the complete gateway configuration from runtime/environment.
 */
export function buildConfig(runtime?: IAgentRuntime): GatewayConfig {
  return {
    apiKey: getApiKey(runtime),
    baseUrl: getBaseUrl(runtime),
    smallModel: getSmallModel(runtime),
    largeModel: getLargeModel(runtime),
    embeddingModel: getEmbeddingModel(runtime),
    embeddingDimensions: getEmbeddingDimensions(runtime),
    imageModel: getImageModel(runtime),
    timeoutMs: getTimeoutMs(runtime),
  };
}

/**
 * Get authorization header for API requests.
 */
export function getAuthHeader(runtime?: IAgentRuntime): Record<string, string> {
  const apiKey = getApiKey(runtime);
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

/**
 * Models that don't support temperature/sampling parameters (reasoning models).
 */
const NO_TEMPERATURE_MODELS = new Set([
  "o1",
  "o1-preview",
  "o1-mini",
  "o3",
  "o3-mini",
  "gpt-5",
  "gpt-5-mini",
]);

/**
 * Check if a model supports temperature parameter.
 */
export function modelSupportsTemperature(model: string): boolean {
  const modelLower = model.toLowerCase();
  for (const noTempModel of NO_TEMPERATURE_MODELS) {
    if (modelLower.includes(noTempModel)) {
      return false;
    }
  }
  return true;
}
