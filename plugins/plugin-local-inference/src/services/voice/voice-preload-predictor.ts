/**
 * Voice next-stage preload predictor (#8809 C5).
 *
 * A voice turn runs its stages sequentially on a memory-constrained device:
 * ASR → text-response → TTS (AGENTS.md §4). The text-response model is the one
 * the {@link MemoryArbiter} owns on the mobile / Capacitor path (where text
 * generation routes through `arbiter` rather than the desktop direct-engine
 * dispatcher). That model is NOT resident while ASR is running — so the first
 * text request of the turn pays the full cold load on the critical path,
 * stalling time-to-first-token right when the user has stopped speaking.
 *
 * This predictor closes that gap with a single, deterministic prediction: the
 * instant ASR finishes, the next arbiter-managed stage is the `"text"` model,
 * so warm it now. It calls {@link ArbiterPreloader.preload} with the resolved
 * text model key. `preload` is intentionally conservative — it only loads under
 * nominal pressure when the configured budget proves the footprint fits, and
 * returns `false` otherwise (low / critical pressure, or no headroom). The
 * predictor never forces a load; it never touches the engine directly; it owns
 * no model handle. It is the prediction, nothing more.
 *
 * Injectable by construction: it depends only on the `preload` surface of the
 * arbiter and the resolved text model key, so it is unit-testable against the
 * real arbiter with a synthetic capability and carries no transitive coupling
 * to the FFI engine, the voice pipeline, or the device bridge.
 */

import type { ArbiterCapability } from "../memory-arbiter";

/**
 * The slice of {@link MemoryArbiter} the predictor needs. Narrowed to `preload`
 * so the predictor can be injected with the real arbiter (which satisfies this
 * structurally) or a test double, with no other surface area in scope.
 */
export interface ArbiterPreloader {
	preload(capability: ArbiterCapability, modelKey: string): Promise<boolean>;
}

export interface VoicePreloadPredictorOptions {
	/** The arbiter (or anything exposing its `preload`) to warm the model on. */
	arbiter: ArbiterPreloader;
	/**
	 * Resolves the arbiter-managed text-response model key for the current turn.
	 * A function (not a bare string) so the predictor reflects a model swap
	 * between turns without being rebuilt. Returning `null` means "no text model
	 * is assigned yet" — the predictor then declines to predict rather than
	 * guessing a key.
	 */
	resolveTextModelKey: () => string | null;
	/** Optional structured logger. Messages are prefixed `[voice-preload-predictor]`. */
	logger?: {
		debug?: (message: string) => void;
		warn?: (message: string) => void;
	};
}

/**
 * The capability the next voice stage uses. On the arbiter-routed mobile path
 * the response after ASR is plain text generation.
 */
const NEXT_STAGE_CAPABILITY: ArbiterCapability = "text";

/**
 * Predicts the next arbiter-managed model for a voice turn and warms it.
 *
 * Wire {@link VoicePreloadPredictor.onAsrStageComplete} to the voice pipeline's
 * `onAsrComplete` event (the instant ASR emits its final token, which is also
 * the drafter/verifier kick-off point): that is the genuine seam where the next
 * stage is known and the arbiter owns its model.
 */
export class VoicePreloadPredictor {
	private readonly arbiter: ArbiterPreloader;
	private readonly resolveTextModelKey: () => string | null;
	private readonly logger: VoicePreloadPredictorOptions["logger"];

	constructor(options: VoicePreloadPredictorOptions) {
		this.arbiter = options.arbiter;
		this.resolveTextModelKey = options.resolveTextModelKey;
		this.logger = options.logger;
	}

	/**
	 * Called when the ASR stage of the current turn completes. Predicts the
	 * next-stage text model and asks the arbiter to warm it.
	 *
	 * Resolves to the model key that was warmed (resident or freshly loaded), or
	 * `null` when no prediction was made or the arbiter declined the preload
	 * (pressure / no budget headroom). Never throws on a declined preload — a
	 * predictor that breaks the voice loop is worse than one that does nothing.
	 */
	async onAsrStageComplete(): Promise<string | null> {
		const textModelKey = this.resolveTextModelKey();
		if (!textModelKey) {
			this.logger?.debug?.(
				"[voice-preload-predictor] no text model assigned; skipping next-stage preload",
			);
			return null;
		}
		const warmed = await this.arbiter.preload(
			NEXT_STAGE_CAPABILITY,
			textModelKey,
		);
		if (!warmed) {
			this.logger?.debug?.(
				`[voice-preload-predictor] arbiter declined preload of text/${textModelKey} (pressure or no budget headroom)`,
			);
			return null;
		}
		this.logger?.debug?.(
			`[voice-preload-predictor] warmed next-stage text/${textModelKey} during ASR stage`,
		);
		return textModelKey;
	}
}
