/**
 * On-device fused voice-turn entry for the Capacitor / AOSP device bridge.
 *
 * This is the production caller for `LocalInferenceEngine.runVoiceTurn` (#8786):
 * the in-process fused mic→speech loop (ASR → {MTP drafts ∥ target verify} →
 * phrase chunker → OmniVoice/Kokoro → PCM ring buffer) that the engine's voice
 * bridge owns. The engine bridge serves ASR + TTS from the fused
 * `libelizainference` handle; the DEVICE supplies its own text runner so the
 * draft/verify loop runs on the on-device text model (the
 * `CapacitorLlamaContext`-backed decode) rather than the desktop dispatcher —
 * exactly the seam `runVoiceTurn`'s `textRunner` option was built for.
 *
 * The native iOS/Android mic-capture layer hands captured PCM to
 * {@link runDeviceVoiceTurn}; everything downstream is in-process JS + the
 * fused FFI. No HTTP, no second voice path.
 */

import type { GenerateArgs } from "../../services/backend";
import type { VoicePipelineEvents } from "../../services/voice/pipeline";
import type { MtpTextRunner } from "../../services/voice/pipeline-impls";
import type {
	TranscriptionAudio,
	VerifierStreamEvent,
} from "../../services/voice/types";
import type { VoicePreloadPredictor } from "../../services/voice/voice-preload-predictor";
import type { CapacitorLlamaContext } from "./types";

/** Turn exit reason, mirroring `LocalInferenceEngine.runVoiceTurn`. */
export type VoiceTurnExitReason = "done" | "token-cap" | "cancelled";

/**
 * Structural view of `LocalInferenceEngine.runVoiceTurn` so the device bridge
 * (and tests) depend on the call shape, not the concrete engine class.
 */
export interface DeviceVoiceEngine {
	runVoiceTurn(
		audio: TranscriptionAudio,
		opts?: {
			maxDraftTokens?: number;
			maxGeneratedTokens?: number;
			events?: VoicePipelineEvents;
			textRunner?: MtpTextRunner;
		},
	): Promise<VoiceTurnExitReason>;
}

export interface CapacitorTextRunnerOptions {
	/** Default sampling temperature when the pipeline does not pin one. */
	temperature?: number;
	/** Default nucleus-sampling cutoff when the pipeline does not pin one. */
	topP?: number;
}

/**
 * Adapt a live `CapacitorLlamaContext` to the {@link MtpTextRunner} contract the
 * fused voice pipeline drives.
 *
 * `hasDrafter()` is `false`: the on-device `CapacitorLlamaContext` does not yet
 * expose a separate speculative-draft window, so the pipeline runs plain decode
 * through the target verifier (`MtpTargetVerifier` splits the returned text into
 * tokens when no per-delta verifier events arrive — its documented non-streaming
 * path). When the on-device fork exposes draft/verify events this flips to
 * `true` with no change to the call sites.
 */
export function createCapacitorMtpTextRunner(
	context: CapacitorLlamaContext,
	options: CapacitorTextRunnerOptions = {},
): MtpTextRunner {
	return {
		hasDrafter() {
			return false;
		},
		async generateWithVerifierEvents(
			args: GenerateArgs & {
				onVerifierEvent: (event: VerifierStreamEvent) => void | Promise<void>;
			},
		): Promise<{ text: string }> {
			const { signal } = args;
			if (signal?.aborted) return { text: "" };

			// A barge-in / kill-switch aborts the in-flight on-device decode.
			let onAbort: (() => void) | undefined;
			if (signal) {
				onAbort = () => {
					void context.stopCompletion();
				};
				signal.addEventListener("abort", onAbort, { once: true });
			}

			try {
				const result = await context.completion({
					prompt: args.prompt,
					n_predict: args.maxTokens,
					temperature: args.temperature ?? options.temperature,
					top_p: args.topP ?? options.topP,
					...(args.stopSequences ? { stop: args.stopSequences } : {}),
				});
				return { text: result.text };
			} finally {
				if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

export interface RunDeviceVoiceTurnArgs {
	/** The engine that owns the armed voice bridge (`startVoice` + `armVoice`). */
	engine: DeviceVoiceEngine;
	/** The on-device text model context that backs the MTP target verifier. */
	context: CapacitorLlamaContext;
	/** Captured mic PCM for this turn. */
	audio: TranscriptionAudio;
	/** Pipeline events (first-audio, transcript, completion, cancel). */
	events?: VoicePipelineEvents;
	/** Upper bound on generated response tokens. */
	maxGeneratedTokens?: number;
	/** Default sampling overrides forwarded to the on-device text runner. */
	generation?: CapacitorTextRunnerOptions;
	/**
	 * Next-stage preload predictor (#8809 C5). On the mobile / Capacitor path the
	 * text-response model is owned by the {@link MemoryArbiter}; this turn's
	 * stages run sequentially (ASR → text → TTS), so the predictor warms the
	 * arbiter-managed text model the instant ASR finishes — during the ASR-stage
	 * page-trim window — collapsing the cold load off the post-ASR critical path.
	 * Wired to the pipeline's `onAsrComplete` event below. Omit to keep the turn
	 * unpredicted (the arbiter still loads the text model on first request).
	 */
	preloadPredictor?: VoicePreloadPredictor;
}

/**
 * Run one fused on-device voice turn. The native capture layer calls this with
 * the captured mic audio; it builds the device text runner from the loaded
 * `CapacitorLlamaContext` and drives `engine.runVoiceTurn`, so ASR + MTP +
 * TTS all run in-process through the fused handle. Resolves with the turn's
 * exit reason.
 */
export function runDeviceVoiceTurn(
	args: RunDeviceVoiceTurnArgs,
): Promise<VoiceTurnExitReason> {
	const textRunner = createCapacitorMtpTextRunner(
		args.context,
		args.generation ?? {},
	);
	const events = composeAsrCompletePreload(args.events, args.preloadPredictor);
	return args.engine.runVoiceTurn(args.audio, {
		textRunner,
		...(events ? { events } : {}),
		...(args.maxGeneratedTokens !== undefined
			? { maxGeneratedTokens: args.maxGeneratedTokens }
			: {}),
	});
}

/**
 * Compose the caller's pipeline events with the next-stage preload prediction.
 *
 * When a predictor is supplied, its `onAsrStageComplete()` is invoked from the
 * pipeline's `onAsrComplete` hook — the instant ASR emits its final token — so
 * the arbiter-managed text model is warmed before the verifier issues its first
 * request. The prediction is fire-and-forget: it must never delay the
 * drafter/verifier kick-off, and a declined preload (pressure / no headroom) is
 * a no-op, not an error. The caller's own `onAsrComplete` (if any) still runs.
 */
function composeAsrCompletePreload(
	events: VoicePipelineEvents | undefined,
	predictor: VoicePreloadPredictor | undefined,
): VoicePipelineEvents | undefined {
	if (!predictor) return events;
	const callerOnAsrComplete = events?.onAsrComplete;
	return {
		...events,
		onAsrComplete(tokens) {
			callerOnAsrComplete?.(tokens);
			void predictor.onAsrStageComplete();
		},
	};
}
