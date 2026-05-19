/**
 * Voice-emotion classifier — on-device acoustic-prosody emotion model.
 *
 * Loads **Wav2Small** (Wagner et al., arXiv:2408.13920 — 72K params)
 * distilled from `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`
 * via the GGUF export produced by
 * `packages/native/plugins/voice-classifier-cpp/scripts/voice_emotion_to_gguf.py`,
 * and runs it through the `voice-classifier-cpp` ggml-backed library
 * (`bun:ffi` -> `libvoice_classifier.{so,dylib,dll}`).
 *
 * Model contract:
 *   - Input  : 16 kHz mono Float32 PCM in [-1, 1], >= 1.0 s window.
 *   - Output : 7-class logits in `EXPRESSIVE_EMOTION_TAGS` order. The
 *              runtime softmax+argmax over those gives the discrete
 *              label. Legacy V-A-D-head bundles are no longer supported;
 *              `projectVadToExpressiveEmotion` is retained for callers
 *              that still want to project an externally-supplied
 *              continuous V-A-D read (Stage-1 prosody fusion).
 *
 * No silent fallback (AGENTS.md §3): every failure mode throws
 * `VoiceEmotionClassifierError`; the wrapping pipeline
 * (`attributeVoiceEmotion` / `pipeline.ts`) decides whether to swallow
 * the failure as an evidence-row downgrade or surface it.
 */

import {
	EXPRESSIVE_EMOTION_TAGS,
	type ExpressiveEmotion,
} from "./expressive-tags";
import {
	VOICE_EMOTION_CLASS_NAMES,
	VoiceEmotionGgmlClassifier,
	VoiceEmotionGgmlUnavailableError,
} from "./voice-emotion-classifier-ggml";

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
	/** Absolute path to the GGUF file. */
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
 * Retained for callers that still want to project an externally-supplied
 * continuous V-A-D read (Stage-1 prosody fusion). The on-device acoustic
 * classifier itself reads cls7 logits directly through the ggml-backed
 * GGUF; it does not regress V-A-D anymore.
 */
export function projectVadToExpressiveEmotion(vad: VoiceEmotionVad): {
	emotion: ExpressiveEmotion | null;
	confidence: number;
	scores: Record<ExpressiveEmotion, number>;
} {
	if (
		!Number.isFinite(vad.valence) ||
		!Number.isFinite(vad.arousal) ||
		!Number.isFinite(vad.dominance)
	) {
		return { emotion: null, confidence: 0, scores: makeEmptyScoresRecord() };
	}

	const v = clamp01(vad.valence);
	const a = clamp01(vad.arousal);
	const d = clamp01(vad.dominance);

	const vC = v - 0.5;
	const aC = a - 0.5;
	const dC = d - 0.5;

	const scores: Record<ExpressiveEmotion, number> = makeEmptyScoresRecord();
	scores.happy = clamp01(vC * 1.4 + Math.max(0, aC) * 0.6 - Math.abs(dC) * 0.4);
	scores.excited = clamp01(vC * 0.9 + aC * 1.6);
	scores.calm = clamp01(Math.max(0, vC) * 1.4 - aC * 1.2 - Math.abs(dC) * 0.3);
	scores.sad = clamp01(-vC * 1.4 - aC * 0.8 - dC * 0.4);
	scores.angry = clamp01(-vC * 1.1 + aC * 1.2 + dC * 1.0);
	scores.nervous = clamp01(-vC * 0.7 + aC * 0.9 - dC * 1.2);
	scores.whisper = clamp01(-aC * 1.4 - dC * 1.4);

	let best: ExpressiveEmotion | null = null;
	let bestScore = 0;
	for (const tag of EXPRESSIVE_EMOTION_TAGS) {
		if (scores[tag] > bestScore) {
			bestScore = scores[tag];
			best = tag;
		}
	}
	if (bestScore < 0.35) {
		return { emotion: null, confidence: bestScore, scores };
	}
	return { emotion: best, confidence: bestScore, scores };
}

/**
 * The cls7-only head contract — the only one supported by the
 * ggml-backed runtime. Kept exported for back-compat with callers that
 * still pattern-match on `getHead()`.
 */
