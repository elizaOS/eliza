/**
 * Voice-emotion types and pure projection functions — consumed by the
 * attribution pipeline (`emotion-attribution.ts`).
 *
 * The ONNX-backed `VoiceEmotionClassifier` class was removed when
 * `onnxruntime-node` was dropped, and the native GGUF port is not yet wired
 * (native/AGENTS.md §11 K1). No resident voice-emotion classifier remains — the
 * acoustic-read path is DEAD at runtime today: nothing loads a `files.emotion`
 * GGUF, and no production caller passes a `model` (acoustic read) into
 * `attributeVoiceEmotion()`, so the fusion runs text/prosody-only. This is a
 * tracked gap (see test-results/evidence/12216-runtime-status.md, K1 follow-up),
 * NOT a silent fallback hidden behind a stub. Only the pure types + projection
 * helpers below survive.
 *
 * Exports here:
 *   - Model id constants (`WAV2SMALL_INT8_MODEL_ID`, etc.)
 *   - Sample rate / window constants
 *   - `VoiceEmotionVad`, `VoiceEmotionClassifierOutput` interfaces
 *   - `VoiceEmotionHead` type
 *   - `VoiceEmotionClassifierError` error class
 *   - `projectVadToExpressiveEmotion` — V-A-D → ExpressiveEmotion projection
 *   - `interpretCls7Output` — 7-class logit → structured output
 */

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
 * Stable model-head identifier — declares whether the model emits
 * V-A-D triples or 7-class logits. `vad` = continuous [valence, arousal,
 * dominance]; `cls7` = 7-class logits in `EXPRESSIVE_EMOTION_TAGS` order.
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
