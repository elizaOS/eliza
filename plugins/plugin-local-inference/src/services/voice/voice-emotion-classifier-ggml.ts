/**
 * Voice-emotion classifier — ggml-backed binding (J1.a).
 *
 * Replaces the `voice-emotion-classifier.ts` onnxruntime-node path
 * with a `bun:ffi` binding to the `voice-classifier-cpp` SHARED
 * library at `packages/native-plugins/voice-classifier-cpp/`.
 *
 * Status today (J1.a infrastructure landed):
 *   - The native library now ships as `libvoice_classifier.{so,dylib,dll}`
 *     (was STATIC-only; J1 converted it to SHARED so `bun:ffi` can
 *     dlopen it).
 *   - `voice_emotion_open` is a REAL implementation: it parses the
 *     GGUF header, validates the metadata block against the locked
 *     C-ABI contract (sample rate, n_mels, n_fft, hop, num_classes),
 *     and produces a real handle.
 *   - `voice_emotion_classify` returns `-ENOSYS` from the placeholder
 *     forward graph — the Wav2Small CNN+Transformer port to ggml is
 *     the J1.a follow-up.
 *
 * That gives the TS surface a cleaner failure split:
 *   - GGUF missing  → `model-missing` (was `native-stub` always).
 *   - GGUF parsed, wrong metadata  → `model-shape-mismatch`.
 *   - GGUF parsed, no forward graph → `forward-not-implemented`.
 *   - bun:ffi / library unavailable → `native-missing`.
 *
 * No silent fallback (AGENTS.md §3): every failure mode throws
 * `VoiceEmotionGgmlUnavailableError` with a structured code. The
 * resolver above this binding picks the legacy ONNX path; this class
 * never fabricates a probability.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/** The canonical 7-class basic-emotion vocabulary, in the locked
 *  order the native `voice_emotion_class_name` table returns. */
export const VOICE_EMOTION_CLASS_NAMES = [
	"neutral",
	"happy",
	"sad",
	"angry",
	"fear",
	"disgust",
	"surprise",
] as const;

export type VoiceEmotionClass = (typeof VOICE_EMOTION_CLASS_NAMES)[number];

/** Required input sample rate. Matches `VOICE_CLASSIFIER_SAMPLE_RATE_HZ`. */
export const VOICE_EMOTION_GGML_SAMPLE_RATE = 16_000;

/** Hard minimum window: anything shorter than 1.0 s is rejected. */
export const VOICE_EMOTION_GGML_MIN_SAMPLES = 16_000;

/** Soft maximum window: longer inputs are truncated to the trailing window. */
export const VOICE_EMOTION_GGML_MAX_SAMPLES = 16_000 * 12;

/** Raised when the ggml binding cannot be loaded or scored. */
export class VoiceEmotionGgmlUnavailableError extends Error {
	readonly code:
		| "native-missing"
		| "library-missing"
		| "model-missing"
		| "model-load-failed"
		| "model-shape-mismatch"
		| "forward-not-implemented"
		| "invalid-input";
	constructor(code: VoiceEmotionGgmlUnavailableError["code"], message: string) {
		super(message);
		this.name = "VoiceEmotionGgmlUnavailableError";
		this.code = code;
	}
}

/** One classifier inference output. */
export interface VoiceEmotionGgmlOutput {
	probs: Float32Array;
	topClass: VoiceEmotionClass;
	confidence: number;
	latencyMs: number;
}

/** Construction options. */
export interface VoiceEmotionGgmlClassifierOptions {
	/** Absolute path to the GGUF file. */
	ggufPath: string;
	/** Override the .so/.dylib path. Default: repo-local build dir. */
	libraryPath?: string;
	/** Override the repo root for the default library search path. */
	repoRoot?: string;
}

/* -------- bun:ffi minimal surface -------- */

