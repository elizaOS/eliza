/**
 * Cross-platform KV-cache type resolver for llama.cpp loads.
 *
 * Both the AOSP bun adapter (`packages/agent/src/runtime/aosp-llama-adapter.ts`)
 * and the Capacitor in-WebView adapter (`./capacitor-llama-adapter.ts`) need
 * the same precedence chain when picking K/V cache types:
 *
 *   1. Explicit `LoadOptions.cacheType{K,V}` from the caller (highest).
 *   2. `ELIZA_LLAMA_CACHE_TYPE_K` / `ELIZA_LLAMA_CACHE_TYPE_V` env vars.
 *   3. Auto-detection: a Bonsai-by-filename match → `{ k: "tbq4_0", v: "tbq3_0" }`
 *      (matches the apothic/Bonsai-8B-1bit-turboquant model card recommendation).
 *   4. Otherwise undefined — the loader leaves cache types at llama.cpp's
 *      fp16 default, which is the safe choice for any non-Bonsai GGUF.
 *
 * The resolver is pure: no DOM, no Node APIs. It works in the renderer
 * (Capacitor WebView, where `process.env` is `{}`) and in the bun runtime
 * (where `process.env` is the OS environment).
 *
 * Recognised type names (all comparisons are case-insensitive):
 *   - `f16`     → llama.cpp's fp16 KV cache (upstream default).
 *   - `tbq3_0`  → buun-llama-cpp fork's TurboQuant 3-bit value cache.
 *   - `tbq4_0`  → buun-llama-cpp fork's TurboQuant 4-bit key cache.
 *
 * Stock llama.cpp builds without the buun fork ignore tbq3_0/tbq4_0 because
 * the underlying Capacitor plugin's `setCacheType` is a no-op there
 * (warn-no-op surface in `capacitor-llama-adapter.ts`). The AOSP adapter
 * routes the same names through the fork-specific shim setters.
 */

export type KvCacheTypeName = "f16" | "tbq3_0" | "tbq4_0";

const RECOGNISED_NAMES: ReadonlySet<KvCacheTypeName> = new Set([
  "f16",
  "tbq3_0",
  "tbq4_0",
]);

const BONSAI_AUTO: { k: KvCacheTypeName; v: KvCacheTypeName } = {
  k: "tbq4_0",
  v: "tbq3_0",
};

export interface KvCacheOverride {
  k?: KvCacheTypeName;
  v?: KvCacheTypeName;
}

/** Pure env reader. No process.env coupling — caller passes the env object. */
export type EnvLike = Record<string, string | undefined>;

/**
 * Optional warning sink so callers in environments without `process` (e.g.
 * the WebView) can route to console.warn while bun-side callers can route
 * to their structured logger.
 */
export type WarnSink = (message: string) => void;

function defaultWarn(message: string): void {
  // eslint-disable-next-line no-console
  if (typeof console !== "undefined") console.warn(message);
}

/**
 * Read a `KvCacheTypeName` from an env-like map. Returns undefined when the
 * var is unset, blank, or not a recognised name. Unrecognised values warn
 * (via `warn`) and return undefined so a typo doesn't crash the loader.
 *
 * Exported for unit tests.
 */
export function readEnvKvCacheType(
  name: string,
  env: EnvLike,
  warn: WarnSink = defaultWarn,
): KvCacheTypeName | undefined {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (RECOGNISED_NAMES.has(raw as KvCacheTypeName)) {
    return raw as KvCacheTypeName;
  }
  warn(
    `[kv-cache-resolver] ${name}=${raw} is not a recognised KV cache type; ignoring (use f16 / tbq3_0 / tbq4_0).`,
  );
  return undefined;
}

/**
 * Auto-detect when a model path indicates a Bonsai 1-bit TurboQuant build,
 * which is the only model in the curated catalog that's trained against the
 * fork's TBQ KV-cache codec. Match is intentionally loose (case-insensitive
 * substring) because users may rename downloaded GGUFs.
 *
 * The Hugging Face repo is `apothic/bonsai-8B-1bit-turboquant` and ships
 * `models/gguf/8B/Bonsai-8B.gguf`; downloads pass that filename through
 * verbatim by default, so a "Bonsai" basename match is the right hook.
 *
 * Exported for unit tests.
 */
export function looksLikeBonsai(modelPath: string): boolean {
  const base = modelPath.split(/[/\\]/).pop() ?? modelPath;
  return /bonsai/i.test(base);
}

/**
 * Resolve the KV-cache type to use for a given model load. See module-level
 * docblock for the precedence chain.
 *
 * Returns `undefined` when no override applies (neither side selected),
 * letting the caller skip the bridge methods entirely. When at least one
 * side is selected the returned object always carries both `k` and `v`
 * fields; either may be undefined when only the other side was overridden.
 */
export function resolveKvCacheType(
  modelPath: string,
  override: KvCacheOverride | undefined,
  env: EnvLike,
  warn: WarnSink = defaultWarn,
): KvCacheOverride | undefined {
  const explicitK = override?.k;
  const explicitV = override?.v;
  const envK = readEnvKvCacheType("ELIZA_LLAMA_CACHE_TYPE_K", env, warn);
  const envV = readEnvKvCacheType("ELIZA_LLAMA_CACHE_TYPE_V", env, warn);
  const auto = looksLikeBonsai(modelPath) ? BONSAI_AUTO : undefined;
  const k = explicitK ?? envK ?? auto?.k;
  const v = explicitV ?? envV ?? auto?.v;
  if (k === undefined && v === undefined) return undefined;
  return { k, v };
}
