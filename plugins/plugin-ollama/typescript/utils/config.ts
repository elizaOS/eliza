/**
 * Configuration utilities for the Ollama plugin.
 */

/** Runtime-like interface for getting settings */
type SettingsProvider = {
  getSetting: (key: string) => string | number | boolean | null;
};

/** Default Ollama API URL */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** Default small model */
export const DEFAULT_SMALL_MODEL = 'gemma3:latest';

/** Default large model */
export const DEFAULT_LARGE_MODEL = 'gemma3:latest';

/** Default embedding model */
export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text:latest';

/**
 * Get a setting from runtime, falling back to environment variables.
 *
 * @param runtime - The agent runtime
 * @param key - The setting key
 * @param defaultValue - Default value if not found
 * @returns The setting value or default
 */
export function getSetting(
  runtime: SettingsProvider,
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
 * Get the Ollama API base URL from runtime settings.
 *
 * @param runtime - The agent runtime
 * @returns The base URL for the Ollama API
 */
export function getBaseURL(runtime: SettingsProvider): string {
  const apiEndpoint =
    getSetting(runtime, 'OLLAMA_API_ENDPOINT') ||
    getSetting(runtime, 'OLLAMA_API_URL') ||
    DEFAULT_OLLAMA_URL;

  // Ensure the URL ends with /api for ollama-ai-provider
  if (!apiEndpoint.endsWith('/api')) {
    return apiEndpoint.endsWith('/') ? `${apiEndpoint}api` : `${apiEndpoint}/api`;
  }
  return apiEndpoint;
}

/**
 * Get the API base without /api suffix for direct API calls.
 *
 * @param runtime - The agent runtime
 * @returns The API base URL without /api suffix
 */
export function getApiBase(runtime: SettingsProvider): string {
  const baseURL = getBaseURL(runtime);
  return baseURL.endsWith('/api') ? baseURL.slice(0, -4) : baseURL;
}

/**
 * Get the small model name from runtime settings.
 *
 * @param runtime - The agent runtime
 * @returns The small model name
 */
export function getSmallModel(runtime: SettingsProvider): string {
  return (
    getSetting(runtime, 'OLLAMA_SMALL_MODEL') ||
    getSetting(runtime, 'SMALL_MODEL') ||
    DEFAULT_SMALL_MODEL
  );
}

/**
 * Get the large model name from runtime settings.
 *
 * @param runtime - The agent runtime
 * @returns The large model name
 */
export function getLargeModel(runtime: SettingsProvider): string {
  return (
    getSetting(runtime, 'OLLAMA_LARGE_MODEL') ||
    getSetting(runtime, 'LARGE_MODEL') ||
    DEFAULT_LARGE_MODEL
  );
}

/**
 * Get the embedding model name from runtime settings.
 *
 * @param runtime - The agent runtime
 * @returns The embedding model name
 */
export function getEmbeddingModel(runtime: SettingsProvider): string {
  return getSetting(runtime, 'OLLAMA_EMBEDDING_MODEL') || DEFAULT_EMBEDDING_MODEL;
}
