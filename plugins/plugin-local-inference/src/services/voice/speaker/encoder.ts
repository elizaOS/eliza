/**
 * Speaker-embedding encoder — GGML-backed re-export shim.
 *
 * The ONNX `WespeakerEncoder` was removed when `onnxruntime-node` was
 * dropped. This file re-exports the GGML equivalents under backward-
 * compatible names so callers in `routes/` and `engine-bridge.ts` do not
 * all need simultaneous updates.
 *
 * New callers should import from `./encoder-ggml` directly.
 */

import { existsSync } from "node:fs";
import { normalizeVoiceEmbedding } from "../speaker-imprint";
import {
	SPEAKER_GGML_EMBEDDING_DIM,
	SPEAKER_GGML_MIN_SAMPLES,
	SPEAKER_GGML_SAMPLE_RATE,
	SpeakerEncoderGgmlImpl,
	SpeakerEncoderGgmlUnavailableError,
} from "./encoder-ggml";

export {
	SpeakerEncoderGgmlImpl,
	type SpeakerEncoderGgmlOptions,
	SpeakerEncoderGgmlUnavailableError,
} from "./encoder-ggml";

// ---------------------------------------------------------------------------
// Backward-compatible model id constants.
// The GGUF model replaces the ONNX exports; the model id strings are kept
// for compatibility with stored profiles (changing them would invalidate
// any existing voice profiles in the database).
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
// Backward-compatible error class alias.
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
// Backward-compatible SpeakerEncoder interface.
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
// WespeakerEncoder — now a factory wrapper around SpeakerEncoderGgmlImpl.
// The model path argument is kept for API compatibility; it now points to
// a GGUF file (`voice/speaker-encoder/wespeaker-resnet34-lm.gguf`).
// ---------------------------------------------------------------------------

export class WespeakerEncoder implements SpeakerEncoder {
	readonly embeddingDim = WESPEAKER_EMBEDDING_DIM;
	readonly sampleRate = WESPEAKER_SAMPLE_RATE;
	private readonly impl: SpeakerEncoderGgmlImpl;

	private constructor(ggufPath: string) {
		this.impl = new SpeakerEncoderGgmlImpl({ ggufPath });
	}

	static async load(
		ggufPath: string,
		_modelId: WespeakerModelId = WESPEAKER_RESNET34_LM_INT8_MODEL_ID,
	): Promise<WespeakerEncoder> {
		if (!existsSync(ggufPath)) {
			throw new SpeakerEncoderUnavailableError(
				"model-missing",
				`[wespeaker] GGUF not found at ${ggufPath}`,
			);
		}
		return new WespeakerEncoder(ggufPath);
	}

	async encode(pcm: Float32Array): Promise<Float32Array> {
		try {
			return await this.impl.encode(pcm);
		} catch (err) {
			if (err instanceof SpeakerEncoderGgmlUnavailableError) {
				throw new SpeakerEncoderUnavailableError(err.code, err.message);
			}
			throw err;
		}
	}

	async dispose(): Promise<void> {
		await this.impl.dispose();
	}
}

// ---------------------------------------------------------------------------
// averageEmbeddings — pure helper, unchanged from original encoder.ts.
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
