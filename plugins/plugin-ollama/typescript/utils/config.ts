type SettingsProvider = {
  getSetting: (key: string) => string | number | boolean | null;
};

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_SMALL_MODEL = "gemma3:latest";
export const DEFAULT_LARGE_MODEL = "gemma3:latest";
export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text:latest";

function getEnvValue(key: string): string | undefined {
  if (typeof process === "undefined" || !process.env) {
    return undefined;
  }
  const value = process.env[key];
  return value === undefined ? undefined : String(value);
}

export function getSetting(
  runtime: SettingsProvider,
  key: string,
  defaultValue?: string
): string | undefined {
  const value = runtime.getSetting(key);
  if (value !== undefined && value !== null) {
    return String(value);
  }
  return getEnvValue(key) ?? defaultValue;
}

export function getBaseURL(runtime: SettingsProvider): string {
  const apiEndpoint =
    getSetting(runtime, "OLLAMA_API_ENDPOINT") ||
    getSetting(runtime, "OLLAMA_API_URL") ||
    DEFAULT_OLLAMA_URL;

  if (!apiEndpoint.endsWith("/api")) {
    return apiEndpoint.endsWith("/") ? `${apiEndpoint}api` : `${apiEndpoint}/api`;
  }
  return apiEndpoint;
}

export function getApiBase(runtime: SettingsProvider): string {
  const baseURL = getBaseURL(runtime);
  return baseURL.endsWith("/api") ? baseURL.slice(0, -4) : baseURL;
}

export function getSmallModel(runtime: SettingsProvider): string {
  return (
    getSetting(runtime, "OLLAMA_SMALL_MODEL") ||
    getSetting(runtime, "SMALL_MODEL") ||
    DEFAULT_SMALL_MODEL
  );
}

export function getLargeModel(runtime: SettingsProvider): string {
  return (
    getSetting(runtime, "OLLAMA_LARGE_MODEL") ||
    getSetting(runtime, "LARGE_MODEL") ||
    DEFAULT_LARGE_MODEL
  );
}

export function getEmbeddingModel(runtime: SettingsProvider): string {
  return getSetting(runtime, "OLLAMA_EMBEDDING_MODEL") || DEFAULT_EMBEDDING_MODEL;
}
