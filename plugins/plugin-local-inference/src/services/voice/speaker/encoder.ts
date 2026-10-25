/**
 * Speaker-embedding encoder — shared contract, model-id constants, and the
 * `averageEmbeddings` centroid helper.
 *
 * The speaker encoder runs EXCLUSIVELY through the fused `libelizainference`
 * `eliza_inference_speaker_*` ABI (`FusedSpeakerEncoder` in `encoder-fused.ts`).
 * The standalone `WespeakerEncoder` (`libvoice_classifier`) binding has been
 * removed — there is one on-device voice runtime.
 *
 * This module retains the cross-cutting pieces every encoder caller shares:
 *   - the `SpeakerEncoder` interface the fused encoder implements,
 *   - the stored model-id strings (kept stable so existing voice profiles in
 *     the database stay valid),
 *   - the canonical dims (re-exported from `encoder-ggml`),
 *   - the `SpeakerEncoderUnavailableError` the enrollment routes raise,
 *   - the pure `averageEmbeddings` centroid helper.
 */

import { normalizeVoiceEmbedding } from "../speaker-imprint";
import {
	SPEAKER_GGML_EMBEDDING_DIM,
	SPEAKER_GGML_MIN_SAMPLES,
	SPEAKER_GGML_SAMPLE_RATE,
} from "./encoder-ggml";

// ---------------------------------------------------------------------------
// Stored model id constants.
// The model id strings are kept stable for compatibility with stored profiles
// (changing them would invalidate any existing voice profiles in the database).
// ---------------------------------------------------------------------------

export const WESPEAKER_RESNET34_LM_INT8_MODEL_ID =
	"wespeaker-resnet34-lm-int8" as const;
export const WESPEAKER_RESNET34_LM_FP32_MODEL_ID =
	"wespeaker-resnet34-lm-fp32" as const;
export type WespeakerModelId =
	| typeof WESPEAKER_RESNET34_LM_INT8_MODEL_ID
	| typeof WESPEAKER_RESNET34_LM_FP32_MODEL_ID;

export const WESPEAKER_EMBEDDING_DIM = SPEAKER_GGML_EMBEDDING_DIM;
export const WESPEAKER_SAMPLE_RATE = SPEAKER_GGML_SAMPLE_RATE;
export const WESPEAKER_MIN_SAMPLES = SPEAKER_GGML_MIN_SAMPLES;

// ---------------------------------------------------------------------------
// Structured error.
// ---------------------------------------------------------------------------

export class SpeakerEncoderUnavailableError extends Error {
	readonly code:
		| "native-missing"
		| "library-missing"
		| "model-missing"
		| "model-load-failed"
		| "model-shape-mismatch"
		| "forward-not-implemented"
		| "invalid-input";
	constructor(code: SpeakerEncoderUnavailableError["code"], message: string) {
		super(message);
		this.name = "SpeakerEncoderUnavailableError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// SpeakerEncoder interface.
// ---------------------------------------------------------------------------

/** The minimal contract every speaker encoder honors. */
export interface SpeakerEncoder {
	readonly embeddingDim: number;
	readonly sampleRate: number;
	readonly modelId?: string;
	encode(pcm: Float32Array): Promise<Float32Array>;
	dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// averageEmbeddings — pure centroid helper.
// ---------------------------------------------------------------------------

export function averageEmbeddings(
	embeddings: readonly Float32Array[],
): Float32Array {
	if (embeddings.length === 0) {
		throw new SpeakerEncoderUnavailableError(
			"invalid-input",
			"[wespeaker] averageEmbeddings called with no inputs",
		);
	}
	const dim = embeddings[0].length;
	const sum = new Float64Array(dim);
	for (const emb of embeddings) {
		if (emb.length !== dim) {
			throw new SpeakerEncoderUnavailableError(
				"invalid-input",
				`[wespeaker] embedding dim mismatch: ${emb.length} vs ${dim}`,
			);
		}
		for (let i = 0; i < dim; i += 1) sum[i] += emb[i];
	}
	const out = new Float32Array(dim);
	for (let i = 0; i < dim; i += 1) out[i] = sum[i] / embeddings.length;
	const normalized = normalizeVoiceEmbedding(out);
	return Float32Array.from(normalized);
}
