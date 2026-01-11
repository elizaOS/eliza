/**
 * Configuration utilities for the OpenRouter plugin.
 */

import type { IAgentRuntime } from '@elizaos/core';

/** Default OpenRouter API URL */
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Default small model */
export const DEFAULT_SMALL_MODEL = 'google/gemini-2.0-flash-001';

/** Default large model */
export const DEFAULT_LARGE_MODEL = 'google/gemini-2.5-flash';

/** Default image model */
export const DEFAULT_IMAGE_MODEL = 'x-ai/grok-2-vision-1212';

/** Default image generation model */
export const DEFAULT_IMAGE_GENERATION_MODEL = 'google/gemini-2.5-flash-image-preview';

/** Default embedding model */
export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';

/** Default embedding dimensions */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/**
 * Get a setting from runtime, falling back to environment variables.
 *
 * @param runtime - The agent runtime
 * @param key - The setting key
 * @param defaultValue - Default value if not found
 * @returns The setting value or default
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
 * Get the OpenRouter API base URL from runtime settings.
 *
 * @param runtime - The agent runtime
 * @returns The base URL for the OpenRouter API
 */
export function getBaseURL(runtime: IAgentRuntime): string {
  const browserURL = getSetting(runtime, 'OPENROUTER_BROWSER_BASE_URL');
  if (typeof globalThis !== 'undefined' && (globalThis as Record<string, unknown>).document && browserURL) {
    return browserURL;
  }
  return getSetting(runtime, 'OPENROUTER_BASE_URL', DEFAULT_BASE_URL) || DEFAULT_BASE_URL;
}

/**
 * Get the API key for OpenRouter.
 *
 * @param runtime - The agent runtime
 * @returns The configured API key
 */
export function getApiKey(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, 'OPENROUTER_API_KEY');
}

/**
 * Get the small model name with fallbacks.
 *
 * @param runtime - The agent runtime
 * @returns The configured small model name
 */
export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, 'OPENROUTER_SMALL_MODEL') ??
    getSetting(runtime, 'SMALL_MODEL', DEFAULT_SMALL_MODEL) ??
    DEFAULT_SMALL_MODEL
  );
}

/**
 * Get the large model name with fallbacks.
 *
 * @param runtime - The agent runtime
 * @returns The configured large model name
 */
export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, 'OPENROUTER_LARGE_MODEL') ??
    getSetting(runtime, 'LARGE_MODEL', DEFAULT_LARGE_MODEL) ??
    DEFAULT_LARGE_MODEL
  );
}

/**
 * Get the image model name with fallbacks.
 *
 * @param runtime - The agent runtime
 * @returns The configured image model name
 */
export function getImageModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, 'OPENROUTER_IMAGE_MODEL') ??
    getSetting(runtime, 'IMAGE_MODEL', DEFAULT_IMAGE_MODEL) ??
    DEFAULT_IMAGE_MODEL
  );
}

/**
 * Get the image generation model name with fallbacks.
 *
 * @param runtime - The agent runtime
 * @returns The configured image generation model name
 */
export function getImageGenerationModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, 'OPENROUTER_IMAGE_GENERATION_MODEL') ??
    getSetting(runtime, 'IMAGE_GENERATION_MODEL', DEFAULT_IMAGE_GENERATION_MODEL) ??
    DEFAULT_IMAGE_GENERATION_MODEL
  );
}

/**
 * Get the embedding model name with fallbacks.
 *
 * @param runtime - The agent runtime
 * @returns The configured embedding model name
 */
export function getEmbeddingModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, 'OPENROUTER_EMBEDDING_MODEL') ??
    getSetting(runtime, 'EMBEDDING_MODEL', DEFAULT_EMBEDDING_MODEL) ??
    DEFAULT_EMBEDDING_MODEL
  );
}

/**
 * Get the embedding dimensions.
 *
 * @param runtime - The agent runtime
 * @returns The configured embedding dimensions
 */
export function getEmbeddingDimensions(runtime: IAgentRuntime): number {
  const setting = getSetting(runtime, 'OPENROUTER_EMBEDDING_DIMENSIONS') ??
    getSetting(runtime, 'EMBEDDING_DIMENSIONS');
  return setting ? parseInt(setting, 10) : DEFAULT_EMBEDDING_DIMENSIONS;
}

/**
 * Check if auto cleanup is enabled for generated images.
 *
 * @param runtime - The agent runtime
 * @returns Whether to auto-cleanup generated images
 */
export function shouldAutoCleanupImages(runtime: IAgentRuntime): boolean {
  const setting = getSetting(runtime, 'OPENROUTER_AUTO_CLEANUP_IMAGES', 'false');
  return setting?.toLowerCase() === 'true';
}


