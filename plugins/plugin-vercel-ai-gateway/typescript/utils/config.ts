import type { IAgentRuntime } from "@elizaos/core";
import type { GatewayConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";

function getEnvValue(key: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  const value = process.env[key];
  return value === undefined ? undefined : String(value);
}

export function getSetting(runtime: IAgentRuntime | undefined, key: string): string | undefined {
  if (runtime) {
    const value = runtime.getSetting(key);
    if (value) return String(value);
  }
  return getEnvValue(key);
}

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

export function getApiKeyOptional(runtime?: IAgentRuntime): string | undefined {
  return (
    getSetting(runtime, "AI_GATEWAY_API_KEY") ||
    getSetting(runtime, "AIGATEWAY_API_KEY") ||
    getSetting(runtime, "VERCEL_OIDC_TOKEN")
  );
}

export function getBaseUrl(runtime?: IAgentRuntime): string {
  return getSetting(runtime, "AI_GATEWAY_BASE_URL") || DEFAULT_CONFIG.baseUrl;
}

export function getSmallModel(runtime?: IAgentRuntime): string {
  return (
    getSetting(runtime, "AI_GATEWAY_SMALL_MODEL") ||
    getSetting(runtime, "SMALL_MODEL") ||
    DEFAULT_CONFIG.smallModel
  );
}

export function getLargeModel(runtime?: IAgentRuntime): string {
  return (
    getSetting(runtime, "AI_GATEWAY_LARGE_MODEL") ||
    getSetting(runtime, "LARGE_MODEL") ||
    DEFAULT_CONFIG.largeModel
  );
}

export function getEmbeddingModel(runtime?: IAgentRuntime): string {
  return getSetting(runtime, "AI_GATEWAY_EMBEDDING_MODEL") || DEFAULT_CONFIG.embeddingModel;
}

export function getEmbeddingDimensions(runtime?: IAgentRuntime): number {
  const dims = getSetting(runtime, "AI_GATEWAY_EMBEDDING_DIMENSIONS");
  if (dims) {
    const parsed = parseInt(dims, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_CONFIG.embeddingDimensions;
}

export function getImageModel(runtime?: IAgentRuntime): string {
  return getSetting(runtime, "AI_GATEWAY_IMAGE_MODEL") || DEFAULT_CONFIG.imageModel;
}

export function getTimeoutMs(runtime?: IAgentRuntime): number {
  const timeout = getSetting(runtime, "AI_GATEWAY_TIMEOUT_MS");
  if (timeout) {
    const parsed = parseInt(timeout, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_CONFIG.timeoutMs;
}

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

export function getAuthHeader(runtime?: IAgentRuntime): Record<string, string> {
  const apiKey = getApiKey(runtime);
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

const NO_TEMPERATURE_MODELS = new Set([
  "o1",
  "o1-preview",
  "o1-mini",
  "o3",
  "o3-mini",
  "gpt-5",
  "gpt-5-mini",
]);

export function modelSupportsTemperature(model: string): boolean {
  const modelLower = model.toLowerCase();
  for (const noTempModel of NO_TEMPERATURE_MODELS) {
    if (modelLower.includes(noTempModel)) {
      return false;
    }
  }
  return true;
}
