/**
 * Speaker-embedding encoder — EXPERIMENTAL ggml-backed binding.
 *
 * This is the Phase 1 TS surface that will replace `encoder.ts` (the
 * onnxruntime-node WeSpeaker ResNet34-LM implementation) once the
 * native `voice-classifier-cpp` library
 * (`packages/native-plugins/voice-classifier-cpp/`) grows real
 * implementations behind its frozen C ABI. The recommended replacement
 * upstream is `speechbrain/spkrec-ecapa-voxceleb` (Apache-2.0,
 * ECAPA-TDNN, native 192-dim embedding — matches the C-side
 * `VOICE_SPEAKER_EMBEDDING_DIM`).
 *
 * Status today (Phase 1):
 *   - The native library exists with a frozen C ABI declared in
 *     `include/voice_classifier/voice_classifier.h`.
 *   - The model entry points (`voice_speaker_open`,
 *     `voice_speaker_embed`, `voice_speaker_close`) currently return
 *     `-ENOSYS` from the stub.
 *   - The cosine-distance helper (`voice_speaker_distance`) is real
 *     and exposed below as `voiceSpeakerDistance` (Float32 fallback —
 *     Phase 2 will dispatch into the native helper for parity).
 *
 * Output contract:
 *   - 192-dim L2-normalized speaker embedding suitable for cosine-
 *     distance matching.
 *   - The embedding dim is fixed at 192 (matches the ECAPA-TDNN
 *     convention and the C-side header). The legacy WeSpeaker
 *     ResNet34-LM encoder used today produces 256-dim embeddings;
 *     callers migrating must update their `embeddingDim` checks.
 *
 * Audio convention:
 *   - Mono Float32 PCM, samples in [-1, 1], sample rate 16 kHz.
 *
 * No silent fallback: when the native library is missing or the model
 * entry points are still stubbed, this class throws
 * `SpeakerEncoderGgmlUnavailableError`. There is no synthetic
 * embedding fallback — synthetic embeddings would silently match every
 * voice to whatever cluster they happened to be near in the synthetic
 * feature space.
 */

/** Output embedding dim. Matches `VOICE_SPEAKER_EMBEDDING_DIM`. */
export const SPEAKER_GGML_EMBEDDING_DIM = 192;

/** Required input sample rate. */
export const SPEAKER_GGML_SAMPLE_RATE = 16_000;

/** Minimum useful audio window (~1.0 s). Shorter windows yield
 *  embeddings dominated by silence-padding bias. */
export const SPEAKER_GGML_MIN_SAMPLES = 16_000;

/** Raised when the encoder cannot be constructed (missing native lib,
 *  bad GGUF) or the native model entry points are still stubbed. */
export class SpeakerEncoderGgmlUnavailableError extends Error {
	readonly code:
		| "native-missing"
		| "native-stub"
		| "model-load-failed"
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

/** The bare contract every speaker encoder honors. Mirrors
 *  `SpeakerEncoder` in the legacy `encoder.ts` so callers can migrate
 *  without changing their interaction shape. */
export interface SpeakerEncoderGgml {
	readonly ggufPath: string;
	readonly embeddingDim: number;
	readonly sampleRate: number;
	/** Encode a PCM window to a 192-dim L2-normalized embedding.
	 *  Throws `SpeakerEncoderGgmlUnavailableError`. */
	encode(pcm: Float32Array): Promise<Float32Array>;
	/** Release the underlying native session. Idempotent. */
	dispose(): Promise<void>;
}

/** Construction options. */
export interface SpeakerEncoderGgmlOptions {
	/** Absolute path to the GGUF file produced by
	 *  `scripts/voice_speaker_to_gguf.py`. */
	ggufPath: string;
}

/**
 * EXPERIMENTAL ggml-backed speaker encoder. Wraps the
 * `voice_speaker_*` entry points in `voice-classifier-cpp`.
 *
 * Today this class declares the stable TS surface; Phase 2 wires it
 * into the production speaker-attribution pipeline once the native
 * model TUs land and parity gates pass. Until then constructing it
 * succeeds (so callers can probe), but `encode()` throws
 * `SpeakerEncoderGgmlUnavailableError` with `code: "native-stub"`.
 */
export class SpeakerEncoderGgmlImpl implements SpeakerEncoderGgml {
	readonly ggufPath: string;
	readonly embeddingDim = SPEAKER_GGML_EMBEDDING_DIM;
	readonly sampleRate = SPEAKER_GGML_SAMPLE_RATE;
	private disposed = false;

	constructor(options: SpeakerEncoderGgmlOptions) {
		if (
			typeof options.ggufPath !== "string" ||
			options.ggufPath.length === 0
		) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"invalid-input",
				"[speaker-ggml] ggufPath is required",
			);
		}
		this.ggufPath = options.ggufPath;
	}

	async encode(pcm: Float32Array): Promise<Float32Array> {
		if (this.disposed) {
			throw new SpeakerEncoderGgmlUnavailableError(
				"model-load-failed",
				"[speaker-ggml] encoder has been disposed",
			);
		}
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

		// Phase 1 stub: the native library returns -ENOSYS. Phase 2
		// wiring loads `voice_classifier_cpp` via N-API / FFI and
		// dispatches into the real `voice_speaker_embed`. Until then
		// surface a structured error rather than fabricate an embedding —
		// a synthetic embedding would silently match every voice to
		// whatever cluster it happened to be near.
		throw new SpeakerEncoderGgmlUnavailableError(
			"native-stub",
			"[speaker-ggml] native voice_speaker_embed is stubbed (-ENOSYS); Phase 2 wires the real ggml backend",
		);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

/**
 * Cosine distance between two 192-dim speaker embeddings. Defined as
 * `1 - cos_similarity(a, b)`, range [0, 2]:
 *   identical / parallel       → 0
 *   orthogonal                 → 1
 *   anti-parallel / opposite   → 2
 *
 * Mirrors the C-side `voice_speaker_distance` helper exactly. Both
 * inputs must be `SPEAKER_GGML_EMBEDDING_DIM` floats long. A zero-norm
 * input degenerates the cosine; this helper treats a zero-norm vector
 * as orthogonal to everything (returns 1) rather than producing a NaN —
 * matches what callers want when an embedding has been zeroed by an
 * upstream error path.
 *
 * Phase 1 TS implementation; Phase 2 wires into the native helper for
 * bit-parity with the C-side dispatch.
 */
export function voiceSpeakerDistance(
	a: Float32Array,
	b: Float32Array,
): number {
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
