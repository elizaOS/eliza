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

/**
 * Resolve a numeric setting that must be a strict positive integer.
 *
 * Only accepts a value when the ENTIRE trimmed string is a run of digits
 * denoting a value `> 0`. Unlike `Number.parseInt`, which stops at the first
 * non-numeric character and silently truncates (`"1536abc"` -> `1536`,
 * `"3.5"` -> `3`), any mixed, fractional, scientific, zero, or negative input
 * is rejected with the same error so a malformed vector width can never be
 * partially accepted (issue #23028). Unset/empty returns the default. Callers
 * (dimensions, counts) are always positive integers.
 */
export function getNumericSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue: number
): number {
  const value = getSetting(runtime, key);
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    return defaultValue;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Setting '${key}' must be a valid integer, got: ${value}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
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

/** Resolves the configured server endpoint without inventing a default. */
export function getEmbeddingBaseURL(runtime: IAgentRuntime): string | undefined {
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

export function getEmbeddingFallbackBaseURL(runtime: IAgentRuntime): string | undefined {
  const baseURL = getSetting(runtime, "EMBEDDING_FALLBACK_BASE_URL");
  return baseURL && baseURL.trim() !== "" ? baseURL.trim() : undefined;
}

export function getEmbeddingFallbackApiKey(runtime: IAgentRuntime): string | undefined {
  const apiKey = getSetting(runtime, "EMBEDDING_FALLBACK_API_KEY");
  return apiKey && apiKey.trim() !== "" ? apiKey.trim() : undefined;
}

export function getEmbeddingFallbackModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "EMBEDDING_FALLBACK_MODEL") ?? getEmbeddingModel(runtime);
}

export function getEmbeddingDimensions(runtime: IAgentRuntime): number {
  return getNumericSetting(runtime, "EMBEDDING_DIMENSIONS", 1536);
}

/** Builds the authorization header for the configured embedding endpoint. */
export function getAuthHeader(runtime: IAgentRuntime): Record<string, string> {
  const key = getEmbeddingApiKey(runtime);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** Builds the authorization header for a primary or fallback endpoint. */
export function getEndpointAuthHeader(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
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
  const fallbackBaseURL = getEmbeddingFallbackBaseURL(runtime);
  logger.info(
    `[Embeddings] model=${getEmbeddingModel(runtime)} dimensions=${getEmbeddingDimensions(
      runtime
    )} endpoint=${baseURL ?? "(unset)"} fallback=${fallbackBaseURL ?? "(unset)"}`
  );
}
