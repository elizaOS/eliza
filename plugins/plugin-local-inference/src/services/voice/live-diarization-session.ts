/**
 * Live on-device diarization session — the agent-process owner of an
 * {@link AudioFrameConsumer} wired to the REAL fused VAD / encoder / diarizer /
 * attribution stack.
 *
 * The Android `audioFrame` PCM stream is produced in the Capacitor WebView
 * (JS renderer) but the voice FFI runs in the embedded bun agent process. The
 * agent's `/api/voice/audio-frames` route pumps batched frames into the single
 * session this module owns, where the consumer segments turns, runs
 * diarization + speaker attribution, and emits VOICE_TURN_OBSERVED.
 *
 * This module is the agent-side mirror of the host smoke harness
 * (`packages/app-core/scripts/voice-attribution-smoke.ts`): same real models,
 * same consumer, fed live frames over HTTP instead of a WAV.
 *
 * Single fused engine: VAD, the WeSpeaker speaker encoder, and the pyannote
 * diarizer all run through the ONE fused `libelizainference` handle via its
 * `eliza_inference_vad_*` / `_speaker_*` / `_diariz_*` ABI (the user directive:
 * no separate bun:ffi-musl libs). Resolution:
 *   - fused lib: `$ELIZA_INFERENCE_LIBRARY` (exact) or `$ELIZA_INFERENCE_LIB_DIR`
 *     (dir) — both exported by ElizaAgentService on Android to the app
 *     nativeLibraryDir.
 *   - context bundle root: `$ELIZA_VOICE_MODEL_DIR` (the same dir the GGUFs
 *     live under); the fused runtime resolves the per-model GGUFs from there.
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
	type TurnTranscriber,
} from "./audio-frame-consumer.js";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
} from "./ffi-bindings.js";
import { loadElizaInferenceFfi } from "./ffi-bindings.js";
import { PlaybackEchoReference } from "./playback-echo-reference.js";
import { VoiceProfileStore } from "./profile-store.js";
import { VoiceAttributionPipeline } from "./speaker/attribution-pipeline.js";
import { FusedDiarizer } from "./speaker/diarizer-fused.js";
import { FusedSpeakerEncoder } from "./speaker/encoder-fused.js";
import { GgmlSileroVad, VadDetector } from "./vad.js";

export type { RuntimeEventSink } from "./audio-frame-consumer.js";

/**
 * Resolve the fixed playback→mic transport delay (ms) for echo-reference
 * alignment from the environment. The per-platform value is tuned on a device
 * (the bulk-delay calibration in #9583); absent or invalid → 0 (the adaptive
 * taps absorb the residual lag within their tail).
 */
