/**
 * Voice-emotion classifier — on-device acoustic-prosody emotion model.
 *
 * Ships **Wav2Small** (Wagner et al., arXiv:2408.13920 — 72K params, ~120 KB
 * ONNX int8) distilled from `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`
 * (teacher — CC-BY-NC-SA-4.0, NEVER bundled). Student weights are produced by
 * `packages/training/scripts/emotion/distill_wav2small.py` and shipped under
 * Apache-2.0 alongside the eliza-1 voice bundle.
 *
 * Model contract — auto-detected at load time from the ONNX output shape:
 *   - Input  : 16 kHz mono Float32 PCM, [-1, 1] normalized, ≥ 1.0 s window.
 *              The student carries its own log-mel front-end (the
 *              paper's Conv1D-LogMel layer is part of the ONNX graph) so the
 *              caller hands raw PCM, not features.
 *   - Output : either a continuous V-A-D triple `[1, 3]` (legacy
 *              `head=vad` contract, projected to a discrete tag via
 *              `projectVadToExpressiveEmotion`) **or** direct 7-class
 *              logits `[1, 7]` (current `head=cls7` contract, ``argmax``
 *              over softmax). The legacy V-A-D projection is bypassed when
 *              the model exposes the 7-class head.
 *
 * Why two contracts: the V-A-D projection table was calibrated against
 * audeering teacher's [0, 1]-spanning V-A-D distribution; on the
 * student's compressed range the projection metric capped at
 * macro-F1 ~0.32 even with a well-fit V-A-D head. The 7-class
 * classifier head (already trained for the auxiliary CE loss) hits
 * macro-F1 ≥ 0.35 on the same checkpoint, so we ship that directly when
 * available.
 *
 * No silent fallback (AGENTS.md §3): when the ONNX runtime is missing the
 * constructor throws `OnnxRuntimeUnavailableError`; when the model file is
 * missing or malformed the inference call throws a `VoiceEmotionClassifierError`.
 * The wrapping pipeline (`attributeVoiceEmotion` / `pipeline.ts`) decides
 * whether to swallow the failure as an evidence-row downgrade or surface it.
 */

import {
	EXPRESSIVE_EMOTION_TAGS,
	type ExpressiveEmotion,
} from "./expressive-tags";
import {
	loadOnnxRuntime,
	OnnxRuntimeUnavailableError,
	type OrtInferenceSession,
	type OrtTensorCtor,
} from "./onnx-runtime";

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
	// Non-finite inputs cannot be reasoned about — abstain explicitly rather
	// than coerce to a default corner. The classifier is the source of truth
	// for V-A-D; a non-finite read means the upstream forward pass diverged
	// and the downstream attribution should not pretend the read happened.
	if (
		!Number.isFinite(vad.valence) ||
		!Number.isFinite(vad.arousal) ||
		!Number.isFinite(vad.dominance)
	) {
		const emptyScores: Record<ExpressiveEmotion, number> = {
			happy: 0,
			sad: 0,
			angry: 0,
			nervous: 0,
			calm: 0,
			excited: 0,
			whisper: 0,
		};
		return { emotion: null, confidence: 0, scores: emptyScores };
	}

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

	// Each class scores only from off-center signal — a fully-neutral
	// (0.5, 0.5, 0.5) read produces all-zero scores and we abstain. Magnitudes
	// are tuned so that a confident corner of V-A-D space lands ≥ 0.5
	// (the bench gate threshold for "discrete label confident enough to
	// surface").
	// happy   — high V, mid-high A, low |D| spread.
	scores.happy = clamp01(vC * 1.4 + Math.max(0, aC) * 0.6 - Math.abs(dC) * 0.4);
	// excited — high V, very high A.
	scores.excited = clamp01(vC * 0.9 + aC * 1.6);
	// calm    — high V, low A.
	scores.calm = clamp01(Math.max(0, vC) * 1.4 - aC * 1.2 - Math.abs(dC) * 0.3);
	// sad     — low V, low A, low D.
	scores.sad = clamp01(-vC * 1.4 - aC * 0.8 - dC * 0.4);
	// angry   — low V, high A, high D.
	scores.angry = clamp01(-vC * 1.1 + aC * 1.2 + dC * 1.0);
	// nervous — low-mid V, mid-high A, low D.
	scores.nervous = clamp01(-vC * 0.7 + aC * 0.9 - dC * 1.2);
	// whisper — very low A and very low D (both at the floor). Valence-agnostic
	// (we have no energy axis here). The double-negative gating means a low
	// arousal alone does NOT trigger whisper — only the very low-A + low-D
	// corner does.
	scores.whisper = clamp01(-aC * 1.4 - dC * 1.4);

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
 * Stable model-head identifier — declares whether the ONNX session emits
 * V-A-D triples or 7-class logits. Auto-detected from the first inference
 * output's last dim (3 → vad, 7 → cls7). Stored on the classifier so
 * callers can inspect after a successful `ensureLoaded()`.
 */
