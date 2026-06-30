/**
 * Setting resolution for `@elizaos/plugin-embeddings`.
 *
 * Every getter is provider-NEUTRAL and resolved through `getSetting`, so the
 * values are per-character overridable (`runtime.getSetting(key)` first, then
 * `process.env[key]`, then a default). There is intentionally NO fallback to a
 * chat provider's settings (`OPENAI_*`, `ELIZAOS_CLOUD_*`, …): this plugin owns
 * the embedding slot independently of the chat brain. If `EMBEDDING_BASE_URL`
 * is not configured, the handler throws rather than silently inheriting an
 * unrelated endpoint.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger, resolveSetting } from "@elizaos/core";

/**
 * Runtime config first, then `process.env`, then the supplied default.
 * Returns `undefined` when unset and no default is given.
 *
 * Thin wrapper over core `resolveSetting` so the precedence lives in one
 * canonical place. The env fallback uses dotenv semantics (trimmed; empty
 * strings treated as unset).
 */
export function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue?: string
): string | undefined {
  return defaultValue === undefined
    ? resolveSetting(runtime, key)
    : resolveSetting(runtime, key, { defaultValue });
}

export function getNumericSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue: number
): number {
  const value = getSetting(runtime, key);
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Setting '${key}' must be a valid integer, got: ${value}`);
  }
  return parsed;
}

export function getBooleanSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue: boolean
): boolean {
  const value = getSetting(runtime, key);
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  );
}

/**
 * Resolved base URL of the OpenAI-compatible embedding endpoint.
 *
 * In a browser build the server-side proxy URL (`EMBEDDING_BROWSER_URL`) is
 * preferred so the real endpoint/key stay server-side. There is NO default
 * endpoint and NO chat-provider fallback: when nothing is configured this
 * returns `undefined` and the handler throws (Commandment 8 — never invent an
 * endpoint that could silently produce or persist a wrong vector).
 */
export function getEmbeddingBaseURL(runtime: IAgentRuntime): string | undefined {
  if (isBrowser()) {
    const browserURL = getSetting(runtime, "EMBEDDING_BROWSER_URL");
    if (browserURL && browserURL.trim() !== "") {
      return browserURL.trim();
    }
  }
  const baseURL = getSetting(runtime, "EMBEDDING_BASE_URL");
  return baseURL && baseURL.trim() !== "" ? baseURL.trim() : undefined;
}

export function getEmbeddingApiKey(runtime: IAgentRuntime): string | undefined {
  const apiKey = getSetting(runtime, "EMBEDDING_API_KEY");
  return apiKey && apiKey.trim() !== "" ? apiKey.trim() : undefined;
}

export function getEmbeddingModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "EMBEDDING_MODEL") ?? "text-embedding-3-small";
}

export function getEmbeddingDimensions(runtime: IAgentRuntime): number {
  return getNumericSetting(runtime, "EMBEDDING_DIMENSIONS", 1536);
}

/**
 * Auth header for the embedding request.
 *
 * In a browser build the `Authorization` header is NOT sent unless an explicit
 * browser proxy URL (`EMBEDDING_BROWSER_URL`) is configured — mirrors
 * plugin-openai's `isBrowser` gating so a frontend bundle never leaks the key.
 * The proxy is expected to inject auth server-side.
 */
export function getAuthHeader(runtime: IAgentRuntime): Record<string, string> {
  if (isBrowser() && !getSetting(runtime, "EMBEDDING_BROWSER_URL")) {
    return {};
  }
  const key = getEmbeddingApiKey(runtime);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** True when the operator has opted in by configuring a URL or a key. */
export function hasEmbeddingConfig(runtime: IAgentRuntime): boolean {
  return Boolean(getEmbeddingBaseURL(runtime) || getEmbeddingApiKey(runtime));
}

/**
 * Log the resolved model + dimension once at init. Kept here so `init()` in
 * index.ts stays a thin wiring layer.
 */
export function logResolvedConfig(runtime: IAgentRuntime): void {
  const baseURL = getEmbeddingBaseURL(runtime);
  logger.info(
    `[Embeddings] model=${getEmbeddingModel(runtime)} dimensions=${getEmbeddingDimensions(
      runtime
    )} endpoint=${baseURL ?? "(unset)"}`
  );
}
