/**
 * Wake-word detection — native runtime binding.
 *
 * Loads the standalone `packages/native-plugins/wakeword-cpp/`
 * library directly via `bun:ffi` and exposes the same `WakeWordModel`
 * interface as the previous `onnxruntime-node`-backed implementation
 * in `./wake-word.ts`, so the voice lifecycle can swap the two without
 * changing anything upstream.
 *
 * Phase 2 status — this binding is now the default when the
 * `libwakeword.{so,dylib,dll}` shared library and three converted
 * GGUFs are present. The C runtime is a pure-fp32 reference
 * implementation of the openWakeWord three-stage pipeline (melspec
 * → embedding CNN → classifier head) — no ggml link, no SIMD; a
 * laptop CPU runs it under 1 % of real time. ABI parity with the
 * upstream openWakeWord ONNX graphs is gated by
 * `packages/native-plugins/wakeword-cpp/test/wakeword_parity_test.py`.
 *
 * The ONNX path in `./wake-word.ts` stays as the fallback while the
 * native binding shakes out. Once the migration is complete the ONNX
 * path can be removed alongside the `onnxruntime-node` dependency.
 *
 * Three GGUFs back one session, mirroring openWakeWord's three ONNX
 * graphs (the C library is the single source of truth on shapes —
 * see `packages/native-plugins/wakeword-cpp/include/wakeword/wakeword.h`):
 *
 *   1. melspec    — 16 kHz PCM → 32-bin log-mel frames.
 *   2. embedding  — 20-Conv2D CNN over a 76-mel-frame sliding window
 *                   → 96-dim embedding.
 *   3. classifier — 4-layer MLP over a 16-embedding window → P(wake)
 *                   ∈ [0, 1].
 */

import type { WakeWordModel } from "./wake-word";

/** PCM frame size the streaming pipeline expects (80 ms @ 16 kHz). */
const FRAME_SAMPLES = 1280;
const SAMPLE_RATE = 16_000;

/** Three GGUF paths that back one session. */
export interface WakeWordGgmlPaths {
	/** Frozen Hann window + mel filter bank + STFT params metadata. */
	melspec: string;
	/** Embedding-CNN weights (fp16) + architecture metadata. */
	embedding: string;
	/** Classifier-head weights (fp16) + (1, 16, 96) input shape. */
	classifier: string;
}

export interface WakeWordGgmlConfig {
	/** Detection threshold ∈ [0, 1]. Default 0.5 (matches upstream openWakeWord). */
	threshold?: number;
}

/**
 * Thrown when the native ggml backend cannot be used. Distinct from
 * `WakeWordUnavailableError` in `./wake-word.ts` so callers that fall
 * back to the legacy ONNX path can tell the two failure modes apart
 * during the migration.
 */
export class WakeWordGgmlUnavailableError extends Error {
	readonly code:
		| "not-bun"
		| "library-load-failed"
		| "model-load-failed"
		| "abi-error";
	constructor(code: WakeWordGgmlUnavailableError["code"], message: string) {
		super(message);
		this.name = "WakeWordGgmlUnavailableError";
		this.code = code;
	}
}

