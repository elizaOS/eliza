/**
 * Ollama-related settings resolution for `@elizaos/plugin-zerollama`.
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
export const DEFAULT_SMALL_MODEL = "eliza-1-2b";
export const DEFAULT_LARGE_MODEL = "eliza-1-4b";
export const DEFAULT_EMBEDDING_MODEL = "eliza-1-2b";

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
    const normalized = String(value).trim();
    if (normalized.length > 0) return normalized;
  }
  const envValue = getEnvValue(key)?.trim();
  return envValue && envValue.length > 0 ? envValue : defaultValue;
}

export function getBaseURL(runtime: SettingsProvider): string {
  const apiEndpoint =
    getSetting(runtime, "OLLAMA_API_ENDPOINT") ||
    getSetting(runtime, "OLLAMA_API_URL") ||
    getSetting(runtime, "OLLAMA_BASE_URL") ||
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

/**
 * Local-inference assignments / env sometimes put a GGUF filename in the
 * `TEXT_EMBEDDING` slot (`gte-small_fp16.gguf`). That is not an Ollama model
 * tag — using it on zerollama/Ollama yields 404/400 and breaks the fallback
 * chain. Prefer `OLLAMA_EMBEDDING_MODEL`; only honor `TEXT_EMBEDDING` when it
 * looks like an Ollama tag (not a local artifact).
 */
function isOllamaEmbedModelTag(model: string): boolean {
  const lower = model.trim().toLowerCase();
  if (!lower) return false;
  if (lower.endsWith(".gguf")) return false;
  if (lower.includes("_fp16") || lower.includes("_fp32") || lower.includes("_q8")) {
    return false;
  }
  return true;
}

export function getEmbeddingModel(runtime: SettingsProvider): string {
  const dedicated = getSetting(runtime, "OLLAMA_EMBEDDING_MODEL");
  if (dedicated && isOllamaEmbedModelTag(dedicated)) {
    return dedicated;
  }
  const alias = getSetting(runtime, "TEXT_EMBEDDING");
  if (alias && isOllamaEmbedModelTag(alias)) {
    return alias;
  }
  return DEFAULT_EMBEDDING_MODEL;
}

/**
 * Speech model for OpenAI-compatible `POST /v1/audio/speech` (zerollama Piper).
 * Empty / unset means the plugin does not register TEXT_TO_SPEECH.
 */
export function getTtsModel(runtime: SettingsProvider): string {
  return (
    getSetting(runtime, "OLLAMA_TTS_MODEL") ||
    getSetting(runtime, "OLLAMA_SPEECH_MODEL") ||
    ""
  ).trim();
}

export function isOllamaTtsEnabled(runtime: SettingsProvider): boolean {
  return getTtsModel(runtime).length > 0;
}

/** Optional Piper voice name (`voice` field / `piper_voice_<name>` path key). */
export function getTtsVoice(runtime: SettingsProvider): string | undefined {
  const voice = (
    getSetting(runtime, "OLLAMA_TTS_VOICE") ||
    getSetting(runtime, "OLLAMA_SPEECH_VOICE") ||
    ""
  ).trim();
  return voice || undefined;
}

/** Optional OpenAI-compatible speed (0.25–4.0) for Piper `--length_scale`. */
export function getTtsSpeed(runtime: SettingsProvider): number | undefined {
  const raw = (
    getSetting(runtime, "OLLAMA_TTS_SPEED") ||
    getSetting(runtime, "OLLAMA_SPEECH_SPEED") ||
    ""
  ).trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.25 || n > 4) return undefined;
  return n;
}

/**
 * STT model for OpenAI-compatible `POST /v1/audio/transcriptions`.
 * Empty / unset means the plugin does not register TRANSCRIPTION.
 */
export function getTranscriptionModel(runtime: SettingsProvider): string {
  return (
    getSetting(runtime, "OLLAMA_TRANSCRIPTION_MODEL") ||
    getSetting(runtime, "OLLAMA_ASR_MODEL") ||
    ""
  ).trim();
}

export function isOllamaTranscriptionEnabled(runtime: SettingsProvider): boolean {
  return getTranscriptionModel(runtime).length > 0;
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