export type VoiceEmotionHead = "cls7";

/**
 * Convert the 7-class logits from the GGUF classifier into a structured
 * emotion read. The native binding already returns softmaxed
 * probabilities (the GGUF graph has the softmax baked in), so this helper
 * is now a pure picker; we keep the public signature so callers that
 * inject logits for testing keep working.
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
		return {
			vad: { valence: 0.5, arousal: 0.5, dominance: 0.5 },
			emotion: null,
			confidence: 0,
			scores: makeEmptyScoresRecord(),
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
 * Map a native `VOICE_EMOTION_CLASS_NAMES` index back into the
 * `EXPRESSIVE_EMOTION_TAGS` order the runtime stores attribution rows
 * against. The two sets are 1-to-1 with different orderings.
 */
const NATIVE_TO_EXPRESSIVE: Record<string, ExpressiveEmotion | null> = {
	// neutral has no expressive-tag equivalent; the attribution layer reads
	// "no high-confidence expressive emotion" and abstains rather than
	// fabricating "calm" or "happy".
	neutral: null,
	happy: "happy",
	sad: "sad",
	angry: "angry",
	fear: "nervous",
	disgust: "angry",
	surprise: "excited",
};

/**
 * GGML-backed voice-emotion classifier. Wraps `VoiceEmotionGgmlClassifier`
 * so the rest of the voice pipeline keeps importing the same
 * `VoiceEmotionClassifier` name the previous ONNX path exposed.
 */
export class VoiceEmotionClassifier {
	private readonly modelPath: string;
	private readonly modelId: VoiceEmotionModelId;
	private inner: VoiceEmotionGgmlClassifier | null = null;
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

	/** Lazy session-load. Subsequent calls reuse the open handle. */
	async ensureLoaded(): Promise<void> {
		if (this.inner) return;
		try {
			this.inner = new VoiceEmotionGgmlClassifier({
				ggufPath: this.modelPath,
			});
		} catch (err) {
			if (err instanceof VoiceEmotionGgmlUnavailableError) {
				throw new VoiceEmotionClassifierError(`[voice-emotion] ${err.message}`);
			}
			throw err;
		}
	}

	/** Returns the active head contract after the first successful inference. */
	getHead(): VoiceEmotionHead | null {
		return this.head;
	}

	/**
	 * Classify a single utterance. `pcm` must be 16 kHz mono Float32 in
	 * [-1, 1]. Inputs shorter than `WAV2SMALL_MIN_SAMPLES` throw; longer
	 * inputs are truncated to the trailing `WAV2SMALL_MAX_SAMPLES` window.
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
		const inner = this.inner;
		if (!inner) {
			throw new VoiceEmotionClassifierError(
				"[voice-emotion] inner ggml handle missing after ensureLoaded()",
			);
		}

		try {
			const out = await inner.classify(pcm);
			this.head = "cls7";
			const scores = makeEmptyScoresRecord();
			let bestProb = 0;
			let bestExpressive: ExpressiveEmotion | null = null;
			for (let i = 0; i < out.probs.length; i++) {
				const className = VOICE_EMOTION_CLASS_NAMES[i];
				if (!className) continue;
				const tag = NATIVE_TO_EXPRESSIVE[className] ?? null;
				const p = out.probs[i] ?? 0;
				if (tag) {
					// Accumulate when two native classes (e.g. angry/disgust) map
					// onto the same expressive tag.
					scores[tag] = Math.max(scores[tag], p);
				}
				if (p > bestProb) {
					bestProb = p;
					bestExpressive = tag;
				}
			}
			return {
				vad: { valence: 0.5, arousal: 0.5, dominance: 0.5 },
				emotion: bestExpressive,
				confidence: bestProb,
				scores,
				modelId: this.modelId,
				latencyMs: out.latencyMs,
			};
		} catch (err) {
			if (err instanceof VoiceEmotionGgmlUnavailableError) {
				throw new VoiceEmotionClassifierError(`[voice-emotion] ${err.message}`);
			}
			throw err;
		}
	}

	/** Free the underlying native session. Safe to call once. */
	dispose(): void {
		void this.inner?.dispose();
		this.inner = null;
		this.head = null;
	}
}
