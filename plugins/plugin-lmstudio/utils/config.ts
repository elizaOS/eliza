/**
 * Setting resolution for `@elizaos/plugin-lmstudio`.
 *
 * LM Studio is functionally an OpenAI-compatible local server. We resolve settings the
 * same way as the Ollama plugin — runtime first, then `process.env`, then a default —
 * so character overrides, CLI launches, and test harnesses all agree on the same value.
 *
 * The default base URL `http://localhost:1234/v1` matches LM Studio's "Local Server" tab
 * out of the box. Callers that put LM Studio behind a proxy can override with
 * `LMSTUDIO_BASE_URL`.
 */

type SettingsProvider = {
  getSetting: (key: string) => string | number | boolean | null;
};

export const DEFAULT_LMSTUDIO_URL = "http://localhost:1234/v1";

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

/**
 * Returns LM Studio's OpenAI-compatible base URL, always including `/v1`.
 *
 * Accepts callers that set `LMSTUDIO_BASE_URL` to either `http://host:1234` or
 * `http://host:1234/v1` — both normalize to the same canonical form so downstream
 * fetch calls don't have to second-guess.
 */
export function getBaseURL(runtime: SettingsProvider): string {
  const raw = getSetting(runtime, "LMSTUDIO_BASE_URL") ?? DEFAULT_LMSTUDIO_URL;
  const trimmed = raw.replace(/\/+$/, "");
  if (/\/v\d+$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

/**
 * Root LM Studio URL (without `/v1`) — used for diagnostics. Mirrors how
 * `plugin-ollama` exposes `getApiBase` so future health probes can append
 * their own paths.
 */
export function getApiBase(runtime: SettingsProvider): string {
  const baseURL = getBaseURL(runtime);
  return baseURL.replace(/\/v\d+$/, "");
}

export function getApiKey(runtime: SettingsProvider): string | undefined {
  const value = getSetting(runtime, "LMSTUDIO_API_KEY");
  if (!value || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

export function getSmallModel(runtime: SettingsProvider): string | undefined {
  return (
    getSetting(runtime, "LMSTUDIO_SMALL_MODEL") ?? getSetting(runtime, "SMALL_MODEL") ?? undefined
  );
}

export function getLargeModel(runtime: SettingsProvider): string | undefined {
  return (
    getSetting(runtime, "LMSTUDIO_LARGE_MODEL") ?? getSetting(runtime, "LARGE_MODEL") ?? undefined
  );
}

export function getEmbeddingModel(runtime: SettingsProvider): string | undefined {
  return getSetting(runtime, "LMSTUDIO_EMBEDDING_MODEL") ?? undefined;
}

export function shouldAutoDetect(runtime: SettingsProvider): boolean {
  const value = getSetting(runtime, "LMSTUDIO_AUTO_DETECT", "true")?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return true;
  }
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