function playbackToMicDelayMs(): number {
	const raw = process.env.ELIZA_VOICE_PLAYBACK_TO_MIC_DELAY_MS?.trim();
	if (!raw) return 0;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Resolve the on-device voice-model directory (env override wins). Doubles as
 *  the fused context bundle root — the runtime resolves per-model GGUFs from it. */
function voiceModelDir(): string {
	const override = process.env.ELIZA_VOICE_MODEL_DIR?.trim();
	if (override) return override;
	return path.join(resolveStateDir(process.env), "models", "voice");
}

/** Candidate filenames for the fused library on this platform. */
function fusedLibraryFilenames(): string[] {
	if (process.platform === "darwin") return ["libelizainference.dylib"];
	if (process.platform === "win32") {
		return ["elizainference.dll", "libelizainference.dll"];
	}
	return ["libelizainference.so"];
}

/**
 * Resolve the fused `libelizainference` path from the environment. Returns
 * `null` when neither an exact path nor a containing dir yields a file —
 * the session then surfaces that as a structured build error.
 */
function resolveFusedLibrary(): string | null {
	const exact = process.env.ELIZA_INFERENCE_LIBRARY?.trim();
	if (exact && existsSync(exact)) return exact;
	const dir = process.env.ELIZA_INFERENCE_LIB_DIR?.trim();
	if (dir) {
		for (const name of fusedLibraryFilenames()) {
			const candidate = path.join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

export interface LiveDiarizationStatus {
	/** True once the consumer + real fused deps are loaded and accepting frames. */
	ready: boolean;
	/** Resolved fused-library path (null when it could not be resolved). */
	libs: {
		fusedInference: string | null;
	};
	/** Resolved context-bundle dir for the fused runtime. */
	models: {
		dir: string;
	};
	/** Frames received from the WebView across this session. */
	framesReceived: number;
	/** Frames dropped at the decode boundary. */
	framesDropped: number;
	/** Turns segmented + attributed so far. */
	turnsObserved: number;
	/** Agent TTS playback samples observed as the AEC far-end reference (#9583). */
	playbackSamplesObserved: number;
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
	private ffi: ElizaInferenceFfi | null = null;
	private ctx: ElizaInferenceContextHandle | null = null;
	private encoder: FusedSpeakerEncoder | null = null;
	private diarizer: FusedDiarizer | null = null;
	private vad: GgmlSileroVad | null = null;
	private building: Promise<void> | null = null;
	private framesReceived = 0;
	private turnsObserved = 0;
	private readonly recentTurns: LiveDiarizationTurnSummary[] = [];
	private resolvedLibPath: string | null = null;
	private buildError: string | null = null;
	/** True once the fused ASR region is mmap-acquired for per-turn transcribe. */
	private asrRegionAcquired = false;
	/**
	 * Far-end (agent TTS playback) reference for acoustic echo cancellation
	 * (#9583). Fed by `observePlayback` from the playback tap; its `reference`
	 * read is the consumer's `echoReference` provider, so every mic frame is
	 * echo-cancelled against the time-aligned playback before VAD/attribution.
	 */
	private readonly playbackReference = new PlaybackEchoReference({
		playbackToMicDelayMs: playbackToMicDelayMs(),
	});
	/** Cumulative playback samples observed (status / device evidence). */
	private playbackSamplesObserved = 0;

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
		const libPath = resolveFusedLibrary();
		if (!libPath) {
			throw new Error(
				`fused libelizainference not found on device. Set $ELIZA_INFERENCE_LIBRARY (exact path) or $ELIZA_INFERENCE_LIB_DIR (containing one of ${fusedLibraryFilenames().join(", ")}).`,
			);
		}
		this.resolvedLibPath = libPath;
		const ffi = loadElizaInferenceFfi(libPath);
		this.ffi = ffi;
		// One context anchored at the voice-model dir; the fused runtime resolves
		// the VAD / speaker / diarizer GGUFs from it.
		const ctx = ffi.create(dir);
		this.ctx = ctx;

		if (!GgmlSileroVad.isSupported(ffi)) {
			throw new Error(
				"fused libelizainference does not export the VAD ABI (eliza_inference_vad_supported() == 0). Rebuild with the fused voice runtime linked in.",
			);
		}
		if (!FusedSpeakerEncoder.isSupported(ffi)) {
			throw new Error(
				"fused libelizainference does not export the speaker ABI (eliza_inference_speaker_supported() == 0).",
			);
		}
		if (!FusedDiarizer.isSupported(ffi)) {
			throw new Error(
				"fused libelizainference does not export the diarizer ABI (eliza_inference_diariz_supported() == 0).",
			);
		}

		const vad = await GgmlSileroVad.load({ ffi, ctx });
		this.vad = vad;
		const detector = new VadDetector(vad, {
			onsetThreshold: 0.5,
			pauseHangoverMs: 120,
			endHangoverMs: 500,
			minSpeechMs: 250,
		});
		const encoder = await FusedSpeakerEncoder.load({ ffi, ctx });
		this.encoder = encoder;
		const diarizer = await FusedDiarizer.load({ ffi, ctx });
		this.diarizer = diarizer;
		const store = new VoiceProfileStore({
			rootDir: path.join(resolveStateDir(process.env), "voice-profiles"),
		});
		await store.init();

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
		// Join the fused batch ASR so the live path carries the real transcript
		// on VOICE_TURN_OBSERVED (#8786). Null when the fused build has no ASR
		// decoder — the path then stays diarization-only, as before.
		const transcribe = this.buildTurnTranscriber(ffi, ctx);
		const consumer = new AudioFrameConsumer(
			{
				vad: detector,
				pipeline,
				runtime: this.runtime,
				...(transcribe ? { transcribe } : {}),
				// #9583: cancel the agent's own TTS echo off the mic before VAD.
				// `observePlayback` feeds the far-end; this answers each mic frame's
				// window with the time-aligned playback (null when the agent is
				// silent → byte-identical passthrough).
				echoReference: (timestampMs, samples) =>
					this.playbackReference.reference(timestampMs, samples),
			},
			config,
		);
		consumer.onTurn((turn) => this.recordTurn(turn));
		this.consumer = consumer;
	}

	/**
	 * Build a per-turn ASR transcriber over the fused batch decoder
	 * (`eliza_inference_asr_transcribe`). Returns null when the fused build
	 * exposes no ASR decoder; acquiring the ASR mmap region is best-effort (a
	 * missing bundled ASR model leaves the path diarization-only rather than
	 * failing the whole session). One batch decode per finalized turn — the turn
	 * is already fully buffered for attribution, so no streaming state is needed.
	 */
	private buildTurnTranscriber(
		ffi: ElizaInferenceFfi,
		ctx: ElizaInferenceContextHandle,
	): TurnTranscriber | null {
		if (typeof ffi.asrTranscribe !== "function") return null;
		try {
			ffi.mmapAcquire(ctx, "asr");
		} catch {
			return null;
		}
		this.asrRegionAcquired = true;
		return (pcm) => {
			const text = ffi.asrTranscribe({ ctx, pcm, sampleRateHz: 16_000 });
			const trimmed = text.trim();
			return trimmed.length > 0 ? trimmed : null;
		};
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

	/**
	 * Record a chunk of the agent's TTS playback PCM (the far-end echo reference),
	 * anchored to the playback-clock ms at which its first sample is played
	 * (#9583). The echo canceller subtracts the time-aligned playback from each
	 * mic frame, so the agent never transcribes its own voice. Fed from the
	 * playback tap (the same audio the scheduler hands to output). PCM must be
	 * 16 kHz mono Float32 [-1, 1] — the mic pipeline's single rate.
	 */
	observePlayback(pcm: Float32Array, sampleRate: number, atMs: number): void {
		this.playbackReference.observePlayback(pcm, sampleRate, atMs);
		this.playbackSamplesObserved += pcm.length;
	}

	/** Drop all buffered playback (call when playback stops / on a hard boundary). */
	resetPlayback(): void {
		this.playbackReference.reset();
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
		return {
			ready: this.consumer != null,
			libs: { fusedInference: this.resolvedLibPath },
			models: { dir: voiceModelDir() },
			framesReceived: this.framesReceived,
			framesDropped: this.consumer?.droppedFrames ?? 0,
			turnsObserved: this.turnsObserved,
			playbackSamplesObserved: this.playbackSamplesObserved,
			recentTurns: [...this.recentTurns],
			...(this.buildError ? { error: this.buildError } : {}),
		};
	}

	/** Release native handles + listeners. */
	async close(): Promise<void> {
		this.playbackReference.reset();
		await this.consumer?.close();
		if (this.asrRegionAcquired && this.ffi && this.ctx !== null) {
			try {
				this.ffi.mmapEvict(this.ctx, "asr");
			} catch {
				// Best-effort release; the context is destroyed below regardless.
			}
			this.asrRegionAcquired = false;
		}
		await this.encoder?.dispose();
		await this.diarizer?.dispose();
		this.vad?.close();
		if (this.ffi && this.ctx !== null) this.ffi.destroy(this.ctx);
		this.ffi?.close();
		this.consumer = null;
		this.ffi = null;
		this.ctx = null;
	}
}
