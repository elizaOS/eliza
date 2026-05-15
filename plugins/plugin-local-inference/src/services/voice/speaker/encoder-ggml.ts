/**
 * Speaker-embedding encoder — ggml-backed binding (J1.b).
 *
 * Replaces `encoder.ts` (onnxruntime-node WeSpeaker ResNet34-LM) with
 * a `bun:ffi` binding to the `voice-classifier-cpp` SHARED library at
 * `packages/native-plugins/voice-classifier-cpp/`.
 *
 * Status today (J1.b infrastructure landed):
 *   - The native library now ships as `libvoice_classifier.{so,dylib,dll}`.
 *   - `voice_speaker_open` is a REAL implementation: parses + validates
 *     the GGUF metadata block, returns a real handle.
 *   - `voice_speaker_embed` returns `-ENOSYS` until the ResNet34 +
 *     statistics-pool graph is ported to ggml (J1.b follow-up).
 *
 * Output dim is pinned at 192 (matches the ECAPA-TDNN convention and
 * the C-side `VOICE_SPEAKER_EMBEDDING_DIM`). The legacy WeSpeaker
 * ResNet34-LM produces 256-dim embeddings; conversion scripts must
 * reproject to 192 before packing the GGUF (the C-side `_open` rejects
 * mismatched dims loudly per AGENTS.md §3 "no silent fallback").
 *
 * No silent fallback: every failure mode throws
 * `SpeakerEncoderGgmlUnavailableError`. There is no synthetic
 * embedding fallback — synthetic embeddings would silently match every
 * voice to whatever cluster they happened to be near.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/** Output embedding dim. Matches `VOICE_SPEAKER_EMBEDDING_DIM`. */
export const SPEAKER_GGML_EMBEDDING_DIM = 192;

/** Required input sample rate. */
export const SPEAKER_GGML_SAMPLE_RATE = 16_000;

/** Minimum useful audio window (~1.0 s). */
export const SPEAKER_GGML_MIN_SAMPLES = 16_000;

export class SpeakerEncoderGgmlUnavailableError extends Error {
	readonly code:
		| "native-missing"
		| "library-missing"
		| "model-missing"
		| "model-load-failed"
		| "model-shape-mismatch"
		| "forward-not-implemented"
		| "invalid-input";
	constructor(
		code: SpeakerEncoderGgmlUnavailableError["code"],
		message: string,
	) {
		super(message);
		this.name = "SpeakerEncoderGgmlUnavailableError";
		this.code = code;
	}
}

export interface SpeakerEncoderGgml {
	readonly ggufPath: string;
	readonly embeddingDim: number;
	readonly sampleRate: number;
	encode(pcm: Float32Array): Promise<Float32Array>;
	dispose(): Promise<void>;
}

export interface SpeakerEncoderGgmlOptions {
	ggufPath: string;
	libraryPath?: string;
	repoRoot?: string;
}

/* -------- bun:ffi minimal surface -------- */

interface BunFfiSymbols {
	voice_speaker_open: (gguf_path: unknown, out: unknown) => number;
	voice_speaker_embed: (
		handle: bigint,
		pcm: unknown,
		n_samples: bigint | number,
		out_embedding: unknown,
	) => number;
	voice_speaker_close: (handle: bigint) => number;
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
	if (typeof req !== "function") {
		throw new SpeakerEncoderGgmlUnavailableError(
			"native-missing",
			"[speaker-ggml] bun:ffi is unavailable. The ggml-backed binding requires Bun.",
		);
	}
	return req("bun:ffi") as BunFfiModule;
}

function resolveVoiceClassifierLibrary(opts: {
	libraryPath?: string;
	repoRoot?: string;
}): string | null {
	const explicit =
		opts.libraryPath ?? process.env.ELIZA_VOICE_CLASSIFIER_LIB;
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
		voice_speaker_open: { args: [T.cstring, T.ptr], returns: T.i32 },
		voice_speaker_embed: {
			args: [T.u64, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		voice_speaker_close: { args: [T.u64], returns: T.i32 },
	});
	return { lib, ffi };
}

/**
 * ggml-backed speaker encoder. Wraps `voice_speaker_*` entry points
 * in `voice-classifier-cpp`. Today the `open` path is real (parses +
 * validates the GGUF); the `embed` forward pass returns -ENOSYS until
 * the J1.b-forward ResNet34 graph ports.
 */
export class SpeakerEncoderGgmlImpl implements SpeakerEncoderGgml {
	readonly ggufPath: string;
	readonly embeddingDim = SPEAKER_GGML_EMBEDDING_DIM;
	readonly sampleRate = SPEAKER_GGML_SAMPLE_RATE;
	private readonly libraryPath: string | undefined;
	private readonly repoRoot: string | undefined;
	private handle: bigint | null = null;
	private ffi: BunFfiModule | null = null;
	private lib: BunFfiLib | null = null;
	private disposed = false;

