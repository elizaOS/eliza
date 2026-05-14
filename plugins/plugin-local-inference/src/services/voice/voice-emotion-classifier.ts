/**
 * Voice-emotion classifier — on-device acoustic-prosody emotion model.
 *
 * Ships **Wav2Small** (Wagner et al., arXiv:2408.13920 — 72K params, ~120 KB
 * ONNX int8) distilled from `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`
 * (teacher — CC-BY-NC-SA-4.0, NEVER bundled). Student weights are produced by
 * `packages/training/scripts/emotion/distill_wav2small.py` and shipped under
 * Apache-2.0 alongside the eliza-1 voice bundle.
 *
 * Model contract:
 *   - Input  : 16 kHz mono Float32 PCM, [-1, 1] normalized, ≥ 1.0 s window.
 *              The student carries its own log-mel front-end (the
 *              paper's Conv1D-LogMel layer is part of the ONNX graph) so the
 *              caller hands raw PCM, not features.
 *   - Output : continuous V-A-D triple in [0, 1] (Plutchik-aligned, mapped
 *              from the teacher's V-A-D regression target).
 *
 * V-A-D → ExpressiveEmotion projection: Plutchik-style deterministic table
 * (`projectVadToExpressiveEmotion`). This is the place to align with our
 * 7-class tag set so downstream code (`EXPRESSIVE_EMOTION_TAGS`) stays
 * unchanged. The projection is intentionally simple — when callers want
 * richer signal they read the raw `vad` floats off the attribution.
 *
 * No silent fallback (AGENTS.md §3): when the ONNX runtime is missing the
 * constructor throws `OnnxRuntimeUnavailableError`; when the model file is
 * missing or malformed the inference call throws a `VoiceEmotionClassifierError`.
 * The wrapping pipeline (`attributeVoiceEmotion` / `pipeline.ts`) decides
 * whether to swallow the failure as an evidence-row downgrade or surface it.
 */

import {
	loadOnnxRuntime,
	OnnxRuntimeUnavailableError,
	type OrtInferenceSession,
	type OrtTensorCtor,
} from "./onnx-runtime";
import {
	EXPRESSIVE_EMOTION_TAGS,
	type ExpressiveEmotion,
} from "./expressive-tags";

/** Stable identifier for the Wav2Small student head we ship. */
export const WAV2SMALL_INT8_MODEL_ID = "wav2small-msp-dim-int8" as const;
/** Stable identifier for the floating-point parent we use in eval. */
export const WAV2SMALL_FP32_MODEL_ID = "wav2small-msp-dim-fp32" as const;
export type VoiceEmotionModelId =
	| typeof WAV2SMALL_INT8_MODEL_ID
	| typeof WAV2SMALL_FP32_MODEL_ID;

/** Required sample rate for the Wav2Small log-mel front-end. */
export const WAV2SMALL_SAMPLE_RATE = 16_000;
/** Hard minimum window: anything shorter is rejected. */
export const WAV2SMALL_MIN_SAMPLES = WAV2SMALL_SAMPLE_RATE; // 1.0 s
/** Soft maximum window: longer inputs are truncated to the trailing window. */
export const WAV2SMALL_MAX_SAMPLES = WAV2SMALL_SAMPLE_RATE * 12; // 12 s

/** Raised when the bundled model file can not be loaded or run. */
export class VoiceEmotionClassifierError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VoiceEmotionClassifierError";
	}
}

/** Continuous V-A-D output. All three are in [0, 1]. */
export interface VoiceEmotionVad {
	valence: number;
	arousal: number;
	dominance: number;
}

/** One classifier inference output. */
export interface VoiceEmotionClassifierOutput {
	vad: VoiceEmotionVad;
	/** Projected discrete label, or null when no projection is confident. */
	emotion: ExpressiveEmotion | null;
	/** Confidence in the projected discrete label, [0, 1]. */
	confidence: number;
	/** Per-class soft scores aligned with `EXPRESSIVE_EMOTION_TAGS`. */
	scores: Record<ExpressiveEmotion, number>;
	/** Model id used for this inference (for the attribution evidence row). */
	modelId: VoiceEmotionModelId;
	/** Inference wall-time in ms (CPU side; useful for the bench harness). */
	latencyMs: number;
}

