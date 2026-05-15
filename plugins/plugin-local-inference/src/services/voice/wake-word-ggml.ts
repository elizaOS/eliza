/**
 * Wake-word detection — EXPERIMENTAL native ggml binding.
 *
 * This module is the in-progress replacement for the
 * `onnxruntime-node`-backed `OpenWakeWordModel` in
 * `./wake-word.ts`. It loads the standalone
 * `packages/native-plugins/wakeword-cpp/` library directly via
 * `bun:ffi` and exposes the same `WakeWordModel` interface so callers
 * can swap implementations without changing the streaming pipeline
 * upstream of it.
 *
 * STATUS — EXPERIMENTAL. The native library currently only ships a
 * stub: every entry point returns `-ENOSYS`. `OpenWakeWordGgmlModel`
 * accordingly throws `WakeWordGgmlUnavailableError({code: "stub"})`
 * from `load()` so callers cannot mistake the binding for a working
 * detector. Once the ggml-backed embedding + classifier graphs land
 * (see `packages/native-plugins/wakeword-cpp/AGENTS.md` Phase 2), this
 * module becomes the default `WakeWordModel` in the voice lifecycle
 * and `./wake-word.ts` is removed alongside the `onnxruntime-node`
 * dependency.
 *
 * Why a separate file: the parent task's contract is "DO NOT delete
 * `wake-word.ts`" while this port is in flight. Keeping the new
 * binding in its own file makes the migration boundary explicit and
 * keeps the read-only `wake-word.ts` free of native-FFI churn.
 *
 * Three GGUFs back one session, mirroring openWakeWord's three ONNX
 * graphs (the C library is the single source of truth on shapes —
 * see `packages/native-plugins/wakeword-cpp/include/wakeword/wakeword.h`):
 *
 *   1. melspec    — 16 kHz PCM → log-mel frames.
 *   2. embedding  — small CNN over a sliding mel window → 96-dim embedding.
 *   3. classifier — small MLP over a 16-embedding window → P(wake) ∈ [0, 1].
 */

import type { WakeWordModel } from "./wake-word";

/** PCM frame size the streaming pipeline expects (80 ms @ 16 kHz). */
const FRAME_SAMPLES = 1280;
const SAMPLE_RATE = 16_000;

/** ABI return code for "stub build, no real backend wired". */
const ENOSYS = -38;

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
		| "stub"
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
			args: [T.cstring, T.cstring, T.cstring, T.ptr],
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
	 * `libwakeword` shared library.
	 *
	 * Throws `WakeWordGgmlUnavailableError({code: "stub"})` on the
	 * current build — the native ABI is a stub and `wakeword_open`
	 * returns `-ENOSYS`. Phase 2 swaps in the ggml-backed
	 * implementation behind the same ABI; callers do not need to change.
	 */
	static async load(args: {
		libraryPath: string;
		paths: WakeWordGgmlPaths;
		config?: WakeWordGgmlConfig;
	}): Promise<OpenWakeWordGgmlModel> {
		const lib = loadLibrary(args.libraryPath);
		const out = new BigInt64Array(1);
		const rc = lib.bindings.wakeword_open(
			Buffer.from(`${args.paths.melspec}\0`, "utf8"),
			Buffer.from(`${args.paths.embedding}\0`, "utf8"),
			Buffer.from(`${args.paths.classifier}\0`, "utf8"),
			out,
		);
		if (rc === ENOSYS) {
			lib.close();
			throw new WakeWordGgmlUnavailableError(
				"stub",
				"[wake-word-ggml] libwakeword is a stub build (returned -ENOSYS); " +
					"see packages/native-plugins/wakeword-cpp/AGENTS.md Phase 2 for the port plan",
			);
		}
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

	/** Diagnostics: `"stub"` on the current build, `"ggml-cpu"` etc. on Phase 2. */
	activeBackend(): string {
		const raw = this.lib.bindings.wakeword_active_backend();
		return typeof raw === "string" ? raw : String(raw ?? "");
	}
}
