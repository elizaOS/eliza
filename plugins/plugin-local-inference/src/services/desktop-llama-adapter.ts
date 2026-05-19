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
	});
	return handle.symbols;
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
	abort: { cancelled: boolean };
	finished: boolean;
	// Reusable single-token buffer for stepwise decode.
	tokenBuf: Int32Array;
	pieceBuf: Uint8Array;
	emittedFirstToken: boolean;
}

/**
 * Loaded desktop adapter. Holds the dlopen handles, model + ctx pointers,
 * and a per-session table for the streaming-LLM contract.
 */
export class DesktopLlamaAdapter {
	private modelPtr: Pointer | null = null;
	private ctxPtr: Pointer | null = null;
	private vocabPtr: Pointer | null = null;
	private hasDecoded = false;
	private nextStreamId = 1n;
	private readonly sessions = new Map<bigint, DesktopSession>();
	private warnedDrafterIgnored = false;

	constructor(
		private readonly ffi: BunFFIModule,
		private readonly llama: LlamaSymbols,
		private readonly shim: ShimSymbols,
	) {}

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
		if (this.ctxPtr !== null) {
			this.llama.llama_free(this.ctxPtr);
			this.ctxPtr = null;
		}
		if (this.modelPtr !== null) {
			this.llama.llama_model_free(this.modelPtr);
			this.modelPtr = null;
		}
		this.vocabPtr = null;
		this.hasDecoded = false;
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
			llmStreamSaveSlot: (args) => this.saveSlot(args.filename),
			llmStreamRestoreSlot: (args) => this.restoreSlot(args.filename),
		};
	}

	/**
	 * Persist the current ctx's seq_id=0 KV state to `filename`. v1 uses a
	 * single seq per ctx — the engine's conversation registry handles
	 * cross-conversation slot pinning above this layer by creating a fresh
	 * adapter per active conversation. Multi-seq pooling (one ctx serving
	 * N concurrent conversations) is tracked under Step E.
	 */
	saveSlot(filename: string): void {
		if (!this.ctxPtr) {
			throw new Error("[desktop-llama] saveSlot before model load");
		}
		const pathBuf = encodeCString(filename);
		const written = this.llama.llama_state_seq_save_file(
			this.ctxPtr,
			this.ffi.ptr(pathBuf),
			0, // seq_id — v1 uses single seq per ctx
			this.ffi.ptr(new Int32Array(1)), // tokens — NULL placeholder; engine owns prompt bookkeeping
			0,
		);
		if (written <= 0) {
			throw new Error(
				`[desktop-llama] llama_state_seq_save_file returned ${written} for ${filename}`,
			);
		}
	}

	/** Restore the seq_id=0 KV state from `filename` into the current ctx. */
	restoreSlot(filename: string): void {
		if (!this.ctxPtr) {
			throw new Error("[desktop-llama] restoreSlot before model load");
		}
		const pathBuf = encodeCString(filename);
		const countOut = new Int32Array(1);
		const read = this.llama.llama_state_seq_load_file(
			this.ctxPtr,
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
		// Mark hasDecoded so future openSession calls clear KV between turns
		// even though the prefill happened off-line.
		this.hasDecoded = true;
	}

	loadedDrafterPath(): string | null {
		return null;
	}

	parallelSlots(): number {
		return 1;
	}

	async resizeParallel(_target: number): Promise<boolean> {
		return false;
	}

	visionSupported(): boolean {
		return false;
	}

	currentMmprojPath(): string | null {
		return null;
	}

	async describeImage(_args: {
		imageBytes: Uint8Array;
		mmprojPath: string;
		prompt?: string;
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
	}): Promise<{ text: string; projectorMs?: number; decodeMs?: number }> {
		throw new Error(
			"[desktop-llama] vision describe is not available in the desktop FFI adapter; use the dflash subprocess backend for mmproj image description",
		);
	}

	getCtxHandle(): LlmCtxHandle {
		if (!this.ctxPtr) {
			throw new Error("[desktop-llama] no context loaded");
		}
		return BigInt(this.ctxPtr);
	}

	private openSession(config: LlmStreamConfig): LlmStreamHandle {
		if (!this.ctxPtr) {
			throw new Error("[desktop-llama] llmStreamOpen before model load");
		}
		// Wipe KV between sessions if we've decoded — first session leaves
		// the cache pristine, otherwise we'd hit the seq_id_max segv path.
		if (this.hasDecoded) {
			const mem = this.llama.llama_get_memory(this.ctxPtr);
			this.llama.llama_memory_clear(mem, true);
		}
		// Drafter args are ignored in v1; warn loudly once.
		if (
			(config.draftMin > 0 ||
				config.draftMax > 0 ||
				config.dflashDrafterPath) &&
			!this.warnedDrafterIgnored
		) {
			console.warn(
				"[desktop-llama] speculative-decoding args (draftMin/draftMax/dflashDrafterPath) are ignored in v1 — the desktop FFI adapter does not yet bind eliza_llama_context_attach_drafter.",
			);
			this.warnedDrafterIgnored = true;
		}
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
			abort: { cancelled: false },
			finished: false,
			tokenBuf: new Int32Array(1),
			pieceBuf: new Uint8Array(256),
			emittedFirstToken: false,
		});
		return stream;
	}

	private prefillSession(stream: LlmStreamHandle, tokens: Int32Array): void {
		const _sess = this.requireSession(stream);
		if (!this.ctxPtr) throw new Error("[desktop-llama] ctx gone mid-prefill");
		// Copy into a session-owned buffer so the FFI batch ptr stays valid
		// for the lifetime of `eliza_llama_decode`.
		const owned = new Int32Array(tokens.length);
		owned.set(tokens);
		const batch = this.shim.eliza_llama_batch_get_one(
			this.ffi.ptr(owned),
			owned.length,
		);
		try {
			const rc = this.shim.eliza_llama_decode(this.ctxPtr, batch);
			if (rc !== 0) {
				throw new Error(`[desktop-llama] prefill decode rc=${rc}`);
			}
			this.hasDecoded = true;
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
		if (!this.ctxPtr || !this.vocabPtr) {
			throw new Error("[desktop-llama] ctx gone mid-step");
		}
		const out: number[] = [];
		let text = "";
		let done = false;

		for (let i = 0; i < maxTokensPerStep; i++) {
			if (sess.abort.cancelled) {
				done = true;
				break;
			}
			const next = this.llama.llama_sampler_sample(
				sess.sampler,
				this.ctxPtr,
				-1,
			);
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
			sess.tokenBuf[0] = next;
			const batch = this.shim.eliza_llama_batch_get_one(
				this.ffi.ptr(sess.tokenBuf),
				1,
			);
			try {
				const rc = this.shim.eliza_llama_decode(this.ctxPtr, batch);
				if (rc !== 0) {
					throw new Error(`[desktop-llama] decode rc=${rc}`);
				}
			} finally {
				this.shim.eliza_llama_batch_free(batch);
			}

			if (text.length >= maxTextBytes) break;
		}
		if (done) sess.finished = true;
		return {
			tokens: out,
			text,
			done,
			drafterDrafted: 0,
			drafterAccepted: 0,
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
	const adapter = new DesktopLlamaAdapter(ffi, llama, shim);
	adapter.loadModel(opts);
	return {
		adapter,
		binding: adapter.createBinding(),
		ctx: adapter.getCtxHandle(),
	};
}
