/**
 * Live on-device diarization session — the agent-process owner of an
 * {@link AudioFrameConsumer} wired to the REAL ggml VAD / encoder / diarizer /
 * attribution stack.
 *
 * The Android `audioFrame` PCM stream is produced in the Capacitor WebView
 * (JS renderer) but the bun:ffi voice libs only run in the embedded bun agent
 * process. The agent's `/api/voice/audio-frames` route pumps batched frames
 * into the single session this module owns, where the consumer segments turns,
 * runs diarization + speaker attribution, and emits VOICE_TURN_OBSERVED.
 *
 * This module is the agent-side mirror of the host smoke harness
 * (`packages/app-core/scripts/voice-attribution-smoke.ts`): same real models,
 * same consumer, fed live frames over HTTP instead of a WAV.
 *
 * Model + library resolution (all bun:ffi loaders honor env overrides):
 *   - native libs: `$ELIZA_SILERO_VAD_LIB`, `$ELIZA_VOICE_CLASSIFIER_LIB`
 *     (exported by ElizaAgentService on Android to the app nativeLibraryDir).
 *   - GGUFs: `<state-dir>/models/voice/{silero-vad-v5,wespeaker-resnet34-lm,
 *     pyannote-segmentation-3.0}.gguf` (overridable via `$ELIZA_VOICE_MODEL_DIR`).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";
import {
	type AttributedTurn,
	AudioFrameConsumer,
	type AudioFrameConsumerConfig,
	type AudioFrameEvent,
	type RuntimeEventSink,
} from "./audio-frame-consumer.js";
import { VoiceProfileStore } from "./profile-store.js";
import { VoiceAttributionPipeline } from "./speaker/attribution-pipeline.js";
import { PyannoteDiarizer } from "./speaker/diarizer.js";
import { SpeakerEncoderGgmlImpl } from "./speaker/encoder-ggml.js";
import { VadDetector } from "./vad.js";
import { SileroVadGgml } from "./vad-ggml.js";

export type { RuntimeEventSink } from "./audio-frame-consumer.js";

/** Canonical voice-GGUF filenames inside `<state-dir>/models/voice/`. */
const VOICE_GGUF = {
	vad: "silero-vad-v5.gguf",
	encoder: "wespeaker-resnet34-lm.gguf",
	diarizer: "pyannote-segmentation-3.0.gguf",
} as const;

/** Resolve the on-device voice-model directory (env override wins). */
function voiceModelDir(): string {
	const override = process.env.ELIZA_VOICE_MODEL_DIR?.trim();
	if (override) return override;
	return path.join(resolveStateDir(process.env), "models", "voice");
}

export interface LiveDiarizationStatus {
	/** True once the consumer + real ggml deps are loaded and accepting frames. */
	ready: boolean;
	/** Resolved native-library paths (null when a lib could not be resolved). */
	libs: {
		sileroVad: string | null;
		voiceClassifier: string | null;
	};
	/** Resolved GGUF paths and whether each exists on disk. */
	models: {
		dir: string;
		vad: { path: string; present: boolean };
		encoder: { path: string; present: boolean };
		diarizer: { path: string; present: boolean };
	};
	/** Frames received from the WebView across this session. */
	framesReceived: number;
	/** Frames dropped at the decode boundary. */
	framesDropped: number;
	/** Turns segmented + attributed so far. */
	turnsObserved: number;
	/** The most recent attributed turns (capped), for device-evidence reads. */
	recentTurns: LiveDiarizationTurnSummary[];
	/** Populated only when readiness failed — the precise blocker. */
	error?: string;
}

/** A compact, JSON-safe summary of one attributed turn (no PCM/embeddings). */
export interface LiveDiarizationTurnSummary {
	turnId: string;
	startedAtMs: number;
	endedAtMs: number;
	samples: number;
	durationMs: number;
	hasSpeaker: boolean;
	speakerEntityId: string | null;
	speakerConfidence: number | null;
	segments: number;
	agentShouldSpeak: boolean | null;
	nextSpeaker: string | null;
}

const MAX_RECENT_TURNS = 20;

/**
 * Owns the single live diarization consumer for the agent process. Built
 * lazily on first frame batch so it does not load voice models at boot.
 */
export class LiveDiarizationSession {
	private consumer: AudioFrameConsumer | null = null;
	private encoder: SpeakerEncoderGgmlImpl | null = null;
	private diarizer: PyannoteDiarizer | null = null;
	private vadGgml: SileroVadGgml | null = null;
	private building: Promise<void> | null = null;
	private framesReceived = 0;
	private turnsObserved = 0;
	private readonly recentTurns: LiveDiarizationTurnSummary[] = [];
	private readonly resolvedLibs: {
		sileroVad: string | null;
		voiceClassifier: string | null;
	} = { sileroVad: null, voiceClassifier: null };
	private buildError: string | null = null;

	constructor(private readonly runtime: RuntimeEventSink) {}

