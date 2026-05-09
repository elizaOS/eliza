/**
 * AOSP-only loader for native llama.cpp via `bun:ffi`.
 *
 * Targets the apothic/llama.cpp-1bit-turboquant fork (commit
 *   https://github.com/Apothic-AI/llama.cpp-1bit-turboquant
 *   tag: main-b8198-b2b5273
 *   sha: b2b5273e8b275bb96362fe844a5202632eb3e52b
 * — the matching libllama.so is compiled by the AOSP build pipeline
 * against this same SHA via `scripts/elizaos/compile-libllama.mjs`).
 *
 * Why this fork (was stock llama.cpp b4500 before):
 *   apothic's fork adds two GGML quant types (TBQ3_0 = 43, TBQ4_0 = 44)
 *   for KV-cache compression, with CPU implementations under
 *   `ggml/src/ggml-cpu/quants.c` + `ggml/src/ggml-cpu/ggml-cpu.c`.
 *   block_tbq3_0 packs 32 floats into 14 bytes (vs 64 bytes for fp16) —
 *   ~4.6x KV-cache memory reduction. KV cache dominates phone-RAM
 *   pressure at long contexts, so this is the difference between Bonsai
 *   "loads but OOMs after 1k tokens" and "loads and chats". The matching
 *   Bonsai-8B-1bit GGUF on Hugging Face is trained against this fork.
 *
 *   The fork is based on llama.cpp b8198 (much newer than b4500), so it
 *   inherits the post-2024 sampler-chain API
 *   (`llama_sampler_chain_init`, `llama_sampler_init_greedy`, etc.) and
 *   the renamed model/vocab API (`llama_model_load_from_file`,
 *   `llama_init_from_model`, `llama_model_get_vocab`, `llama_vocab_eos`,
 *   `llama_vocab_is_eog`) AND the embedding helpers
 *   (`llama_set_embeddings`, `llama_get_embeddings_seq`,
 *   `llama_model_n_embd`).
 *
 *   Drift since the b4500 pin handled in the shim:
 *     - llama_context_params.flash_attn (bool) → flash_attn_type (enum);
 *       shim removed the bool setter (the adapter never called it).
 *     - llama_context_params adds type_k / type_v / samplers / kv_unified;
 *       shim now exposes set_type_k / set_type_v for TBQ KV-cache wiring
 *       (driven by `kvCacheType` in the adapter LoadOptions, with
 *       Bonsai-by-filename auto-detection as a default).
 *
 * Symbols pinned for reference:
 *   libllama.so (dlopen'd first):
 *     - llama_backend_init / llama_backend_free
 *     - llama_model_free / llama_free
 *     - llama_model_get_vocab / llama_vocab_eos / llama_vocab_is_eog
 *     - llama_tokenize / llama_token_to_piece
 *     - llama_sampler_chain_add / llama_sampler_init_temp /
 *       llama_sampler_init_top_p / llama_sampler_init_dist /
 *       llama_sampler_init_greedy / llama_sampler_sample /
 *       llama_sampler_accept / llama_sampler_free
 *     - llama_get_model / llama_n_ctx / llama_model_n_embd
 *     - llama_set_embeddings / llama_get_embeddings_seq / llama_get_embeddings
 *   libeliza-llama-shim.so (dlopen'd second; NEEDED libllama.so):
 *     - eliza_llama_model_params_default / *_free + per-field setters
 *     - eliza_llama_model_load_from_file
 *     - eliza_llama_context_params_default / *_free + per-field setters
 *     - eliza_llama_init_from_model
 *     - eliza_llama_sampler_chain_params_default / *_free
 *     - eliza_llama_sampler_chain_init
 *     - eliza_llama_batch_get_one / eliza_llama_batch_free
 *     - eliza_llama_decode
 *
 * Struct-by-value handled via libeliza-llama-shim.so (NEEDED-links
 * libllama.so, ships in the same per-ABI asset dir). bun:ffi cannot pass
 * llama.cpp's by-value param structs (model_params, context_params,
 * sampler_chain_params) directly. The shim — built by
 * `scripts/elizaos/compile-libllama.mjs` from
 * `scripts/elizaos/llama-shim/eliza_llama_shim.c` — exposes a
 * pointer-style API: `eliza_llama_model_params_default()` returns a
 * malloc'd pointer initialized via `llama_model_default_params()`, then
 * field-by-field setters override the few values the adapter cares about
 * (n_gpu_layers, use_mmap, use_mlock, n_threads, n_ctx, etc.) before the
 * pointer is handed to `eliza_llama_model_load_from_file()` /
 * `eliza_llama_init_from_model()` / `eliza_llama_sampler_chain_init()`,
 * each of which dereferences once into the real struct-by-value entry
 * point. This restores the canonical defaults — most importantly
 * model_params.use_mmap = true (was clobbered to false by the previous
 * zeroed-buffer workaround, which forced the loader to read entire
 * weights files into RAM on phones).
 *
 * Wired in via `ensure-local-inference-handler.ts`:
 *   - Trigger: `ELIZA_LOCAL_LLAMA=1` in the AOSP agent process env.
 *   - Slot:    `localInferenceLoader` runtime service (LocalInferenceLoader contract).
 *   - Selection precedence: this loader is registered BEFORE the Capacitor
 *     adapter so AOSP builds always pick the in-process FFI path.
 *
 * On a non-AOSP build that accidentally sets the env, this module logs and
 * returns false from `registerAospLlamaLoader`. It does not throw at module
 * load — bundlers must be able to statically import it on every platform.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";

/**
 * `bun:ffi` is a Bun built-in. In non-Bun bundle targets (Vitest under Node,
 * Vite for the web shell) the static specifier is unresolvable; even when
 * Bun.build dynamic-imports this module, the symbol is only valid inside a
 * Bun runtime. We therefore import it lazily and fail loudly on non-Bun
 * processes that explicitly opted into `ELIZA_LOCAL_LLAMA=1`.
 */
type FFITypeEnum = {
  void: number;
  bool: number;
  i32: number;
  u32: number;
  i64: number;
  f32: number;
  ptr: number;
  cstring: number;
};

interface BunFFIModule {
  dlopen: (
    path: string,
    symbols: Record<string, { args: readonly number[]; returns: number }>,
  ) => {
    symbols: Record<string, (...args: unknown[]) => unknown>;
    close: () => void;
  };
  FFIType: FFITypeEnum;
  ptr: (typed: ArrayBufferView) => number;
  read: { cstring: (addr: number) => string };
  /**
   * Wrap a raw native pointer as an ArrayBuffer view of `byteLength` bytes
   * starting at `byteOffset`. Used to copy the `float *` returned from
   * `llama_get_embeddings_seq` / `llama_get_embeddings` into a JS-owned
   * Float32Array so the caller can serialize it without holding a reference
   * to ctx-owned memory across the next `llama_decode` call.
   */
  toArrayBuffer: (
    ptr: number,
    byteOffset?: number,
    byteLength?: number,
  ) => ArrayBuffer;
  CString: new (
    addr: number,
    byteOffset?: number,
    byteLength?: number,
  ) => string;
}

type Pointer = number;

/**
 * Strongly-typed view of the libllama.so symbols we bind. Bun's `dlopen`
 * does not infer call signatures from FFIType descriptors, so callers cast
 * the symbols object to this shape.
 */
interface LlamaSymbols {
  llama_backend_init: () => void;
  llama_backend_free: () => void;

  llama_model_free: (model: Pointer) => void;

  llama_free: (ctx: Pointer) => void;

  llama_get_model: (ctx: Pointer) => Pointer;
  llama_model_get_vocab: (model: Pointer) => Pointer;
  llama_model_n_embd: (model: Pointer) => number;
  llama_n_ctx: (ctx: Pointer) => number;
  llama_vocab_eos: (vocab: Pointer) => number;
  llama_vocab_is_eog: (vocab: Pointer, token: number) => boolean;

