/**
 * Native PCM capture coordinator for the Capacitor / AOSP voice path.
 *
 * Platform mic front-ends own capture and VAD/turn segmentation. This class is
 * the TypeScript bridge they call with a completed PCM turn: it serializes the
 * turn through {@link runDeviceVoiceTurn}, which joins ASR, speaker attribution,
 * response policy, text generation, and TTS in the fused voice path.
 */

import type { VoicePipelineEvents } from "../../services/voice/pipeline";
import type { TranscriptionAudio } from "../../services/voice/types";
import type { VoicePreloadPredictor } from "../../services/voice/voice-preload-predictor";
import type { CapacitorLlamaContext } from "./types";
import {
	type CapacitorTextRunnerOptions,
	type DeviceVoiceEngine,
	runDeviceVoiceTurn,
	type VoiceTurnExitReason,
} from "./voice-turn";

export interface NativePcmVoiceTurn {
	/** Captured mic PCM for one VAD-completed native turn. */
	audio: TranscriptionAudio;
	/** Optional host turn id, useful for traces and logs. */
	turnId?: string;
	/** Per-turn event hooks. Falls back to coordinator defaults when omitted. */
	events?: VoicePipelineEvents;
	/** Per-turn generated-token cap. Falls back to coordinator defaults. */
	maxGeneratedTokens?: number;
	/** Per-turn sampling overrides. Falls back to coordinator defaults. */
	generation?: CapacitorTextRunnerOptions;
	/** Per-turn preload predictor. Falls back to coordinator defaults. */
	preloadPredictor?: VoicePreloadPredictor;
}

export interface NativePcmVoiceTurnCoordinatorOptions {
	/** The engine that owns the armed voice bridge (`startVoice` + `armVoice`). */
	engine: DeviceVoiceEngine;
	/** Loaded on-device text model context for the MTP target verifier. */
	context: CapacitorLlamaContext;
	/** Default pipeline events for every accepted native turn. */
	events?: VoicePipelineEvents;
	/** Default generated-token cap for every accepted native turn. */
	maxGeneratedTokens?: number;
	/** Default sampling overrides for the on-device text runner. */
	generation?: CapacitorTextRunnerOptions;
	/** Default next-stage preload predictor. */
	preloadPredictor?: VoicePreloadPredictor;
}

export interface NativePcmVoiceTurnResult {
	turnId?: string;
	exitReason: VoiceTurnExitReason;
}

/**
 * Serializes native completed PCM turns into the fused device voice engine.
 *
 * Native capture can emit turns quickly, especially when a flush returns more
 * than one segment. The fused voice bridge only allows one active turn; this
 * coordinator preserves order by queueing each accepted turn after the previous
 * `runDeviceVoiceTurn` settles.
 */
export class NativePcmVoiceTurnCoordinator {
	private readonly options: NativePcmVoiceTurnCoordinatorOptions;
	private queue: Promise<void> = Promise.resolve();
	private running = false;

	constructor(options: NativePcmVoiceTurnCoordinatorOptions) {
		this.options = options;
	}

	get isRunning(): boolean {
		return this.running;
	}

	start(): void {
		this.running = true;
	}

	async stop(): Promise<void> {
		this.running = false;
		await this.queue;
	}

	/**
	 * Accept one VAD-completed native PCM turn and run it through the fused
	 * device voice path. Throws when the coordinator has not been started so
	 * callers cannot accidentally bypass the capture lifecycle.
	 */
	acceptTurn(turn: NativePcmVoiceTurn): Promise<NativePcmVoiceTurnResult> {
		if (!this.running) {
			return Promise.reject(
				new Error(
					"[native-voice-capture] cannot accept a PCM turn before start()",
				),
			);
		}

		const run = this.queue.then(async () => {
			const exitReason = await runDeviceVoiceTurn({
				engine: this.options.engine,
				context: this.options.context,
				audio: turn.audio,
				...this.resolveTurnOptions(turn),
			});
			return {
				...(turn.turnId ? { turnId: turn.turnId } : {}),
				exitReason,
			};
		});

		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private resolveTurnOptions(
		turn: NativePcmVoiceTurn,
	): Pick<
		Parameters<typeof runDeviceVoiceTurn>[0],
		"events" | "generation" | "maxGeneratedTokens" | "preloadPredictor"
	> {
		const events = turn.events ?? this.options.events;
		const maxGeneratedTokens =
			turn.maxGeneratedTokens ?? this.options.maxGeneratedTokens;
		const generation = turn.generation ?? this.options.generation;
		const preloadPredictor =
			turn.preloadPredictor ?? this.options.preloadPredictor;

		return {
			...(events ? { events } : {}),
			...(maxGeneratedTokens !== undefined ? { maxGeneratedTokens } : {}),
			...(generation ? { generation } : {}),
			...(preloadPredictor ? { preloadPredictor } : {}),
		};
	}
}