/** Construction options. */
export interface VoiceEmotionClassifierOptions {
	/** Absolute path to the ONNX file. */
	modelPath: string;
	/** Stable model id recorded on every inference; defaults to int8. */
	modelId?: VoiceEmotionModelId;
}

/**
 * Clamp `value` into the unit interval. Non-finite inputs become 0 — the
 * downstream attribution will see 0-confidence and reject the read.
 */
function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/**
 * Project a continuous V-A-D triple into the 7-class
 * `ExpressiveEmotion` tag set. Returns soft scores per tag and the best
 * discrete pick with a confidence score.
 *
 * The projection is Plutchik-aligned and deterministic. The thresholds
 * are tuned against the MSP-Podcast V-A-D mean/std reported in the
 * audeering model card and Wav2Small paper; small enough to be stable but
 * wide enough to give every class some mass on conversational speech.
 *
 * Sign convention (audeering teacher, mirrored by Wav2Small):
 *   valence    — high = positive affect (happy, calm), low = negative (sad, angry).
 *   arousal    — high = energetic (excited, angry), low = subdued (calm, sad).
 *   dominance  — high = assertive (angry), low = submissive (nervous, whisper).
 */
export function projectVadToExpressiveEmotion(vad: VoiceEmotionVad): {
	emotion: ExpressiveEmotion | null;
	confidence: number;
	scores: Record<ExpressiveEmotion, number>;
} {
	const v = clamp01(vad.valence);
	const a = clamp01(vad.arousal);
	const d = clamp01(vad.dominance);

	// Center each axis at 0.5; magnitudes in [-0.5, 0.5].
	const vC = v - 0.5;
	const aC = a - 0.5;
	const dC = d - 0.5;

	const scores: Record<ExpressiveEmotion, number> = {
		happy: 0,
		sad: 0,
		angry: 0,
		nervous: 0,
		calm: 0,
		excited: 0,
		whisper: 0,
	};

	// happy   — high V, mid-high A, mid D.
	scores.happy = clamp01(0.5 + vC * 1.4 + Math.max(0, aC) * 0.8 - Math.abs(dC) * 0.4);
	// excited — high V, very high A.
	scores.excited = clamp01(0.4 + vC * 0.9 + aC * 1.8);
	// calm    — high-mid V, low A, mid D.
	scores.calm = clamp01(0.5 + Math.max(0, vC) * 0.8 - aC * 1.6 - Math.abs(dC) * 0.4);
	// sad     — low V, low A, low D.
	scores.sad = clamp01(0.5 - vC * 1.6 - aC * 0.8 - dC * 0.6);
	// angry   — low V, high A, high D.
	scores.angry = clamp01(0.4 - vC * 1.1 + aC * 1.2 + dC * 1.2);
	// nervous — low-mid V, mid-high A, low D.
	scores.nervous = clamp01(0.4 - vC * 0.7 + aC * 0.9 - dC * 1.4);
	// whisper — low A, low D. Valence-agnostic (we have no energy axis here).
	scores.whisper = clamp01(0.3 - aC * 1.6 - dC * 1.2);

	let best: ExpressiveEmotion | null = null;
	let bestScore = 0;
	for (const tag of EXPRESSIVE_EMOTION_TAGS) {
		if (scores[tag] > bestScore) {
			bestScore = scores[tag];
			best = tag;
		}
	}
	// Require a minimum mass before we attribute a discrete label.
	if (bestScore < 0.35) {
		return { emotion: null, confidence: bestScore, scores };
	}
	return { emotion: best, confidence: bestScore, scores };
}

/**
 * Run the Wav2Small ONNX session and return a structured emotion read.
 * Side-effect-free; safe to call concurrently as long as `ort` enforces
 * per-session locking (the node binding does).
 */
export class VoiceEmotionClassifier {
	private readonly modelPath: string;
	private readonly modelId: VoiceEmotionModelId;
	private session: OrtInferenceSession | null = null;
	private tensorCtor: OrtTensorCtor | null = null;
	private inputName: string | null = null;

	constructor(options: VoiceEmotionClassifierOptions) {
		if (typeof options.modelPath !== "string" || options.modelPath.length === 0) {
			throw new VoiceEmotionClassifierError(
				"[voice-emotion] modelPath is required",
			);
		}
		this.modelPath = options.modelPath;
		this.modelId = options.modelId ?? WAV2SMALL_INT8_MODEL_ID;
	}