interface BunFfiSymbols {
	voice_emotion_open: (gguf_path: unknown, out: unknown) => number;
	voice_emotion_classify: (
		handle: bigint,
		pcm: unknown,
		n_samples: bigint | number,
		out_probs: unknown,
	) => number;
	voice_emotion_close: (handle: bigint) => number;
	voice_classifier_active_backend: () => unknown;
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
		throw new VoiceEmotionGgmlUnavailableError(
			"native-missing",
			`[voice-emotion-ggml] bun:ffi is unavailable. The ggml-backed binding requires Bun: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/**
 * Resolve `libvoice_classifier.{so,dylib,dll}` on disk. Search order:
 *   1. `opts.libraryPath` if explicitly set.
 *   2. `$ELIZA_VOICE_CLASSIFIER_LIB` if set.
 *   3. The repo-local CMake build output.
 */
export function resolveVoiceClassifierLibrary(opts: {
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

interface DlopenResult {
	lib: BunFfiLib;
	ffi: BunFfiModule;
	libraryPath: string;
}

function dlopenLibrary(libraryPath: string): DlopenResult {
	const ffi = loadBunFfi();
	const T = ffi.FFIType;
	const lib = ffi.dlopen(libraryPath, {
		voice_emotion_open: { args: [T.cstring, T.ptr], returns: T.i32 },
		voice_emotion_classify: {
			args: [T.u64, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		voice_emotion_close: { args: [T.u64], returns: T.i32 },
		voice_classifier_active_backend: { args: [], returns: T.cstring },
	});
	return { lib, ffi, libraryPath };
}

/**
 * EXPERIMENTAL ggml-backed voice-emotion classifier. Wraps the
 * `voice_emotion_*` entry points in `voice-classifier-cpp`. Today the
 * `open` path is real (parses + validates the GGUF metadata block);
 * the `classify` forward pass returns `-ENOSYS` until the J1.a-forward
 * graph ports.
 */
export class VoiceEmotionGgmlClassifier {
	readonly ggufPath: string;
	readonly sampleRate = VOICE_EMOTION_GGML_SAMPLE_RATE;
	readonly numClasses = VOICE_EMOTION_CLASS_NAMES.length;
	private readonly libraryPath: string | undefined;
	private readonly repoRoot: string | undefined;
	private handle: bigint | null = null;
	private ffi: BunFfiModule | null = null;
	private lib: BunFfiLib | null = null;
	private disposed = false;

	constructor(options: VoiceEmotionGgmlClassifierOptions) {
		if (typeof options.ggufPath !== "string" || options.ggufPath.length === 0) {
			throw new VoiceEmotionGgmlUnavailableError(
				"invalid-input",
				"[voice-emotion-ggml] ggufPath is required",
			);
		}
		this.ggufPath = options.ggufPath;
		this.libraryPath = options.libraryPath;
		this.repoRoot = options.repoRoot;
	}

	/** Diagnostic — name of the active dispatch path. Returns
	 *  `"ggml-cpu-shape"` on the J1 infrastructure build, `"stub"` on
	 *  the legacy. */
	activeBackend(): string {
		this.ensureOpen();
		if (!this.ffi || !this.lib) return "unloaded";
		const cstr = this.lib.symbols.voice_classifier_active_backend();
		return new this.ffi.CString(cstr).toString();
	}

	private ensureOpen(): void {
		if (this.disposed) {
			throw new VoiceEmotionGgmlUnavailableError(
				"model-load-failed",
				"[voice-emotion-ggml] classifier has been disposed",
			);
		}
		if (this.handle !== null) return;

		if (!existsSync(this.ggufPath)) {
			throw new VoiceEmotionGgmlUnavailableError(
				"model-missing",
				`[voice-emotion-ggml] GGUF not found at ${this.ggufPath}`,
			);
		}
		const libraryPath = resolveVoiceClassifierLibrary({
			...(this.libraryPath ? { libraryPath: this.libraryPath } : {}),
			...(this.repoRoot ? { repoRoot: this.repoRoot } : {}),
		});
		if (!libraryPath) {
			throw new VoiceEmotionGgmlUnavailableError(
				"library-missing",
				"[voice-emotion-ggml] libvoice_classifier not found. Build it via `cmake -B packages/native-plugins/voice-classifier-cpp/build -S packages/native-plugins/voice-classifier-cpp && cmake --build packages/native-plugins/voice-classifier-cpp/build`, or set $ELIZA_VOICE_CLASSIFIER_LIB.",
			);
		}

		const { lib, ffi } = dlopenLibrary(libraryPath);
		const handleView = new BigUint64Array(1);
		const cstrBuf = new TextEncoder().encode(`${this.ggufPath}\0`);
		const rc = lib.symbols.voice_emotion_open(
			ffi.ptr(cstrBuf),
			ffi.ptr(handleView),
		);
		if (rc !== 0) {
			lib.close();
			const code: VoiceEmotionGgmlUnavailableError["code"] =
				rc === -2 /* ENOENT */
					? "model-missing"
					: rc === -22 /* EINVAL */
						? "model-shape-mismatch"
						: "model-load-failed";
			throw new VoiceEmotionGgmlUnavailableError(
				code,
				`[voice-emotion-ggml] voice_emotion_open returned ${rc} for ${this.ggufPath}`,
			);
		}
		const handle = handleView[0];
		if (handle === 0n) {
			lib.close();
			throw new VoiceEmotionGgmlUnavailableError(
				"model-load-failed",
				"[voice-emotion-ggml] voice_emotion_open returned 0 but did not write a handle",
			);
		}
		this.handle = handle;
		this.ffi = ffi;
		this.lib = lib;
	}

	/** Classify a single utterance. Throws until the J1.a-forward
	 *  ggml graph lands — returns `forward-not-implemented` so the
	 *  resolver can fall back cleanly. */
	async classify(pcm: Float32Array): Promise<VoiceEmotionGgmlOutput> {
		if (!(pcm instanceof Float32Array)) {
			throw new VoiceEmotionGgmlUnavailableError(
				"invalid-input",
				"[voice-emotion-ggml] pcm must be a Float32Array",
			);
		}
		if (pcm.length < VOICE_EMOTION_GGML_MIN_SAMPLES) {
			throw new VoiceEmotionGgmlUnavailableError(
				"invalid-input",
				`[voice-emotion-ggml] pcm too short: ${pcm.length} samples < ${VOICE_EMOTION_GGML_MIN_SAMPLES}`,
			);
		}
		this.ensureOpen();
		if (!this.handle || !this.ffi || !this.lib) {
			throw new VoiceEmotionGgmlUnavailableError(
				"model-load-failed",
				"[voice-emotion-ggml] handle is null after ensureOpen",
			);
		}

		const samples =
			pcm.length > VOICE_EMOTION_GGML_MAX_SAMPLES
				? pcm.subarray(pcm.length - VOICE_EMOTION_GGML_MAX_SAMPLES)
				: pcm;
		const probsView = new Float32Array(VOICE_EMOTION_CLASS_NAMES.length);
		const started = performance.now();
		const rc = this.lib.symbols.voice_emotion_classify(
			this.handle,
			this.ffi.ptr(samples),
			BigInt(samples.length),
			this.ffi.ptr(probsView),
		);
		const latencyMs = performance.now() - started;
		if (rc !== 0) {
			// -38 = ENOSYS on Linux; the forward graph isn't wired yet.
			const code: VoiceEmotionGgmlUnavailableError["code"] =
				rc === -38 /* ENOSYS */
					? "forward-not-implemented"
					: rc === -22 /* EINVAL */
						? "invalid-input"
						: "model-load-failed";
			throw new VoiceEmotionGgmlUnavailableError(
				code,
				`[voice-emotion-ggml] voice_emotion_classify returned ${rc}; the J1.a-forward ggml graph is the next port.`,
			);
		}
		let topIdx = 0;
		let topProb = probsView[0];
		for (let i = 1; i < probsView.length; ++i) {
			if (probsView[i] > topProb) {
				topProb = probsView[i];
				topIdx = i;
			}
		}
		return {
			probs: probsView,
			topClass: VOICE_EMOTION_CLASS_NAMES[topIdx],
			confidence: topProb,
			latencyMs,
		};
	}

	/** Free the underlying native session. Idempotent. */
	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.handle !== null && this.lib) {
			this.lib.symbols.voice_emotion_close(this.handle);
			this.lib.close();
		}
		this.handle = null;
		this.lib = null;
		this.ffi = null;
	}
}

/**
 * Convenience: map a class index (0-6) to the canonical class name.
 * Mirrors the C-side `voice_emotion_class_name` accessor.
 */
export function voiceEmotionClassName(idx: number): VoiceEmotionClass | null {
	if (!Number.isInteger(idx)) return null;
	if (idx < 0 || idx >= VOICE_EMOTION_CLASS_NAMES.length) return null;
	return VOICE_EMOTION_CLASS_NAMES[idx];
}
