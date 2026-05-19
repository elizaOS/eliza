/**
 * WeSpeaker ResNet34-LM speaker-embedding encoder — GGML/GGUF path.
 *
 * Produces a 256-dim L2-normalized speaker embedding from a mono PCM
 * waveform sampled at 16 kHz. The encoder loads
 * `wespeaker-resnet34-lm.gguf` (produced by
 * `packages/native/plugins/voice-classifier-cpp/scripts/voice_speaker_to_gguf.py`)
 * through the `voice-classifier-cpp` SHARED library via `bun:ffi` and
 * runs the native ggml graph end-to-end.
 *
 * There is no ONNX fallback (architecture commandment: every on-device
 * model loads as GGUF). When the native library or the GGUF is missing
 * the constructor throws `SpeakerEncoderUnavailableError` and the
 * pipeline surfaces "speaker recognition unavailable" without
 * fabricating a synthetic embedding.
 */

import {
	SPEAKER_GGML_EMBEDDING_DIM,
	SPEAKER_GGML_MIN_SAMPLES,
	SPEAKER_GGML_SAMPLE_RATE,
	SpeakerEncoderGgmlImpl,
	SpeakerEncoderGgmlUnavailableError,
} from "./encoder-ggml";

/** Canonical model id stored on every `VoiceProfileRecord.embeddingModel`. */
export const WESPEAKER_RESNET34_LM_INT8_MODEL_ID =
	"wespeaker-resnet34-lm-int8" as const;
export const WESPEAKER_RESNET34_LM_FP32_MODEL_ID =
	"wespeaker-resnet34-lm-fp32" as const;
export type WespeakerModelId =
	| typeof WESPEAKER_RESNET34_LM_INT8_MODEL_ID
	| typeof WESPEAKER_RESNET34_LM_FP32_MODEL_ID;

/** Output embedding dim of the ResNet34-LM checkpoint. */
export const WESPEAKER_EMBEDDING_DIM = SPEAKER_GGML_EMBEDDING_DIM;

/** Required input sample rate (matches the WeSpeaker training config). */
export const WESPEAKER_SAMPLE_RATE = SPEAKER_GGML_SAMPLE_RATE;

/** Minimum useful audio window for an embedding (~1.0 s). */
export const WESPEAKER_MIN_SAMPLES = SPEAKER_GGML_MIN_SAMPLES;

/** Thrown when the encoder cannot be constructed (missing native lib,
 *  missing GGUF, ggml graph failure). */
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

/** The bare contract every speaker encoder honors. */
export interface SpeakerEncoder {
	readonly modelId: WespeakerModelId;
	readonly embeddingDim: number;
	readonly sampleRate: number;
	encode(pcm: Float32Array): Promise<Float32Array>;
	dispose(): Promise<void>;
}

function translateError(err: unknown): SpeakerEncoderUnavailableError | Error {
	if (err instanceof SpeakerEncoderGgmlUnavailableError) {
		return new SpeakerEncoderUnavailableError(err.code, err.message);
	}
	return err instanceof Error ? err : new Error(String(err));
}

/**
 * GGML-backed WeSpeaker ResNet34-LM encoder. Wraps `SpeakerEncoderGgmlImpl`
 * so the rest of the pipeline keeps importing `WespeakerEncoder` by
 * name.
 */
export class WespeakerEncoder implements SpeakerEncoder {
	readonly modelId: WespeakerModelId;
	readonly embeddingDim = WESPEAKER_EMBEDDING_DIM;
	readonly sampleRate = WESPEAKER_SAMPLE_RATE;
	private disposed = false;

	private constructor(
		private readonly inner: SpeakerEncoderGgmlImpl,
		modelId: WespeakerModelId,
	) {
		this.modelId = modelId;
	}

	/**
	 * Load a WeSpeaker encoder from a `.gguf` file. The `modelId` only
	 * affects the attribution evidence row; both INT8 and FP32 GGUFs
	 * resolve to the same C ABI.
	 */
	static async load(
		modelPath: string,
		modelId: WespeakerModelId = WESPEAKER_RESNET34_LM_INT8_MODEL_ID,
	): Promise<WespeakerEncoder> {
		let inner: SpeakerEncoderGgmlImpl;
		try {
			inner = new SpeakerEncoderGgmlImpl({ ggufPath: modelPath });
		} catch (err) {
			throw translateError(err);
		}
		// Eagerly trigger ensureOpen via a no-op encode probe? The ggml
		// binding opens lazily on first encode(); we keep that behaviour
		// here so `load()` stays cheap (matches the previous ORT path,
		// which only mmap'd on first run).
		return new WespeakerEncoder(inner, modelId);
	}

	async encode(pcm: Float32Array): Promise<Float32Array> {
		if (this.disposed) {
			throw new SpeakerEncoderUnavailableError(
				"model-load-failed",
				"[wespeaker] encoder has been disposed",
			);
		}
		if (pcm.length < WESPEAKER_MIN_SAMPLES) {
			throw new SpeakerEncoderUnavailableError(
				"invalid-input",
				`[wespeaker] input window too short: ${pcm.length} samples (< ${WESPEAKER_MIN_SAMPLES})`,
			);
		}
		for (let i = 0; i < pcm.length; i += 1) {
			if (!Number.isFinite(pcm[i])) {
				throw new SpeakerEncoderUnavailableError(
					"invalid-input",
					`[wespeaker] non-finite sample at index ${i}`,
				);
			}
		}
		try {
			return await this.inner.encode(pcm);
		} catch (err) {
			throw translateError(err);
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.inner.dispose();
	}
}

/**
 * Combine N per-window embeddings into a single L2-normalized centroid.
 * Used by the onboarding finalizer and the running-mean refinement on
 * each new attribution.
 */
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
	let norm = 0;
	for (let i = 0; i < dim; i += 1) {
		out[i] = sum[i] / embeddings.length;
		norm += out[i] * out[i];
	}
	const denom = Math.sqrt(norm);
	if (denom > 0) {
		for (let i = 0; i < dim; i += 1) out[i] = out[i] / denom;
	}
	return out;
}
