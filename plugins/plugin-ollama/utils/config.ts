/**
 * Ollama-related settings resolution for `@elizaos/plugin-ollama`.
 *
 * ## Why `getSetting` merges runtime + `process.env`
 *
 * Eliza agents can override keys per-character via `runtime.getSetting`, while CLI and
 * container deployments typically use environment variables. Reading both in one helper
 * keeps model selection consistent whether the agent is started from the desktop app,
 * `eliza start`, or tests.
 */

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

export function getNanoModel(runtime: SettingsProvider): string {
  return (
    getSetting(runtime, "OLLAMA_NANO_MODEL") ||
    getSetting(runtime, "NANO_MODEL") ||
    getSmallModel(runtime)
  );
}

export function getMediumModel(runtime: SettingsProvider): string {
  return (
    getSetting(runtime, "OLLAMA_MEDIUM_MODEL") ||
    getSetting(runtime, "MEDIUM_MODEL") ||
    getSmallModel(runtime)
  );
}

export function getLargeModel(runtime: SettingsProvider): string {
  return (
    getSetting(runtime, "OLLAMA_LARGE_MODEL") ||
    getSetting(runtime, "LARGE_MODEL") ||
    DEFAULT_LARGE_MODEL
  );
}

export function getMegaModel(runtime: SettingsProvider): string {
  return (
    getSetting(runtime, "OLLAMA_MEGA_MODEL") ||
    getSetting(runtime, "MEGA_MODEL") ||
    getLargeModel(runtime)
  );
}

export function getResponseHandlerModel(runtime: SettingsProvider): string {
  return (
    getSetting(runtime, "OLLAMA_RESPONSE_HANDLER_MODEL") ||
    getSetting(runtime, "OLLAMA_SHOULD_RESPOND_MODEL") ||
    getSetting(runtime, "RESPONSE_HANDLER_MODEL") ||
    getSetting(runtime, "SHOULD_RESPOND_MODEL") ||
    getNanoModel(runtime)
  );
}

export function getActionPlannerModel(runtime: SettingsProvider): string {
  return (
    getSetting(runtime, "OLLAMA_ACTION_PLANNER_MODEL") ||
    getSetting(runtime, "OLLAMA_PLANNER_MODEL") ||
    getSetting(runtime, "ACTION_PLANNER_MODEL") ||
    getSetting(runtime, "PLANNER_MODEL") ||
    getMediumModel(runtime)
  );
}

export function getEmbeddingModel(runtime: SettingsProvider): string {
  return getSetting(runtime, "OLLAMA_EMBEDDING_MODEL") || DEFAULT_EMBEDDING_MODEL;
}

/**
 * Escape hatch for JSON-schema structured text (`responseSchema` on `useModel`).
 *
 * **Why this exists:** Ollama `format` / schema mode is correct for core pipelines
 * (fact extraction, planners), but some local models return invalid JSON, loop, or 500.
 * Disabling structured output forces plain `generateText` so the agent stays alive; callers
 * that require strict JSON may log parse failures until the operator fixes the model or
 * clears this flag.
 */
export function isOllamaStructuredOutputDisabled(runtime: SettingsProvider): boolean {
  const v = getSetting(runtime, "OLLAMA_DISABLE_STRUCTURED_OUTPUT")?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
