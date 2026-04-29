/**
 * AOSP-only loader for native llama.cpp via `bun:ffi`.
 *
 * Targets the apothic/llama.cpp-1bit-turboquant fork (commit
 *   https://github.com/Apothic-AI/llama.cpp-1bit-turboquant
 *   tag: main-b8198-b2b5273
 *   sha: b2b5273e8b275bb96362fe844a5202632eb3e52b
 * — the matching libllama.so is compiled by the AOSP build pipeline
 * against this same SHA via `scripts/miladyos/compile-libllama.mjs`).
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
 *     - llama_batch_get_one / llama_decode
 *     - llama_sampler_chain_add / llama_sampler_init_temp /
 *       llama_sampler_init_top_p / llama_sampler_init_dist /
 *       llama_sampler_init_greedy / llama_sampler_sample /
 *       llama_sampler_accept / llama_sampler_free
 *     - llama_get_model / llama_n_ctx / llama_model_n_embd
 *     - llama_set_embeddings / llama_get_embeddings_seq / llama_get_embeddings
 *   libmilady-llama-shim.so (dlopen'd second; NEEDED libllama.so):
 *     - milady_llama_model_params_default / *_free + per-field setters
 *     - milady_llama_model_load_from_file
 *     - milady_llama_context_params_default / *_free + per-field setters
 *     - milady_llama_init_from_model
 *     - milady_llama_sampler_chain_params_default / *_free
 *     - milady_llama_sampler_chain_init
 *
 * Struct-by-value handled via libmilady-llama-shim.so (NEEDED-links
 * libllama.so, ships in the same per-ABI asset dir). bun:ffi cannot pass
 * llama.cpp's by-value param structs (model_params, context_params,
 * sampler_chain_params) directly. The shim — built by
 * `scripts/miladyos/compile-libllama.mjs` from
 * `scripts/miladyos/llama-shim/milady_llama_shim.c` — exposes a
 * pointer-style API: `milady_llama_model_params_default()` returns a
 * malloc'd pointer initialized via `llama_model_default_params()`, then
 * field-by-field setters override the few values the adapter cares about
 * (n_gpu_layers, use_mmap, use_mlock, n_threads, n_ctx, etc.) before the
 * pointer is handed to `milady_llama_model_load_from_file()` /
 * `milady_llama_init_from_model()` / `milady_llama_sampler_chain_init()`,
 * each of which dereferences once into the real struct-by-value entry
 * point. This restores the canonical defaults — most importantly
 * model_params.use_mmap = true (was clobbered to false by the previous
 * zeroed-buffer workaround, which forced the loader to read entire
 * weights files into RAM on phones).
 *
 * Wired in via `ensure-local-inference-handler.ts`:
 *   - Trigger: `MILADY_LOCAL_LLAMA=1` in the AOSP agent process env.
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
 * processes that explicitly opted into `MILADY_LOCAL_LLAMA=1`.
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

  llama_batch_get_one: (tokens: Pointer, n_tokens: number) => Pointer;
  llama_decode: (ctx: Pointer, batch: Pointer) => number;

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
 * Strongly-typed view of the libmilady-llama-shim.so exports. The shim is
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
 * `check_tensors=false`, `n_batch`/`n_ubatch` left at upstream values,
 * `offload_kqv`/`flash_attn` not relevant on phone CPU, `no_perf` cosmetic)
 * are intentionally not bound. Adding one is a one-line edit here +
 * one-line edit in `dlopenShim` if a future LoadOptions field needs it.
 */
interface ShimSymbols {
  // model_params
  milady_llama_model_params_default: () => Pointer;
  milady_llama_model_params_free: (p: Pointer) => void;
  milady_llama_model_params_set_n_gpu_layers: (p: Pointer, v: number) => void;
  milady_llama_model_load_from_file: (
    path: Pointer,
    params: Pointer,
  ) => Pointer;

  // context_params
  milady_llama_context_params_default: () => Pointer;
  milady_llama_context_params_free: (p: Pointer) => void;
  milady_llama_context_params_set_n_ctx: (p: Pointer, v: number) => void;
  milady_llama_context_params_set_n_threads: (p: Pointer, v: number) => void;
  milady_llama_context_params_set_n_threads_batch: (
    p: Pointer,
    v: number,
  ) => void;
  milady_llama_context_params_set_embeddings: (p: Pointer, v: boolean) => void;
  milady_llama_context_params_set_pooling_type: (p: Pointer, v: number) => void;
  /**
   * type_k / type_v: ggml_type enum values for the K and V cache slots.
   * TBQ3_0 = 43 and TBQ4_0 = 44 are the apothic/llama.cpp-1bit-turboquant
   * additions; stock types (F16 = 1, Q4_0 = 2, Q8_0 = 8) work too. Setting
   * these flips the KV cache from fp16 to the chosen quant on the next
   * `llama_init_from_model` call. The CPU vec-dot path lives in
   * ggml/src/ggml-cpu/quants.c — this is the actual switch that turns on
   * the memory win on phones.
   */
  milady_llama_context_params_set_type_k: (p: Pointer, v: number) => void;
  milady_llama_context_params_set_type_v: (p: Pointer, v: number) => void;
  milady_llama_init_from_model: (model: Pointer, params: Pointer) => Pointer;

