import type { IAgentRuntime } from "@elizaos/core";

export function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue?: string,
): string | undefined {
  const value = runtime.getSetting(key);
  if (value !== undefined && value !== null) {
    return String(value);
  }
  return process.env[key] ?? defaultValue;
}

export function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined"
  );
}

const DEFAULT_BASE = "https://integrate.api.nvidia.com/v1";

export function getBaseURL(runtime: IAgentRuntime): string {
  const browserURL = getSetting(runtime, "NVIDIA_BROWSER_BASE_URL");
  if (isBrowser() && browserURL) {
    return browserURL;
  }
  return getSetting(runtime, "NVIDIA_BASE_URL", DEFAULT_BASE) ?? DEFAULT_BASE;
}

/** Base URL for `/v1/embeddings` (defaults to chat base). Override if NVIDIA docs give a different embed host. */
export function getEmbeddingBaseURL(runtime: IAgentRuntime): string {
  const explicit = getSetting(runtime, "NVIDIA_EMBEDDING_BASE_URL");
  const raw = (explicit ?? getBaseURL(runtime)).replace(/\/$/, "");
  return raw;
}

export function getApiKey(runtime: IAgentRuntime): string | undefined {
  return (
    getSetting(runtime, "NVIDIA_CLOUD_API_KEY") ??
    getSetting(runtime, "NVIDIA_API_KEY")
  );
}

/**
 * Defaults chosen from live NVIDIA Build probes for reliable XML/control output.
 *
 * WHY not default to newer reasoning-flavored models:
 * ElizaOS frequently asks for strict XML. Models that burn completion tokens on
 * hidden/reasoning output can return empty visible text or hit length limits
 * before the XML arrives.
 */
const DEFAULT_SMALL = "meta/llama-3.1-8b-instruct";
const DEFAULT_LARGE = "meta/llama-3.1-405b-instruct";

export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "NVIDIA_SMALL_MODEL") ??
    getSetting(runtime, "SMALL_MODEL", DEFAULT_SMALL) ??
    DEFAULT_SMALL
  );
}

export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "NVIDIA_LARGE_MODEL") ??
    getSetting(runtime, "LARGE_MODEL", DEFAULT_LARGE) ??
    DEFAULT_LARGE
  );
}

function getPositiveIntSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue: number,
): number {
  const value = getSetting(runtime, key);
  if (!value) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function getTextTimeoutMs(runtime: IAgentRuntime): number {
  return getPositiveIntSetting(runtime, "NVIDIA_TEXT_TIMEOUT_MS", 180_000);
}

// Keep these caps provider-local. Core should not impose NVIDIA-specific token policy
// because other model plugins may account for hidden/reasoning tokens differently.
export function getDefaultSmallMaxOutputTokens(runtime: IAgentRuntime): number {
  return getPositiveIntSetting(runtime, "NVIDIA_SMALL_MAX_OUTPUT_TOKENS", 1024);
}

export function getDefaultLargeMaxOutputTokens(runtime: IAgentRuntime): number {
  return getPositiveIntSetting(runtime, "NVIDIA_LARGE_MAX_OUTPUT_TOKENS", 4096);
}

/**
 * Default: NVIDIA first-party retriever embed ([docs](https://docs.api.nvidia.com/nim/reference/nvidia-nv-embedqa-e5-v5-infer)).
 * Uses `input_type` (passage/query). Many keys that work for chat fail on `baai/bge-m3` with NVCF 500 — override with NVIDIA_EMBEDDING_MODEL if needed.
 */
const DEFAULT_EMBEDDING_MODEL = "nvidia/nv-embedqa-e5-v5";

export function getEmbeddingModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "NVIDIA_EMBEDDING_MODEL") ??
    getSetting(runtime, "EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL) ??
    DEFAULT_EMBEDDING_MODEL
  );
}

/** Required for nv-embed / nv-embedqa models (passage = indexing, query = retrieval). */
export function getEmbeddingInputType(
  runtime: IAgentRuntime,
): "passage" | "query" | undefined {
  const model = getEmbeddingModel(runtime).toLowerCase();
  const needs =
    model.includes("nv-embed") ||
    model.includes("nv-embedqa") ||
    model.includes("embedqa");
  if (!needs) {
    return undefined;
  }
  const v =
    getSetting(runtime, "NVIDIA_EMBEDDING_INPUT_TYPE", "passage") ?? "passage";
  return v === "query" ? "query" : "passage";
}