  llama_set_embeddings: (ctx: Pointer, embeddings: boolean) => void;
  /**
   * `llama_get_memory(ctx)` returns the opaque memory handle (KV cache).
   * `llama_memory_clear(mem, data)` wipes the KV cache so the next
   * `llama_decode` call starts at position 0. We call this at the top
   * of every generate() / embed() to reset state between requests —
   * without it, llama.cpp accumulates KV slots across calls and decode
   * eventually returns rc=1 ("could not find a KV slot for the batch")
   * once the cache fills up.
   */
  llama_get_memory: (ctx: Pointer) => Pointer;
  llama_memory_clear: (mem: Pointer, data: boolean) => void;
  /**
   * `llama_get_embeddings_seq(ctx, seq_id)` — returns a `float *` of length
   * `n_embd` for the given sequence id when pooling is configured. Returns
   * NULL when the model is not in embeddings mode or the sequence has no
   * embedding output. The returned pointer is owned by ctx and remains
   * valid until the next `llama_decode` call.
   */
  llama_get_embeddings_seq: (ctx: Pointer, seq_id: number) => Pointer;
  /**
   * `llama_get_embeddings(ctx)` — returns a `float *` of length
   * `n_outputs * n_embd` containing per-token embeddings when no pooling
   * is configured. Used as the fallback when `pooling_type == NONE`.
   */
  llama_get_embeddings: (ctx: Pointer) => Pointer;

  llama_tokenize: (
    vocab: Pointer,
    text: Pointer,
    text_len: number,
    tokens: Pointer,
    n_tokens_max: number,
    add_special: boolean,
    parse_special: boolean,
  ) => number;
  llama_token_to_piece: (
    vocab: Pointer,
    token: number,
    buf: Pointer,
    length: number,
    lstrip: number,
    special: boolean,
  ) => number;

  // NOTE: `llama_batch_get_one` returns `struct llama_batch` by value and
  // `llama_decode` consumes it the same way — neither is callable directly
  // through bun:ffi (struct-aggregate ABI lowering is not synthesised).
  // Use the pointer-style wrappers on `ShimSymbols`
  // (`eliza_llama_batch_get_one` / `eliza_llama_decode`) instead.

  llama_sampler_chain_add: (chain: Pointer, sampler: Pointer) => void;
  llama_sampler_init_temp: (t: number) => Pointer;
  llama_sampler_init_top_p: (p: number, min_keep: number) => Pointer;
  llama_sampler_init_dist: (seed: number) => Pointer;
  llama_sampler_init_greedy: () => Pointer;
  llama_sampler_sample: (smpl: Pointer, ctx: Pointer, idx: number) => number;
  llama_sampler_accept: (smpl: Pointer, token: number) => void;
  llama_sampler_free: (smpl: Pointer) => void;
}

/**
 * Strongly-typed view of the libeliza-llama-shim.so exports. The shim is
 * a thin C wrapper that converts llama.cpp's struct-by-value entry points
 * (which bun:ffi cannot call directly) into pointer-style equivalents.
 *
 * Memory model:
 *   *_params_default() returns a malloc'd pointer that the caller MUST
 *   free with the matching *_params_free() after the load/init/chain-init
 *   call returns. The adapter does this in try/finally to guarantee
 *   no leak on error paths.
 */
/**
 * Bound shim symbols. We bind only what `loadModel` / `embed` / `generate`
 * actually call — speculative bindings get dlsym'd at dlopen time and
 * silently widen the surface a future refactor might rely on. Setters
 * for fields whose llama.cpp defaults are correct for AOSP CPU
 * (`use_mmap=true`, `use_mlock=false`, `vocab_only=false`,
 * `check_tensors=false`, `offload_kqv`/`flash_attn` not relevant on phone
 * CPU, `no_perf` cosmetic) are intentionally not bound. Adding one is a
 * one-line edit here + one-line edit in `dlopenShim` if a future LoadOptions
 * field needs it.
 */
interface ShimSymbols {
  // model_params
  eliza_llama_model_params_default: () => Pointer;
  eliza_llama_model_params_free: (p: Pointer) => void;
  eliza_llama_model_params_set_n_gpu_layers: (p: Pointer, v: number) => void;
  eliza_llama_model_load_from_file: (path: Pointer, params: Pointer) => Pointer;

  // context_params
  eliza_llama_context_params_default: () => Pointer;
  eliza_llama_context_params_free: (p: Pointer) => void;
  eliza_llama_context_params_set_n_ctx: (p: Pointer, v: number) => void;
  eliza_llama_context_params_set_n_batch: (p: Pointer, v: number) => void;
  eliza_llama_context_params_set_n_ubatch: (p: Pointer, v: number) => void;
  eliza_llama_context_params_set_n_threads: (p: Pointer, v: number) => void;
  eliza_llama_context_params_set_n_threads_batch: (
    p: Pointer,
    v: number,
  ) => void;
  eliza_llama_context_params_set_embeddings: (p: Pointer, v: boolean) => void;
  eliza_llama_context_params_set_pooling_type: (p: Pointer, v: number) => void;
  /**
   * type_k / type_v: ggml_type enum values for the K and V cache slots.
   * TBQ3_0 = 43 and TBQ4_0 = 44 are the apothic/llama.cpp-1bit-turboquant
   * additions; stock types (F16 = 1, Q4_0 = 2, Q8_0 = 8) work too. Setting
   * these flips the KV cache from fp16 to the chosen quant on the next
   * `llama_init_from_model` call. The CPU vec-dot path lives in
   * ggml/src/ggml-cpu/quants.c — this is the actual switch that turns on
   * the memory win on phones.
   */
  eliza_llama_context_params_set_type_k: (p: Pointer, v: number) => void;
  eliza_llama_context_params_set_type_v: (p: Pointer, v: number) => void;
  eliza_llama_init_from_model: (model: Pointer, params: Pointer) => Pointer;

  // sampler_chain_params
  eliza_llama_sampler_chain_params_default: () => Pointer;
  eliza_llama_sampler_chain_params_free: (p: Pointer) => void;
  eliza_llama_sampler_chain_init: (params: Pointer) => Pointer;

  /**
   * Pointer-style wrappers around llama.cpp's struct-by-value batch API.
   * `llama_batch_get_one` returns `struct llama_batch` by value and
   * `llama_decode` takes the same struct by value — bun:ffi cannot
   * round-trip aggregates through foreign function calls (the SysV
   * AArch64 / x86_64 ABI for >16-byte aggregates uses hidden return
   * pointers / split-register lowering that bun:ffi doesn't synthesise),
   * so we wrap both. The shim version of `_get_one` malloc's a heap
   * `llama_batch *`, the matching `_free` releases that heap struct
   * (NOT the token buffer the caller owns), and `eliza_llama_decode`
   * dereferences the pointer before delegating to real `llama_decode`.
   */
  eliza_llama_batch_get_one: (tokens: Pointer, n_tokens: number) => Pointer;
  eliza_llama_batch_free: (batch: Pointer) => void;
  eliza_llama_decode: (ctx: Pointer, batch: Pointer) => number;
}

interface RuntimeWithRegisterService {
  registerService?: (name: string, impl: unknown) => unknown;
}

/**
 * AOSP-only `LoadOptions` extension. The cross-platform `LocalInferenceLoader`
 * contract (`@elizaos/native-plugins/llama` and the Capacitor side) does NOT
 * surface KV-cache type — that's an AOSP-specific tunable that only the
 * fork-built libllama.so supports. We carry it on this private interface and
 * default-resolve from filename + env in `loadModel`.
 */
export interface AospLlamaLoadOptions {
  modelPath: string;
  contextSize?: number;
  useGpu?: boolean;
  maxThreads?: number;
  draftModelPath?: string;
  draftContextSize?: number;
  draftMin?: number;
  draftMax?: number;
  speculativeSamples?: number;
  mobileSpeculative?: boolean;
  cacheTypeK?: KvCacheTypeName;
  cacheTypeV?: KvCacheTypeName;
  disableThinking?: boolean;
  /**
   * KV-cache type override. When undefined we auto-pick:
   *   - Bonsai-by-filename → { k: "tbq4_0", v: "tbq3_0" }
   *   - everything else    → undefined (let llama.cpp keep its fp16 default)
   * Env overrides:
   *   ELIZA_LLAMA_CACHE_TYPE_K, ELIZA_LLAMA_CACHE_TYPE_V (e.g. "tbq4_0").
   */
  kvCacheType?: { k?: KvCacheTypeName; v?: KvCacheTypeName };
}

