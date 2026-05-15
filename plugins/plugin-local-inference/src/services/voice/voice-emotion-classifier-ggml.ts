/**
 * Voice-emotion classifier — EXPERIMENTAL ggml-backed binding.
 *
 * This is the Phase 1 TS surface that will replace
 * `voice-emotion-classifier.ts` (the onnxruntime-node implementation)
 * once the native `voice-classifier-cpp` library
 * (`packages/native-plugins/voice-classifier-cpp/`) grows real
 * implementations behind its frozen C ABI.
 *
 * Status today (Phase 1):
 *   - The native library exists with a frozen C ABI declared in
 *     `include/voice_classifier/voice_classifier.h`.
 *   - The model entry points (`voice_emotion_open`,
 *     `voice_emotion_classify`, `voice_emotion_close`) currently
 *     return `-ENOSYS` from the stub.
 *   - The class-name table (`voice_emotion_class_name`) is real and
 *     surfaces the canonical 7-class basic-emotion order.
 *   - This binding therefore declares the surface today; calling
 *     `classify()` against the stub will raise
 *     `VoiceEmotionGgmlUnavailableError`. The surface itself is
 *     stable.
 *
 * Output contract (matches the locked C ABI):
 *   - 7-class soft probabilities in this exact order:
 *       0 = neutral
 *       1 = happy
 *       2 = sad
 *       3 = angry
 *       4 = fear
 *       5 = disgust
 *       6 = surprise
 *
 * Audio convention:
 *   - Mono Float32 PCM, samples in [-1, 1], sample rate 16 kHz.
 *   - Callers running at a different rate must pre-resample (the
 *     sibling `silero-vad` library exposes a linear resampler the
 *     audio front-end already uses).
 *
 * No silent fallback (AGENTS.md §3): when the native library is
 * missing or the model entry points are still stubbed (`-ENOSYS`),
 * this class throws `VoiceEmotionGgmlUnavailableError`. The wrapping
 * pipeline decides whether to swallow the failure as an evidence-row
 * downgrade or surface it.
 */

/** The canonical 7-class basic-emotion vocabulary, in the locked
 *  order the native `voice_emotion_class_name` table returns. */
export const VOICE_EMOTION_CLASS_NAMES = [
	"neutral",
	"happy",
	"sad",
	"angry",
	"fear",
	"disgust",
	"surprise",
] as const;

export type VoiceEmotionClass = (typeof VOICE_EMOTION_CLASS_NAMES)[number];

/** Required input sample rate. Matches `VOICE_CLASSIFIER_SAMPLE_RATE_HZ`. */
export const VOICE_EMOTION_GGML_SAMPLE_RATE = 16_000;

/** Hard minimum window: anything shorter than 1.0 s is rejected — the
 *  emotion read is dominated by silence-padding bias below that. */
export const VOICE_EMOTION_GGML_MIN_SAMPLES = 16_000;

/** Soft maximum window: longer inputs are truncated to the trailing
 *  window. The final 12 s carry the most-recent prosody. */
export const VOICE_EMOTION_GGML_MAX_SAMPLES = 16_000 * 12;

/** Raised when the ggml binding cannot be loaded or the native model
 *  entry points are still stubbed. */
export class VoiceEmotionGgmlUnavailableError extends Error {
	readonly code:
		| "native-missing"
		| "native-stub"
		| "model-load-failed"
		| "invalid-input";
	constructor(code: VoiceEmotionGgmlUnavailableError["code"], message: string) {
		super(message);
		this.name = "VoiceEmotionGgmlUnavailableError";
		this.code = code;
	}
}

/** One classifier inference output. The probability vector is in the
 *  order documented by `VOICE_EMOTION_CLASS_NAMES`. */
export interface VoiceEmotionGgmlOutput {
	/** P per class, summing to ~1, in `VOICE_EMOTION_CLASS_NAMES` order. */
	probs: Float32Array;
	/** The argmax class. */
	topClass: VoiceEmotionClass;
	/** Confidence of the argmax (== max(probs)). */
	confidence: number;
	/** Inference wall-time in ms. */
	latencyMs: number;
}

