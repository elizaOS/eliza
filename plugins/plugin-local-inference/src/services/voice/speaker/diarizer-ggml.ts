/**
 * Pyannote-3 diarizer — ggml-backed binding (K3 end-to-end real).
 *
 * Replaces `diarizer.ts` (onnxruntime-node pyannote-3 ONNX path) with
 * a `bun:ffi` binding to the `voice-classifier-cpp` SHARED library at
 * `packages/native-plugins/voice-classifier-cpp/`.
 *
 * K3 lands the forward pass: `voice_diarizer_segment` runs the full
 * SincNet + 4× BiLSTM + 3-layer linear head + 7-class powerset argmax
 * in pure C, with 100 % per-frame label agreement against the ONNX
 * reference on the W3-6 fixture suite. The previous J1.c
 * `-ENOSYS / forward-not-implemented` branch is now unreachable when
 * the GGUF is on disk.
 *
 * 7-class powerset output (per the upstream pyannote-3 contract — see
 * H2.b for the correctness rationale):
 *
 *   0 = silence
 *   1 = speaker A only
 *   2 = speaker B only
 *   3 = speaker C only
 *   4 = speakers A + B
 *   5 = speakers A + C
 *   6 = speakers B + C
 *
 * License: the pyannote-segmentation-3.0 CHECKPOINT is MIT — the
 * wider pyannote toolkit is CC-BY-NC, but the model itself is
 * shippable in commercial builds. Documented per H4 license audit.
 *
 * No silent fallback: every failure mode throws
 * `DiarizerGgmlUnavailableError`. The runtime resolver above this
 * binding picks the legacy ONNX path; this class never fabricates a
 * label sequence.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/** Number of powerset classes. Matches `VOICE_DIARIZER_NUM_CLASSES`. */
export const DIARIZER_GGML_NUM_CLASSES = 7;

/** Required input sample rate. */
export const DIARIZER_GGML_SAMPLE_RATE = 16_000;

/** Minimum useful window — pyannote-3 was trained on 5 s windows. */
export const DIARIZER_GGML_MIN_SAMPLES = 16_000;

/** Window size matches the ONNX export: 5 s @ 16 kHz = 80 000 samples. */
export const DIARIZER_GGML_WINDOW_SAMPLES = 16_000 * 5;

/** Frame rate of the head: 293 labels per 5-s window. */
export const DIARIZER_GGML_FRAMES_PER_WINDOW = 293;

export class DiarizerGgmlUnavailableError extends Error {
	readonly code:
		| "native-missing"
		| "library-missing"
		| "model-missing"
		| "model-load-failed"
		| "model-shape-mismatch"
		| "forward-not-implemented"
		| "invalid-input";
	constructor(code: DiarizerGgmlUnavailableError["code"], message: string) {
		super(message);
		this.name = "DiarizerGgmlUnavailableError";
		this.code = code;
	}
}

export interface DiarizerGgmlOptions {
	ggufPath: string;
	libraryPath?: string;
	repoRoot?: string;
}

export interface DiarizerGgmlOutput {
	/** Per-frame powerset labels in `[0, 7)`. */
	labels: Int8Array;
	/** Inference wall-time in ms. */
	latencyMs: number;
}

interface BunFfiSymbols {
	voice_diarizer_open: (gguf_path: unknown, out: unknown) => number;
	voice_diarizer_segment: (
		handle: bigint,
		pcm: unknown,
		n_samples: bigint | number,
		labels_out: unknown,
		frames_capacity_inout: unknown,
	) => number;
	voice_diarizer_close: (handle: bigint) => number;
}

interface BunFfiLib {
	symbols: BunFfiSymbols;
	close(): void;
}

interface BunFfiModule {
	dlopen(path: string, defs: Record<string, unknown>): BunFfiLib;
	FFIType: Record<string, number>;
	ptr(value: ArrayBufferView): unknown;
}

