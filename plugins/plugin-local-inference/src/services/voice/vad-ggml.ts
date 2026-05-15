/**
 * ggml-backed Silero VAD binding.
 *
 * This module is the JS-side proxy for the C ABI declared in
 * `packages/native-plugins/silero-vad-cpp/include/silero_vad/silero_vad.h`.
 * As of Phase 2 the underlying C library is a real, GGUF-backed
 * scalar-C runtime that loads the Silero v5 (16 kHz) graph and
 * runs it per 32 ms / 512-sample window with parity vs the upstream
 * `silero-vad` Python `OnnxWrapper` (verified at ±0.02 by
 * `packages/native-plugins/silero-vad-cpp/test/silero_vad_parity_test.py`).
 *
 * The binding is wired into `./vad.ts`'s `vadProviderOrder` ahead of
 * the `silero-onnx` provider; the ONNX path stays as a fallback
 * until the ggml runtime has soaked in production.
 *
 * Runtime: production runs under Bun (Electrobun shell, Capacitor
 * bridge). The loader uses `bun:ffi`. Calling this loader from a
 * non-Bun runtime (plain Node, Deno) throws `VadGgmlUnavailableError`
 * with a diagnostic explaining why.
 *
 * Contract: the exported `SileroVadGgml` class implements the same
 * `VadLike` interface as `SileroVad` and `NativeSileroVad`
 * (`process(window: Float32Array): Promise<number>`, `reset(): void`,
 * `windowSamples`, `sampleRate`).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { VadLike } from "./vad";

/* ---- ABI constants (mirrors include/silero_vad/silero_vad.h) ---- */

/** Native input window length in samples — locked by the C ABI. */
export const SILERO_VAD_GGML_WINDOW_SAMPLES = 512;

/** Native input sample rate in Hz — locked by the C ABI. */
export const SILERO_VAD_GGML_SAMPLE_RATE_HZ = 16_000;

/* ---- Errors ----------------------------------------------------- */

export type VadGgmlUnavailableCode =
	| "ffi-unavailable"
	| "library-missing"
	| "library-load-failed"
	| "model-missing"
	| "open-failed"
	| "abi-violation";

export class VadGgmlUnavailableError extends Error {
	readonly code: VadGgmlUnavailableCode;
	constructor(code: VadGgmlUnavailableCode, message: string) {
		super(message);
		this.name = "VadGgmlUnavailableError";
		this.code = code;
	}
}

/* ---- bun:ffi minimal surface ------------------------------------ */

interface BunFfiSymbols {
	silero_vad_open: (gguf_path: unknown, out: unknown) => number;
	silero_vad_reset_state: (handle: bigint) => number;
	silero_vad_process: (
		handle: bigint,
		pcm: unknown,
		n_samples: bigint | number,
		out_prob: unknown,
	) => number;
	silero_vad_close: (handle: bigint) => number;
	silero_vad_active_backend: () => unknown;
}

interface BunFfiLib {
	symbols: BunFfiSymbols;
	close(): void;
}

interface BunFfiModule {
	dlopen(path: string, defs: Record<string, unknown>): BunFfiLib;
	FFIType: Record<string, number>;
	ptr(value: ArrayBufferView): unknown;
	CString: new (ptr: unknown) => { toString(): string };
	read: { u64(buf: unknown, offset?: number): bigint };
}

async function loadBunFfi(): Promise<BunFfiModule> {
	const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
	if (!isBun) {
		throw new VadGgmlUnavailableError(
			"ffi-unavailable",
			"[vad-ggml] bun:ffi is unavailable. The ggml-backed Silero VAD binding requires Bun (Electrobun / Capacitor bridge); plain Node cannot dlopen libsilero_vad.",
		);
	}
	// `import("bun:ffi")` is a Bun-only module specifier — wrapping the
	// dynamic import in a Function constructor keeps tsc/Node from
	// resolving it at build time. Under Bun the runtime resolves the
	// specifier natively.
	const dynamicImport = new Function(
		"specifier",
		"return import(specifier);",
	) as (specifier: string) => Promise<unknown>;
	const mod = (await dynamicImport("bun:ffi")) as BunFfiModule;
	return mod;
}

/* ---- Library resolution ----------------------------------------- */

