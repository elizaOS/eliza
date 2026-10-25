/**
 * Speaker-embedding encoder — shared constants, error class, and the
 * embedding-distance helper.
 *
 * The speaker encoder runs EXCLUSIVELY through the fused `libelizainference`
 * `eliza_inference_speaker_*` ABI (`FusedSpeakerEncoder` in `encoder-fused.ts`).
 * There is one on-device voice runtime — no standalone `libvoice_classifier`
 * binding.
 *
 * This module retains the pieces the fused path shares:
 *   - the canonical dims (`SPEAKER_GGML_*`), pinned at 256 to match the C-side
 *     `VOICE_SPEAKER_EMBEDDING_DIM` and the WeSpeaker ResNet34-LM head,
 *   - the structured `SpeakerEncoderGgmlUnavailableError` the fused encoder
 *     throws (no synthetic embedding fallback),
 *   - the pure `voiceSpeakerDistance` cosine-distance helper.
 */

/** Output embedding dim. Matches `VOICE_SPEAKER_EMBEDDING_DIM`. */
export const SPEAKER_GGML_EMBEDDING_DIM = 256;

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

/**
 * Cosine distance between two 256-dim speaker embeddings. Defined as
 * `1 - cos_similarity(a, b)`, range [0, 2]. Mirrors the C-side
 * `voice_speaker_distance` helper exactly.
 */
export function voiceSpeakerDistance(a: Float32Array, b: Float32Array): number {
	if (a.length !== SPEAKER_GGML_EMBEDDING_DIM) {
		throw new SpeakerEncoderGgmlUnavailableError(
			"invalid-input",
			`[speaker] left embedding has dim ${a.length}, expected ${SPEAKER_GGML_EMBEDDING_DIM}`,
		);
	}
	if (b.length !== SPEAKER_GGML_EMBEDDING_DIM) {
		throw new SpeakerEncoderGgmlUnavailableError(
			"invalid-input",
			`[speaker] right embedding has dim ${b.length}, expected ${SPEAKER_GGML_EMBEDDING_DIM}`,
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
