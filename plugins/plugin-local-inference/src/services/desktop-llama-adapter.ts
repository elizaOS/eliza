/**
 * Desktop in-process llama.cpp adapter via `bun:ffi`.
 *
 * The desktop sibling of `plugins/plugin-aosp-local-inference/src/aosp-llama-adapter.ts`.
 * Loads the `libllama.{dylib,so,dll}` + `libeliza-llama-shim.{dylib,so,dll}`
 * pair built by `packages/app-core/scripts/build-llama-cpp-desktop-dylib.mjs`
 * into the agent process and exposes:
 *
 *   1. `loadDesktopLlama({modelPath, contextSize, gpuLayers, threads})` —
 *      mmap the GGUF, init a `llama_context`, return an opaque handle.
 *   2. `tokenize(text): Int32Array` — wraps `llama_tokenize` for the
 *      `LlmStreamingBinding` contract (`FfiStreamingRunner` consumes
 *      `Int32Array`, not strings).
 *   3. A `LlmStreamingBinding` implementation backed by the loaded ctx:
 *      open/prefill/next/cancel/close sessions, one sampler chain per
 *      session, single-flight serialised at the runner layer.
 *
 * Scope of this first cut:
 *   - Text generation only. Embeddings, vision (mmproj), slot save/restore,
 *     prewarm, parallel resize all stay on the subprocess `dflash-server`
 *     fallback. Each needs a separate native extension to the shim and is
 *     tracked in `FFI_BACKEND_WIREUP_PLAN.md`.
 *   - No speculative decoding in v1. `LlmStreamConfig.draftMin/draftMax/
 *     dflashDrafterPath` are silently ignored; a one-time warning fires.
 *
 * Memory + lifecycle:
 *   - `*_params_default()` returns a malloc'd pointer that MUST be freed
 *     via the matching `*_params_free()` after init returns. Wrapped in
 *     try/finally below.
 *   - The model + ctx live for the adapter's lifetime; `close()` frees
 *     both and the dlopen handles.
 *   - Each `llmStreamOpen` allocates a sampler chain that is freed on
 *     `llmStreamClose`. Sessions are leak-tracked via `activeSessions`.
 *
 * Non-Bun runtimes (Vitest under Node, Vite for the web shell) cannot
 * resolve `bun:ffi`. `loadBunFfi` does a dynamic import and returns
 * `{ ok: false }` on failure; the bootstrap returns null and the
 * dispatcher falls through to the subprocess path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
	LlmCtxHandle,
	LlmStreamingBinding,
} from "./llm-streaming-binding";
import type {
	LlmStreamConfig,
	LlmStreamHandle,
	LlmStreamStep,
} from "./voice/ffi-bindings";

// === bun:ffi shape (mirrors AOSP) ===========================================

type FFITypeEnum = {
	void: number;
	bool: number;
	i32: number;
	u32: number;
	i64: number;
	u64: number;
	f32: number;
	ptr: number;
	cstring: number;
};

type BunSymbolMap<TSymbols extends object> = {
	[K in keyof TSymbols]: TSymbols[K] extends (...args: infer A) => infer R
		? (...args: A) => R
		: never;
};

interface BunFFIModule {
	dlopen: <TSymbols extends object>(
		path: string,
		symbols: Record<string, { args: readonly number[]; returns: number }>,
	) => {
		symbols: BunSymbolMap<TSymbols>;
		close: () => void;
	};
	FFIType: FFITypeEnum;
	ptr: (typed: ArrayBufferView) => number;
	CString: new (
		addr: number,
		byteOffset?: number,
		byteLength?: number,
	) => string;
}

function isBunFFIModule(value: unknown): value is BunFFIModule {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { dlopen?: unknown }).dlopen === "function" &&
		typeof (value as { ptr?: unknown }).ptr === "function"
	);
}

type Pointer = number;

// === libllama symbols (subset needed for text generation) ===================

interface LlamaSymbols {
	llama_backend_init: () => void;
	llama_backend_free: () => void;
	llama_model_free: (model: Pointer) => void;
	llama_free: (ctx: Pointer) => void;
	llama_get_model: (ctx: Pointer) => Pointer;
	llama_model_get_vocab: (model: Pointer) => Pointer;
	llama_n_ctx: (ctx: Pointer) => number;
	llama_vocab_is_eog: (vocab: Pointer, token: number) => boolean;
	llama_set_embeddings: (ctx: Pointer, embeddings: boolean) => void;
	llama_get_memory: (ctx: Pointer) => Pointer;
	llama_memory_clear: (mem: Pointer, data: boolean) => void;
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
	llama_sampler_chain_add: (chain: Pointer, sampler: Pointer) => void;
	llama_sampler_init_temp: (t: number) => Pointer;
	llama_sampler_init_top_p: (p: number, min_keep: number) => Pointer;
	llama_sampler_init_top_k: (k: number) => Pointer;
	llama_sampler_init_dist: (seed: number) => Pointer;
	llama_sampler_init_greedy: () => Pointer;
	llama_sampler_sample: (smpl: Pointer, ctx: Pointer, idx: number) => number;
	llama_sampler_accept: (smpl: Pointer, token: number) => void;
	llama_sampler_free: (smpl: Pointer) => void;

	/**
	 * Upstream KV cache persistence. Both functions take a context pointer
	 * + UTF-8 NUL-terminated filepath. `save_file` writes the seq's KV
	 * state to disk; `load_file` rebuilds it. seq_id is the slot id —
	 * we use 0 in v1 (single conversation per ctx). Both return bytes
	 * written/read; 0 indicates failure.
	 *
	 * Token arrays are optional context the caller can save alongside the
	 * KV (so a reload knows what tokens are already prefilled). We pass
	 * NULL + 0 in v1 — the engine owns prompt token bookkeeping above
	 * the adapter.
	 */
	llama_state_seq_save_file: (
		ctx: Pointer,
		filepath: Pointer,
		seq_id: number,
		tokens: Pointer,
		n_token_count: number,
	) => number;
	llama_state_seq_load_file: (
		ctx: Pointer,
		filepath: Pointer,
		dest_seq_id: number,
		tokens_out: Pointer,
		n_token_capacity: number,
		n_token_count_out: Pointer,
	) => number;
}

// === libeliza-llama-shim symbols (struct-by-value workarounds) =============

interface ShimSymbols {
	eliza_llama_model_params_default: () => Pointer;
	eliza_llama_model_params_free: (p: Pointer) => void;
	eliza_llama_model_params_set_n_gpu_layers: (p: Pointer, v: number) => void;
	eliza_llama_model_params_set_use_mmap: (p: Pointer, v: boolean) => void;
	eliza_llama_model_params_set_use_mlock: (p: Pointer, v: boolean) => void;
	eliza_llama_model_load_from_file: (path: Pointer, params: Pointer) => Pointer;

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
	eliza_llama_context_params_set_offload_kqv: (p: Pointer, v: boolean) => void;
	eliza_llama_init_from_model: (model: Pointer, params: Pointer) => Pointer;

	eliza_llama_sampler_chain_params_default: () => Pointer;
	eliza_llama_sampler_chain_params_free: (p: Pointer) => void;
	eliza_llama_sampler_chain_init: (params: Pointer) => Pointer;

	eliza_llama_batch_get_one: (tokens: Pointer, n_tokens: number) => Pointer;
	eliza_llama_batch_free: (batch: Pointer) => void;
	eliza_llama_decode: (ctx: Pointer, batch: Pointer) => number;