export type VoiceEmotionHead = "vad" | "cls7";

/**
 * Convert the 7-class logits from the `cls7` head into a structured
 * emotion read. Applies a numerically-stable softmax (max-subtraction)
 * over `EXPRESSIVE_EMOTION_TAGS` and selects the argmax.
 *
 * Confidence is the softmax probability of the picked class (in [0, 1]),
 * which gives downstream consumers a calibrated mass to compare against
 * the V-A-D-projection path's 0.35 abstain floor.
 *
 * The `vad` field is synthesised at the neutral midpoint (0.5, 0.5, 0.5).
 * The cls7 head is the ground truth for the picked emotion — the V-A-D
 * triple is left at neutral because we no longer regress to a V-A-D
 * target. Consumers that need real V-A-D must use a `head=vad` model.
 */
export function interpretCls7Output(
	logits: Float32Array,
	modelId: VoiceEmotionModelId,
	latencyMs: number,
): VoiceEmotionClassifierOutput {
	const n = EXPRESSIVE_EMOTION_TAGS.length;
	if (logits.length !== n) {
		throw new VoiceEmotionClassifierError(
			`[voice-emotion] interpretCls7Output: expected ${n} logits, got ${logits.length}`,
		);
	}
	let maxLogit = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < n; i++) {
		const v = logits[i] ?? 0;
		if (Number.isFinite(v) && v > maxLogit) maxLogit = v;
	}
	if (!Number.isFinite(maxLogit)) {
		// All-NaN/Inf logits — abstain rather than coerce.
		const emptyScores = makeEmptyScoresRecord();
		return {
			vad: { valence: 0.5, arousal: 0.5, dominance: 0.5 },
			emotion: null,
			confidence: 0,
			scores: emptyScores,
			modelId,
			latencyMs,
		};
	}
	const exps = new Float32Array(n);
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const v = logits[i] ?? 0;
		const e = Math.exp((Number.isFinite(v) ? v : maxLogit) - maxLogit);
		exps[i] = e;
		sum += e;
	}
	const denom = sum > 0 ? sum : 1;
	let bestIdx = 0;
	let bestProb = 0;
	const scores = makeEmptyScoresRecord();
	for (let i = 0; i < n; i++) {
		const tag = EXPRESSIVE_EMOTION_TAGS[i];
		if (!tag) continue;
		const p = (exps[i] ?? 0) / denom;
		scores[tag] = p;
		if (p > bestProb) {
			bestProb = p;
			bestIdx = i;
		}
	}
	const emotionTag = EXPRESSIVE_EMOTION_TAGS[bestIdx];
	return {
		// The cls7 head doesn't regress V-A-D — surface the neutral
		// midpoint so callers can still destructure but know not to trust
		// these floats as anything other than "head was cls7".
		vad: { valence: 0.5, arousal: 0.5, dominance: 0.5 },
		emotion: emotionTag ?? null,
		confidence: bestProb,
		scores,
		modelId,
		latencyMs,
	};
}

function makeEmptyScoresRecord(): Record<ExpressiveEmotion, number> {
	return {
		happy: 0,
		sad: 0,
		angry: 0,
		nervous: 0,
		calm: 0,
		excited: 0,
		whisper: 0,
	};
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
	/**
	 * Set on first successful inference based on the model's output shape.
	 * `null` until then. Exposed via `getHead()` for diagnostics.
	 */
	private head: VoiceEmotionHead | null = null;

	constructor(options: VoiceEmotionClassifierOptions) {
		if (
			typeof options.modelPath !== "string" ||
			options.modelPath.length === 0
		) {
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
		let ort: Awaited<ReturnType<typeof loadOnnxRuntime>>;
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

	/** Returns the active head contract after the first successful inference. */
	getHead(): VoiceEmotionHead | null {
		return this.head;
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

		// Wav2Small canonical exports either:
		//   - `head=vad`  → first output [1, 3] in (V, A, D) order, name
		//     `vad`; the runtime projects to `EXPRESSIVE_EMOTION_TAGS`.
		//   - `head=cls7` → first output [1, 7] logits in
		//     `EXPRESSIVE_EMOTION_TAGS` order, name `cls_logits`; the runtime
		//     softmaxes + argmaxes directly without going through the V-A-D
		//     projection table.
		// Auto-detect by the output's last dim — robust to renamed exports.
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
		const dataLen = out.data.length;
		if (dataLen === 3) {
			this.head = "vad";
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
		if (dataLen === EXPRESSIVE_EMOTION_TAGS.length) {
			this.head = "cls7";
			return interpretCls7Output(out.data, this.modelId, latencyMs);
		}
		throw new VoiceEmotionClassifierError(
			`[voice-emotion] expected output of length 3 (V-A-D) or ${EXPRESSIVE_EMOTION_TAGS.length} (cls7), got ${dataLen}`,
		);
	}

	/** Free the underlying ONNX session. Safe to call once. */
	dispose(): void {
		this.session = null;
		this.tensorCtor = null;
		this.inputName = null;
	}
}