	/** Lazy session-load; first call pays the cost. Subsequent calls reuse. */
	async ensureLoaded(): Promise<void> {
		if (this.session) return;
		let ort;
		try {
			ort = await loadOnnxRuntime();
		} catch (err) {
			if (err instanceof OnnxRuntimeUnavailableError) throw err;
			throw new VoiceEmotionClassifierError(
				`[voice-emotion] failed to load onnxruntime-node: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		try {
			this.session = await ort.InferenceSession.create(this.modelPath);
		} catch (err) {
			throw new VoiceEmotionClassifierError(
				`[voice-emotion] failed to load model at ${this.modelPath}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		this.tensorCtor = ort.Tensor;
		this.inputName = this.session.inputNames[0] ?? null;
		if (!this.inputName) {
			throw new VoiceEmotionClassifierError(
				"[voice-emotion] ONNX session reported zero input names",
			);
		}
	}

	/**
	 * Classify a single utterance. `pcm` must be 16 kHz mono Float32 in
	 * [-1, 1]. Inputs shorter than `WAV2SMALL_MIN_SAMPLES` throw; longer
	 * inputs are truncated to the trailing `WAV2SMALL_MAX_SAMPLES` window
	 * (the final 12 s carry the most-recent prosody — strongest signal for
	 * "what did the user just say in what mood").
	 */
	async classify(pcm: Float32Array): Promise<VoiceEmotionClassifierOutput> {
		if (!(pcm instanceof Float32Array)) {
			throw new VoiceEmotionClassifierError(
				"[voice-emotion] pcm must be a Float32Array",
			);
		}
		if (pcm.length < WAV2SMALL_MIN_SAMPLES) {
			throw new VoiceEmotionClassifierError(
				`[voice-emotion] pcm too short: ${pcm.length} samples < ${WAV2SMALL_MIN_SAMPLES}`,
			);
		}
		await this.ensureLoaded();
		const session = this.session;
		const Tensor = this.tensorCtor;
		const inputName = this.inputName;
		if (!session || !Tensor || !inputName) {
			throw new VoiceEmotionClassifierError(
				"[voice-emotion] session not loaded after ensureLoaded()",
			);
		}
		const samples =
			pcm.length > WAV2SMALL_MAX_SAMPLES
				? pcm.subarray(pcm.length - WAV2SMALL_MAX_SAMPLES)
				: pcm;
		// Wav2Small input is rank-2: [batch=1, samples].
		const tensor = new Tensor("float32", samples.slice(), [1, samples.length]);
		const startedAt = Date.now();
		let outputs: Record<string, { data: Float32Array | BigInt64Array }>;
		try {
			outputs = (await session.run({ [inputName]: tensor })) as Record<
				string,
				{ data: Float32Array | BigInt64Array }
			>;
		} catch (err) {
			throw new VoiceEmotionClassifierError(
				`[voice-emotion] ONNX run failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		const latencyMs = Date.now() - startedAt;

		// Wav2Small canonical export: single output tensor of shape [1, 3] —
		// (valence, arousal, dominance). Some quantised exports name the output
		// differently; we read the first output by enumeration order.
		const outputNames = session.outputNames;
		const headName = outputNames[0];
		if (!headName) {
			throw new VoiceEmotionClassifierError(
				"[voice-emotion] ONNX session reported zero output names",
			);
		}
		const out = outputs[headName];
		if (!out || !(out.data instanceof Float32Array)) {
			throw new VoiceEmotionClassifierError(
				`[voice-emotion] expected Float32 output, got ${out?.data?.constructor?.name ?? "undefined"}`,
			);
		}
		if (out.data.length < 3) {
			throw new VoiceEmotionClassifierError(
				`[voice-emotion] expected ≥ 3 outputs (V,A,D), got ${out.data.length}`,
			);
		}
		const vad: VoiceEmotionVad = {
			valence: clamp01(out.data[0] ?? 0),
			arousal: clamp01(out.data[1] ?? 0),
			dominance: clamp01(out.data[2] ?? 0),
		};
		const projected = projectVadToExpressiveEmotion(vad);
		return {
			vad,
			emotion: projected.emotion,
			confidence: projected.confidence,
			scores: projected.scores,
			modelId: this.modelId,
			latencyMs,
		};
	}

	/** Free the underlying ONNX session. Safe to call once. */
	dispose(): void {
		this.session = null;
		this.tensorCtor = null;
		this.inputName = null;
	}
}