/** Construction options. */
export interface VoiceEmotionGgmlClassifierOptions {
	/** Absolute path to the GGUF file produced by
	 *  `scripts/voice_emotion_to_gguf.py`. */
	ggufPath: string;
}

/**
 * EXPERIMENTAL ggml-backed voice-emotion classifier. Wraps the
 * `voice_emotion_*` entry points in `voice-classifier-cpp`.
 *
 * Today this class declares the stable TS surface; Phase 2 wires it
 * into the production pipeline once the native model TUs land and
 * parity gates pass. Until then constructing it succeeds (so callers
 * can probe), but `classify()` throws `VoiceEmotionGgmlUnavailableError`
 * with `code: "native-stub"`.
 */
export class VoiceEmotionGgmlClassifier {
	readonly ggufPath: string;
	readonly sampleRate = VOICE_EMOTION_GGML_SAMPLE_RATE;
	readonly numClasses = VOICE_EMOTION_CLASS_NAMES.length;
	private disposed = false;

	constructor(options: VoiceEmotionGgmlClassifierOptions) {
		if (typeof options.ggufPath !== "string" || options.ggufPath.length === 0) {
			throw new VoiceEmotionGgmlUnavailableError(
				"invalid-input",
				"[voice-emotion-ggml] ggufPath is required",
			);
		}
		this.ggufPath = options.ggufPath;
	}

	/** Classify a single utterance. Throws until Phase 2 wiring lands.
	 *  When the native model TUs are real, returns 7 soft probs in the
	 *  order documented by `VOICE_EMOTION_CLASS_NAMES`. */
	async classify(pcm: Float32Array): Promise<VoiceEmotionGgmlOutput> {
		if (this.disposed) {
			throw new VoiceEmotionGgmlUnavailableError(
				"model-load-failed",
				"[voice-emotion-ggml] classifier has been disposed",
			);
		}
		if (!(pcm instanceof Float32Array)) {
			throw new VoiceEmotionGgmlUnavailableError(
				"invalid-input",
				"[voice-emotion-ggml] pcm must be a Float32Array",
			);
		}
		if (pcm.length < VOICE_EMOTION_GGML_MIN_SAMPLES) {
			throw new VoiceEmotionGgmlUnavailableError(
				"invalid-input",
				`[voice-emotion-ggml] pcm too short: ${pcm.length} samples < ${VOICE_EMOTION_GGML_MIN_SAMPLES}`,
			);
		}
		// Truncate to the trailing window for very long inputs so callers
		// can pass arbitrary segments without paying for unused audio.
		const _samples =
			pcm.length > VOICE_EMOTION_GGML_MAX_SAMPLES
				? pcm.subarray(pcm.length - VOICE_EMOTION_GGML_MAX_SAMPLES)
				: pcm;

		// Phase 1 stub: the native library returns -ENOSYS. The Phase 2
		// wiring will load `voice_classifier_cpp` via N-API / FFI and
		// dispatch into the real `voice_emotion_classify`. Until then
		// surface a structured error rather than fabricate a probability
		// vector — silent fallbacks would let downstream code mistake a
		// synthetic read for a measured one.
		throw new VoiceEmotionGgmlUnavailableError(
			"native-stub",
			"[voice-emotion-ggml] native voice_emotion_classify is stubbed (-ENOSYS); Phase 2 wires the real ggml backend",
		);
	}

	/** Free the underlying native session. Idempotent. */
	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

/**
 * Convenience: map a class index (0-6) to the canonical class name.
 * Mirrors the C-side `voice_emotion_class_name` accessor.
 */
export function voiceEmotionClassName(idx: number): VoiceEmotionClass | null {
	if (!Number.isInteger(idx)) return null;
	if (idx < 0 || idx >= VOICE_EMOTION_CLASS_NAMES.length) return null;
	return VOICE_EMOTION_CLASS_NAMES[idx];
}