/**
 * Resolve `libsilero_vad.{so,dylib,dll}` on disk. Search order:
 *   1. `opts.libraryPath` if explicitly set (no fallback if missing).
 *   2. `$ELIZA_SILERO_VAD_LIB` if set (no fallback if missing).
 *   3. The repo-local CMake build output for the standalone library
 *      (`packages/native-plugins/silero-vad-cpp/build/libsilero_vad.*`).
 * Returns `null` when none exist.
 */
export function resolveSileroVadGgmlLibrary(opts: {
	libraryPath?: string;
	repoRoot?: string;
}): string | null {
	const explicit = opts.libraryPath ?? process.env.ELIZA_SILERO_VAD_LIB;
	if (explicit) return existsSync(explicit) ? path.resolve(explicit) : null;

	const repoRoot = opts.repoRoot ?? process.cwd();
	const buildDir = path.join(
		repoRoot,
		"packages",
		"native-plugins",
		"silero-vad-cpp",
		"build",
	);
	const platformNames =
		process.platform === "darwin"
			? ["libsilero_vad.dylib", "libsilero_vad.so", "silero_vad.dll"]
			: process.platform === "win32"
				? ["silero_vad.dll", "libsilero_vad.dll"]
				: ["libsilero_vad.so", "libsilero_vad.dylib", "silero_vad.dll"];
	for (const name of platformNames) {
		const candidate = path.join(buildDir, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/* ---- The binding ------------------------------------------------- */

interface DlopenResult {
	lib: BunFfiLib;
	ffi: BunFfiModule;
	libraryPath: string;
}

async function dlopenLibrary(libraryPath: string): Promise<DlopenResult> {
	const ffi = await loadBunFfi();
	const T = ffi.FFIType;
	const lib = ffi.dlopen(libraryPath, {
		silero_vad_open: { args: [T.cstring, T.ptr], returns: T.i32 },
		silero_vad_reset_state: { args: [T.u64], returns: T.i32 },
		silero_vad_process: {
			args: [T.u64, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		silero_vad_close: { args: [T.u64], returns: T.i32 },
		silero_vad_active_backend: { args: [], returns: T.cstring },
	});
	return { lib, ffi, libraryPath };
}

/**
 * Thin wrapper over the ggml-backed Silero VAD C ABI. Stateful:
 * `process()` carries the LSTM state across calls and expects a
 * 512-sample window at 16 kHz (the only window size the native graph
 * supports). `reset()` clears the state at utterance boundaries.
 *
 * Implements `VadLike` so `VadDetector` can drive it interchangeably
 * with `SileroVad` (ONNX) and `NativeSileroVad` (libelizainference).
 */
export class SileroVadGgml implements VadLike {
	readonly windowSamples = SILERO_VAD_GGML_WINDOW_SAMPLES;
	readonly sampleRate: number;

	private constructor(
		private readonly ffi: BunFfiModule,
		private readonly lib: BunFfiLib,
		private readonly handle: bigint,
		readonly libraryPath: string,
		sampleRate: number,
	) {
		this.sampleRate = sampleRate;
	}

	/**
	 * Load the ggml-backed Silero VAD library and open a session against
	 * `gguf_path`. Throws `VadGgmlUnavailableError` on any failure (no
	 * silent fallback to ONNX — the resolver in `./vad.ts` owns that
	 * fallback decision).
	 */
	static async load(opts: {
		ggufPath: string;
		libraryPath?: string;
		repoRoot?: string;
		sampleRate?: number;
	}): Promise<SileroVadGgml> {
		const sampleRate = opts.sampleRate ?? SILERO_VAD_GGML_SAMPLE_RATE_HZ;
		if (sampleRate !== SILERO_VAD_GGML_SAMPLE_RATE_HZ) {
			throw new VadGgmlUnavailableError(
				"abi-violation",
				`[vad-ggml] Silero VAD only supports ${SILERO_VAD_GGML_SAMPLE_RATE_HZ} Hz; got ${sampleRate}. Resample upstream before calling the binding.`,
			);
		}
		if (!existsSync(opts.ggufPath)) {
			throw new VadGgmlUnavailableError(
				"model-missing",
				`[vad-ggml] GGUF model not found at ${opts.ggufPath}. Run scripts/silero_vad_to_gguf.py to produce one.`,
			);
		}
		const libraryPath = resolveSileroVadGgmlLibrary({
			libraryPath: opts.libraryPath,
			repoRoot: opts.repoRoot,
		});
		if (!libraryPath) {
			throw new VadGgmlUnavailableError(
				"library-missing",
				"[vad-ggml] libsilero_vad not found. Build it via `cmake -B packages/native-plugins/silero-vad-cpp/build -S packages/native-plugins/silero-vad-cpp && cmake --build packages/native-plugins/silero-vad-cpp/build`, or set $ELIZA_SILERO_VAD_LIB.",
			);
		}

		let opened: DlopenResult;
		try {
			opened = await dlopenLibrary(libraryPath);
		} catch (e) {
			throw new VadGgmlUnavailableError(
				"library-load-failed",
				`[vad-ggml] failed to load libsilero_vad at ${libraryPath}: ${
					e instanceof Error ? e.message : String(e)
				}`,
			);
		}
		const { lib, ffi } = opened;

		// `silero_vad_open` writes the new handle into `*out` (a u64
		// pointer). We allocate an 8-byte BigUint64 view, hand its
		// pointer to the C side, then read back the produced handle.
		const handleView = new BigUint64Array(1);
		const cstrBuf = new TextEncoder().encode(`${opts.ggufPath}\0`);

		const rc = lib.symbols.silero_vad_open(
			ffi.ptr(cstrBuf),
			ffi.ptr(handleView),
		);
		if (rc !== 0) {
			lib.close();
			throw new VadGgmlUnavailableError(
				"open-failed",
				`[vad-ggml] silero_vad_open returned ${rc} for ${opts.ggufPath}. ` +
					"Common causes: -2 (ENOENT) the GGUF file is unreadable, " +
					"-22 (EINVAL) the GGUF metadata mismatched the expected " +
					"silero_vad_v5 / 16 kHz / 512-sample / 128-dim contract. " +
					"Re-run scripts/silero_vad_to_gguf.py from the pinned commit " +
					"and confirm `silero_vad.variant` reads `silero_vad_v5`. " +
					"See packages/native-plugins/silero-vad-cpp/AGENTS.md.",
			);
		}

		const handle = handleView[0];
		if (handle === 0n) {
			lib.close();
			throw new VadGgmlUnavailableError(
				"abi-violation",
				"[vad-ggml] silero_vad_open returned 0 but did not write a handle.",
			);
		}

		return new SileroVadGgml(ffi, lib, handle, libraryPath, sampleRate);
	}

	/** Diagnostic — name of the active dispatch path inside the library. */
	activeBackend(): string {
		const cstr = this.lib.symbols.silero_vad_active_backend();
		// bun:ffi with `returns: T.cstring` already hands back a CString;
		// fall back to constructing one from a raw pointer if the
		// runtime returned a number/bigint instead (older Bun versions).
		if (
			cstr &&
			typeof (cstr as { toString?: () => string }).toString === "function" &&
			typeof cstr !== "number" &&
			typeof cstr !== "bigint"
		) {
			return String(cstr);
		}
		return new this.ffi.CString(cstr).toString();
	}

	/** Clear the LSTM state. Call at the start of every new utterance. */
	reset(): void {
		const rc = this.lib.symbols.silero_vad_reset_state(this.handle);
		if (rc !== 0) {
			throw new VadGgmlUnavailableError(
				"abi-violation",
				`[vad-ggml] silero_vad_reset_state returned ${rc}.`,
			);
		}
	}

	/**
	 * Run one window. `window` MUST be exactly `windowSamples` long.
	 * Returns the speech probability in `[0, 1]`.
	 */
	async process(window: Float32Array): Promise<number> {
		if (window.length !== SILERO_VAD_GGML_WINDOW_SAMPLES) {
			throw new VadGgmlUnavailableError(
				"abi-violation",
				`[vad-ggml] process expects a ${SILERO_VAD_GGML_WINDOW_SAMPLES}-sample window; got ${window.length}.`,
			);
		}
		const probView = new Float32Array(1);
		const rc = this.lib.symbols.silero_vad_process(
			this.handle,
			this.ffi.ptr(window),
			BigInt(window.length),
			this.ffi.ptr(probView),
		);
		if (rc !== 0) {
			throw new VadGgmlUnavailableError(
				"abi-violation",
				`[vad-ggml] silero_vad_process returned ${rc}.`,
			);
		}
		return probView[0];
	}

	/** Release the native session. Idempotent; safe to call multiple times. */
	close(): void {
		const rc = this.lib.symbols.silero_vad_close(this.handle);
		if (rc !== 0) {
			throw new VadGgmlUnavailableError(
				"abi-violation",
				`[vad-ggml] silero_vad_close returned ${rc}.`,
			);
		}
		this.lib.close();
	}
}
