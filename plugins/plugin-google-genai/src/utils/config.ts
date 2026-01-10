import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from '@google/genai';
import type { IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';

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
  defaultValue?: string
): string | undefined {
  return runtime.getSetting(key) ?? process.env[key] ?? defaultValue;
}

/**
 * Helper function to get the API key for Google AI
 *
 * @param runtime The runtime context
 * @returns The configured API key
 */
export function getApiKey(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, 'GOOGLE_GENERATIVE_AI_API_KEY');
}

/**
 * Helper function to get the small model name with fallbacks
 *
 * @param runtime The runtime context
 * @returns The configured small model name
 */
export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, 'GOOGLE_SMALL_MODEL') ??
    getSetting(runtime, 'SMALL_MODEL', 'gemini-2.0-flash-001') ??
    'gemini-2.0-flash-001'
  );
}

/**
 * Helper function to get the large model name with fallbacks
 *
 * @param runtime The runtime context
 * @returns The configured large model name
 */
export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, 'GOOGLE_LARGE_MODEL') ??
    getSetting(runtime, 'LARGE_MODEL', 'gemini-2.5-pro-preview-03-25') ??
    'gemini-2.5-pro-preview-03-25'
  );
}

/**
 * Helper function to get the image model name with fallbacks
 *
 * @param runtime The runtime context
 * @returns The configured image model name
 */
export function getImageModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, 'GOOGLE_IMAGE_MODEL') ??
    getSetting(runtime, 'IMAGE_MODEL', 'gemini-2.5-pro-preview-03-25') ??
    'gemini-2.5-pro-preview-03-25'
  );
}

/**
 * Helper function to get the embedding model name with fallbacks
 *
 * @param runtime The runtime context
 * @returns The configured embedding model name
 */
export function getEmbeddingModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, 'GOOGLE_EMBEDDING_MODEL', 'text-embedding-004') ?? 'text-embedding-004'
  );
}

/**
 * Create a Google Generative AI client instance with proper configuration
 *
 * @param runtime The runtime context
 * @returns Configured Google Generative AI instance
 */
export function createGoogleGenAI(runtime: IAgentRuntime): GoogleGenAI | null {
  const apiKey = getApiKey(runtime);
  if (!apiKey) {
    logger.error('Google Generative AI API Key is missing');
    return null;
  }

  return new GoogleGenAI({ apiKey });
}

/**
 * Convert safety settings to Google format
 */
export function getSafetySettings() {
  return [
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
  ];
}
