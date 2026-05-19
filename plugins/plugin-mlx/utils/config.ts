/**
 * Setting resolution for `@elizaos/plugin-mlx`.
 *
 * `mlx-lm.server` is functionally an OpenAI-compatible local server. We resolve
 * settings the same way as the LM Studio and Ollama plugins — runtime first, then
 * `process.env`, then a default — so character overrides, CLI launches, and test
 * harnesses all agree on the same value.
 *
 * The default base URL `http://localhost:8080/v1` matches `mlx_lm.server`'s
 * out-of-the-box configuration. Callers that put mlx-lm behind a proxy can
 * override with `MLX_BASE_URL`.
 */

type SettingsProvider = {
  getSetting: (key: string) => string | number | boolean | null;
};

export const DEFAULT_MLX_URL = "http://localhost:8080/v1";

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
 * Returns mlx-lm.server's OpenAI-compatible base URL, always including `/v1`.
 *
 * Accepts callers that set `MLX_BASE_URL` to either `http://host:8080` or
 * `http://host:8080/v1` — both normalize to the same canonical form so downstream
 * fetch calls don't have to second-guess.
 */
export function getBaseURL(runtime: SettingsProvider): string {
  const raw = getSetting(runtime, "MLX_BASE_URL") ?? DEFAULT_MLX_URL;
  const trimmed = raw.replace(/\/+$/, "");
  if (/\/v\d+$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

/**
 * Root mlx-lm URL (without `/v1`) — used for diagnostics. Mirrors how
 * `plugin-ollama` and `plugin-lmstudio` expose `getApiBase` so future health
 * probes can append their own paths.
 */
export function getApiBase(runtime: SettingsProvider): string {
  const baseURL = getBaseURL(runtime);
  return baseURL.replace(/\/v\d+$/, "");
}

export function getApiKey(runtime: SettingsProvider): string | undefined {
  const value = getSetting(runtime, "MLX_API_KEY");
  if (!value || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

export function getSmallModel(runtime: SettingsProvider): string | undefined {
  return getSetting(runtime, "MLX_SMALL_MODEL") ?? getSetting(runtime, "SMALL_MODEL") ?? undefined;
}

export function getLargeModel(runtime: SettingsProvider): string | undefined {
  return getSetting(runtime, "MLX_LARGE_MODEL") ?? getSetting(runtime, "LARGE_MODEL") ?? undefined;
}

export function getEmbeddingModel(runtime: SettingsProvider): string | undefined {
  return getSetting(runtime, "MLX_EMBEDDING_MODEL") ?? undefined;
}

export function shouldAutoDetect(runtime: SettingsProvider): boolean {
  const value = getSetting(runtime, "MLX_AUTO_DETECT", "true")?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return true;
  }
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Apple Silicon gate.
 *
 * MLX is Apple's machine-learning framework built around the Metal Performance
 * Shaders unified-memory model. The framework itself only ships for
 * `darwin-arm64`, and `mlx-lm.server` requires that runtime. Plugins must not
 * activate on other hosts even if the user pointed `MLX_BASE_URL` at a remote
 * mlx-lm instance — that's a deliberately out-of-scope deployment.
 */
export function isAppleSiliconHost(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}