	/** Ensure the real-deps consumer exists; idempotent + concurrency-safe. */
	private ensureBuilt(): Promise<void> {
		if (this.consumer) return Promise.resolve();
		if (this.building) return this.building;
		this.building = this.build().catch((err) => {
			this.buildError = err instanceof Error ? err.message : String(err);
			throw err;
		});
		return this.building;
	}

	private async build(): Promise<void> {
		const dir = voiceModelDir();
		const vadGguf = path.join(dir, VOICE_GGUF.vad);
		const encGguf = path.join(dir, VOICE_GGUF.encoder);
		const diaGguf = path.join(dir, VOICE_GGUF.diarizer);
		const missing = [
			[vadGguf, "VAD"],
			[encGguf, "encoder"],
			[diaGguf, "diarizer"],
		].filter(([p]) => !existsSync(p));
		if (missing.length > 0) {
			throw new Error(
				`voice GGUFs missing on device: ${missing
					.map(([p, label]) => `${label}=${p}`)
					.join(", ")}. Stage them under ${dir}.`,
			);
		}

		const vadGgml = await SileroVadGgml.load({ ggufPath: vadGguf });
		this.vadGgml = vadGgml;
		this.resolvedLibs.sileroVad = vadGgml.libraryPath ?? null;
		const detector = new VadDetector(vadGgml, {
			onsetThreshold: 0.5,
			pauseHangoverMs: 120,
			endHangoverMs: 500,
			minSpeechMs: 250,
		});
		const encoder = new SpeakerEncoderGgmlImpl({ ggufPath: encGguf });
		this.encoder = encoder;
		const diarizer = await PyannoteDiarizer.load(diaGguf);
		this.diarizer = diarizer;
		const store = new VoiceProfileStore({
			rootDir: path.join(resolveStateDir(process.env), "voice-profiles"),
		});
		await store.init();
		this.resolvedLibs.voiceClassifier =
			process.env.ELIZA_VOICE_CLASSIFIER_LIB?.trim() ?? null;

		const pipeline = new VoiceAttributionPipeline({
			encoder,
			diarizer,
			profileStore: store,
		});
		const config: AudioFrameConsumerConfig = {
			source: { kind: "local_mic", deviceId: "android-audioframe" },
			preRollSeconds: 0.3,
			maxTurnSeconds: 30,
		};
		const consumer = new AudioFrameConsumer(
			{ vad: detector, pipeline, runtime: this.runtime },
			config,
		);
		consumer.onTurn((turn) => this.recordTurn(turn));
		this.consumer = consumer;
	}

	private recordTurn(turn: AttributedTurn): void {
		this.turnsObserved += 1;
		const speaker = turn.output.primarySpeaker;
		const summary: LiveDiarizationTurnSummary = {
			turnId: turn.turnId,
			startedAtMs: turn.startedAtMs,
			endedAtMs: turn.endedAtMs,
			samples: turn.samples,
			durationMs: Math.round((turn.samples / 16_000) * 1000),
			hasSpeaker: speaker != null,
			speakerEntityId: speaker?.entityId ?? null,
			speakerConfidence: speaker?.confidence ?? null,
			segments: turn.output.segments.length,
			agentShouldSpeak: turn.signal.agentShouldSpeak,
			nextSpeaker: turn.signal.nextSpeaker ?? null,
		};
		this.recentTurns.push(summary);
		if (this.recentTurns.length > MAX_RECENT_TURNS) this.recentTurns.shift();
	}

	/** Feed a batch of WebView-captured frames; resolves once VAD has processed them. */
	async ingest(frames: AudioFrameEvent[]): Promise<void> {
		await this.ensureBuilt();
		if (!this.consumer) return;
		for (const frame of frames) {
			this.framesReceived += 1;
			await this.consumer.onAudioFrame(frame);
		}
	}

	/** Flush any open segment (call on stopAudioFrames) and await attribution. */
	async flush(): Promise<void> {
		if (this.consumer) await this.consumer.flush();
	}

	/** Build (if needed) and report status — the device-evidence read. */
	async status(): Promise<LiveDiarizationStatus> {
		try {
			await this.ensureBuilt();
		} catch {
			// Surface the blocker in the status payload rather than throwing.
		}
		const dir = voiceModelDir();
		const mk = (name: string) => {
			const p = path.join(dir, name);
			return { path: p, present: existsSync(p) };
		};
		return {
			ready: this.consumer != null,
			libs: { ...this.resolvedLibs },
			models: {
				dir,
				vad: mk(VOICE_GGUF.vad),
				encoder: mk(VOICE_GGUF.encoder),
				diarizer: mk(VOICE_GGUF.diarizer),
			},
			framesReceived: this.framesReceived,
			framesDropped: this.consumer?.droppedFrames ?? 0,
			turnsObserved: this.turnsObserved,
			recentTurns: [...this.recentTurns],
			...(this.buildError ? { error: this.buildError } : {}),
		};
	}

	/** Release native handles + listeners. */
	async close(): Promise<void> {
		await this.consumer?.close();
		await this.encoder?.dispose();
		await this.diarizer?.dispose?.();
		this.vadGgml?.close();
		this.consumer = null;
	}
}