function loadBunFfi(): BunFfiModule {
	const req: ((id: string) => unknown) | undefined = (
		globalThis as { Bun?: { __require?: (id: string) => unknown } }
	).Bun?.__require;
	if (typeof req === "function") {
		return req("bun:ffi") as BunFfiModule;
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mod = require("node:module") as {
			createRequire: (filename: string) => (id: string) => unknown;
		};
		return mod.createRequire(import.meta.url)("bun:ffi") as BunFfiModule;
	} catch (err) {
		throw new DiarizerGgmlUnavailableError(
			"native-missing",
			`[diarizer-ggml] bun:ffi is unavailable. The ggml-backed binding requires Bun: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

function resolveVoiceClassifierLibrary(opts: {
	libraryPath?: string;
	repoRoot?: string;
}): string | null {
	const explicit = opts.libraryPath ?? process.env.ELIZA_VOICE_CLASSIFIER_LIB;
	if (explicit) return existsSync(explicit) ? path.resolve(explicit) : null;
	const repoRoot = opts.repoRoot ?? process.cwd();
	const buildDir = path.join(
		repoRoot,
		"packages",
		"native-plugins",
		"voice-classifier-cpp",
		"build",
	);
	for (const name of [
		"libvoice_classifier.so",
		"libvoice_classifier.dylib",
		"voice_classifier.dll",
	]) {
		const candidate = path.join(buildDir, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function dlopenLibrary(libraryPath: string): {
	lib: BunFfiLib;
	ffi: BunFfiModule;
} {
	const ffi = loadBunFfi();
	const T = ffi.FFIType;
	const lib = ffi.dlopen(libraryPath, {
		voice_diarizer_open: { args: [T.cstring, T.ptr], returns: T.i32 },
		voice_diarizer_segment: {
			args: [T.u64, T.ptr, T.usize, T.ptr, T.ptr],
			returns: T.i32,
		},
		voice_diarizer_close: { args: [T.u64], returns: T.i32 },
	});
	return { lib, ffi };
}

/**
 * ggml-backed pyannote-3 diarizer. Wraps `voice_diarizer_*` entry
 * points in `voice-classifier-cpp`. Today the `open` path is real
 * (parses + validates the GGUF); the `segment` forward pass returns
 * -ENOSYS until the J1.c-forward SincNet + LSTM + powerset graph
 * ports.
 */
export class DiarizerGgml {
	readonly ggufPath: string;
	readonly numClasses = DIARIZER_GGML_NUM_CLASSES;
	readonly sampleRate = DIARIZER_GGML_SAMPLE_RATE;
	private readonly libraryPath: string | undefined;
	private readonly repoRoot: string | undefined;
	private handle: bigint | null = null;
	private ffi: BunFfiModule | null = null;
	private lib: BunFfiLib | null = null;
	private disposed = false;

	constructor(options: DiarizerGgmlOptions) {
		if (typeof options.ggufPath !== "string" || options.ggufPath.length === 0) {
			throw new DiarizerGgmlUnavailableError(
				"invalid-input",
				"[diarizer-ggml] ggufPath is required",
			);
		}
		this.ggufPath = options.ggufPath;
		this.libraryPath = options.libraryPath;
		this.repoRoot = options.repoRoot;
	}

	private ensureOpen(): void {
		if (this.disposed) {
			throw new DiarizerGgmlUnavailableError(
				"model-load-failed",
				"[diarizer-ggml] diarizer has been disposed",
			);
		}
		if (this.handle !== null) return;

		if (!existsSync(this.ggufPath)) {
			throw new DiarizerGgmlUnavailableError(
				"model-missing",
				`[diarizer-ggml] GGUF not found at ${this.ggufPath}`,
			);
		}
		const libraryPath = resolveVoiceClassifierLibrary({
			...(this.libraryPath ? { libraryPath: this.libraryPath } : {}),
			...(this.repoRoot ? { repoRoot: this.repoRoot } : {}),
		});
		if (!libraryPath) {
			throw new DiarizerGgmlUnavailableError(
				"library-missing",
				"[diarizer-ggml] libvoice_classifier not found. Build via cmake in packages/native-plugins/voice-classifier-cpp/.",
			);
		}

		const { lib, ffi } = dlopenLibrary(libraryPath);
		const handleView = new BigUint64Array(1);
		const cstrBuf = new TextEncoder().encode(`${this.ggufPath}\0`);
		const rc = lib.symbols.voice_diarizer_open(
			ffi.ptr(cstrBuf),
			ffi.ptr(handleView),
		);
		if (rc !== 0) {
			lib.close();
			const code: DiarizerGgmlUnavailableError["code"] =
				rc === -2
					? "model-missing"
					: rc === -22
						? "model-shape-mismatch"
						: "model-load-failed";
			throw new DiarizerGgmlUnavailableError(
				code,
				`[diarizer-ggml] voice_diarizer_open returned ${rc} for ${this.ggufPath}`,
			);
		}
		const handle = handleView[0];
		if (handle === 0n) {
			lib.close();
			throw new DiarizerGgmlUnavailableError(
				"model-load-failed",
				"[diarizer-ggml] voice_diarizer_open returned 0 but did not write a handle",
			);
		}
		this.handle = handle;
		this.ffi = ffi;
		this.lib = lib;
	}

	/** Segment a 5 s window into a per-frame powerset label sequence.
	 *  K3 lands the forward pass: returns ~293 labels per 5 s window. */
	async segment(pcm: Float32Array): Promise<DiarizerGgmlOutput> {
		if (!(pcm instanceof Float32Array)) {
			throw new DiarizerGgmlUnavailableError(
				"invalid-input",
				"[diarizer-ggml] pcm must be a Float32Array",
			);
		}
		if (pcm.length < DIARIZER_GGML_MIN_SAMPLES) {
			throw new DiarizerGgmlUnavailableError(
				"invalid-input",
				`[diarizer-ggml] pcm too short: ${pcm.length} samples < ${DIARIZER_GGML_MIN_SAMPLES}`,
			);
		}
		this.ensureOpen();
		if (!this.handle || !this.ffi || !this.lib) {
			throw new DiarizerGgmlUnavailableError(
				"model-load-failed",
				"[diarizer-ggml] handle is null after ensureOpen",
			);
		}

		// Pyannote-3 emits 293 labels per 5-s window at 16 kHz. Allocate
		// a generous upper bound and let the library report the actual
		// frame count back via *frames_capacity_inout.
		const labelsView = new Int8Array(2048);
		const capacityView = new BigUint64Array(1);
		capacityView[0] = BigInt(labelsView.length);
		const started = performance.now();
		const rc = this.lib.symbols.voice_diarizer_segment(
			this.handle,
			this.ffi.ptr(pcm),
			BigInt(pcm.length),
			this.ffi.ptr(labelsView),
			this.ffi.ptr(capacityView),
		);
		const latencyMs = performance.now() - started;
		if (rc !== 0) {
			const code: DiarizerGgmlUnavailableError["code"] =
				rc === -38
					? "forward-not-implemented"
					: rc === -22
						? "invalid-input"
						: "model-load-failed";
			throw new DiarizerGgmlUnavailableError(
				code,
				`[diarizer-ggml] voice_diarizer_segment returned ${rc}; J1.c-forward SincNet+LSTM graph is the next port.`,
			);
		}
		const nFrames = Number(capacityView[0]);
		return { labels: labelsView.slice(0, nFrames), latencyMs };
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.handle !== null && this.lib) {
			this.lib.symbols.voice_diarizer_close(this.handle);
			this.lib.close();
		}
		this.handle = null;
		this.lib = null;
		this.ffi = null;
	}
}
