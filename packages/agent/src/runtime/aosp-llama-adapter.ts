/**
 * AOSP-only loader for native llama.cpp via `bun:ffi`.
 *
 * Targets llama.cpp upstream tag `b4500` (commit
 *   git@github.com:ggml-org/llama.cpp.git tags/b4500
 *   sha: a133566d34a1dd3693c504786963bf1b7b7d8c0e
 * — the matching libllama.so is compiled by the AOSP build pipeline against
 * this same SHA via `scripts/miladyos/compile-libllama.mjs`).
 *
 * Why b4500 (was b3490 in the initial spike):
 *   The previous pin predated the sampler-chain API rewrite and the
 *   model/vocab rename. dlopen succeeded but every renamed symbol resolved
 *   to NULL — the adapter would have thrown at the first inference call.
 *   b4500 is the first stable tag that exports all of the post-rewrite
 *   symbols this file binds (sampler chain, `llama_model_load_from_file`,
 *   `llama_init_from_model`, `llama_model_get_vocab`, `llama_vocab_eos`,
 *   `llama_vocab_is_eog`) AND the embedding helpers
 *   (`llama_set_embeddings`, `llama_get_embeddings_seq`,
 *   `llama_model_n_embd`).
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
interface ShimSymbols {
  // model_params
  milady_llama_model_params_default: () => Pointer;
  milady_llama_model_params_free: (p: Pointer) => void;
  milady_llama_model_params_set_n_gpu_layers: (p: Pointer, v: number) => void;
  milady_llama_model_params_set_use_mmap: (p: Pointer, v: boolean) => void;
  milady_llama_model_params_set_use_mlock: (p: Pointer, v: boolean) => void;
  milady_llama_model_params_set_vocab_only: (p: Pointer, v: boolean) => void;
  milady_llama_model_params_set_check_tensors: (p: Pointer, v: boolean) => void;
  milady_llama_model_load_from_file: (
    path: Pointer,
    params: Pointer,
  ) => Pointer;

  // context_params
  milady_llama_context_params_default: () => Pointer;
  milady_llama_context_params_free: (p: Pointer) => void;
  milady_llama_context_params_set_n_ctx: (p: Pointer, v: number) => void;
  milady_llama_context_params_set_n_batch: (p: Pointer, v: number) => void;
  milady_llama_context_params_set_n_ubatch: (p: Pointer, v: number) => void;
  milady_llama_context_params_set_n_threads: (p: Pointer, v: number) => void;
  milady_llama_context_params_set_n_threads_batch: (
    p: Pointer,
    v: number,
  ) => void;
  milady_llama_context_params_set_embeddings: (p: Pointer, v: boolean) => void;
  milady_llama_context_params_set_offload_kqv: (p: Pointer, v: boolean) => void;
  milady_llama_context_params_set_flash_attn: (p: Pointer, v: boolean) => void;
  milady_llama_context_params_set_pooling_type: (p: Pointer, v: number) => void;
  milady_llama_init_from_model: (model: Pointer, params: Pointer) => Pointer;

  // sampler_chain_params
  milady_llama_sampler_chain_params_default: () => Pointer;
  milady_llama_sampler_chain_params_free: (p: Pointer) => void;
  milady_llama_sampler_chain_params_set_no_perf: (
    p: Pointer,
    v: boolean,
  ) => void;
  milady_llama_sampler_chain_init: (params: Pointer) => Pointer;
}

interface RuntimeWithRegisterService {
  registerService?: (name: string, impl: unknown) => unknown;
}

/** Minimal subset of LocalInferenceLoader we satisfy here. */
interface AospLoader {
  loadModel(args: { modelPath: string }): Promise<void>;
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

const SERVICE_NAME = "localInferenceLoader";

function isAospEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MILADY_LOCAL_LLAMA?.trim() === "1";
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

async function loadBunFfi(): Promise<BunFFIModule | null> {
  // Dynamic import keeps non-Bun bundlers from failing on the bare specifier.
  // The AOSP runtime is Bun, so this resolves; on Vitest/Node it throws and
  // the adapter degrades to a logged failure rather than crashing the boot.
  const mod = (await import("bun:ffi").catch(
    () => null,
  )) as BunFFIModule | null;
  return mod ?? null;
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
    milady_llama_model_params_set_use_mmap: {
      args: [T.ptr, T.bool],
      returns: T.void,
    },
    milady_llama_model_params_set_use_mlock: {
      args: [T.ptr, T.bool],
      returns: T.void,
    },
    milady_llama_model_params_set_vocab_only: {
      args: [T.ptr, T.bool],
      returns: T.void,
    },
    milady_llama_model_params_set_check_tensors: {
      args: [T.ptr, T.bool],
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
    milady_llama_context_params_set_n_batch: {
      args: [T.ptr, T.u32],
      returns: T.void,
    },
    milady_llama_context_params_set_n_ubatch: {
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
    milady_llama_context_params_set_offload_kqv: {
      args: [T.ptr, T.bool],
      returns: T.void,
    },
    milady_llama_context_params_set_flash_attn: {
      args: [T.ptr, T.bool],
      returns: T.void,
    },
    milady_llama_context_params_set_pooling_type: {
      args: [T.ptr, T.i32],
      returns: T.void,
    },
    milady_llama_init_from_model: { args: [T.ptr, T.ptr], returns: T.ptr },

    milady_llama_sampler_chain_params_default: { args: [], returns: T.ptr },
    milady_llama_sampler_chain_params_free: {
      args: [T.ptr],
      returns: T.void,
    },
    milady_llama_sampler_chain_params_set_no_perf: {
      args: [T.ptr, T.bool],
      returns: T.void,
    },
    milady_llama_sampler_chain_init: { args: [T.ptr], returns: T.ptr },
  });
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

  async loadModel(args: { modelPath: string }): Promise<void> {
    this.ensureBackend();
    if (this.loadedPath === args.modelPath && this.ctx !== null) return;
    if (this.ctx !== null || this.model !== null) {
      await this.unloadModel();
    }

    // Materialize llama_model_params via the shim. The shim runs
    // llama_model_default_params() under the hood, so use_mmap=true,
    // use_mlock=false, n_gpu_layers=999 (or whatever upstream's defaults
    // are at the pinned tag) all land correctly. We don't override
    // anything here today — the canonical defaults are what we want for
    // the AOSP CPU-only path. Future GPU-layer overrides plug in via
    // milady_llama_model_params_set_n_gpu_layers().
    const modelParamsPtr = this.shim.milady_llama_model_params_default();
    if (!modelParamsPtr) {
      throw new Error(
        "[aosp-llama] milady_llama_model_params_default returned NULL (malloc failure?)",
      );
    }
    let modelPtr: Pointer = 0;
    try {
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
    logger.info(`[aosp-llama] Loaded ${args.modelPath} (n_ctx=${this.nCtx})`);
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

    // 1. Tokenize the prompt. Two-pass: ask for length, then alloc and fill.
    const promptBuf = encodeCString(args.prompt);
    const promptByteLen = promptBuf.length - 1; // exclude NUL
    const probe = new Int32Array(0);
    const requested = this.sym.llama_tokenize(
      vocab,
      this.ffi.ptr(promptBuf),
      promptByteLen,
      this.ffi.ptr(new Int32Array(1)),
      0,
      true,
      false,
    );
    void probe;
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
   * pooled embedding. When pooling is NONE (model wasn't trained with a
   * pooling head), we fall back to mean-pooling the per-token embeddings
   * from `llama_get_embeddings`.
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
    //    token; we mirror generate() and pass add_special=true.
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

      // Prefer the pooled per-sequence buffer. Models trained with a
      // pooling head (mean / cls / last) return a ready vector here.
      const pooledPtr = this.sym.llama_get_embeddings_seq(ctx, 0);
      if (pooledPtr) {
        const buf = this.ffi.toArrayBuffer(pooledPtr, 0, byteLength);
        // Copy off the ctx-owned buffer so the result outlives the next
        // llama_decode() call.
        const view = new Float32Array(buf.slice(0));
        return { embedding: Array.from(view), tokens: written };
      }

      // Fallback: pooling_type == NONE. The ctx exposes per-token
      // embeddings contiguously via `llama_get_embeddings`. Shape is
      // `[n_outputs * n_embd]`; we mean-pool across the n_outputs rows.
      const allPtr = this.sym.llama_get_embeddings(ctx);
      if (!allPtr) {
        throw new Error(
          "[aosp-llama] llama_get_embeddings returned NULL after decode",
        );
      }
      const allBuf = this.ffi.toArrayBuffer(allPtr, 0, written * byteLength);
      const allView = new Float32Array(allBuf);
      const pooled = new Array<number>(nEmbd);
      for (let i = 0; i < nEmbd; i += 1) pooled[i] = 0;
      for (let row = 0; row < written; row += 1) {
        const offset = row * nEmbd;
        for (let i = 0; i < nEmbd; i += 1) {
          pooled[i] = (pooled[i] ?? 0) + (allView[offset + i] ?? 0);
        }
      }
      const denom = written > 0 ? written : 1;
      for (let i = 0; i < nEmbd; i += 1) {
        pooled[i] = (pooled[i] ?? 0) / denom;
      }
      return { embedding: pooled, tokens: written };
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

  const ffi = await loadBunFfi();
  if (!ffi) {
    logger.error(
      "[aosp-llama] MILADY_LOCAL_LLAMA=1 but bun:ffi is unavailable on this runtime",
    );
    return null;
  }

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
    loadModel: (a: { modelPath: string }) => adapter.loadModel(a),
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