/** Runtime detector — `bun:ffi` is Bun-only. */
function isBunRuntime(): boolean {
	return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Native session handle. The C side gives us a pointer (`bigint` under
 * `bun:ffi`); we never inspect it on the JS side beyond passing it
 * back through the binding.
 */
type NativeHandle = bigint;

/** Bound symbols from `libwakeword`. Mirrors `wakeword.h` 1:1. */
interface WakeWordBindings {
	wakeword_open: (
		melspec: unknown,
		embedding: unknown,
		classifier: unknown,
		outHandle: unknown,
	) => number;
	wakeword_close: (handle: NativeHandle) => number;
	wakeword_process: (
		handle: NativeHandle,
		pcm: unknown,
		nSamples: bigint | number,
		outScore: unknown,
	) => number;
	wakeword_set_threshold: (handle: NativeHandle, threshold: number) => number;
	wakeword_active_backend: () => unknown;
}

interface BoundLibrary {
	bindings: WakeWordBindings;
	close(): void;
	libraryPath: string;
	/** `bun:ffi` helper: encode an ArrayBufferView as a native pointer. */
	ptr(value: ArrayBufferView): unknown;
}

/** Minimal shape of the bun:ffi module we use here. */
interface BunFfiModule {
	dlopen(
		path: string,
		def: Record<string, { args: number[]; returns: number }>,
	): {
		symbols: Record<string, (...args: unknown[]) => unknown>;
		close(): void;
	};
	ptr(value: ArrayBufferView): unknown;
	FFIType: {
		cstring: number;
		ptr: number;
		i32: number;
		u64: number;
		f32: number;
	};
}

/**
 * Resolve `bun:ffi` at runtime via the Bun-injected `require`. Mirrors
 * the loader pattern in `./ffi-bindings.ts` (search for
 * `loadBunFfiModule`) so plain Node test runs that import this file
 * for type-only purposes do not blow up at the import site.
 */
function loadBunFfiModule(): BunFfiModule {
	const req: ((id: string) => unknown) | undefined = (
		globalThis as { Bun?: { __require?: (id: string) => unknown } }
	).Bun?.__require;
	if (typeof req === "function") {
		return req("bun:ffi") as BunFfiModule;
	}
	const mod = require("node:module") as {
		createRequire: (filename: string) => (id: string) => unknown;
	};
	const r = mod.createRequire(import.meta.url);
	return r("bun:ffi") as BunFfiModule;
}

/**
 * Load `libwakeword` and bind every symbol declared in `wakeword.h`.
 * Throws `WakeWordGgmlUnavailableError({code: "library-load-failed"})`
 * on `dlopen` failure.
 */
function loadLibrary(libraryPath: string): BoundLibrary {
	if (!isBunRuntime()) {
		throw new WakeWordGgmlUnavailableError(
			"not-bun",
			"[wake-word-ggml] bun:ffi is required; current runtime is not Bun",
		);
	}
	if (!libraryPath || libraryPath.length === 0) {
		throw new WakeWordGgmlUnavailableError(
			"library-load-failed",
			"[wake-word-ggml] libraryPath is required",
		);
	}
	const bunFfi = loadBunFfiModule();
	const T = bunFfi.FFIType;
	const lib = bunFfi.dlopen(libraryPath, {
		wakeword_open: {
			args: [T.ptr, T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
		wakeword_close: {
			args: [T.ptr],
			returns: T.i32,
		},
		wakeword_process: {
			args: [T.ptr, T.ptr, T.u64, T.ptr],
			returns: T.i32,
		},
		wakeword_set_threshold: {
			args: [T.ptr, T.f32],
			returns: T.i32,
		},
		wakeword_active_backend: {
			args: [],
			returns: T.cstring,
		},
	});
	return {
		bindings: lib.symbols as unknown as WakeWordBindings,
		close: () => lib.close(),
		libraryPath,
		ptr: (v: ArrayBufferView) => bunFfi.ptr(v),
	};
}

/**
 * Streaming wake-word detector backed by `libwakeword`.
 *
 * Implements the same `WakeWordModel` interface as `OpenWakeWordModel`
 * in `./wake-word.ts` so the voice lifecycle can swap implementations
 * without changing anything upstream.
 */
export class OpenWakeWordGgmlModel implements WakeWordModel {
	readonly frameSamples = FRAME_SAMPLES;
	readonly sampleRate = SAMPLE_RATE;

	private constructor(
		private readonly lib: BoundLibrary,
		private readonly handle: NativeHandle,
	) {}

	/**
	 * Load a wake-word model from its three GGUFs and the
	 * `libwakeword` shared library. Returns a ready-to-use detector
	 * with a fresh streaming session. Throws
	 * `WakeWordGgmlUnavailableError` on dlopen / ABI / GGUF failure.
	 */
	static async load(args: {
		libraryPath: string;
		paths: WakeWordGgmlPaths;
		config?: WakeWordGgmlConfig;
	}): Promise<OpenWakeWordGgmlModel> {
		const lib = loadLibrary(args.libraryPath);
		const out = new BigInt64Array(1);
		/* Each path string needs a NUL terminator; we encode through
		 * Uint8Array and pass an explicit pointer because bun:ffi does
		 * not auto-convert Buffer -> cstring on every binding shape. */
		const enc = new TextEncoder();
		const melBuf = enc.encode(`${args.paths.melspec}\0`);
		const embBuf = enc.encode(`${args.paths.embedding}\0`);
		const clsBuf = enc.encode(`${args.paths.classifier}\0`);
		const rc = lib.bindings.wakeword_open(
			lib.ptr(melBuf),
			lib.ptr(embBuf),
			lib.ptr(clsBuf),
			lib.ptr(out),
		);
		if (rc !== 0) {
			lib.close();
			throw new WakeWordGgmlUnavailableError(
				"model-load-failed",
				`[wake-word-ggml] wakeword_open(${args.paths.melspec}, ${args.paths.embedding}, ${args.paths.classifier}) returned ${rc}`,
			);
		}
		const handle = out[0] as NativeHandle;
		const model = new OpenWakeWordGgmlModel(lib, handle);
		if (args.config?.threshold !== undefined) {
			const setRc = lib.bindings.wakeword_set_threshold(
				handle,
				args.config.threshold,
			);
			if (setRc !== 0) {
				model.close();
				throw new WakeWordGgmlUnavailableError(
					"abi-error",
					`[wake-word-ggml] wakeword_set_threshold(${args.config.threshold}) returned ${setRc}`,
				);
			}
		}
		return model;
	}

	/**
	 * Score one 1280-sample (80 ms @ 16 kHz) fp32 mono frame and
	 * return the most recent classifier probability ∈ [0, 1]. Early
	 * frames (before enough mel + embedding context has accumulated)
	 * return 0.
	 */
	async scoreFrame(frame: Float32Array): Promise<number> {
		if (frame.length !== FRAME_SAMPLES) {
			throw new Error(
				`[wake-word-ggml] scoreFrame expects ${FRAME_SAMPLES} samples; got ${frame.length}`,
			);
		}
		const out = new Float32Array(1);
		const rc = this.lib.bindings.wakeword_process(
			this.handle,
			frame,
			BigInt(frame.length),
			out,
		);
		if (rc !== 0) {
			throw new WakeWordGgmlUnavailableError(
				"abi-error",
				`[wake-word-ggml] wakeword_process returned ${rc}`,
			);
		}
		const p = out[0] ?? 0;
		return Math.min(1, Math.max(0, p));
	}

	/**
	 * Streaming state lives on the native side. The C ABI does not
	 * expose a separate `reset` entry point yet (Phase 2 will add one
	 * if the ggml-backed implementation needs it); for now, reset is
	 * a no-op on the JS side. Callers that need a hard state clear
	 * close + reopen the session.
	 */
	reset(): void {
		// Intentionally empty — see jsdoc above.
	}

	/** Release the native session and the dlopen handle. */
	close(): void {
		this.lib.bindings.wakeword_close(this.handle);
		this.lib.close();
	}

	/** Diagnostics: `"native-cpu"` on this build (pure-fp32 reference). */
	activeBackend(): string {
		const raw = this.lib.bindings.wakeword_active_backend();
		return typeof raw === "string" ? raw : String(raw ?? "");
	}
}