  // sampler_chain_params
  milady_llama_sampler_chain_params_default: () => Pointer;
  milady_llama_sampler_chain_params_free: (p: Pointer) => void;
  milady_llama_sampler_chain_init: (params: Pointer) => Pointer;
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
  /**
   * KV-cache type override. When undefined we auto-pick:
   *   - Bonsai-by-filename → { k: "tbq4_0", v: "tbq3_0" }
   *   - everything else    → undefined (let llama.cpp keep its fp16 default)
   * Env overrides:
   *   MILADY_LLAMA_CACHE_TYPE_K, MILADY_LLAMA_CACHE_TYPE_V (e.g. "tbq4_0").
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
const LLAMA_POOLING_TYPE_NONE = 0;
const LLAMA_POOLING_TYPE_MEAN = 1;

/**
 * GGML type ids used for KV-cache configuration. The base set comes from
 * ggml.h; TBQ3_0 / TBQ4_0 are the apothic/llama.cpp-1bit-turboquant fork
 * additions and only valid against the fork-built libllama.so + matching
 * Bonsai-8B-1bit GGUF model.
 *
 * Verified against
 *   ~/.cache/milady-android-agent/llama-cpp-main-b8198-b2b5273/ggml/include/ggml.h
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
 *   2. `MILADY_LLAMA_CACHE_TYPE_K` / `MILADY_LLAMA_CACHE_TYPE_V` env vars.
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
  const envK = readEnvKvCacheType("MILADY_LLAMA_CACHE_TYPE_K", env);
  const envV = readEnvKvCacheType("MILADY_LLAMA_CACHE_TYPE_V", env);
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
  return env.MILADY_LOCAL_LLAMA?.trim() === "1";
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
 * Resolve the libmilady-llama-shim.so path for the current ABI. Lives in
 * the same per-ABI dir as libllama.so; the dynamic linker resolves the
 * shim's NEEDED libllama.so via LD_LIBRARY_PATH.
 *
 * Exported for unit tests.
 */
export function resolveLlamaShimPath(
  arch: NodeJS.Architecture = process.arch,
  cwd: string = process.cwd(),
): string {
  return path.join(resolveAbiDir(arch, cwd), "libmilady-llama-shim.so");
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

    llama_tokenize: {
      args: [T.ptr, T.ptr, T.i32, T.ptr, T.i32, T.bool, T.bool],
      returns: T.i32,
    },
    llama_token_to_piece: {
      args: [T.ptr, T.i32, T.ptr, T.i32, T.i32, T.bool],
      returns: T.i32,
    },

    llama_batch_get_one: { args: [T.ptr, T.i32], returns: T.ptr },
    llama_decode: { args: [T.ptr, T.ptr], returns: T.i32 },

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
 * dlopen libmilady-llama-shim.so and bind the pointer-style wrappers
 * around llama.cpp's struct-by-value entry points. The shim NEEDED-links
 * libllama.so, so libllama.so MUST already be loaded (via the earlier
 * `dlopenLlama` call) or resolvable through LD_LIBRARY_PATH before this
 * runs. On Android both conditions are satisfied — MiladyAgentService.java
 * sets LD_LIBRARY_PATH to the per-ABI asset dir, and we always dlopen
 * libllama.so first.
 */
function dlopenShim(ffi: BunFFIModule, shimPath: string): ShimSymbols {
  const T = ffi.FFIType;
  const handle = ffi.dlopen(shimPath, {
    milady_llama_model_params_default: { args: [], returns: T.ptr },
    milady_llama_model_params_free: { args: [T.ptr], returns: T.void },
    milady_llama_model_params_set_n_gpu_layers: {
      args: [T.ptr, T.i32],
      returns: T.void,
    },
    milady_llama_model_load_from_file: {
      args: [T.ptr, T.ptr],
      returns: T.ptr,
    },

    milady_llama_context_params_default: { args: [], returns: T.ptr },
    milady_llama_context_params_free: { args: [T.ptr], returns: T.void },
    milady_llama_context_params_set_n_ctx: {
      args: [T.ptr, T.u32],
      returns: T.void,
    },
    milady_llama_context_params_set_n_threads: {
      args: [T.ptr, T.i32],
      returns: T.void,
    },
    milady_llama_context_params_set_n_threads_batch: {
      args: [T.ptr, T.i32],
      returns: T.void,
    },
    milady_llama_context_params_set_embeddings: {
      args: [T.ptr, T.bool],
      returns: T.void,
    },
    milady_llama_context_params_set_pooling_type: {
      args: [T.ptr, T.i32],
      returns: T.void,
    },
    milady_llama_context_params_set_type_k: {
      args: [T.ptr, T.i32],
      returns: T.void,
    },
    milady_llama_context_params_set_type_v: {
      args: [T.ptr, T.i32],
      returns: T.void,
    },
    milady_llama_init_from_model: { args: [T.ptr, T.ptr], returns: T.ptr },

    milady_llama_sampler_chain_params_default: { args: [], returns: T.ptr },
    milady_llama_sampler_chain_params_free: {
      args: [T.ptr],
      returns: T.void,
    },
    milady_llama_sampler_chain_init: { args: [T.ptr], returns: T.ptr },
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
    const contextSize = args.contextSize ?? readEnvInt("MILADY_LLAMA_N_CTX", 4096);
    const maxThreads = args.maxThreads ?? readEnvInt("MILADY_LLAMA_THREADS", 0);
    const useGpu = args.useGpu ?? false;
    const kvCacheType = resolveKvCacheType(args.modelPath, args.kvCacheType);

    // Materialize llama_model_params via the shim. The shim runs
    // llama_model_default_params() under the hood, so use_mmap=true,
    // use_mlock=false, n_gpu_layers=999 (or whatever upstream's defaults
    // are at the pinned tag) all land correctly. We pin n_gpu_layers=0
    // explicitly when the caller opts out of GPU so the value is
    // self-documenting in logs even though it matches the AOSP default.
    const modelParamsPtr = this.shim.milady_llama_model_params_default();
    if (!modelParamsPtr) {
      throw new Error(
        "[aosp-llama] milady_llama_model_params_default returned NULL (malloc failure?)",
      );
    }
    let modelPtr: Pointer = 0;
    try {
      if (!useGpu) {
        this.shim.milady_llama_model_params_set_n_gpu_layers(modelParamsPtr, 0);
      }
      const pathBuf = encodeCString(args.modelPath);
      modelPtr = this.shim.milady_llama_model_load_from_file(
        this.ffi.ptr(pathBuf),
        modelParamsPtr,
      );
    } finally {
      this.shim.milady_llama_model_params_free(modelParamsPtr);
    }
    if (!modelPtr) {
      throw new Error(
        `[aosp-llama] llama_model_load_from_file returned NULL for ${args.modelPath}`,
      );
    }

    const ctxParamsPtr = this.shim.milady_llama_context_params_default();
    if (!ctxParamsPtr) {
      this.sym.llama_model_free(modelPtr);
      throw new Error(
        "[aosp-llama] milady_llama_context_params_default returned NULL (malloc failure?)",
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
      this.shim.milady_llama_context_params_set_n_ctx(ctxParamsPtr, contextSize);
      this.shim.milady_llama_context_params_set_n_threads(
        ctxParamsPtr,
        maxThreads,
      );
      this.shim.milady_llama_context_params_set_n_threads_batch(
        ctxParamsPtr,
        maxThreads,
      );
      this.shim.milady_llama_context_params_set_embeddings(ctxParamsPtr, true);
      this.shim.milady_llama_context_params_set_pooling_type(
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
        this.shim.milady_llama_context_params_set_type_k(
          ctxParamsPtr,
          kvCacheTypeNameToEnum(kvCacheType.k),
        );
      }
      if (kvCacheType?.v !== undefined) {
        this.shim.milady_llama_context_params_set_type_v(
          ctxParamsPtr,
          kvCacheTypeNameToEnum(kvCacheType.v),
        );
      }
      ctxPtr = this.shim.milady_llama_init_from_model(modelPtr, ctxParamsPtr);
    } finally {
      this.shim.milady_llama_context_params_free(ctxParamsPtr);
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
    logger.info(
      `[aosp-llama] Loaded ${args.modelPath} (n_ctx=${this.nCtx}, n_threads=${maxThreads}, gpu=${useGpu}, kv_k=${kvCacheType?.k ?? "f16"}, kv_v=${kvCacheType?.v ?? "f16"})`,
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

    // 1. Tokenize the prompt. Two-pass: ask for length (n_tokens_max=0,
    // empty buffer — llama_tokenize never reads or writes through the
    // pointer when the cap is zero, so a zero-length probe array is
    // sufficient and avoids the wasteful 4-byte allocation), then alloc
    // and fill.
    const promptBuf = encodeCString(args.prompt);
    const promptByteLen = promptBuf.length - 1; // exclude NUL
    const probe = new Int32Array(0);
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
      this.shim.milady_llama_sampler_chain_params_default();
    if (!samplerParamsPtr) {
      throw new Error(
        "[aosp-llama] milady_llama_sampler_chain_params_default returned NULL (malloc failure?)",
      );
    }
    let chain: Pointer = 0;
    try {
      chain = this.shim.milady_llama_sampler_chain_init(samplerParamsPtr);
    } finally {
      this.shim.milady_llama_sampler_chain_params_free(samplerParamsPtr);
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
      const promptBatch = this.sym.llama_batch_get_one(
        this.ffi.ptr(tokens),
        written,
      );
      const decodeRc = this.sym.llama_decode(ctx, promptBatch);
      if (decodeRc !== 0) {
        throw new Error(
          `[aosp-llama] llama_decode (prompt) returned ${decodeRc}`,
        );
      }

      // 4. Token loop.
      const maxTokens = args.maxTokens ?? 512;
      const stopSequences = args.stopSequences ?? [];
      const pieceBuf = new Uint8Array(256);
      const singleToken = new Int32Array(1);
      let output = "";

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
        const stepBatch = this.sym.llama_batch_get_one(
          this.ffi.ptr(singleToken),
          1,
        );
        const stepRc = this.sym.llama_decode(ctx, stepBatch);
        if (stepRc !== 0) {
          throw new Error(
            `[aosp-llama] llama_decode (step) returned ${stepRc}`,
          );
        }
      }
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

    // 1. Tokenize the input. Embedding pipelines typically include the BOS
    //    token; we mirror generate() and pass add_special=true. Probe pass
    //    needs only a length, not storage — empty Int32Array avoids the
    //    pointless 4-byte allocation.
    const inputBuf = encodeCString(args.input);
    const inputByteLen = inputBuf.length - 1;
    const probeOut = new Int32Array(0);
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
      const batch = this.sym.llama_batch_get_one(this.ffi.ptr(tokens), written);
      const decodeRc = this.sym.llama_decode(ctx, batch);
      if (decodeRc !== 0) {
        throw new Error(
          `[aosp-llama] llama_decode (embed) returned ${decodeRc}`,
        );
      }

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
 * set, libllama.so / libmilady-llama-shim.so cannot be located, or `bun:ffi`
 * is unavailable. Each failure is logged once. Failures while
 * `MILADY_LOCAL_LLAMA=1` is set are elevated to `error` because the user
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
      `[aosp-llama] MILADY_LOCAL_LLAMA=1 but libllama.so missing at ${libPath}`,
    );
    return null;
  }
  if (!existsSync(shimPath)) {
    logger.error(
      `[aosp-llama] MILADY_LOCAL_LLAMA=1 but libmilady-llama-shim.so missing at ${shimPath}. ` +
        `Re-run scripts/miladyos/compile-libllama.mjs to produce the bun:ffi struct-by-value shim.`,
    );
    return null;
  }

  const ffiResult = await loadBunFfi();
  if (ffiResult.ok === false) {
    logger.error(
      `[aosp-llama] MILADY_LOCAL_LLAMA=1 but bun:ffi is unavailable on this runtime: ${ffiResult.error.message}`,
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
 * builds (when `MILADY_LOCAL_LLAMA !== "1"`). Returns true on successful
 * registration so the caller can confirm precedence.
 */
export async function registerAospLlamaLoader(
  runtime: RuntimeWithRegisterService,
): Promise<boolean> {
  if (!isAospEnabled()) return false;
  if (typeof runtime.registerService !== "function") return false;
  const adapter = await buildAdapter();
  if (!adapter) return false;
  runtime.registerService(SERVICE_NAME, {
    // Accept the shared LocalInferenceLoader shape (`{ modelPath }`) AND the
    // AOSP-specific extension (`{ modelPath, kvCacheType?, … }`) — callers
    // that don't know about TBQ pass the slim shape and the adapter
    // auto-detects from the filename.
    loadModel: (a: AospLlamaLoadOptions) => adapter.loadModel(a),
    unloadModel: () => adapter.unloadModel(),
    currentModelPath: () => adapter.currentModelPath(),
    generate: (a: {
      prompt: string;
      stopSequences?: string[];
      maxTokens?: number;
      temperature?: number;
    }) => adapter.generate(a),
    embed: (a: { input: string }) => adapter.embed(a),
  });
  logger.info(
    "[aosp-llama] Registered native libllama.so loader (MILADY_LOCAL_LLAMA=1)",
  );
  return true;
}

/** Test-only: drop the cached adapter so a fresh build can run. */
export function __resetForTests(): void {
  cachedAdapter = null;
}