	constructor(options: SpeakerEncoderGgmlOptions) {
		if (typeof options.ggufPath !== "string" || options.ggufPath.length === 0) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"invalid-input",
				"[speaker-ggml] ggufPath is required",
			);
		}
		this.ggufPath = options.ggufPath;
		this.libraryPath = options.libraryPath;
		this.repoRoot = options.repoRoot;
	}

	private ensureOpen(): void {
		if (this.disposed) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"model-load-failed",
				"[speaker-ggml] encoder has been disposed",
			);
		}
		if (this.handle !== null) return;

		if (!existsSync(this.ggufPath)) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"model-missing",
				`[speaker-ggml] GGUF not found at ${this.ggufPath}`,
			);
		}
		const libraryPath = resolveVoiceClassifierLibrary({
			...(this.libraryPath ? { libraryPath: this.libraryPath } : {}),
			...(this.repoRoot ? { repoRoot: this.repoRoot } : {}),
		});
		if (!libraryPath) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"library-missing",
				"[speaker-ggml] libvoice_classifier not found. Build via cmake in packages/native-plugins/voice-classifier-cpp/.",
			);
		}

		const { lib, ffi } = dlopenLibrary(libraryPath);
		const handleView = new BigUint64Array(1);
		const cstrBuf = new TextEncoder().encode(`${this.ggufPath}\0`);
		const rc = lib.symbols.voice_speaker_open(
			ffi.ptr(cstrBuf),
			ffi.ptr(handleView),
		);
		if (rc !== 0) {
			lib.close();
			const code: SpeakerEncoderGgmlUnavailableError["code"] =
				rc === -2
					? "model-missing"
					: rc === -22
						? "model-shape-mismatch"
						: "model-load-failed";
			throw new SpeakerEncoderGgmlUnavailableError(
				code,
				`[speaker-ggml] voice_speaker_open returned ${rc} for ${this.ggufPath}`,
			);
		}
		const handle = handleView[0];
		if (handle === 0n) {
			lib.close();
			throw new SpeakerEncoderGgmlUnavailableError(
				"model-load-failed",
				"[speaker-ggml] voice_speaker_open returned 0 but did not write a handle",
			);
		}
		this.handle = handle;
		this.ffi = ffi;
		this.lib = lib;
	}

	async encode(pcm: Float32Array): Promise<Float32Array> {
		if (!(pcm instanceof Float32Array)) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"invalid-input",
				"[speaker-ggml] pcm must be a Float32Array",
			);
		}
		if (pcm.length < SPEAKER_GGML_MIN_SAMPLES) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"invalid-input",
				`[speaker-ggml] pcm too short: ${pcm.length} samples < ${SPEAKER_GGML_MIN_SAMPLES}`,
			);
		}
		for (let i = 0; i < pcm.length; i += 1) {
			if (!Number.isFinite(pcm[i])) {
				throw new SpeakerEncoderGgmlUnavailableError(
					"invalid-input",
					`[speaker-ggml] non-finite sample at index ${i}`,
				);
			}
		}
		this.ensureOpen();
		if (!this.handle || !this.ffi || !this.lib) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"model-load-failed",
				"[speaker-ggml] handle is null after ensureOpen",
			);
		}

		const embView = new Float32Array(SPEAKER_GGML_EMBEDDING_DIM);
		const rc = this.lib.symbols.voice_speaker_embed(
			this.handle,
			this.ffi.ptr(pcm),
			BigInt(pcm.length),
			this.ffi.ptr(embView),
		);
		if (rc !== 0) {
			const code: SpeakerEncoderGgmlUnavailableError["code"] =
				rc === -38
					? "forward-not-implemented"
					: rc === -22
						? "invalid-input"
						: "model-load-failed";
			throw new SpeakerEncoderGgmlUnavailableError(
				code,
				`[speaker-ggml] voice_speaker_embed returned ${rc}; J1.b-forward ResNet34 graph is the next port.`,
			);
		}
		return embView;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.handle !== null && this.lib) {
			this.lib.symbols.voice_speaker_close(this.handle);
			this.lib.close();
		}
		this.handle = null;
		this.lib = null;
		this.ffi = null;
	}
}

/**
 * Cosine distance between two 192-dim speaker embeddings. Defined as
 * `1 - cos_similarity(a, b)`, range [0, 2]. Mirrors the C-side
 * `voice_speaker_distance` helper exactly.
 */
export function voiceSpeakerDistance(a: Float32Array, b: Float32Array): number {
	if (a.length !== SPEAKER_GGML_EMBEDDING_DIM) {
		throw new SpeakerEncoderGgmlUnavailableError(
			"invalid-input",
			`[speaker-ggml] left embedding has dim ${a.length}, expected ${SPEAKER_GGML_EMBEDDING_DIM}`,
		);
	}
	if (b.length !== SPEAKER_GGML_EMBEDDING_DIM) {
		throw new SpeakerEncoderGgmlUnavailableError(
			"invalid-input",
			`[speaker-ggml] right embedding has dim ${b.length}, expected ${SPEAKER_GGML_EMBEDDING_DIM}`,
		);
	}
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < SPEAKER_GGML_EMBEDDING_DIM; i += 1) {
		const av = a[i];
		const bv = b[i];
		dot += av * bv;
		normA += av * av;
		normB += bv * bv;
	}
	if (normA <= 0 || normB <= 0) return 1;
	let cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));
	if (cosine > 1) cosine = 1;
	if (cosine < -1) cosine = -1;
	return 1 - cosine;
}