	eliza_llama_log_silence: () => void;

	// === Speculative decoding (DFlash). When a drafter model is attached
	// === to the main ctx, `decode_unified` runs the verify-and-rewind
	// === cycle internally; `dflash_stats` exposes the per-step counters
	// === so we can populate `drafterDrafted` / `drafterAccepted` on
	// === LlmStreamStep.
	eliza_llama_context_attach_drafter: (
		main_ctx: Pointer,
		drafter_model: Pointer,
		n_ctx_draft: number,
		n_gpu_layers_draft: number,
		n_parallel: number,
	) => number;
	eliza_llama_context_detach_drafter: (main_ctx: Pointer) => void;
	eliza_llama_context_has_drafter: (main_ctx: Pointer) => number;
	eliza_llama_context_set_spec_mode: (
		main_ctx: Pointer,
		mode: number,
		draft_min: number,
		draft_max: number,
	) => number;
	eliza_llama_decode_unified: (ctx: Pointer, batch: Pointer) => number;
	/** Legacy 4-int32 telemetry: [drafted, accepted, rejected, last_status]. */
	eliza_llama_dflash_stats: (ctx: Pointer, out: Pointer) => void;
}

/**
 * Vision (mmproj/mtmd) shim symbols. Present only when the shim was built
 * with `-DELIZA_ENABLE_VISION=1`. Bound separately in a try/catch so the
 * absence of these symbols on a non-vision shim degrades gracefully to
 * `describeImage` throwing "vision build flag not set".
 *
 * Target ABI is the consolidated `tools/mtmd/mtmd.h` surface in llama.cpp
 * HEAD (the older `examples/llava/` path has been removed upstream).
 */
interface VisionShimSymbols {
	eliza_mtmd_init: (
		mmproj_path: Pointer,
		text_model: Pointer,
		use_gpu: boolean,
		n_threads: number,
	) => Pointer;
	eliza_mtmd_free: (ctx: Pointer) => void;
	eliza_mtmd_bitmap_init_rgb: (nx: number, ny: number, rgb: Pointer) => Pointer;
	eliza_mtmd_bitmap_free: (bm: Pointer) => void;
	eliza_mtmd_input_chunks_init: () => Pointer;
	eliza_mtmd_input_chunks_free: (c: Pointer) => void;
	eliza_mtmd_tokenize: (
		ctx: Pointer,
		out_chunks: Pointer,
		text: Pointer,
		add_special: boolean,
		parse_special: boolean,
		bitmaps: Pointer,
		// size_t (u64) on the C side — bun:ffi marshals u64 as bigint.
		n_bitmaps: bigint,
	) => number;
	// size_t returns / args — bun:ffi marshals u64 as bigint.
	eliza_mtmd_input_chunks_size: (c: Pointer) => bigint;
	eliza_mtmd_input_chunks_get: (c: Pointer, i: bigint) => Pointer;
	eliza_mtmd_input_chunk_type: (ch: Pointer) => number;
	eliza_mtmd_input_chunk_n_tokens: (ch: Pointer) => bigint;
	eliza_mtmd_encode_chunk: (ctx: Pointer, chunk: Pointer) => number;
	eliza_mtmd_output_embd: (ctx: Pointer) => Pointer;
}

// === Path resolution =======================================================

/**
 * Resolve `$ELIZA_STATE_DIR/local-inference/bin/dflash/<platform>-<arch>-<backend>/`
 * — where `packages/app-core/scripts/build-llama-cpp-desktop-dylib.mjs` writes
 * the desktop dylibs. `<backend>` defaults per platform; `ELIZA_DESKTOP_BACKEND`
 * env var overrides.
 */
export function resolveDesktopBinDir(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const stateDir =
		env.ELIZA_STATE_DIR ??
		env.MILADY_STATE_DIR ??
		path.join(os.homedir(), ".eliza");
	const platform =
		process.platform === "darwin"
			? "darwin"
			: process.platform === "linux"
				? "linux"
				: process.platform === "win32"
					? "windows"
					: null;
	if (platform === null) {
		throw new Error(
			`[desktop-llama] unsupported process.platform=${process.platform}`,
		);
	}
	const arch =
		process.arch === "arm64"
			? "arm64"
			: process.arch === "x64"
				? "x86_64"
				: null;
	if (arch === null) {
		throw new Error(`[desktop-llama] unsupported process.arch=${process.arch}`);
	}
	const backend =
		env.ELIZA_DESKTOP_BACKEND?.trim() ||
		(platform === "darwin" ? "metal" : platform === "linux" ? "vulkan" : "cpu");
	return path.join(
		stateDir,
		"local-inference",
		"bin",
		"dflash",
		`${platform}-${arch}-${backend}`,
	);
}

function dylibExt(): string {
	if (process.platform === "darwin") return "dylib";
	if (process.platform === "win32") return "dll";
	return "so";
}

export function resolveDesktopLibllamaPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return path.join(resolveDesktopBinDir(env), `libllama.${dylibExt()}`);
}

export function resolveDesktopShimPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return path.join(
		resolveDesktopBinDir(env),
		`libeliza-llama-shim.${dylibExt()}`,
	);
}

/**
 * Probe for the dylib pair without actually dlopen'ing. Used by the
 * bootstrap to decide whether to attempt the FFI path or fall through
 * to the subprocess.
 */
export function desktopLlamaDylibsPresent(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	try {
		return (
			fs.existsSync(resolveDesktopLibllamaPath(env)) &&
			fs.existsSync(resolveDesktopShimPath(env))
		);
	} catch {
		return false;
	}
}

// === bun:ffi dynamic load (non-Bun-safe) ===================================

type BunFfiLoadResult =
	| { ok: true; mod: BunFFIModule }
	| { ok: false; error: Error };

async function loadBunFfi(): Promise<BunFfiLoadResult> {
	try {
		// Indirect specifier so bundlers don't try to resolve `bun:ffi`
		// on non-Bun targets at build time.
		const spec = "bun:ffi";
		const mod = await import(spec);
		if (!isBunFFIModule(mod)) {
			throw new Error("bun:ffi did not expose the expected API");
		}
		return { ok: true, mod };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err : new Error(String(err)),
		};
	}
}

// === Symbol-binding tables =================================================

function bindLlama(ffi: BunFFIModule, libPath: string): LlamaSymbols {
	const T = ffi.FFIType;
	const handle = ffi.dlopen<LlamaSymbols>(libPath, {
		llama_backend_init: { args: [], returns: T.void },
		llama_backend_free: { args: [], returns: T.void },
		llama_model_free: { args: [T.ptr], returns: T.void },
		llama_free: { args: [T.ptr], returns: T.void },
		llama_get_model: { args: [T.ptr], returns: T.ptr },
		llama_model_get_vocab: { args: [T.ptr], returns: T.ptr },
		llama_n_ctx: { args: [T.ptr], returns: T.u32 },
		llama_vocab_is_eog: { args: [T.ptr, T.i32], returns: T.bool },
		llama_set_embeddings: { args: [T.ptr, T.bool], returns: T.void },
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
		llama_sampler_chain_add: { args: [T.ptr, T.ptr], returns: T.void },
		llama_sampler_init_temp: { args: [T.f32], returns: T.ptr },
		llama_sampler_init_top_p: { args: [T.f32, T.i32], returns: T.ptr },
		llama_sampler_init_top_k: { args: [T.i32], returns: T.ptr },
		llama_sampler_init_dist: { args: [T.u32], returns: T.ptr },
		llama_sampler_init_greedy: { args: [], returns: T.ptr },
		llama_sampler_sample: { args: [T.ptr, T.ptr, T.i32], returns: T.i32 },
		llama_sampler_accept: { args: [T.ptr, T.i32], returns: T.void },
		llama_sampler_free: { args: [T.ptr], returns: T.void },

		llama_state_seq_save_file: {
			args: [T.ptr, T.ptr, T.i32, T.ptr, T.i32],
			returns: T.i32,
		},
		llama_state_seq_load_file: {
			args: [T.ptr, T.ptr, T.i32, T.ptr, T.i32, T.ptr],
			returns: T.i32,
		},
	});
	return handle.symbols;
}

