import type { IAgentRuntime } from "@elizaos/core";

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_SMALL_MODEL = "google/gemini-2.0-flash-001";
export const DEFAULT_LARGE_MODEL = "google/gemini-2.5-flash";
export const DEFAULT_IMAGE_MODEL = "x-ai/grok-2-vision-1212";
export const DEFAULT_IMAGE_GENERATION_MODEL = "google/gemini-2.5-flash-image-preview";
export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

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

export function getBaseURL(runtime: IAgentRuntime): string {
  const browserURL = getSetting(runtime, "OPENROUTER_BROWSER_BASE_URL");
  if (
    typeof globalThis !== "undefined" &&
    (globalThis as Record<string, unknown>).document &&
    browserURL
  ) {
    return browserURL;
  }
  return getSetting(runtime, "OPENROUTER_BASE_URL", DEFAULT_BASE_URL) || DEFAULT_BASE_URL;
}

export function getApiKey(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, "OPENROUTER_API_KEY");
}

export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENROUTER_SMALL_MODEL") ??
    getSetting(runtime, "SMALL_MODEL", DEFAULT_SMALL_MODEL) ??
    DEFAULT_SMALL_MODEL
  );
}

export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENROUTER_LARGE_MODEL") ??
    getSetting(runtime, "LARGE_MODEL", DEFAULT_LARGE_MODEL) ??
    DEFAULT_LARGE_MODEL
  );
}

export function getImageModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENROUTER_IMAGE_MODEL") ??
    getSetting(runtime, "IMAGE_MODEL", DEFAULT_IMAGE_MODEL) ??
    DEFAULT_IMAGE_MODEL
  );
}

export function getImageGenerationModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENROUTER_IMAGE_GENERATION_MODEL") ??
    getSetting(runtime, "IMAGE_GENERATION_MODEL", DEFAULT_IMAGE_GENERATION_MODEL) ??
    DEFAULT_IMAGE_GENERATION_MODEL
  );
}

export function getEmbeddingModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "OPENROUTER_EMBEDDING_MODEL") ??
    getSetting(runtime, "EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL) ??
    DEFAULT_EMBEDDING_MODEL
  );
}

export function getEmbeddingDimensions(runtime: IAgentRuntime): number {
  const setting =
    getSetting(runtime, "OPENROUTER_EMBEDDING_DIMENSIONS") ??
    getSetting(runtime, "EMBEDDING_DIMENSIONS");
  return setting ? parseInt(setting, 10) : DEFAULT_EMBEDDING_DIMENSIONS;
}

export function shouldAutoCleanupImages(runtime: IAgentRuntime): boolean {
  const setting = getSetting(runtime, "OPENROUTER_AUTO_CLEANUP_IMAGES", "false");
  return setting?.toLowerCase() === "true";
}