/** Minimal subset of LocalInferenceLoader we satisfy here. */
interface AospLoader {
  loadModel(args: AospLlamaLoadOptions): Promise<void>;
  unloadModel(): Promise<void>;
  currentModelPath(): string | null;
  generate(args: {
    prompt: string;
    stopSequences?: string[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<string>;
  embed(args: { input: string }): Promise<{
    embedding: number[];
    tokens: number;
  }>;
}

/**
 * Pooling type values from llama.h b4500. We always materialize the AOSP
 * context with `MEAN` pooling so `llama_get_embeddings_seq(ctx, 0)` returns
 * exactly `n_embd` floats — the sequence buffer is sized by pooling type,
 * and `NONE` would shape it as `n_outputs * n_embd` where `n_outputs <
 * written` for output-pruning models, leading to a read-OOB on the
 * mean-pool fallback path. By forcing MEAN at init we collapse two code
 * paths into one and remove the OOB risk entirely.
 */
const LLAMA_POOLING_TYPE_MEAN = 1;

/**
 * GGML type ids used for KV-cache configuration. The base set comes from
 * ggml.h; TBQ3_0 / TBQ4_0 are the apothic/llama.cpp-1bit-turboquant fork
 * additions and only valid against the fork-built libllama.so + matching
 * Bonsai-8B-1bit GGUF model.
 *
 * Verified against
 *   ~/.cache/eliza-android-agent/llama-cpp-main-b8198-b2b5273/ggml/include/ggml.h
 * (lines 420-435 — Q1_0 = 42 sits next to TBQ3_0 = 43, TBQ4_0 = 44).
 */
const GGML_TYPE_F16 = 1;
const GGML_TYPE_TBQ3_0 = 43;
const GGML_TYPE_TBQ4_0 = 44;

/**
 * Map a friendly KV-cache type name to its ggml_type enum value. Keep the
 * table small — only types we actually intend to drive end up here. F16
 * is the upstream default; tbq3_0 / tbq4_0 are the fork additions used by
 * Bonsai. Unknown names throw rather than silently degrade.
 *
 * Exported for unit tests so we can assert mapping correctness without
 * reaching into the adapter internals.
 */
export type KvCacheTypeName = "f16" | "tbq3_0" | "tbq4_0";

export function kvCacheTypeNameToEnum(name: KvCacheTypeName): number {
  switch (name) {
    case "f16":
      return GGML_TYPE_F16;
    case "tbq3_0":
      return GGML_TYPE_TBQ3_0;
    case "tbq4_0":
      return GGML_TYPE_TBQ4_0;
    default: {
      // Exhaustive switch — fall here only if a future type is added without
      // updating the map. Throw with the offending name so a future caller
      // doesn't silently get f16.
      const exhaustive: never = name;
      throw new Error(`[aosp-llama] Unknown KV cache type: ${exhaustive}`);
    }
  }
}

/**
 * Auto-detect when a model path indicates a Bonsai 1-bit TurboQuant build,
 * which is the only model in the curated catalog that's trained against
 * the fork's TBQ KV-cache codec. Match is intentionally loose
 * (case-insensitive substring) because users may rename downloaded GGUFs.
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
 * Read a `KvCacheTypeName` from an env var, returning undefined when the var
 * is unset, blank, or not a recognised type name. Recognised values are
 * exactly `"f16"`, `"tbq3_0"`, `"tbq4_0"` (case-insensitive). An unrecognised
 * value logs a warning and returns undefined rather than throwing — env-var
 * typos shouldn't crash the loader.
 *
 * Exported for unit tests.
 */
export function readEnvKvCacheType(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): KvCacheTypeName | undefined {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "f16" || raw === "tbq3_0" || raw === "tbq4_0") {
    return raw;
  }
  logger.warn(
    `[aosp-llama] ${name}=${raw} is not a recognised KV cache type; ignoring (use f16 / tbq3_0 / tbq4_0).`,
  );
  return undefined;
}

/**
 * Resolve the KV-cache type to use for a given load. Precedence:
 *   1. Explicit `LoadOptions.kvCacheType.{k,v}` (highest priority).
 *   2. `ELIZA_LLAMA_CACHE_TYPE_K` / `ELIZA_LLAMA_CACHE_TYPE_V` env vars.
 *   3. Auto-detection: Bonsai-by-filename → `{ k: "tbq4_0", v: "tbq3_0" }`
 *      (matches the model card recommendation).
 *   4. Otherwise undefined — the shim leaves the cache at llama.cpp's fp16
 *      default, which is the safe choice for any non-Bonsai GGUF.
 *
 * Returns `undefined` when no override applies, so the caller can skip the
 * shim setters entirely (smaller diff to upstream behaviour, easier to
 * reason about in logs).
 *
 * Exported for unit tests.
 */
export function resolveKvCacheType(
  modelPath: string,
  override: AospLlamaLoadOptions["kvCacheType"] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { k?: KvCacheTypeName; v?: KvCacheTypeName } | undefined {
  const explicitK = override?.k;
  const explicitV = override?.v;
  const envK = readEnvKvCacheType("ELIZA_LLAMA_CACHE_TYPE_K", env);
  const envV = readEnvKvCacheType("ELIZA_LLAMA_CACHE_TYPE_V", env);
  // Auto-detection only kicks in when neither an explicit override nor an
  // env override is set. Catalog blurb references this contract directly —
  // change here = update catalog.ts blurb in the same commit.
  const auto = looksLikeBonsai(modelPath)
    ? { k: "tbq4_0" as const, v: "tbq3_0" as const }
    : undefined;
  const k = explicitK ?? envK ?? auto?.k;
  const v = explicitV ?? envV ?? auto?.v;
  if (k === undefined && v === undefined) return undefined;
  return { k, v };
}

const SERVICE_NAME = "localInferenceLoader";

function isAospEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ELIZA_LOCAL_LLAMA?.trim() === "1";
}

/**
 * Read a non-negative integer env override, falling back to `fallback`
 * when the variable is unset, blank, or not parseable. Negative values
 * are clamped to the fallback to avoid passing an int32-min into the
 * shim setters.
 */
function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * Resolve the n_threads to pass to llama.cpp. Precedence:
 *   1. Explicit `LoadOptions.maxThreads` (highest priority).
 *   2. `ELIZA_LLAMA_THREADS` env var (set by ElizaAgentService.java
 *      to `Runtime.availableProcessors()` on AOSP).
 *   3. `os.cpus().length` from the JS runtime.
 *   4. Final fallback: 4 (cuttlefish baseline).
 *
 * Why not pass 0 ("let llama.cpp auto-detect")? llama.cpp's auto-detect
 * on Android frequently returns 1 because it parses
 * `/proc/cpuinfo` for "processor :" lines, and Android's seccomp filter
 * blocks the `sched_getaffinity` fallback. A hard-coded core count is
 * dramatically faster than the wrong auto-detect result.
 *
 * Exported for unit tests so we can verify the precedence chain
 * without spinning up a Bun runtime.
 */
export function resolveThreads(
  explicit: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const raw = env.ELIZA_LLAMA_THREADS?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  // os.cpus() on Bun returns the same shape as Node — array of CPU
  // descriptor objects. We deliberately don't import "node:os" at the
  // top because the bundler then has to resolve it on every platform;
  // here we lazy-require it so non-Bun targets can still type-check.
  try {
    /* Boundary cast: dynamic require returns weakly-typed module shape */
    const os = require("node:os") as { cpus(): unknown[] };
    const count = os.cpus()?.length ?? 0;
    if (count > 0) return count;
  } catch {
    // require unavailable in some bundler contexts; fall through.
  }
  return 4;
}

/**
 * Resolve the libllama.so path for the current ABI. The AOSP agent process
 * runs with `cwd = <agent_root>`; the Java side unpacks `agent/{abi}/libllama.so`
 * alongside the bun runtime and matching shared libraries.
 *
 * Exported for unit tests so we can verify ABI mapping without dlopen.
 */
export function resolveLibllamaPath(
  arch: NodeJS.Architecture = process.arch,
  cwd: string = process.cwd(),
): string {
  return path.join(resolveAbiDir(arch, cwd), "libllama.so");
}

/**
 * Resolve the libeliza-llama-shim.so path for the current ABI. Lives in
 * the same per-ABI dir as libllama.so; the dynamic linker resolves the
 * shim's NEEDED libllama.so via LD_LIBRARY_PATH.
 *
 * Exported for unit tests.
 */
export function resolveLlamaShimPath(
  arch: NodeJS.Architecture = process.arch,
  cwd: string = process.cwd(),
): string {
  return path.join(resolveAbiDir(arch, cwd), "libeliza-llama-shim.so");
}

function resolveAbiDir(arch: NodeJS.Architecture, cwd: string): string {
  const abiDir =
    arch === "arm64" ? "arm64-v8a" : arch === "x64" ? "x86_64" : null;
  if (abiDir === null) {
    throw new Error(
      `[aosp-llama] Unsupported process.arch for AOSP build: ${arch}`,
    );
  }
  return path.join(cwd, abiDir);
}

type BunFfiLoadResult =
  | { ok: true; mod: BunFFIModule }
  | { ok: false; error: Error };

async function loadBunFfi(): Promise<BunFfiLoadResult> {
  // Dynamic import keeps non-Bun bundlers from failing on the bare specifier.
  // The AOSP runtime is Bun, so this resolves; on Vitest/Node it throws and
  // the adapter degrades to a logged failure rather than crashing the boot.
  // We surface the real error so AOSP-only debugging on Android can see the
  // root cause instead of the generic "bun:ffi unavailable" message.
  try {
    /* Deliberate boundary cast: the real bun:ffi typings define dlopen
     * with a generic `Fns extends Record<string, FFIFunction>` constraint
     * we don't want leaking into adapter types; we only consume the
     * weakly-typed runtime shape. */
    // biome-ignore lint/suspicious/noTsIgnore: bun:ffi is a Bun runtime builtin loaded only on AOSP.
    // @ts-ignore
    const mod = (await import("bun:ffi")) as unknown as BunFFIModule;
    return { ok: true, mod };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

function dlopenLlama(ffi: BunFFIModule, libPath: string): LlamaSymbols {
  const T = ffi.FFIType;
  const handle = ffi.dlopen(libPath, {
    llama_backend_init: { args: [], returns: T.void },
    llama_backend_free: { args: [], returns: T.void },

    llama_model_free: { args: [T.ptr], returns: T.void },

    llama_free: { args: [T.ptr], returns: T.void },

    llama_get_model: { args: [T.ptr], returns: T.ptr },
    llama_model_get_vocab: { args: [T.ptr], returns: T.ptr },
    llama_model_n_embd: { args: [T.ptr], returns: T.i32 },
    llama_n_ctx: { args: [T.ptr], returns: T.u32 },
    llama_vocab_eos: { args: [T.ptr], returns: T.i32 },
    llama_vocab_is_eog: { args: [T.ptr, T.i32], returns: T.bool },

    llama_set_embeddings: { args: [T.ptr, T.bool], returns: T.void },
    llama_get_embeddings_seq: { args: [T.ptr, T.i32], returns: T.ptr },
    llama_get_embeddings: { args: [T.ptr], returns: T.ptr },
    llama_get_memory: { args: [T.ptr], returns: T.ptr },
    llama_memory_clear: { args: [T.ptr, T.bool], returns: T.void },

    llama_tokenize: {
      args: [T.ptr, T.ptr, T.i32, T.ptr, T.i32, T.bool, T.bool],
      returns: T.i32,
    },
    llama_token_to_piece: {
      args: [T.ptr, T.i32, T.ptr, T.i32, T.i32, T.bool],
      returns: T.i32,
    },

    // Skip llama_batch_get_one / llama_decode — see LlamaSymbols comment.
    // The pointer-style wrappers in ShimSymbols are bound below.

    llama_sampler_chain_add: { args: [T.ptr, T.ptr], returns: T.void },
    llama_sampler_init_temp: { args: [T.f32], returns: T.ptr },
    llama_sampler_init_top_p: { args: [T.f32, T.u32], returns: T.ptr },
    llama_sampler_init_dist: { args: [T.u32], returns: T.ptr },
    llama_sampler_init_greedy: { args: [], returns: T.ptr },
    llama_sampler_sample: { args: [T.ptr, T.ptr, T.i32], returns: T.i32 },
    llama_sampler_accept: { args: [T.ptr, T.i32], returns: T.void },
    llama_sampler_free: { args: [T.ptr], returns: T.void },
  });
  /* Deliberate boundary cast: bun:ffi.dlopen returns weakly-typed callable map */
  return handle.symbols as unknown as LlamaSymbols;
}

/**
 * dlopen libeliza-llama-shim.so and bind the pointer-style wrappers
 * around llama.cpp's struct-by-value entry points. The shim NEEDED-links
 * libllama.so, so libllama.so MUST already be loaded (via the earlier
 * `dlopenLlama` call) or resolvable through LD_LIBRARY_PATH before this
 * runs. On Android both conditions are satisfied — ElizaAgentService.java
 * sets LD_LIBRARY_PATH to the per-ABI asset dir, and we always dlopen
 * libllama.so first.
 */
function dlopenShim(ffi: BunFFIModule, shimPath: string): ShimSymbols {
  const T = ffi.FFIType;
  const handle = ffi.dlopen(shimPath, {
    eliza_llama_model_params_default: { args: [], returns: T.ptr },
    eliza_llama_model_params_free: { args: [T.ptr], returns: T.void },
    eliza_llama_model_params_set_n_gpu_layers: {
      args: [T.ptr, T.i32],
      returns: T.void,
    },
    eliza_llama_model_load_from_file: {
      args: [T.ptr, T.ptr],
      returns: T.ptr,
    },

    eliza_llama_context_params_default: { args: [], returns: T.ptr },
    eliza_llama_context_params_free: { args: [T.ptr], returns: T.void },
    eliza_llama_context_params_set_n_ctx: {
      args: [T.ptr, T.u32],
      returns: T.void,
    },
    eliza_llama_context_params_set_n_batch: {
      args: [T.ptr, T.u32],
      returns: T.void,
    },
    eliza_llama_context_params_set_n_ubatch: {
      args: [T.ptr, T.u32],
      returns: T.void,
    },
    eliza_llama_context_params_set_n_threads: {
      args: [T.ptr, T.i32],
      returns: T.void,
    },
    eliza_llama_context_params_set_n_threads_batch: {
      args: [T.ptr, T.i32],
      returns: T.void,
    },
    eliza_llama_context_params_set_embeddings: {
      args: [T.ptr, T.bool],
      returns: T.void,
    },
    eliza_llama_context_params_set_pooling_type: {
      args: [T.ptr, T.i32],
      returns: T.void,
    },
    eliza_llama_context_params_set_type_k: {
      args: [T.ptr, T.i32],
      returns: T.void,
    },
    eliza_llama_context_params_set_type_v: {
      args: [T.ptr, T.i32],
      returns: T.void,
    },
    eliza_llama_init_from_model: { args: [T.ptr, T.ptr], returns: T.ptr },

    eliza_llama_sampler_chain_params_default: { args: [], returns: T.ptr },
    eliza_llama_sampler_chain_params_free: {
      args: [T.ptr],
      returns: T.void,
    },
    eliza_llama_sampler_chain_init: { args: [T.ptr], returns: T.ptr },

    eliza_llama_batch_get_one: {
      args: [T.ptr, T.i32],
      returns: T.ptr,
    },
    eliza_llama_batch_free: { args: [T.ptr], returns: T.void },
    eliza_llama_decode: { args: [T.ptr, T.ptr], returns: T.i32 },
  });
  /* Deliberate boundary cast: bun:ffi.dlopen returns weakly-typed callable map */
  return handle.symbols as unknown as ShimSymbols;
}

function encodeCString(text: string): Uint8Array {
  const enc = new TextEncoder().encode(text);
  const buf = new Uint8Array(enc.length + 1);
  buf.set(enc, 0);
  buf[enc.length] = 0;
  return buf;
}

class AospLlamaAdapter implements AospLoader {
  private readonly ffi: BunFFIModule;
  private readonly sym: LlamaSymbols;
  private readonly shim: ShimSymbols;
  private model: Pointer | null = null;
  private ctx: Pointer | null = null;
  private vocab: Pointer | null = null;
  private nCtx = 0;
  private loadedPath: string | null = null;
  private backendInitialized = false;
  /**
   * Tracks whether the current ctx has had at least one successful
   * `llama_decode` call. `llama_memory_clear` segfaults on cuttlefish
   * x86_64 when called against a freshly-initialized ctx with no
   * decoded positions, so we only invoke it once we know the KV cache
   * has live state to wipe. Reset to `false` on every `loadModel` /
   * `unloadModel`.
   */
  private hasDecoded = false;

  constructor(ffi: BunFFIModule, sym: LlamaSymbols, shim: ShimSymbols) {
    this.ffi = ffi;
    this.sym = sym;
    this.shim = shim;
  }

  private ensureBackend(): void {
    if (this.backendInitialized) return;
    this.sym.llama_backend_init();
    this.backendInitialized = true;
  }

  currentModelPath(): string | null {
    return this.loadedPath;
  }

  async loadModel(args: AospLlamaLoadOptions): Promise<void> {
    this.ensureBackend();
    if (this.loadedPath === args.modelPath && this.ctx !== null) return;
    if (this.ctx !== null || this.model !== null) {
      await this.unloadModel();
    }

    // Resolve runtime tunables. The active-model coordinator only forwards
    // `{ modelPath }` today, so we backfill from env so AOSP doesn't run at
    // upstream defaults that under-use phone CPU cores.
    //
    // contextSize default: 16384. Llama-3.2-1B (the AOSP default chat
    // model) has a 128k native context window. The planner builds
    // ~12k-token prompts on every chat turn (system + tools + history +
    // user message). 16k fits comfortably with output reserve while
    // keeping KV-cache RAM under ~80 MB on cvd's 4 GB budget. The env
    // override lets builders push higher on real-device hardware where
    // RAM permits.
    const contextSize =
      args.contextSize ?? readEnvInt("ELIZA_LLAMA_N_CTX", 16384);
    // n_threads via the precedence chain. Never pass 0 — see
    // resolveThreads docblock for why "auto-detect" is dangerous on
    // Android.
    const maxThreads = resolveThreads(args.maxThreads);
    const useGpu = args.useGpu ?? false;
    const kvCacheType = resolveKvCacheType(
      args.modelPath,
      args.kvCacheType ??
        (args.cacheTypeK || args.cacheTypeV
          ? { k: args.cacheTypeK, v: args.cacheTypeV }
          : undefined),
    );

    // Materialize llama_model_params via the shim. The shim runs
    // llama_model_default_params() under the hood, so use_mmap=true,
    // use_mlock=false, n_gpu_layers=999 (or whatever upstream's defaults
    // are at the pinned tag) all land correctly. We pin n_gpu_layers=0
    // explicitly when the caller opts out of GPU so the value is
    // self-documenting in logs even though it matches the AOSP default.
    const modelParamsPtr = this.shim.eliza_llama_model_params_default();
    if (!modelParamsPtr) {
      throw new Error(
        "[aosp-llama] eliza_llama_model_params_default returned NULL (malloc failure?)",
      );
    }
    let modelPtr: Pointer = 0;
    try {
      if (!useGpu) {
        this.shim.eliza_llama_model_params_set_n_gpu_layers(modelParamsPtr, 0);
      }
      const pathBuf = encodeCString(args.modelPath);
      modelPtr = this.shim.eliza_llama_model_load_from_file(
        this.ffi.ptr(pathBuf),
        modelParamsPtr,
      );
    } finally {
      this.shim.eliza_llama_model_params_free(modelParamsPtr);
    }
    if (!modelPtr) {
      throw new Error(
        `[aosp-llama] llama_model_load_from_file returned NULL for ${args.modelPath}`,
      );
    }

    const ctxParamsPtr = this.shim.eliza_llama_context_params_default();
    if (!ctxParamsPtr) {
      this.sym.llama_model_free(modelPtr);
      throw new Error(
        "[aosp-llama] eliza_llama_context_params_default returned NULL (malloc failure?)",
      );
    }
    let ctxPtr: Pointer = 0;
    try {
      // Override the canonical defaults for the few fields that actually
      // matter on phones:
      //   - n_ctx: cap the context window (defaults to 0 = "from model"
      //     which can be huge on Llama-3-8B GGUFs and OOMs the device).
      //   - n_threads / n_threads_batch: parallelize generation + batch
      //     decode across the user's CPU cores. n_threads is on
      //     context_params (verified against b4500 llama.h:319-320),
      //     NOT model_params.
      //   - embeddings: leave the runtime toggle (`llama_set_embeddings`)
      //     to flip this per-call, but pre-allocate the buffers at init
      //     so the first embed() call doesn't pay an allocation tax.
      //   - pooling_type: pin to MEAN so `llama_get_embeddings_seq(ctx, 0)`
      //     always returns exactly `n_embd` floats. NONE would shape the
      //     ctx buffer as `n_outputs * n_embd` where n_outputs can be
      //     less than the input token count for output-pruning models —
      //     we'd read OOB on the mean-pool fallback. By forcing MEAN at
      //     init we collapse the embed() path to a single read.
      this.shim.eliza_llama_context_params_set_n_ctx(ctxParamsPtr, contextSize);
      // n_batch = 512 (AOSP default): the per-decode token cap. We chunk
      // longer prompts in the decode loop. Smaller chunks = more frequent
      // event-loop yields, so the service watchdog's HTTP probe doesn't
      // sit on a closed listener queue for the entire prompt prefill.
      // Empirically a 512-token chunk on cuttlefish CPU lands each
      // llama_decode call in ~6–8 s (Llama-3.2-1B), giving the HTTP
      // probe (30 s timeout) a realistic chance to wake the listener
      // between chunks. The previous default of 2048 ran each chunk
      // for ~30 s and triggered repeated probe failures.
      // n_ubatch = 512: matches the chunk size, upstream default for
      // phone CPU cache.
      const nBatchParam = readEnvInt("ELIZA_LLAMA_N_BATCH", 512);
      const nUBatchParam = readEnvInt("ELIZA_LLAMA_N_UBATCH", 512);
      this.shim.eliza_llama_context_params_set_n_batch(
        ctxParamsPtr,
        nBatchParam,
      );
      this.shim.eliza_llama_context_params_set_n_ubatch(
        ctxParamsPtr,
        nUBatchParam,
      );
      this.shim.eliza_llama_context_params_set_n_threads(
        ctxParamsPtr,
        maxThreads,
      );
      this.shim.eliza_llama_context_params_set_n_threads_batch(
        ctxParamsPtr,
        maxThreads,
      );
      this.shim.eliza_llama_context_params_set_embeddings(ctxParamsPtr, true);
      this.shim.eliza_llama_context_params_set_pooling_type(
        ctxParamsPtr,
        LLAMA_POOLING_TYPE_MEAN,
      );
      // KV-cache type override (TBQ for Bonsai, fp16 default for everything
      // else). When kvCacheType.k / .v are set we forward the resolved
      // ggml_type enum to the shim setters; otherwise we leave the cache at
      // llama.cpp's canonical default. Only the apothic fork-built libllama.so
      // understands TBQ3_0 / TBQ4_0 — using these against stock llama.cpp
      // would crash inside type_traits lookup.
      if (kvCacheType?.k !== undefined) {
        this.shim.eliza_llama_context_params_set_type_k(
          ctxParamsPtr,
          kvCacheTypeNameToEnum(kvCacheType.k),
        );
      }
      if (kvCacheType?.v !== undefined) {
        this.shim.eliza_llama_context_params_set_type_v(
          ctxParamsPtr,
          kvCacheTypeNameToEnum(kvCacheType.v),
        );
      }
      ctxPtr = this.shim.eliza_llama_init_from_model(modelPtr, ctxParamsPtr);
    } finally {
      this.shim.eliza_llama_context_params_free(ctxParamsPtr);
    }
    if (!ctxPtr) {
      this.sym.llama_model_free(modelPtr);
      throw new Error(
        `[aosp-llama] llama_init_from_model returned NULL for ${args.modelPath}`,
      );
    }

    this.model = modelPtr;
    this.ctx = ctxPtr;
    this.vocab = this.sym.llama_model_get_vocab(modelPtr);
    this.nCtx = this.sym.llama_n_ctx(ctxPtr);
    this.loadedPath = args.modelPath;
    this.hasDecoded = false;
    const nBatchEffective = readEnvInt("ELIZA_LLAMA_N_BATCH", 512);
    logger.info(
      `[aosp-llama] Loaded ${args.modelPath} (n_ctx=${this.nCtx}, n_batch=${nBatchEffective}, n_threads=${maxThreads}, gpu=${useGpu}, kv_k=${kvCacheType?.k ?? "f16"}, kv_v=${kvCacheType?.v ?? "f16"})`,
    );
  }

  async unloadModel(): Promise<void> {
    if (this.ctx !== null) {
      this.sym.llama_free(this.ctx);
      this.ctx = null;
    }
    if (this.model !== null) {
      this.sym.llama_model_free(this.model);
      this.model = null;
    }
    this.vocab = null;
    this.nCtx = 0;
    this.loadedPath = null;
    this.hasDecoded = false;
  }

  async generate(args: {
    prompt: string;
    stopSequences?: string[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> {
    if (this.ctx === null || this.model === null || this.vocab === null) {
      throw new Error("[aosp-llama] generate called before loadModel");
    }
    const ctx = this.ctx;
    const vocab = this.vocab;

    // 0. Reset KV cache for this turn. The b8198 cuttlefish build
    // segfaults when llama_memory_clear runs on a freshly-initialized
    // ctx (no positions yet), so we only wipe once we've decoded at
    // least one batch. The first generate() / embed() against a fresh
    // ctx skips the clear; subsequent calls always wipe before the
    // first chunk so prompts can land cleanly without stacking on top
    // of stale KV state.
    if (this.hasDecoded) {
      const memHandle = this.sym.llama_get_memory(ctx);
      if (memHandle) {
        this.sym.llama_memory_clear(memHandle, false);
      }
    }

    // 1. Tokenize the prompt. Two-pass: ask for length (n_tokens_max=0,
    // single-slot buffer — llama_tokenize never reads or writes through
    // the pointer when the cap is zero, but bun:ffi's ptr() helper
    // rejects zero-length TypedArrays with
    // `ArrayBufferView must have a length > 0`. A length-1 probe is the
    // smallest legal allocation that round-trips through ptr() without
    // a runtime exception. Then alloc and fill on the second pass.
    const promptBuf = encodeCString(args.prompt);
    const promptByteLen = promptBuf.length - 1; // exclude NUL
    const probe = new Int32Array(1);
    const requested = this.sym.llama_tokenize(
      vocab,
      this.ffi.ptr(promptBuf),
      promptByteLen,
      this.ffi.ptr(probe),
      0,
      true,
      false,
    );
    // llama_tokenize returns the negative of required length when n_tokens_max
    // is too small. With n_tokens_max=0 we always get a negative number.
    const required = requested < 0 ? -requested : requested;
    if (required <= 0) {
      throw new Error("[aosp-llama] llama_tokenize returned zero tokens");
    }
    const tokens = new Int32Array(required);
    const written = this.sym.llama_tokenize(
      vocab,
      this.ffi.ptr(promptBuf),
      promptByteLen,
      this.ffi.ptr(tokens),
      required,
      true,
      false,
    );
    if (written < 0) {
      throw new Error(
        `[aosp-llama] llama_tokenize second pass failed: ${written}`,
      );
    }

    // 2. Build a sampler chain: temp → top_p → dist (or greedy). The
    // sampler_chain_params struct is single-field (no_perf bool); the
    // shim materializes it with llama.cpp's default and we don't
    // override.
    const samplerParamsPtr =
      this.shim.eliza_llama_sampler_chain_params_default();
    if (!samplerParamsPtr) {
      throw new Error(
        "[aosp-llama] eliza_llama_sampler_chain_params_default returned NULL (malloc failure?)",
      );
    }
    let chain: Pointer = 0;
    try {
      chain = this.shim.eliza_llama_sampler_chain_init(samplerParamsPtr);
    } finally {
      this.shim.eliza_llama_sampler_chain_params_free(samplerParamsPtr);
    }
    if (!chain) {
      throw new Error("[aosp-llama] llama_sampler_chain_init returned NULL");
    }
    const temperature = args.temperature ?? 0.7;
    if (temperature <= 0) {
      this.sym.llama_sampler_chain_add(
        chain,
        this.sym.llama_sampler_init_greedy(),
      );
    } else {
      this.sym.llama_sampler_chain_add(
        chain,
        this.sym.llama_sampler_init_temp(temperature),
      );
      this.sym.llama_sampler_chain_add(
        chain,
        this.sym.llama_sampler_init_top_p(0.9, 1),
      );
      this.sym.llama_sampler_chain_add(
        chain,
        this.sym.llama_sampler_init_dist(0xffffffff),
      );
    }

    try {
      // 3. Decode the prompt batch.
      // llama.cpp's llama_decode rejects token-only batches when the
      // context is in embedding mode — the per-call assert is
      //   GGML_ASSERT((!batch_inp.token && batch_inp.embd) ||
      //               (batch_inp.token && !batch_inp.embd))
      // and a previous embed() call may have flipped the flag on the
      // shared context. Reset to OFF before every chat decode so the
      // batch shape that llama_batch_get_one produces (token-only)
      // matches what the decoder accepts, regardless of prior calls.
      this.sym.llama_set_embeddings(ctx, false);
      // Chunk the prompt into n_batch-sized pieces and feed them to
      // llama_decode one at a time. llama.cpp asserts
      //   GGML_ASSERT(n_tokens_all <= cparams.n_batch)
      // on the first decode if the prompt exceeds the configured n_batch
      // — and even with n_batch == n_ctx the planner routinely hands us
      // prompts that exceed n_ctx (system prompt + tools + history +
      // user msg). When that happens we keep the TAIL of the prompt
      // (the user's most recent message + closest context), reserving
      // headroom for the model to generate output. Truncating from the
      // tail would silently drop the user's question; truncating from
      // the head preserves the question at the cost of dropping the
      // earliest tools/history.
      // bun:ffi struct-by-value workaround: route llama_batch_get_one +
      // llama_decode through the shim. See ShimSymbols comment.
      // Decode chunk size is bounded by n_batch (set in loadModel).
      // Reading it here mirrors the parameter that loadModel committed
      // to via eliza_llama_context_params_set_n_batch.
      const nBatch = readEnvInt("ELIZA_LLAMA_N_BATCH", 2048);
      const maxOutputReserve = args.maxTokens ?? 512;
      // Reserve maxOutputReserve + n_batch (one ubatch slack) + an
      // empirical 25 % safety margin. llama.cpp's Flash-Attention sliding
      // memory allocator on the b8198 build returns
      //   decode: failed to find a memory slot for batch of size N
      // when the per-sequence KV slots get fragmented by repeated
      // back-to-back chunks even with positions still nominally free,
      // so we leave generous headroom rather than push to the limit.
      const promptCapacity = Math.max(
        1,
        Math.floor((this.nCtx - maxOutputReserve - nBatch) * 0.75),
      );
      let promptTokens = tokens;
      let promptLen = written;
      if (written > promptCapacity) {
        const head = written - promptCapacity;
        promptTokens = tokens.subarray(head);
        promptLen = promptCapacity;
        logger.warn(
          `[aosp-llama] prompt ${written} tokens > capacity ${promptCapacity} (n_ctx=${this.nCtx} - reserve ${maxOutputReserve}); dropping ${head} head tokens`,
        );
      }
      const prefillStart = Date.now();
      for (let offset = 0; offset < promptLen; offset += nBatch) {
        const chunkLen = Math.min(nBatch, promptLen - offset);
        const chunk = promptTokens.subarray(offset, offset + chunkLen);
        const promptBatchPtr = this.shim.eliza_llama_batch_get_one(
          this.ffi.ptr(chunk),
          chunkLen,
        );
        if (!promptBatchPtr) {
          throw new Error(
            "[aosp-llama] eliza_llama_batch_get_one returned NULL (malloc failure?)",
          );
        }
        const chunkStart = Date.now();
        let decodeRc: number;
        try {
          decodeRc = this.shim.eliza_llama_decode(ctx, promptBatchPtr);
        } finally {
          this.shim.eliza_llama_batch_free(promptBatchPtr);
        }
        if (decodeRc !== 0) {
          throw new Error(
            `[aosp-llama] llama_decode (prompt chunk @${offset}/${promptLen}) returned ${decodeRc}`,
          );
        }
        // Mark the ctx as decoded so subsequent generate()/embed() calls
        // will issue the leading llama_memory_clear safely.
        this.hasDecoded = true;
        // Per-chunk token-rate logging. Inform operators of real
        // throughput on whatever hardware is hosting bun. On cuttlefish
        // CPU + Llama-3.2-1B / Q4_K_M we expect ~30–60 tok/s prefill;
        // anything below 5 tok/s indicates n_threads not set, KV cache
        // thrashing, or the SIGSYS shim degrading something. Log at
        // info level so it's always visible without bumping LOG_LEVEL.
        const chunkElapsedMs = Date.now() - chunkStart;
        const tokPerSec =
          chunkElapsedMs > 0 ? (chunkLen * 1000) / chunkElapsedMs : 0;
        logger.info(
          `[aosp-llama] decode chunk ${offset}+${chunkLen}/${promptLen}: ${chunkElapsedMs}ms (${tokPerSec.toFixed(1)} tok/s)`,
        );
        // Yield to the event loop between chunks so the service
        // watchdog's /api/health probe (HEALTH_TIMEOUT_MS=30s) can
        // complete. Without this yield bun's single-threaded loop
        // sits inside FFI for the entire prompt decode (minutes on
        // cuttlefish CPU) and HTTP requests pile up at the listener.
        // setImmediate yields after I/O processing has had a chance
        // to run; queueMicrotask would yield AFTER the current task,
        // which on bun is the FFI call that just returned, so the
        // listener still gets to handle queued requests. We use
        // setImmediate as the canonical "yield to the event loop"
        // signal.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const prefillElapsedMs = Date.now() - prefillStart;
      const prefillTokPerSec =
        prefillElapsedMs > 0 ? (promptLen * 1000) / prefillElapsedMs : 0;
      logger.info(
        `[aosp-llama] prefill done: ${promptLen} tokens in ${prefillElapsedMs}ms (${prefillTokPerSec.toFixed(1)} tok/s overall)`,
      );

      // 4. Token loop.
      const maxTokens = args.maxTokens ?? 512;
      const stopSequences = args.stopSequences ?? [];
      const pieceBuf = new Uint8Array(256);
      const singleToken = new Int32Array(1);
      let output = "";
      const decodeStart = Date.now();
      let lastTokRateLog = decodeStart;

      for (let i = 0; i < maxTokens; i++) {
        const next = this.sym.llama_sampler_sample(chain, ctx, -1);
        if (this.sym.llama_vocab_is_eog(vocab, next)) break;
        this.sym.llama_sampler_accept(chain, next);

        const wrote = this.sym.llama_token_to_piece(
          vocab,
          next,
          this.ffi.ptr(pieceBuf),
          pieceBuf.length,
          0,
          false,
        );
        if (wrote > 0) {
          const piece = new TextDecoder().decode(pieceBuf.subarray(0, wrote));
          output += piece;
          if (stopSequences.some((s) => s.length > 0 && output.endsWith(s))) {
            for (const stop of stopSequences) {
              if (stop.length > 0 && output.endsWith(stop)) {
                output = output.slice(0, -stop.length);
                break;
              }
            }
            break;
          }
        }

        singleToken[0] = next;
        const stepBatchPtr = this.shim.eliza_llama_batch_get_one(
          this.ffi.ptr(singleToken),
          1,
        );
        if (!stepBatchPtr) {
          throw new Error(
            "[aosp-llama] eliza_llama_batch_get_one returned NULL (malloc failure?)",
          );
        }
        let stepRc: number;
        try {
          stepRc = this.shim.eliza_llama_decode(ctx, stepBatchPtr);
        } finally {
          this.shim.eliza_llama_batch_free(stepBatchPtr);
        }
        if (stepRc !== 0) {
          throw new Error(
            `[aosp-llama] llama_decode (step) returned ${stepRc}`,
          );
        }
        // Yield every 4 generated tokens. setImmediate every step
        // would cut sampling throughput by ~30 %; a stride of 4 stays
        // close to peak generation rate while keeping the listener
        // wake-up budget tight enough that the watchdog's HTTP probe
        // (30 s timeout) can complete mid-decode without the
        // BUSY-but-not-DEAD distinction being needed. Llama-3.2-1B on
        // cvd CPU lands ~3–8 tok/s, so 4 tokens = ~1 s per yield.
        if ((i & 3) === 3) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        // Log generation rate every ~10 s so operators can watch
        // throughput without polling the bun process. Frequent enough
        // to detect a stall, infrequent enough to avoid spamming logs
        // (10 s × ~5 tok/s = ~50 tokens between log lines).
        const now = Date.now();
        if (now - lastTokRateLog > 10_000) {
          const elapsedMs = now - decodeStart;
          const tokPerSec = elapsedMs > 0 ? ((i + 1) * 1000) / elapsedMs : 0;
          logger.info(
            `[aosp-llama] gen progress: ${i + 1}/${maxTokens} tokens, ${elapsedMs}ms (${tokPerSec.toFixed(1)} tok/s)`,
          );
          lastTokRateLog = now;
        }
      }
      const decodeElapsedMs = Date.now() - decodeStart;
      const decodeTokPerSec =
        decodeElapsedMs > 0 ? (output.length * 1000) / decodeElapsedMs : 0;
      logger.info(
        `[aosp-llama] gen done: ${output.length} chars in ${decodeElapsedMs}ms (~${decodeTokPerSec.toFixed(1)} char/s)`,
      );
      return output;
    } finally {
      this.sym.llama_sampler_free(chain);
    }
  }

  /**
   * Compute a sentence-level embedding for `input`. Single-context loader:
   * we toggle the loaded ctx into embeddings mode via `llama_set_embeddings`,
   * decode the tokenized input as one sequence, then read the per-sequence
   * pooled embedding.
   *
   * Pooling contract: `loadModel()` initialises the context with
   * `pooling_type = MEAN` (verified against b4500 llama.h enum), so
   * `llama_get_embeddings_seq(ctx, 0)` returns exactly `n_embd` floats and
   * we never need the per-token fallback path. If a future change ever
   * sets `pooling_type = NONE`, this method must reject — reading
   * `llama_get_embeddings(ctx)` for `written * n_embd` floats races with
   * llama.cpp's per-decode `n_outputs` and would over-read for
   * output-pruning models.
   *
   * Trade-off: the same context is used for generation and embeddings;
   * toggling between modes flushes the KV cache implicitly on the next
   * `llama_decode`, so repeated mode-switching is slow. Acceptable for a
   * mobile-first runtime where embeddings are infrequent (memory + RAG
   * indexing) compared to chat turns.
   */
  async embed(args: { input: string }): Promise<{
    embedding: number[];
    tokens: number;
  }> {
    if (this.ctx === null || this.model === null || this.vocab === null) {
      throw new Error("[aosp-llama] embed called before loadModel");
    }
    const ctx = this.ctx;
    const model = this.model;
    const vocab = this.vocab;

    // 0. Reset KV cache. See generate() for the hasDecoded gating
    // rationale (cuttlefish x86_64 segfault on a freshly-initialized
    // ctx).
    if (this.hasDecoded) {
      const memHandle = this.sym.llama_get_memory(ctx);
      if (memHandle) {
        this.sym.llama_memory_clear(memHandle, false);
      }
    }

    // 1. Tokenize the input. Embedding pipelines typically include the BOS
    //    token; we mirror generate() and pass add_special=true. Probe pass
    //    needs only a length, not storage, but bun:ffi's ptr() rejects
    //    zero-length TypedArrays — use a single-slot Int32Array, the
    //    smallest legal allocation that round-trips through ptr() without
    //    `ArrayBufferView must have a length > 0`.
    const inputBuf = encodeCString(args.input);
    const inputByteLen = inputBuf.length - 1;
    const probeOut = new Int32Array(1);
    const requested = this.sym.llama_tokenize(
      vocab,
      this.ffi.ptr(inputBuf),
      inputByteLen,
      this.ffi.ptr(probeOut),
      0,
      true,
      false,
    );
    const required = requested < 0 ? -requested : requested;
    if (required <= 0) {
      throw new Error(
        "[aosp-llama] llama_tokenize returned zero tokens for embed input",
      );
    }
    const tokens = new Int32Array(required);
    const written = this.sym.llama_tokenize(
      vocab,
      this.ffi.ptr(inputBuf),
      inputByteLen,
      this.ffi.ptr(tokens),
      required,
      true,
      false,
    );
    if (written < 0) {
      throw new Error(
        `[aosp-llama] llama_tokenize embed second pass failed: ${written}`,
      );
    }

    // 2. Switch ctx into embeddings mode, decode, then switch back. The
    //    next decode() implicitly clears KV cache state when the embeddings
    //    flag flips — `generate()` callers that ran before `embed()` see a
    //    fresh prompt anyway, so this is safe to do unconditionally.
    this.sym.llama_set_embeddings(ctx, true);
    try {
      // bun:ffi struct-by-value workaround: route through the shim's
      // pointer-style wrappers. See ShimSymbols.eliza_llama_batch_get_one
      // / eliza_llama_decode for the rationale.
      const batchPtr = this.shim.eliza_llama_batch_get_one(
        this.ffi.ptr(tokens),
        written,
      );
      if (!batchPtr) {
        throw new Error(
          "[aosp-llama] eliza_llama_batch_get_one returned NULL (malloc failure?)",
        );
      }
      let decodeRc: number;
      try {
        decodeRc = this.shim.eliza_llama_decode(ctx, batchPtr);
      } finally {
        this.shim.eliza_llama_batch_free(batchPtr);
      }
      if (decodeRc !== 0) {
        throw new Error(
          `[aosp-llama] llama_decode (embed) returned ${decodeRc}`,
        );
      }
      this.hasDecoded = true;

      const nEmbd = this.sym.llama_model_n_embd(model);
      if (nEmbd <= 0) {
        throw new Error(
          `[aosp-llama] llama_model_n_embd returned non-positive ${nEmbd}`,
        );
      }
      const byteLength = nEmbd * 4; // float32

      // Read the pooled per-sequence buffer. `loadModel` pinned
      // pooling_type = MEAN, so llama.cpp produces exactly `n_embd`
      // floats here. A NULL return means either pooling was disabled
      // (contract violation) or the model emitted no output for
      // sequence 0 — both cases are unrecoverable, so fail loudly.
      const pooledPtr = this.sym.llama_get_embeddings_seq(ctx, 0);
      if (!pooledPtr) {
        throw new Error(
          "[aosp-llama] llama_get_embeddings_seq returned NULL — pooling_type contract violated",
        );
      }
      const buf = this.ffi.toArrayBuffer(pooledPtr, 0, byteLength);
      // Copy off the ctx-owned buffer so the result outlives the next
      // llama_decode() call.
      const view = new Float32Array(buf.slice(0));
      return { embedding: Array.from(view), tokens: written };
    } finally {
      // Restore generation mode so the next `generate()` call doesn't get
      // hit with a reload-KV-cache stall on its first decode.
      this.sym.llama_set_embeddings(ctx, false);
    }
  }
}

let cachedAdapter: AospLlamaAdapter | null = null;

/**
 * Build (or return cached) AOSP loader. Returns null if the env opt-in is not
 * set, libllama.so / libeliza-llama-shim.so cannot be located, or `bun:ffi`
 * is unavailable. Each failure is logged once. Failures while
 * `ELIZA_LOCAL_LLAMA=1` is set are elevated to `error` because the user
 * explicitly opted in.
 */
async function buildAdapter(): Promise<AospLlamaAdapter | null> {
  if (cachedAdapter) return cachedAdapter;
  if (!isAospEnabled()) return null;

  let libPath: string;
  let shimPath: string;
  try {
    libPath = resolveLibllamaPath();
    shimPath = resolveLlamaShimPath();
  } catch (err) {
    logger.error(
      "[aosp-llama] Cannot resolve native library paths:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (!existsSync(libPath)) {
    logger.error(
      `[aosp-llama] ELIZA_LOCAL_LLAMA=1 but libllama.so missing at ${libPath}`,
    );
    return null;
  }
  if (!existsSync(shimPath)) {
    logger.error(
      `[aosp-llama] ELIZA_LOCAL_LLAMA=1 but libeliza-llama-shim.so missing at ${shimPath}. ` +
        `Re-run scripts/elizaos/compile-libllama.mjs to produce the bun:ffi struct-by-value shim.`,
    );
    return null;
  }

  const ffiResult = await loadBunFfi();
  if (ffiResult.ok === false) {
    logger.error(
      `[aosp-llama] ELIZA_LOCAL_LLAMA=1 but bun:ffi is unavailable on this runtime: ${ffiResult.error.message}`,
    );
    return null;
  }
  const ffi = ffiResult.mod;

  let symbols: LlamaSymbols;
  try {
    // Order matters: libllama.so must be loaded first so the shim's
    // NEEDED entry resolves at dlopen time. (LD_LIBRARY_PATH is the
    // runtime fallback, but loading libllama.so first guarantees the
    // symbols are already in the global namespace.)
    symbols = dlopenLlama(ffi, libPath);
  } catch (err) {
    logger.error(
      `[aosp-llama] dlopen failed for ${libPath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  let shim: ShimSymbols;
  try {
    shim = dlopenShim(ffi, shimPath);
  } catch (err) {
    logger.error(
      `[aosp-llama] dlopen failed for ${shimPath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  cachedAdapter = new AospLlamaAdapter(ffi, symbols, shim);
  return cachedAdapter;
}

/**
 * Register the AOSP llama.cpp FFI loader on the runtime. No-op on non-AOSP
 * builds (when `ELIZA_LOCAL_LLAMA !== "1"`). Returns true on successful
 * registration so the caller can confirm precedence.
 *
 * When DFlash is requested (a `draftModelPath` is on the load args, or
 * `ELIZA_DFLASH=1` is in env), `loadModel` and `generate` are routed to
 * the out-of-process llama-server adapter (`aosp-dflash-adapter.ts`) so
 * speculative decoding can use the upstream `--model-draft` + `--spec-type
 * dflash` flags. `embed()` always stays on the in-process FFI path.
 */
export async function registerAospLlamaLoader(
  runtime: RuntimeWithRegisterService,
): Promise<boolean> {
  if (!isAospEnabled()) return false;
  if (typeof runtime.registerService !== "function") return false;
  const adapter = await buildAdapter();
  if (!adapter) return false;

  // Lazy-construct the DFlash adapter on first use so we don't pay the
  // file-existence + chmod-bit checks on every boot. The dispatcher below
  // routes load/generate to it when a drafter is paired.
  const { buildDflashAdapter, shouldRouteViaDflash } = await import(
    "./aosp-dflash-adapter.js"
  );
  let dflashAdapter: ReturnType<typeof buildDflashAdapter> = null;
  let dflashProbed = false;
  const getDflashAdapter = () => {
    if (!dflashProbed) {
      dflashAdapter = buildDflashAdapter();
      dflashProbed = true;
      if (dflashAdapter) {
        logger.info(
          "[aosp-llama] DFlash spawn-and-route adapter ready (llama-server present in per-ABI asset dir)",
        );
      }
    }
    return dflashAdapter;
  };
  // Track which backend is active for currentModelPath() reporting.
  let activeBackend: "ffi" | "dflash" = "ffi";

  runtime.registerService(SERVICE_NAME, {
    // Accept the shared LocalInferenceLoader shape (`{ modelPath }`) AND the
    // AOSP-specific extension (`{ modelPath, kvCacheType?, draftModelPath?, … }`).
    // When draftModelPath is set (or ELIZA_DFLASH=1) and a llama-server binary
    // is staged for this ABI, route through the spawn-and-route DFlash adapter.
    loadModel: async (a: AospLlamaLoadOptions) => {
      if (shouldRouteViaDflash(a) && a.draftModelPath) {
        const df = getDflashAdapter();
        if (df) {
          // Tear down any FFI model that was loaded so we don't double-occupy
          // RAM with the in-process target weights.
          if (adapter.currentModelPath() !== null) {
            await adapter.unloadModel();
          }
          await df.loadModel({
            modelPath: a.modelPath,
            draftModelPath: a.draftModelPath,
            contextSize: a.contextSize,
            draftContextSize: a.draftContextSize,
            draftMin: a.draftMin,
            draftMax: a.draftMax,
            cacheTypeK: a.cacheTypeK,
            cacheTypeV: a.cacheTypeV,
            disableThinking: a.disableThinking,
          });
          activeBackend = "dflash";
          return;
        }
        logger.warn(
          "[aosp-llama] DFlash requested but llama-server binary missing; falling back to single-model FFI decode",
        );
      }
      activeBackend = "ffi";
      return adapter.loadModel(a);
    },
    unloadModel: async () => {
      if (activeBackend === "dflash") {
        const df = dflashAdapter;
        if (df) await df.unloadModel();
      } else {
        await adapter.unloadModel();
      }
    },
    currentModelPath: () =>
      activeBackend === "dflash"
        ? (dflashAdapter?.currentModelPath() ?? null)
        : adapter.currentModelPath(),
    generate: async (a: {
      prompt: string;
      stopSequences?: string[];
      maxTokens?: number;
      temperature?: number;
    }) => {
      if (activeBackend === "dflash") {
        const df = dflashAdapter;
        if (!df) {
          throw new Error(
            "[aosp-llama] DFlash adapter went away between loadModel and generate",
          );
        }
        return df.generate(a);
      }
      return adapter.generate(a);
    },
    // Embeddings stay on the in-process FFI path. DFlash is target+drafter
    // for token decode; llama-server's /embedding endpoint exists but the
    // model usually configured for chat doesn't have pooling enabled.
    embed: (a: { input: string }) => adapter.embed(a),
  });
  logger.info(
    "[aosp-llama] Registered native libllama.so loader (ELIZA_LOCAL_LLAMA=1)",
  );
  return true;
}

/** Test-only: drop the cached adapter so a fresh build can run. */
export function __resetForTests(): void {
  cachedAdapter = null;
}