function bindShim(ffi: BunFFIModule, libPath: string): ShimSymbols {
	const T = ffi.FFIType;
	const handle = ffi.dlopen<ShimSymbols>(libPath, {
		eliza_llama_model_params_default: { args: [], returns: T.ptr },
		eliza_llama_model_params_free: { args: [T.ptr], returns: T.void },
		eliza_llama_model_params_set_n_gpu_layers: {
			args: [T.ptr, T.i32],
			returns: T.void,
		},
		eliza_llama_model_params_set_use_mmap: {
			args: [T.ptr, T.bool],
			returns: T.void,
		},
		eliza_llama_model_params_set_use_mlock: {
			args: [T.ptr, T.bool],
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
		eliza_llama_context_params_set_offload_kqv: {
			args: [T.ptr, T.bool],
			returns: T.void,
		},
		eliza_llama_init_from_model: { args: [T.ptr, T.ptr], returns: T.ptr },
		eliza_llama_sampler_chain_params_default: { args: [], returns: T.ptr },
		eliza_llama_sampler_chain_params_free: {
			args: [T.ptr],
			returns: T.void,
		},
		eliza_llama_sampler_chain_init: { args: [T.ptr], returns: T.ptr },
		eliza_llama_batch_get_one: { args: [T.ptr, T.i32], returns: T.ptr },
		eliza_llama_batch_free: { args: [T.ptr], returns: T.void },
		eliza_llama_decode: { args: [T.ptr, T.ptr], returns: T.i32 },
		eliza_llama_log_silence: { args: [], returns: T.void },

		eliza_llama_context_attach_drafter: {
			args: [T.ptr, T.ptr, T.u32, T.i32, T.i32],
			returns: T.i32,
		},
		eliza_llama_context_detach_drafter: {
			args: [T.ptr],
			returns: T.void,
		},
		eliza_llama_context_has_drafter: { args: [T.ptr], returns: T.i32 },
		eliza_llama_context_set_spec_mode: {
			args: [T.ptr, T.i32, T.i32, T.i32],
			returns: T.i32,
		},
		eliza_llama_decode_unified: { args: [T.ptr, T.ptr], returns: T.i32 },
		eliza_llama_dflash_stats: { args: [T.ptr, T.ptr], returns: T.void },
	});
	return handle.symbols;
}

/**
 * Bind the vision-only symbols. Returns null when the shim wasn't built
 * with `ELIZA_ENABLE_VISION=1` (dlopen rejects unresolved symbols on the
 * second pass; we attempt the bind in a try/catch and degrade to
 * "vision unavailable" on failure).
 */
function bindVision(
	ffi: BunFFIModule,
	libPath: string,
): VisionShimSymbols | null {
	const T = ffi.FFIType;
	try {
		const handle = ffi.dlopen<VisionShimSymbols>(libPath, {
			eliza_mtmd_init: {
				args: [T.ptr, T.ptr, T.bool, T.i32],
				returns: T.ptr,
			},
			eliza_mtmd_free: { args: [T.ptr], returns: T.void },
			eliza_mtmd_bitmap_init_rgb: {
				args: [T.u32, T.u32, T.ptr],
				returns: T.ptr,
			},
			eliza_mtmd_bitmap_free: { args: [T.ptr], returns: T.void },
			eliza_mtmd_input_chunks_init: { args: [], returns: T.ptr },
			eliza_mtmd_input_chunks_free: { args: [T.ptr], returns: T.void },
			eliza_mtmd_tokenize: {
				args: [T.ptr, T.ptr, T.ptr, T.bool, T.bool, T.ptr, T.u64],
				returns: T.i32,
			},
			eliza_mtmd_input_chunks_size: { args: [T.ptr], returns: T.u64 },
			eliza_mtmd_input_chunks_get: {
				args: [T.ptr, T.u64],
				returns: T.ptr,
			},
			eliza_mtmd_input_chunk_type: { args: [T.ptr], returns: T.i32 },
			eliza_mtmd_input_chunk_n_tokens: { args: [T.ptr], returns: T.u64 },
			eliza_mtmd_encode_chunk: {
				args: [T.ptr, T.ptr],
				returns: T.i32,
			},
			eliza_mtmd_output_embd: { args: [T.ptr], returns: T.ptr },
		});
		return handle.symbols;
	} catch {
		// Symbols absent — the shim was built without vision support.
		// `describeImage` will throw an actionable error.
		return null;
	}
}

// === Helpers ===============================================================

function encodeCString(text: string): Uint8Array {
	const enc = new TextEncoder().encode(text);
	const out = new Uint8Array(enc.length + 1);
	out.set(enc);
	out[enc.length] = 0;
	return out;
}

function decodeCStringBytes(buf: Uint8Array): string {
	const end = buf.indexOf(0);
	return new TextDecoder("utf-8").decode(end < 0 ? buf : buf.subarray(0, end));
}

/** Default thread count: half the logical cores (a sensible P-core proxy on Apple Silicon). */
function defaultThreads(env: NodeJS.ProcessEnv = process.env): number {
	const explicit = Number.parseInt(env.ELIZA_LLAMA_THREADS ?? "", 10);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	try {
		return Math.max(1, Math.floor((os.cpus()?.length ?? 4) / 2));
	} catch {
		return 4;
	}
}

// === Adapter ===============================================================

export interface DesktopLlamaLoadOptions {
	modelPath: string;
	contextSize?: number;
	nBatch?: number;
	nUBatch?: number;
	gpuLayers?: number;
	threads?: number;
	useMmap?: boolean;
	useMlock?: boolean;
}

interface DesktopSession {
	stream: bigint;
	sampler: Pointer;
	/** Which pool slot (ctx index) this session is pinned to. */
	ctxIdx: number;
	abort: { cancelled: boolean };
	finished: boolean;
	// Reusable single-token buffer for stepwise decode.
	tokenBuf: Int32Array;
	pieceBuf: Uint8Array;
	emittedFirstToken: boolean;
	/** Snapshotted at openSession; nextStep never re-reads has_drafter. */
	usingDrafter: boolean;
}

/**
 * Loaded desktop adapter. Holds the dlopen handles, model + ctx pool, and
 * a per-session table for the streaming-LLM contract.
 *
 * Multi-context pool: the adapter maintains an array of `llama_context`
 * instances (one per parallel slot). Sessions pin to a specific ctx via
 * `slotId` in `LlmStreamConfig`. `resizeParallel(N)` grows or shrinks
 * the pool — growing allocates new ctxs against the same model
 * (`eliza_llama_init_from_model`), shrinking frees the excess. Default
 * pool size is 1 (single-conversation mode); the engine's
 * `maybeAutoResizeParallel` grows it when conversation high-water mark
 * exceeds 1.
 *
 * Drafter (speculative decoding) is per-ctx: each ctx in the pool can
 * have its own drafter attached. v1 attaches lazily on the first
 * session opened against a ctx that requests one — the same drafter
 * model is loaded once and re-used for subsequent ctxs in the pool.
 */
export class DesktopLlamaAdapter {
	private modelPtr: Pointer | null = null;
	/** Pool of `llama_context` instances. Index 0 is allocated by `loadModel()`. */
	private ctxPool: Pointer[] = [];
	/**
	 * Serializes concurrent resizeParallel() callers. The C-side
	 * llama_init_from_model is itself thread-safe (Metal registry uses
	 * static std::mutex; CUDA/Vulkan ctx ctors are independent) and
	 * bun:ffi calls block the JS thread, so within one call the for-loop
	 * inside resizeParallel is already safe. This lock exists so future
	 * `await`s added inside resizeParallel cannot let two callers
	 * interleave pool mutations (push/pop on ctxPool, hasDecodedFlags,
	 * drafterAttached).
	 */
	private growLock: Promise<unknown> = Promise.resolve();
	/** Per-ctx KV-decoded flag (drives the `memory_clear` guard between sessions). */
	private hasDecodedFlags: boolean[] = [];
	/** Per-ctx attached drafter — `null` when no drafter on that ctx. */
	private drafterAttached: boolean[] = [];
	private vocabPtr: Pointer | null = null;
	private nextStreamId = 1n;
	private readonly sessions = new Map<bigint, DesktopSession>();
	/** Loaded drafter model (DFlash speculative decoding) — shared across ctxs in the pool. */
	private drafterModelPtr: Pointer | null = null;
	private drafterModelPath: string | null = null;
	/**
	 * `loadModel()` records its ctx params here so `resizeParallel()` can
	 * recreate ctxs with the same shape when growing the pool.
	 */
	private loadOpts: DesktopLlamaLoadOptions | null = null;

	/** Loaded mtmd context for the active mmproj GGUF, or null when unset. */
	private mtmdCtxPtr: Pointer | null = null;
	private mtmdMmprojPath: string | null = null;

	constructor(
		private readonly ffi: BunFFIModule,
		private readonly llama: LlamaSymbols,
		private readonly shim: ShimSymbols,
		/**
		 * Vision symbols. Null when the shim wasn't built with
		 * `ELIZA_ENABLE_VISION=1` — `describeImage` then throws an
		 * actionable error pointing at the build flag.
		 */
		private readonly vision: VisionShimSymbols | null = null,
	) {}

	visionSupported(): boolean {
		return this.vision !== null;
	}

	currentMmprojPath(): string | null {
		return this.mtmdMmprojPath;
	}

	/**
	 * Lazily load an mmproj GGUF via the mtmd ABI. Idempotent on the same
	 * path — repeated calls with the same `mmprojPath` are no-ops. Switching
	 * paths frees the old mtmd ctx and loads the new one.
	 */
	loadMmproj(mmprojPath: string): void {
		if (!this.vision) {
			throw new Error(
				"[desktop-llama] vision requested but the shim was not built with " +
					"-DELIZA_ENABLE_VISION=1. Rebuild via " +
					"`ELIZA_ENABLE_VISION=1 bun run --cwd packages/app-core scripts/build-llama-cpp-desktop-dylib.mjs`.",
			);
		}
		if (this.mtmdMmprojPath === mmprojPath && this.mtmdCtxPtr !== null) {
			return;
		}
		if (this.mtmdCtxPtr !== null) {
			this.vision.eliza_mtmd_free(this.mtmdCtxPtr);
			this.mtmdCtxPtr = null;
			this.mtmdMmprojPath = null;
		}
		if (!this.modelPtr) {
			throw new Error("[desktop-llama] loadMmproj before loadModel");
		}
		const pathBuf = encodeCString(mmprojPath);
		const threads = this.loadOpts?.threads ?? defaultThreads();
		// `use_gpu=true` matches subprocess `dflash-server` behaviour
		// (mtmd offloads the projector to whichever backend is active —
		// Metal on darwin, Vulkan/CUDA on linux/windows).
		const ctxPtr = this.vision.eliza_mtmd_init(
			this.ffi.ptr(pathBuf),
			this.modelPtr,
			true,
			threads,
		);
		if (!ctxPtr) {
			throw new Error(
				`[desktop-llama] eliza_mtmd_init failed for ${mmprojPath}`,
			);
		}
		this.mtmdCtxPtr = ctxPtr;
		this.mtmdMmprojPath = mmprojPath;
	}

	/**
	 * Describe an image via the mtmd (multimodal) ABI.
	 *
	 * Flow:
	 *   1. Init an mtmd ctx against the loaded text model + mmproj GGUF.
	 *   2. Decode `args.imageBytes` to raw RGB on the JS side. This step
	 *      requires an image-decoding library (sharp / jimp). `sharp` is
	 *      present in `packages/app-core` but NOT in this plugin's deps.
	 *      Until that's resolved this method throws an actionable error.
	 *   3. mtmd_bitmap_init_rgb → input_chunks_init → mtmd_tokenize.
	 *   4. mtmd_encode_chunk per image-chunk; pipe the resulting embedding
	 *      vector through llama_decode (requires an `embd`-flavour
	 *      llama_batch — the shim's current `eliza_llama_batch_get_one`
	 *      only wraps the *token* variant, so a new shim function
	 *      `eliza_llama_batch_get_one_embd(float*, n, n_embd)` will be
	 *      needed for the full path).
	 *   5. Standard generate loop with the user's prompt prefix.
	 *
	 * `args.imageBytes` is the raw image (PNG/JPEG/WebP). `args.mmprojPath`
	 * is the path to the multimodal projector GGUF (e.g. mmproj-eliza-1.gguf).
	 */
	async describeImage(args: {
		imageBytes: Uint8Array;
		mmprojPath: string;
		prompt?: string;
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
	}): Promise<{ text: string; projectorMs?: number; decodeMs?: number }> {
		if (!this.vision) {
			throw new Error(
				"[desktop-llama] describeImage: vision build flag not set. " +
					"Rebuild the shim with ELIZA_ENABLE_VISION=1.",
			);
		}
		const ctx = this.ctxPool[0];
		if (!ctx || !this.vocabPtr) {
			throw new Error("[desktop-llama] describeImage before model load");
		}
		this.loadMmproj(args.mmprojPath);
		if (!this.mtmdCtxPtr) {
			throw new Error("[desktop-llama] mtmd ctx unexpectedly null");
		}

		// Clear KV between image-describe turns so each call starts fresh.
		if (this.hasDecodedFlags[0]) {
			const mem = this.llama.llama_get_memory(ctx);
			this.llama.llama_memory_clear(mem, true);
		}

		// Reference args explicitly so unused-warnings stay quiet on the
		// stub. Once the JS-side RGB decode + embedding-batch shim wrapper
		// land, this method should consume `imageBytes`, `prompt`,
		// `maxTokens`, `temperature`, and `signal` end-to-end.
		void args.imageBytes;
		void args.prompt;
		void args.maxTokens;
		void args.temperature;
		void args.signal;

		// TODO(vision/mtmd): full describe path. Two missing pieces:
		//   1. JS-side image-bytes → RGB decode. `sharp` exists in
		//      `packages/app-core/package.json` but NOT in
		//      `plugins/plugin-local-inference/package.json`. Add it as
		//      a direct dep (or move the decode into a shared adapter
		//      that lives in app-core) before wiring this up.
		//   2. Shim wrapper for the embeddings-batch variant of
		//      `llama_batch` (`llama_batch_get_one` only handles tokens).
		//      Add e.g. `eliza_llama_batch_get_one_embd(float*, n, n_embd)`
		//      to `eliza_llama_shim.{c,h}` and bind it in `ShimSymbols`.
		throw new Error(
			"[desktop-llama] describeImage (mtmd path) not yet implemented. " +
				"Required: (a) image bytes → RGB decode (add `sharp` to " +
				"plugin-local-inference deps; it is already in app-core) and " +
				"(b) an embeddings-batch shim wrapper around llama_batch_get_one. " +
				"Until both land, callers fall through to the subprocess " +
				"`dflash-server` vision path.",
		);
	}

	/**
	 * Backward-compat alias for the primary ctx (pool index 0). Non-session
	 * operations (model load, drafter attach, slot save/restore, stats)
	 * operate on the primary ctx; session-specific methods use
	 * `this.ctxPool[session.ctxIdx]` directly.
	 */
	private get ctxPtr(): Pointer | null {
		return this.ctxPool[0] ?? null;
	}
	private set ctxPtr(v: Pointer | null) {
		if (v === null) {
			this.ctxPool = [];
			this.hasDecodedFlags = [];
			this.drafterAttached = [];
		} else {
			this.ctxPool[0] = v;
			this.hasDecodedFlags[0] = false;
			this.drafterAttached[0] = false;
		}
	}
	private get hasDecoded(): boolean {
		return this.hasDecodedFlags[0] ?? false;
	}
	private set hasDecoded(v: boolean) {
		if (this.ctxPool[0] !== undefined) this.hasDecodedFlags[0] = v;
	}

	/** Live parallel-slot count. Default 1; `resizeParallel(N)` grows/shrinks. */
	parallelSlots(): number {
		return this.ctxPool.length;
	}

	/**
	 * Grow or shrink the ctx pool to `target` slots. Growing allocates
	 * additional `llama_context` instances against the loaded model with
	 * the same parameters as the primary ctx (recorded in `loadOpts`).
	 * Shrinking frees the excess ctxs after first ensuring no session is
	 * still pinned to them. Throws when shrinking would orphan an active
	 * session; callers should drain those sessions first.
	 *
	 * Returns true when the pool size actually changed, false on no-op.
	 */
	async resizeParallel(target: number): Promise<boolean> {
		const prev = this.growLock;
		let release!: () => void;
		this.growLock = new Promise<void>((r) => {
			release = r;
		});
		try {
			await prev;
			if (!this.modelPtr || !this.loadOpts) {
				throw new Error("[desktop-llama] resizeParallel before model load");
			}
			if (target < 1) {
				throw new Error(
					`[desktop-llama] resizeParallel target must be >= 1, got ${target}`,
				);
			}
			const current = this.ctxPool.length;
			if (target === current) return false;
			if (target < current) {
				// Refuse to shrink while sessions are still pinned to outgoing slots.
				for (const sess of this.sessions.values()) {
					if (sess.ctxIdx >= target) {
						throw new Error(
							`[desktop-llama] cannot shrink pool to ${target}: session pinned to ctxIdx=${sess.ctxIdx}`,
						);
					}
				}
				for (let i = current - 1; i >= target; i--) {
					const ctx = this.ctxPool[i];
					if (ctx !== undefined) this.llama.llama_free(ctx);
					this.ctxPool.pop();
					this.hasDecodedFlags.pop();
					this.drafterAttached.pop();
				}
				return true;
			}
			// Grow: allocate (target - current) additional ctxs.
			for (let i = current; i < target; i++) {
				const cp = this.shim.eliza_llama_context_params_default();
				let nextCtx: Pointer;
				try {
					const ctxSize = this.loadOpts.contextSize ?? 4096;
					const nBatch = this.loadOpts.nBatch ?? 256;
					const threads = this.loadOpts.threads ?? defaultThreads();
					this.shim.eliza_llama_context_params_set_n_ctx(cp, ctxSize);
					this.shim.eliza_llama_context_params_set_n_batch(cp, nBatch);
					this.shim.eliza_llama_context_params_set_n_ubatch(
						cp,
						this.loadOpts.nUBatch ?? nBatch,
					);
					this.shim.eliza_llama_context_params_set_n_threads(cp, threads);
					this.shim.eliza_llama_context_params_set_n_threads_batch(cp, threads);
					this.shim.eliza_llama_context_params_set_embeddings(cp, false);
					this.shim.eliza_llama_context_params_set_offload_kqv(cp, true);
					nextCtx = this.shim.eliza_llama_init_from_model(this.modelPtr, cp);
				} finally {
					this.shim.eliza_llama_context_params_free(cp);
				}
				if (!nextCtx) {
					throw new Error(
						`[desktop-llama] llama_init_from_model failed when growing pool to ${target}`,
					);
				}
				this.ctxPool.push(nextCtx);
				this.hasDecodedFlags.push(false);
				this.drafterAttached.push(false);
			}
			return true;
		} finally {
			release();
		}
	}

	/**
	 * Load a DFlash drafter model and attach it to the main context. Once
	 * attached, `decode_unified` runs the verify-and-rewind speculative loop
	 * internally and `dflash_stats` exposes per-step accept/reject counters.
	 *
	 * Reuses the loaded main model's GPU layer count by default — the
	 * drafter is usually 4–8x smaller and benefits from the same backend.
	 * `n_parallel` mirrors the main ctx so concurrent sessions can share.
	 *
	 * Idempotent on the same path: if a drafter is already attached and the
	 * path matches, returns without reloading. Different path => detach +
	 * reload + reattach.
	 */
	/**
	 * Public attach-drafter API. Targets the primary ctx (pool slot 0).
	 * Per-ctx attach for other pool slots happens lazily inside
	 * `openSession()` when the session's config specifies a drafter path.
	 */
	attachDrafter(opts: {
		drafterPath: string;
		draftMin?: number;
		draftMax?: number;
	}): void {
		this.attachDrafterToCtx(0, opts);
	}

	/** Detach + free any drafter on the primary ctx (pool slot 0). */
	detachDrafter(): void {
		// Detach from every ctx in the pool that has one, then free the
		// shared drafter model.
		for (let i = 0; i < this.ctxPool.length; i++) {
			if (this.drafterAttached[i]) this.detachDrafterFromCtx(i);
		}
		if (this.drafterModelPtr !== null) {
			this.llama.llama_model_free(this.drafterModelPtr);
			this.drafterModelPtr = null;
		}
		this.drafterModelPath = null;
	}

	loadedDrafterPath(): string | null {
		return this.drafterModelPath;
	}

	/** Singleton-ish backend init — safe to call repeatedly per upstream. */
	initBackend(): void {
		this.shim.eliza_llama_log_silence();
		this.llama.llama_backend_init();
	}

	loadModel(opts: DesktopLlamaLoadOptions): void {
		if (this.modelPtr !== null) {
			throw new Error("[desktop-llama] model already loaded — unload first");
		}
		this.initBackend();
		this.loadOpts = opts;
		// --- model params ---
		const mp = this.shim.eliza_llama_model_params_default();
		try {
			this.shim.eliza_llama_model_params_set_n_gpu_layers(
				mp,
				opts.gpuLayers ?? 999, // 999 = "all layers on GPU" per llama.cpp convention
			);
			this.shim.eliza_llama_model_params_set_use_mmap(mp, opts.useMmap ?? true);
			this.shim.eliza_llama_model_params_set_use_mlock(
				mp,
				opts.useMlock ?? false,
			);
			const pathBuf = encodeCString(opts.modelPath);
			this.modelPtr = this.shim.eliza_llama_model_load_from_file(
				this.ffi.ptr(pathBuf),
				mp,
			);
		} finally {
			this.shim.eliza_llama_model_params_free(mp);
		}
		if (!this.modelPtr) {
			throw new Error(
				`[desktop-llama] llama_model_load_from_file failed for ${opts.modelPath}`,
			);
		}
		this.vocabPtr = this.llama.llama_model_get_vocab(this.modelPtr);

		// --- ctx params ---
		const cp = this.shim.eliza_llama_context_params_default();
		try {
			const ctxSize = opts.contextSize ?? 4096;
			const nBatch = opts.nBatch ?? 256;
			const threads = opts.threads ?? defaultThreads();
			this.shim.eliza_llama_context_params_set_n_ctx(cp, ctxSize);
			this.shim.eliza_llama_context_params_set_n_batch(cp, nBatch);
			this.shim.eliza_llama_context_params_set_n_ubatch(
				cp,
				opts.nUBatch ?? nBatch,
			);
			this.shim.eliza_llama_context_params_set_n_threads(cp, threads);
			this.shim.eliza_llama_context_params_set_n_threads_batch(cp, threads);
			this.shim.eliza_llama_context_params_set_embeddings(cp, false);
			this.shim.eliza_llama_context_params_set_offload_kqv(cp, true);
			this.ctxPtr = this.shim.eliza_llama_init_from_model(this.modelPtr, cp);
		} finally {
			this.shim.eliza_llama_context_params_free(cp);
		}
		if (!this.ctxPtr) {
			throw new Error("[desktop-llama] llama_init_from_model failed");
		}
		this.hasDecoded = false;
	}

	unloadModel(): void {
		for (const sess of this.sessions.values()) {
			this.llama.llama_sampler_free(sess.sampler);
		}
		this.sessions.clear();
		// Free mtmd ctx (vision) before the main ctx — the mtmd context is
		// bound to the text model and must outlive neither the model nor
		// the active llama ctx.
		if (this.mtmdCtxPtr !== null && this.vision) {
			this.vision.eliza_mtmd_free(this.mtmdCtxPtr);
			this.mtmdCtxPtr = null;
			this.mtmdMmprojPath = null;
		}
		// Detach + free the drafter BEFORE freeing any main ctx — the
		// drafter is borrowed via the primary ctx's shim slot. `llama_free`
		// on the main ctx is otherwise unsafe while a drafter ctx
		// references it.
		this.detachDrafter();
		// Free every ctx in the pool. The pool is in allocation order;
		// freeing back-to-front keeps the implicit slot ordering stable.
		for (let i = this.ctxPool.length - 1; i >= 0; i--) {
			const ctx = this.ctxPool[i];
			if (ctx !== undefined) this.llama.llama_free(ctx);
		}
		this.ctxPool = [];
		this.hasDecodedFlags = [];
		this.drafterAttached = [];
		if (this.modelPtr !== null) {
			this.llama.llama_model_free(this.modelPtr);
			this.modelPtr = null;
		}
		this.vocabPtr = null;
		this.loadOpts = null;
	}

	close(): void {
		this.unloadModel();
		this.llama.llama_backend_free();
	}

	/** Tokenize `text` against the loaded vocab. Two-pass — first call sizes, second writes. */
	tokenize(text: string): Int32Array {
		if (!this.vocabPtr) {
			throw new Error("[desktop-llama] tokenize() before loadModel()");
		}
		const textBuf = encodeCString(text);
		// First pass — pass cap 0, llama_tokenize returns the negative count needed.
		const need = this.llama.llama_tokenize(
			this.vocabPtr,
			this.ffi.ptr(textBuf),
			textBuf.length - 1, // exclude trailing NUL
			this.ffi.ptr(new Int32Array(1)), // dummy non-null buffer
			0,
			true, // add_special (BOS)
			false, // parse_special
		);
		const cap = Math.abs(need);
		if (cap === 0) return new Int32Array(0);
		const out = new Int32Array(cap);
		const written = this.llama.llama_tokenize(
			this.vocabPtr,
			this.ffi.ptr(textBuf),
			textBuf.length - 1,
			this.ffi.ptr(out),
			cap,
			true,
			false,
		);
		if (written < 0) {
			throw new Error(
				`[desktop-llama] llama_tokenize returned ${written} (buffer too small)`,
			);
		}
		return out.subarray(0, written);
	}

	// === LlmStreamingBinding plumbing =====================================

	createBinding(): LlmStreamingBinding {
		return {
			llmStreamSupported: () => true,
			llmStreamOpen: (args) => this.openSession(args.config),
			llmStreamPrefill: (args) => this.prefillSession(args.stream, args.tokens),
			llmStreamNext: (args) =>
				this.nextStep(args.stream, args.maxTokensPerStep, args.maxTextBytes),
			llmStreamCancel: (stream) => this.cancelSession(stream),
			llmStreamClose: (stream) => this.closeSession(stream),
			llmStreamSaveSlot: (args) =>
				this.saveSlotForStream(args.stream, args.filename),
			llmStreamRestoreSlot: (args) =>
				this.restoreSlotForStream(args.stream, args.filename),
		};
	}

	/**
	 * Persist the ctx's KV state to `filename`. The ctx is the one this
	 * `stream` is pinned to (via `session.ctxIdx`) — multi-slot pools route
	 * save/restore to the session's specific ctx so concurrent conversations
	 * persist independently.
	 */
	private saveSlotForStream(stream: LlmStreamHandle, filename: string): void {
		const sess = this.requireSession(stream);
		const ctx = this.ctxPool[sess.ctxIdx];
		if (!ctx) throw new Error("[desktop-llama] saveSlot ctx gone");
		const pathBuf = encodeCString(filename);
		const written = this.llama.llama_state_seq_save_file(
			ctx,
			this.ffi.ptr(pathBuf),
			0, // seq_id — single seq per ctx; multi-ctx covers parallel use
			this.ffi.ptr(new Int32Array(1)),
			0,
		);
		if (written <= 0) {
			throw new Error(
				`[desktop-llama] llama_state_seq_save_file returned ${written} for ${filename}`,
			);
		}
	}

	private restoreSlotForStream(
		stream: LlmStreamHandle,
		filename: string,
	): void {
		const sess = this.requireSession(stream);
		const ctx = this.ctxPool[sess.ctxIdx];
		if (!ctx) throw new Error("[desktop-llama] restoreSlot ctx gone");
		const pathBuf = encodeCString(filename);
		const countOut = new Int32Array(1);
		const read = this.llama.llama_state_seq_load_file(
			ctx,
			this.ffi.ptr(pathBuf),
			0,
			this.ffi.ptr(new Int32Array(1)),
			0,
			this.ffi.ptr(countOut),
		);
		if (read <= 0) {
			throw new Error(
				`[desktop-llama] llama_state_seq_load_file returned ${read} for ${filename}`,
			);
		}
		// Mark hasDecoded on this ctx so future openSession calls clear KV.
		this.hasDecodedFlags[sess.ctxIdx] = true;
	}

	/**
	 * Top-level slot save/restore for callers that don't have a session
	 * handle. Always targets ctx pool slot 0 — the primary conversation
	 * slot used by single-conversation mode. Kept for backward-compat with
	 * earlier wiring that called these without a stream context.
	 */
	saveSlot(filename: string): void {
		const ctx = this.ctxPool[0];
		if (!ctx) throw new Error("[desktop-llama] saveSlot before model load");
		const pathBuf = encodeCString(filename);
		const written = this.llama.llama_state_seq_save_file(
			ctx,
			this.ffi.ptr(pathBuf),
			0,
			this.ffi.ptr(new Int32Array(1)),
			0,
		);
		if (written <= 0) {
			throw new Error(
				`[desktop-llama] llama_state_seq_save_file returned ${written} for ${filename}`,
			);
		}
	}

	restoreSlot(filename: string): void {
		const ctx = this.ctxPool[0];
		if (!ctx) throw new Error("[desktop-llama] restoreSlot before model load");
		const pathBuf = encodeCString(filename);
		const countOut = new Int32Array(1);
		const read = this.llama.llama_state_seq_load_file(
			ctx,
			this.ffi.ptr(pathBuf),
			0,
			this.ffi.ptr(new Int32Array(1)),
			0,
			this.ffi.ptr(countOut),
		);
		if (read <= 0) {
			throw new Error(
				`[desktop-llama] llama_state_seq_load_file returned ${read} for ${filename}`,
			);
		}
		this.hasDecodedFlags[0] = true;
	}

	getCtxHandle(): LlmCtxHandle {
		if (!this.ctxPtr) {
			throw new Error("[desktop-llama] no context loaded");
		}
		return BigInt(this.ctxPtr);
	}

	private openSession(config: LlmStreamConfig): LlmStreamHandle {
		if (this.ctxPool.length === 0) {
			throw new Error("[desktop-llama] llmStreamOpen before model load");
		}
		// Route this session to a ctx in the pool. `slotId` is the caller's
		// explicit pin (e.g. conversation registry); modulo by pool size so
		// the assignment is stable + safe regardless of how N relates to
		// slot id. slotId < 0 (any-free-slot) round-robins via stream id.
		const ctxIdx =
			config.slotId >= 0
				? config.slotId % this.ctxPool.length
				: Number(this.nextStreamId % BigInt(this.ctxPool.length));
		const ctx = this.ctxPool[ctxIdx];
		if (ctx === undefined) {
			throw new Error(
				`[desktop-llama] ctx pool index ${ctxIdx} missing (pool size ${this.ctxPool.length})`,
			);
		}
		// Wipe KV between sessions if this ctx has decoded — first session
		// per ctx leaves the cache pristine, otherwise we'd hit the
		// seq_id_max segv path.
		if (this.hasDecodedFlags[ctxIdx]) {
			const mem = this.llama.llama_get_memory(ctx);
			this.llama.llama_memory_clear(mem, true);
		}
		// Speculative decoding: drafter attach is per-ctx. Attach lazily
		// when this session requests one. We track per-ctx attachment in
		// `drafterAttached[ctxIdx]` so we don't re-attach unnecessarily.
		if (config.dflashDrafterPath) {
			this.attachDrafterToCtx(ctxIdx, {
				drafterPath: config.dflashDrafterPath,
				draftMin: config.draftMin,
				draftMax: config.draftMax,
			});
		} else if (this.drafterAttached[ctxIdx]) {
			// No drafter requested but this ctx still has one — detach so
			// plain decode runs.
			this.detachDrafterFromCtx(ctxIdx);
		}
		const usingDrafter = this.drafterAttached[ctxIdx] === true;
		// Sampler chain.
		const sp = this.shim.eliza_llama_sampler_chain_params_default();
		let sampler: Pointer;
		try {
			sampler = this.shim.eliza_llama_sampler_chain_init(sp);
		} finally {
			this.shim.eliza_llama_sampler_chain_params_free(sp);
		}
		if (config.topK > 0) {
			this.llama.llama_sampler_chain_add(
				sampler,
				this.llama.llama_sampler_init_top_k(config.topK),
			);
		}
		if (config.topP > 0 && config.topP < 1) {
			this.llama.llama_sampler_chain_add(
				sampler,
				this.llama.llama_sampler_init_top_p(config.topP, 1),
			);
		}
		if (config.temperature > 0) {
			this.llama.llama_sampler_chain_add(
				sampler,
				this.llama.llama_sampler_init_temp(config.temperature),
			);
			this.llama.llama_sampler_chain_add(
				sampler,
				this.llama.llama_sampler_init_dist(0xdeadbeef),
			);
		} else {
			this.llama.llama_sampler_chain_add(
				sampler,
				this.llama.llama_sampler_init_greedy(),
			);
		}

		const stream = this.nextStreamId;
		this.nextStreamId += 1n;
		this.sessions.set(stream, {
			stream,
			sampler,
			ctxIdx,
			abort: { cancelled: false },
			finished: false,
			tokenBuf: new Int32Array(1),
			pieceBuf: new Uint8Array(256),
			emittedFirstToken: false,
			usingDrafter,
		});
		return stream;
	}

	/**
	 * Per-ctx drafter attach. Loads the drafter model once (shared across
	 * all ctxs in the pool) and attaches it to `ctxPool[ctxIdx]` via the
	 * shim. Idempotent on same path + same ctx.
	 */
	private attachDrafterToCtx(
		ctxIdx: number,
		opts: {
			drafterPath: string;
			draftMin?: number;
			draftMax?: number;
		},
	): void {
		const ctx = this.ctxPool[ctxIdx];
		if (!ctx) {
			throw new Error(`[desktop-llama] attachDrafter: no ctx at ${ctxIdx}`);
		}
		if (
			this.drafterAttached[ctxIdx] &&
			this.drafterModelPath === opts.drafterPath
		) {
			return;
		}
		if (
			this.drafterModelPtr !== null &&
			this.drafterModelPath !== opts.drafterPath
		) {
			throw new Error(
				`[desktop-llama] drafter path immutable for pool lifecycle: ` +
					`loaded='${this.drafterModelPath}', requested='${opts.drafterPath}'. ` +
					`Call detachDrafter() (frees the shared model and detaches from all ctxs) ` +
					`before switching paths.`,
			);
		}
		// Load model once if not already loaded.
		if (this.drafterModelPtr === null) {
			const mp = this.shim.eliza_llama_model_params_default();
			try {
				this.shim.eliza_llama_model_params_set_n_gpu_layers(mp, 999);
				this.shim.eliza_llama_model_params_set_use_mmap(mp, true);
				const pathBuf = encodeCString(opts.drafterPath);
				this.drafterModelPtr = this.shim.eliza_llama_model_load_from_file(
					this.ffi.ptr(pathBuf),
					mp,
				);
			} finally {
				this.shim.eliza_llama_model_params_free(mp);
			}
			if (!this.drafterModelPtr) {
				throw new Error(
					`[desktop-llama] drafter model load failed for ${opts.drafterPath}`,
				);
			}
			this.drafterModelPath = opts.drafterPath;
		}
		// Attach the (shared) model to this ctx.
		const rc = this.shim.eliza_llama_context_attach_drafter(
			ctx,
			this.drafterModelPtr,
			(this.loadOpts?.contextSize ?? 4096) as number,
			999,
			1,
		);
		if (rc !== 0) {
			throw new Error(
				`[desktop-llama] eliza_llama_context_attach_drafter rc=${rc}`,
			);
		}
		this.shim.eliza_llama_context_set_spec_mode(
			ctx,
			1,
			opts.draftMin ?? 4,
			opts.draftMax ?? 16,
		);
		this.drafterAttached[ctxIdx] = true;
	}

	private detachDrafterFromCtx(ctxIdx: number): void {
		const ctx = this.ctxPool[ctxIdx];
		if (!ctx) return;
		if (this.shim.eliza_llama_context_has_drafter(ctx) === 1) {
			this.shim.eliza_llama_context_detach_drafter(ctx);
		}
		this.drafterAttached[ctxIdx] = false;
	}

	private prefillSession(stream: LlmStreamHandle, tokens: Int32Array): void {
		const sess = this.requireSession(stream);
		const ctx = this.ctxPool[sess.ctxIdx];
		if (!ctx) throw new Error("[desktop-llama] ctx gone mid-prefill");
		// Copy into a session-owned buffer so the FFI batch ptr stays valid
		// for the lifetime of `eliza_llama_decode`.
		const owned = new Int32Array(tokens.length);
		owned.set(tokens);
		const batch = this.shim.eliza_llama_batch_get_one(
			this.ffi.ptr(owned),
			owned.length,
		);
		try {
			const rc = this.shim.eliza_llama_decode(ctx, batch);
			if (rc !== 0) {
				throw new Error(`[desktop-llama] prefill decode rc=${rc}`);
			}
			this.hasDecodedFlags[sess.ctxIdx] = true;
		} finally {
			this.shim.eliza_llama_batch_free(batch);
		}
	}

	private nextStep(
		stream: LlmStreamHandle,
		maxTokensPerStep = 32,
		maxTextBytes = 1024,
	): LlmStreamStep {
		const sess = this.requireSession(stream);
		const ctx = this.ctxPool[sess.ctxIdx];
		if (!ctx || !this.vocabPtr) {
			throw new Error("[desktop-llama] ctx gone mid-step");
		}
		const out: number[] = [];
		let text = "";
		let done = false;
		// When a drafter is attached to this session's ctx,
		// `eliza_llama_decode_unified` runs the verify-and-rewind cycle
		// internally and accumulates drafter counters on the ctx. We
		// snapshot before/after and diff to report per-step
		// `drafterDrafted` / `drafterAccepted` on the LlmStreamStep.
		const usingDrafter = sess.usingDrafter;
		const statsBefore = usingDrafter ? this.readDflashStats(ctx) : null;

		for (let i = 0; i < maxTokensPerStep; i++) {
			if (sess.abort.cancelled) {
				done = true;
				break;
			}
			const next = this.llama.llama_sampler_sample(sess.sampler, ctx, -1);
			if (this.llama.llama_vocab_is_eog(this.vocabPtr, next)) {
				done = true;
				break;
			}
			this.llama.llama_sampler_accept(sess.sampler, next);
			const wrote = this.llama.llama_token_to_piece(
				this.vocabPtr,
				next,
				this.ffi.ptr(sess.pieceBuf),
				sess.pieceBuf.length,
				0,
				false,
			);
			if (wrote > 0) {
				text += decodeCStringBytes(sess.pieceBuf.subarray(0, wrote));
			}
			out.push(next);

			// Decode the just-sampled token to advance the KV cache.
			// `decode_unified` runs verify-and-rewind when a drafter is
			// attached; `decode` is the plain path used otherwise.
			sess.tokenBuf[0] = next;
			const batch = this.shim.eliza_llama_batch_get_one(
				this.ffi.ptr(sess.tokenBuf),
				1,
			);
			try {
				const rc = usingDrafter
					? this.shim.eliza_llama_decode_unified(ctx, batch)
					: this.shim.eliza_llama_decode(ctx, batch);
				if (rc !== 0) {
					throw new Error(`[desktop-llama] decode rc=${rc}`);
				}
			} finally {
				this.shim.eliza_llama_batch_free(batch);
			}

			if (text.length >= maxTextBytes) break;
		}
		if (done) sess.finished = true;

		let drafted = 0;
		let accepted = 0;
		if (usingDrafter && statsBefore) {
			const statsAfter = this.readDflashStats(ctx);
			drafted = Math.max(0, statsAfter.drafted - statsBefore.drafted);
			accepted = Math.max(0, statsAfter.accepted - statsBefore.accepted);
		}
		return {
			tokens: out,
			text,
			done,
			drafterDrafted: drafted,
			drafterAccepted: accepted,
		};
	}

	/**
	 * Read the legacy 4-int32 DFlash telemetry block for a specific ctx.
	 * Counters are per-ctx since each ctx in the pool has its own drafter
	 * state. Returns zero counters when no drafter is attached.
	 */
	private readDflashStats(ctx: Pointer): {
		drafted: number;
		accepted: number;
		rejected: number;
		lastStatus: number;
	} {
		const buf = new Int32Array(4);
		this.shim.eliza_llama_dflash_stats(ctx, this.ffi.ptr(buf));
		return {
			drafted: buf[0] ?? 0,
			accepted: buf[1] ?? 0,
			rejected: buf[2] ?? 0,
			lastStatus: buf[3] ?? 0,
		};
	}

	private cancelSession(stream: LlmStreamHandle): void {
		const sess = this.sessions.get(stream);
		if (sess) sess.abort.cancelled = true;
	}

	private closeSession(stream: LlmStreamHandle): void {
		const sess = this.sessions.get(stream);
		if (!sess) return;
		this.llama.llama_sampler_free(sess.sampler);
		this.sessions.delete(stream);
	}

	private requireSession(stream: LlmStreamHandle): DesktopSession {
		const sess = this.sessions.get(stream);
		if (!sess) throw new Error(`[desktop-llama] unknown stream ${stream}`);
		return sess;
	}
}

// === Public load entrypoint ================================================

export interface DesktopLlamaLoadResult {
	adapter: DesktopLlamaAdapter;
	binding: LlmStreamingBinding;
	ctx: LlmCtxHandle;
}

/**
 * Load the desktop dylib pair, instantiate the adapter, mmap the model.
 * Returns `null` when the runtime isn't Bun, the dylibs aren't on disk, or
 * `dlopen` fails — callers fall through to the subprocess `dflash-server`
 * path on null.
 */
export async function loadDesktopLlama(
	opts: DesktopLlamaLoadOptions,
): Promise<DesktopLlamaLoadResult | null> {
	if (!desktopLlamaDylibsPresent()) return null;
	const ffiResult = await loadBunFfi();
	if (!ffiResult.ok) {
		console.warn(
			`[desktop-llama] bun:ffi unavailable: ${ffiResult.error.message} — falling through to subprocess path`,
		);
		return null;
	}
	const ffi = ffiResult.mod;
	let llama: LlamaSymbols;
	let shim: ShimSymbols;
	try {
		llama = bindLlama(ffi, resolveDesktopLibllamaPath());
		shim = bindShim(ffi, resolveDesktopShimPath());
	} catch (err) {
		console.warn(
			`[desktop-llama] dlopen failed: ${err instanceof Error ? err.message : String(err)} — falling through to subprocess path`,
		);
		return null;
	}
	// Optional vision symbols — present only when the shim was built with
	// `-DELIZA_ENABLE_VISION=1`. Absent symbols → `describeImage` throws an
	// actionable "rebuild with vision flag" error instead of silently
	// degrading.
	const vision = bindVision(ffi, resolveDesktopShimPath());
	const adapter = new DesktopLlamaAdapter(ffi, llama, shim, vision);
	adapter.loadModel(opts);
	return {
		adapter,
		binding: adapter.createBinding(),
		ctx: adapter.getCtxHandle(),
	};
}
