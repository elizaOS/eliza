/**
 * Audio-side end-of-turn (EOT) detector — EXPERIMENTAL ggml-backed binding.
 *
 * This is the Phase 1 TS surface for the audio-side semantic EOT
 * detector exposed by the native `voice-classifier-cpp` library
 * (`packages/native-plugins/voice-classifier-cpp/`). It complements
 * the existing text-side EOT classifiers in `eot-classifier.ts`
 * (`HeuristicEotClassifier`, `LiveKitTurnDetector`,
 * `TurnsenseEotClassifier`); the runtime can fuse the two signals
 * (text-side + audio-side) for a stronger turn-completion read than
 * either alone.
 *
 * Status today (Phase 1):
 *   - The native library exists with a frozen C ABI declared in
 *     `include/voice_classifier/voice_classifier.h`.
 *   - The model entry points (`voice_eot_open`, `voice_eot_score`,
 *     `voice_eot_close`) currently return `-ENOSYS` from the stub.
 *   - This binding declares the surface today; calling `score()`
 *     against the stub will raise `EotGgmlUnavailableError`. The
 *     surface itself is stable.
 *
 * Output contract:
 *   - A single P(end_of_turn) ∈ [0, 1] per audio window.
 *
 * Audio convention:
 *   - Mono Float32 PCM, samples in [-1, 1], sample rate 16 kHz.
 *
 * No silent fallback: when the native library is missing or the model
 * entry points are still stubbed, this class throws
 * `EotGgmlUnavailableError`. Callers fuse with the text-side
 * classifiers above the binding.
 */

/** Required input sample rate. */
export const EOT_GGML_SAMPLE_RATE = 16_000;

/** Hard minimum window: anything shorter than ~200 ms is rejected —
 *  the audio-side detector needs a meaningful audio context. */
export const EOT_GGML_MIN_SAMPLES = 3_200;

/** Soft maximum window: longer inputs are truncated to the trailing
 *  window. The audio-side EOT signal is dominated by recent prosody. */
export const EOT_GGML_MAX_SAMPLES = 16_000 * 4;

/** Raised when the ggml binding cannot be loaded or the native model
 *  entry points are still stubbed. */
export class EotGgmlUnavailableError extends Error {
	readonly code:
		| "native-missing"
		| "native-stub"
		| "model-load-failed"
		| "invalid-input";
	constructor(code: EotGgmlUnavailableError["code"], message: string) {
		super(message);
		this.name = "EotGgmlUnavailableError";
		this.code = code;
	}
}

/** Construction options. */
export interface EotGgmlClassifierOptions {
	/** Absolute path to the GGUF file produced by
	 *  `scripts/voice_eot_to_gguf.py`. */
	ggufPath: string;
}

/** One inference output. */
export interface EotGgmlOutput {
	/** P(end_of_turn) ∈ [0, 1]. */
	endOfTurnProbability: number;
	/** Inference wall-time in ms. */
	latencyMs: number;
}

/**
 * EXPERIMENTAL ggml-backed audio-side EOT detector. Wraps the
 * `voice_eot_*` entry points in `voice-classifier-cpp`.
 *
 * Today this class declares the stable TS surface; Phase 2 wires it
 * into the production turn-controller once the native model TUs land
 * and parity gates pass. Until then constructing it succeeds (so
 * callers can probe), but `score()` throws `EotGgmlUnavailableError`
 * with `code: "native-stub"`.
 */
export class EotGgmlClassifier {
	readonly ggufPath: string;
	readonly sampleRate = EOT_GGML_SAMPLE_RATE;
	private disposed = false;

	constructor(options: EotGgmlClassifierOptions) {
		if (
			typeof options.ggufPath !== "string" ||
			options.ggufPath.length === 0
		) {
			throw new EotGgmlUnavailableError(
				"invalid-input",
				"[eot-ggml] ggufPath is required",
			);
		}
		this.ggufPath = options.ggufPath;
	}

	/** Score an audio window for end-of-turn probability. Throws until
	 *  Phase 2 wiring lands. */
	async score(pcm: Float32Array): Promise<EotGgmlOutput> {
		if (this.disposed) {
			throw new EotGgmlUnavailableError(
				"model-load-failed",
				"[eot-ggml] classifier has been disposed",
			);
		}
		if (!(pcm instanceof Float32Array)) {
			throw new EotGgmlUnavailableError(
				"invalid-input",
				"[eot-ggml] pcm must be a Float32Array",
			);
		}
		if (pcm.length < EOT_GGML_MIN_SAMPLES) {
			throw new EotGgmlUnavailableError(
				"invalid-input",
				`[eot-ggml] pcm too short: ${pcm.length} samples < ${EOT_GGML_MIN_SAMPLES}`,
			);
		}
		const _samples =
			pcm.length > EOT_GGML_MAX_SAMPLES
				? pcm.subarray(pcm.length - EOT_GGML_MAX_SAMPLES)
				: pcm;

		// Phase 1 stub: the native library returns -ENOSYS. Phase 2
		// wiring loads `voice_classifier_cpp` via N-API / FFI and
		// dispatches into the real `voice_eot_score`. Until then surface
		// a structured error rather than fabricate a probability — the
		// turn controller fuses this signal with the text-side EOT and
		// a synthetic read would silently bias the fusion.
		throw new EotGgmlUnavailableError(
			"native-stub",
			"[eot-ggml] native voice_eot_score is stubbed (-ENOSYS); Phase 2 wires the real ggml backend",
		);
	}

	/** Free the underlying native session. Idempotent. */
	async dispose(): Promise<void> {
		this.disposed = true;
	}
}
