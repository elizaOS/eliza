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
	type AttributionPipelineLike,
	AudioFrameConsumer,
	type AudioFrameConsumerConfig,
	type AudioFrameConsumerDeps,
	type AudioFrameEvent,
	decodeAudioFramePcm,
	type EchoReferenceProvider,
	type RuntimeEventSink,
	type TurnTranscriber,
	type VadSegmenter,
} from "./audio-frame-consumer.js";
import { EchoReferenceBuffer } from "./echo-reference-buffer.js";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
} from "./ffi-bindings.js";
import { loadElizaInferenceFfi } from "./ffi-bindings.js";
import { VoiceProfileStore } from "./profile-store.js";
import { VoiceAttributionPipeline } from "./speaker/attribution-pipeline.js";
import { FusedDiarizer } from "./speaker/diarizer-fused.js";
import { FusedSpeakerEncoder } from "./speaker/encoder-fused.js";
import { GgmlSileroVad, VadDetector } from "./vad.js";

export type { RuntimeEventSink } from "./audio-frame-consumer.js";

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
	/** Live AEC wiring status. Echo cancellation runs only when this is true. */
	aec: {
		echoReferenceWired: boolean;
	};
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

export interface LiveDiarizationSessionOptions {
	/**
	 * Agent-playback PCM provider for AEC. The caller owns playback capture and
	 * delay calibration when supplied. Without an external provider, the session
	 * uses its built-in playback buffer fed by /api/voice/playback-frames.
	 */
	echoReference?: EchoReferenceProvider | null;
}

export interface LiveDiarizationConsumerDepsInput {
	vad: VadSegmenter;
	pipeline: AttributionPipelineLike;
	runtime: RuntimeEventSink;
	transcribe?: TurnTranscriber | null;
	echoReference?: EchoReferenceProvider | null;
}

export function buildLiveDiarizationConsumerDeps({
	vad,
	pipeline,
	runtime,
	transcribe,
	echoReference,
}: LiveDiarizationConsumerDepsInput): AudioFrameConsumerDeps {
	return {
		vad,
		pipeline,
		runtime,
		...(transcribe ? { transcribe } : {}),
		...(echoReference ? { echoReference } : {}),
	};
}

const AUDIO_FRAME_SAMPLE_RATE = 16_000;

/**
 * Playback→mic transport delay used to time-align the far-end echo reference,
 * in samples @ 16 kHz. Device-tunable via `ELIZA_VOICE_ECHO_DELAY_MS`; the
 * on-device calibration (`estimateEchoDelaySamples`, #9586) is the device-side
 * follow-up. Default 0 — the canceller aligns to the most-recently-rendered
 * playback and the NLMS filter adapts the residual.
 */
function resolveEchoDelaySamples(): number {
	const ms = Number(process.env.ELIZA_VOICE_ECHO_DELAY_MS);
	if (!Number.isFinite(ms) || ms <= 0) return 0;
	return Math.round((ms / 1000) * AUDIO_FRAME_SAMPLE_RATE);
}

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
	 * Far-end (agent TTS playback) alignment buffer for echo cancellation
	 * (#9583/#9455). Fed by {@link pushPlayback}; read per mic frame via the
	 * consumer's `echoReference` seam. Inert (zero far-end ⇒ NLMS passthrough)
	 * until the device streams playback, so wiring it never regresses the
	 * no-playback case.
	 */
	private readonly echoBuffer = new EchoReferenceBuffer();
	private readonly echoDelaySamples = resolveEchoDelaySamples();

	constructor(
		private readonly runtime: RuntimeEventSink,
		private readonly options: LiveDiarizationSessionOptions = {},
	) {}

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
			buildLiveDiarizationConsumerDeps({
				vad: detector,
				pipeline,
				runtime: this.runtime,
				transcribe,
				// Cancel the agent's own TTS playback before VAD/attribution so the
				// live path never transcribes its echo (#9455/#9583). Hosts may
				// provide their own live reference; otherwise the session uses the
				// built-in playback buffer fed by pushPlayback.
				echoReference:
					this.options.echoReference ??
					((_timestampMs, samples) => this.echoReferenceFrame(samples)),
			}),
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

	/**
	 * The far-end (agent TTS playback) reference aligned to a mic frame of
	 * `samples` samples — the consumer's `echoReference` seam (#9455/#9583).
	 * Reads the alignment buffer at the configured playback→mic delay; the slice
	 * is zero-filled (⇒ NLMS passthrough) until the device streams playback.
	 * Public so the wiring is unit-testable without the fused FFI.
	 */
	echoReferenceFrame(samples: number): Float32Array {
		return this.echoBuffer.referenceFor(samples, this.echoDelaySamples);
	}

	/**
	 * Feed a batch of agent-playback (far-end) frames for echo cancellation. The
	 * device captures the agent's TTS output in the SAME base64 LE-s16 16 kHz
	 * mono wire format as the mic and POSTs it in real time as it renders; we
	 * decode + append to the alignment buffer. The device MUST also call
	 * {@link resetPlayback} when playback stops (or on barge-in) so the canceller
	 * never aligns a later mic frame to stale, no-longer-playing audio.
	 */
	pushPlayback(frames: AudioFrameEvent[]): void {
		for (const frame of frames) {
			this.echoBuffer.push(decodeAudioFramePcm(frame));
		}
	}

	/** Drop buffered far-end playback (playback stopped / barge-in). */
	resetPlayback(): void {
		this.echoBuffer.reset();
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
		return {
			ready: this.consumer != null,
			libs: { fusedInference: this.resolvedLibPath },
			models: { dir: voiceModelDir() },
			framesReceived: this.framesReceived,
			framesDropped: this.consumer?.droppedFrames ?? 0,
			turnsObserved: this.turnsObserved,
			aec: {
				echoReferenceWired:
					this.consumer != null || this.options.echoReference != null,
			},
			recentTurns: [...this.recentTurns],
			...(this.buildError ? { error: this.buildError } : {}),
		};
	}

	/** Release native handles + listeners. */
	async close(): Promise<void> {
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
