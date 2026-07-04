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
import {
	estimateEchoDelaySamples,
	platformPlaybackDelaySamples,
} from "./echo-delay.js";
import { EchoReferenceBuffer } from "./echo-reference-buffer.js";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
} from "./ffi-bindings.js";
import { loadElizaInferenceFfi } from "./ffi-bindings.js";
import { VoiceAttributionPipeline } from "./speaker/attribution-pipeline.js";
import { FusedDiarizer } from "./speaker/diarizer-fused.js";
import { FusedSpeakerEncoder } from "./speaker/encoder-fused.js";
import { getSharedVoiceProfileStore } from "./speaker/profile-store-factory.js";
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
	/** Live AEC wiring status. */
	aec: {
		/**
		 * True only when a real far-end source exists: a host-registered echo
		 * reference provider, or at least one playback frame with samples actually
		 * delivered via `/api/voice/playback-frames`. Cancellation is active only
		 * when this AND `ready` are both true. Cumulative — a playback reset does
		 * not un-prove that the far-end transport delivered (#9583).
		 */
		echoReferenceWired: boolean;
		/** Far-end playback frames delivered via /api/voice/playback-frames. */
		playbackFramesReceived: number;
		/** Total decoded far-end samples delivered (@16 kHz). */
		playbackSamplesReceived: number;
		/** Wall-clock epoch ms of the last delivered playback frame (null = never). */
		lastPlaybackFrameAt: number | null;
		/** Playback→mic delay (samples @16 kHz) currently applied to align the
		 * far-end reference — self-calibrated from real echo when confident,
		 * otherwise the `ELIZA_VOICE_ECHO_DELAY_MS` seed (default 0). */
		echoDelaySamples: number;
		/** Peak cross-correlation [0,1] of the last accepted delay calibration;
		 * 0 until a confident estimate replaces the seed. */
		echoDelayConfidence: number;
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

/** Bounded AEC evidence capture (#11373): hard cap so an armed capture can
 * never grow past ~3.8 MB per stream (60 s of Float32 @16 kHz). */
const AEC_CAPTURE_MAX_SECONDS = 60;
/** Default capture window when the caller does not pass `maxSeconds`. */
const AEC_CAPTURE_DEFAULT_SECONDS = 20;

/** Arm/disarm + progress view of the AEC evidence capture. */
export interface AecCaptureStatus {
	armed: boolean;
	/** Near-end samples captured so far (@16 kHz). */
	sampleCount: number;
	/** Capture stops appending once this many samples are buffered. */
	maxSamples: number;
	/** Mic-clock timestamp (ms) of the first captured frame, null before any. */
	startTimestampMs: number | null;
}

/** The captured near/far evidence window (#11373 device-evidence read). */
export interface AecCaptureSnapshot extends AecCaptureStatus {
	sampleRate: number;
	/** Raw near-end mic PCM as ingested (pre-AEC), base64 LE-s16 @16 kHz. */
	nearPcm16: string;
	/** Far-end playback reference read at delay 0 for the same mic-clock
	 * timestamps, base64 LE-s16 @16 kHz. Offline replay applies the delay. */
	farPcm16: string;
	/** Delay state the live canceller applied during this window. */
	echoDelaySamples: number;
	echoDelayConfidence: number;
	echoDelayCalibrated: boolean;
}

/** Encode Float32 PCM chunks as base64 LE-s16 (the wire format). */
function encodePcm16Base64(chunks: Float32Array[]): string {
	let total = 0;
	for (const c of chunks) total += c.length;
	const bytes = Buffer.alloc(total * 2);
	let offset = 0;
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i++) {
			const v = Math.max(-1, Math.min(1, chunk[i]));
			bytes.writeInt16LE(Math.round(v * 32767), (offset + i) * 2);
		}
		offset += chunk.length;
	}
	return bytes.toString("base64");
}

/** Echo-delay self-calibration (#9583/#9586). */
/** Accumulate this many playback-active samples before estimating the delay
 * (1 s @16 kHz — enough correlated echo overlap for a stable cross-correlation
 * even when the transport lag eats several hundred ms of the window). */
const ECHO_CAL_TARGET_SAMPLES = 16_000;
/** Bound the rolling calibration window so a long talk-over doesn't grow it. */
const ECHO_CAL_MAX_SAMPLES = 24_000;
/** Accept a calibrated delay only above this normalized cross-correlation; below
 * it the near/far are independent (user talking, no echo) — keep the seed. */
const ECHO_CAL_MIN_CONFIDENCE = 0.3;
/** Largest playback→mic delay to search (500 ms @16 kHz). The Pixel 6a WebView
 * pump path measured ~381–408 ms end-to-end (#11373 device evidence) — beyond
 * the previous 300 ms ceiling, which made the one-shot calibration lock a
 * wrong cap-edge lag (~298 ms) and permanently misalign the NLMS reference. */
const ECHO_CAL_MAX_LAG_SAMPLES = 8_000;
/** Reject locks within one frame of the search ceiling: a cap-edge peak means
 * the true delay is likely beyond the searched range, and a one-shot lock on
 * it would pin a wrong alignment forever. Keep observing instead. */
const ECHO_CAL_CAP_EDGE_SAMPLES = 320;
/** Far-end mean-square floor below which a frame is "no playback" (skip). */
const ECHO_CAL_FAR_ENERGY_FLOOR = 1e-7;

function concatFloat32(chunks: Float32Array[]): Float32Array {
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Float32Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}

/**
 * Playback→mic transport delay used to time-align the far-end echo reference,
 * in samples @ 16 kHz. Device-tunable via `ELIZA_VOICE_ECHO_DELAY_MS`:
 *   - a positive number → that many milliseconds, exactly;
 *   - the literal `"auto"` → seed from a per-platform default
 *     (`platformPlaybackDelaySamples`, #9583), useful on iOS/macOS where the
 *     CoreAudio / AVAudioEngine transport delay is small but non-zero;
 *   - unset / anything else → 0 (the default — the canceller aligns to the
 *     most-recently-rendered playback and the NLMS filter adapts the residual).
 *
 * Either way the on-device calibration (`estimateEchoDelaySamples`, #9586)
 * refines this seed at runtime once enough correlated echo is observed.
 */
function resolveEchoDelaySamples(): number {
	const raw = process.env.ELIZA_VOICE_ECHO_DELAY_MS;
	if (raw && raw.trim().toLowerCase() === "auto") {
		// Resolve the platform id the way the rest of this plugin does
		// (service.ts / backend-selector.ts): the mobile shells report
		// `ELIZA_PLATFORM=ios|android`, where `process.platform` is `darwin`/
		// `linux`. Using the resolved id makes the iOS (25 ms) / AOSP-Android
		// (45 ms) seeds in the #9653 table reachable on device instead of
		// collapsing to the host's darwin (20 ms) / linux (30 ms) seed.
		const platformId =
			process.env.ELIZA_PLATFORM === "ios"
				? "ios"
				: process.env.ELIZA_PLATFORM === "android"
					? "android"
					: process.platform;
		return platformPlaybackDelaySamples(platformId, AUDIO_FRAME_SAMPLE_RATE);
	}
	const ms = Number(raw);
	if (!Number.isFinite(ms) || ms <= 0) return 0;
	return Math.round((ms / 1000) * AUDIO_FRAME_SAMPLE_RATE);
}

/**
 * Opt-in residual-echo suppressor, off by default (#9583/#9649). Device-tunable
 * via `ELIZA_VOICE_RESIDUAL_SUPPRESSION`:
 *   - `"1"` / `"true"` / `"on"` → enable with the canceller's default gain;
 *   - a number in (0,1] → enable with that residual gain (lower = stronger);
 *   - unset / anything else → disabled (the canceller does linear NLMS only).
 * Left off until validated with real device audio, per #9649 item 2.
 */
function resolveResidualSuppression(): boolean | { gain: number } | undefined {
	const raw =
		process.env.ELIZA_VOICE_RESIDUAL_SUPPRESSION?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "1" || raw === "true" || raw === "on") return true;
	const gain = Number(raw);
	if (Number.isFinite(gain) && gain > 0 && gain <= 1) return { gain };
	return undefined;
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
	/**
	 * Playback→mic delay applied when reading the far-end reference. Seeded from
	 * `ELIZA_VOICE_ECHO_DELAY_MS` (default 0) and then SELF-CALIBRATED on the live
	 * path: once enough playback-active echo is observed, `estimateEchoDelaySamples`
	 * (#9586) recovers the bulk transport lag by cross-correlation and replaces the
	 * seed (#9583). Mutable for that reason.
	 */
	private echoDelaySamples = resolveEchoDelaySamples();
	private echoDelayConfidence = 0;
	private echoDelayCalibrated = false;
	/**
	 * Far-end delivery evidence (#9583): frames/samples actually pushed through
	 * {@link pushPlayback} and the wall-clock time of the last one. These drive
	 * the truthful `aec.echoReferenceWired` status — the wiring is only "live"
	 * once a real far-end source has delivered samples, never merely because the
	 * consumer built. Cumulative across {@link resetPlayback}.
	 */
	private playbackFramesReceived = 0;
	private playbackSamplesReceived = 0;
	private lastPlaybackFrameAt: number | null = null;
	/** Rolling near/far windows accumulated only while the far-end is active, used
	 * once to estimate the playback→mic delay. Cleared after a confident estimate
	 * and on {@link resetPlayback}. */
	private calNear: Float32Array[] = [];
	private calFar: Float32Array[] = [];
	private calSampleCount = 0;
	/** Bounded AEC evidence capture (#11373): while armed, every ingested mic
	 * frame (near) and the delay-0 far-end reference at its timestamp are
	 * buffered so real on-device ERLE/double-talk measurements can replay the
	 * exact production canceller offline. Off by default; hard sample cap. */
	private aecCaptureArmed = false;
	private aecCaptureMaxSamples = 0;
	private aecCaptureNear: Float32Array[] = [];
	private aecCaptureFar: Float32Array[] = [];
	private aecCaptureSamples = 0;
	private aecCaptureStartTimestampMs: number | null = null;

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
		// One shared store per state dir so Pipeline A (here) and Pipeline B
		// (the speak-back loop) resolve the same identities (#12257).
		const store = await getSharedVoiceProfileStore();

		const pipeline = new VoiceAttributionPipeline({
			encoder,
			diarizer,
			profileStore: store,
		});
		const residualSuppression = resolveResidualSuppression();
		const config: AudioFrameConsumerConfig = {
			source: { kind: "local_mic", deviceId: "android-audioframe" },
			preRollSeconds: 0.3,
			maxTurnSeconds: 30,
			...(residualSuppression ? { residualSuppression } : {}),
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
					((timestampMs, samples) =>
						this.echoReferenceFrame(timestampMs, samples)),
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
	echoReferenceFrame(timestampMs: number, samples: number): Float32Array {
		return this.echoBuffer.referenceAt(
			timestampMs,
			samples,
			this.echoDelaySamples,
		);
	}

	/** Current self-calibrated AEC delay state (for status + tests). */
	aecDelayState(): {
		delaySamples: number;
		confidence: number;
		calibrated: boolean;
	} {
		return {
			delaySamples: this.echoDelaySamples,
			confidence: this.echoDelayConfidence,
			calibrated: this.echoDelayCalibrated,
		};
	}

	/**
	 * Self-calibrate the playback→mic delay (#9583/#9586) from real echo. Called
	 * per mic frame while uncalibrated: when the far-end is active (the agent is
	 * playing TTS), accumulate the time-aligned near/far windows; once ~0.75 s of
	 * playback-active audio is buffered, recover the bulk transport lag by
	 * cross-correlation and, if confident, replace the static seed. One-shot — the
	 * device's speaker→mic path is stable, so we lock the first confident estimate
	 * and stop re-measuring. Public so it can be unit-tested without the fused FFI.
	 */
	observeForDelayCalibration(nearPcm: Float32Array, timestampMs: number): void {
		if (this.echoDelayCalibrated || nearPcm.length === 0) return;
		// Read the RAW far-end at this frame (delay 0) — calibration recovers the
		// delay, so it must not pre-apply the value it is trying to measure.
		const far = this.echoBuffer.referenceAt(timestampMs, nearPcm.length, 0);
		let farEnergy = 0;
		for (let i = 0; i < far.length; i++) farEnergy += far[i] * far[i];
		if (farEnergy / Math.max(1, far.length) < ECHO_CAL_FAR_ENERGY_FLOOR) {
			return; // no playback → nothing to calibrate against
		}

		this.calNear.push(nearPcm.slice());
		this.calFar.push(far);
		this.calSampleCount += nearPcm.length;
		while (
			this.calSampleCount > ECHO_CAL_MAX_SAMPLES &&
			this.calNear.length > 1
		) {
			this.calSampleCount -= (this.calNear.shift() as Float32Array).length;
			this.calFar.shift();
		}
		if (this.calSampleCount < ECHO_CAL_TARGET_SAMPLES) return;

		const near = concatFloat32(this.calNear);
		const farWin = concatFloat32(this.calFar);
		const est = estimateEchoDelaySamples(near, farWin, {
			maxLagSamples: ECHO_CAL_MAX_LAG_SAMPLES,
		});
		if (
			est.confidence >= ECHO_CAL_MIN_CONFIDENCE &&
			est.lagSamples < ECHO_CAL_MAX_LAG_SAMPLES - ECHO_CAL_CAP_EDGE_SAMPLES
		) {
			this.echoDelaySamples = est.lagSamples;
			this.echoDelayConfidence = est.confidence;
			this.echoDelayCalibrated = true;
		}
		this.calNear = [];
		this.calFar = [];
		this.calSampleCount = 0;
	}

	/**
	 * Arm the bounded AEC evidence capture (#11373). Restarts any previous
	 * window. `maxSeconds` is clamped to [1, {@link AEC_CAPTURE_MAX_SECONDS}].
	 */
	armAecCapture(maxSeconds?: number): AecCaptureStatus {
		const seconds = Math.min(
			AEC_CAPTURE_MAX_SECONDS,
			Math.max(1, maxSeconds ?? AEC_CAPTURE_DEFAULT_SECONDS),
		);
		this.aecCaptureArmed = true;
		this.aecCaptureMaxSamples = Math.round(seconds * AUDIO_FRAME_SAMPLE_RATE);
		this.aecCaptureNear = [];
		this.aecCaptureFar = [];
		this.aecCaptureSamples = 0;
		this.aecCaptureStartTimestampMs = null;
		return this.aecCaptureStatus();
	}

	/** Stop appending to the capture window; the buffered window stays readable
	 * via {@link aecCaptureSnapshot} until the next {@link armAecCapture}. */
	disarmAecCapture(): AecCaptureStatus {
		this.aecCaptureArmed = false;
		return this.aecCaptureStatus();
	}

	aecCaptureStatus(): AecCaptureStatus {
		return {
			armed: this.aecCaptureArmed,
			sampleCount: this.aecCaptureSamples,
			maxSamples: this.aecCaptureMaxSamples,
			startTimestampMs: this.aecCaptureStartTimestampMs,
		};
	}

	/** The captured near/far window plus the delay state the live canceller
	 * applied while it was recorded. */
	aecCaptureSnapshot(): AecCaptureSnapshot {
		return {
			...this.aecCaptureStatus(),
			sampleRate: AUDIO_FRAME_SAMPLE_RATE,
			nearPcm16: encodePcm16Base64(this.aecCaptureNear),
			farPcm16: encodePcm16Base64(this.aecCaptureFar),
			echoDelaySamples: this.echoDelaySamples,
			echoDelayConfidence: this.echoDelayConfidence,
			echoDelayCalibrated: this.echoDelayCalibrated,
		};
	}

	/**
	 * Append one ingested mic frame (near) and the delay-0 far-end reference at
	 * its timestamp to the armed capture window. Public so the seam is
	 * unit-testable without the fused FFI (mirrors
	 * {@link observeForDelayCalibration}).
	 */
	captureAecFrame(nearPcm: Float32Array, timestampMs: number): void {
		if (!this.aecCaptureArmed || nearPcm.length === 0) return;
		if (this.aecCaptureSamples >= this.aecCaptureMaxSamples) {
			this.aecCaptureArmed = false;
			return;
		}
		if (this.aecCaptureStartTimestampMs === null) {
			this.aecCaptureStartTimestampMs = timestampMs;
		}
		// Delay 0 on purpose: offline replay measures/applies the delay itself,
		// so the capture must not bake in the value under measurement.
		const far = this.echoBuffer.referenceAt(timestampMs, nearPcm.length, 0);
		this.aecCaptureNear.push(nearPcm.slice());
		this.aecCaptureFar.push(far);
		this.aecCaptureSamples += nearPcm.length;
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
			const pcm = decodeAudioFramePcm(frame);
			this.echoBuffer.pushAt(frame.timestamp, pcm);
			this.playbackFramesReceived += 1;
			this.playbackSamplesReceived += pcm.length;
			this.lastPlaybackFrameAt = Date.now();
		}
	}

	/** Drop buffered far-end playback (playback stopped / barge-in). Also clears
	 * the in-progress delay-calibration window (it would otherwise straddle a
	 * playback gap); the already-learned delay is kept. */
	resetPlayback(): void {
		this.echoBuffer.reset();
		this.calNear = [];
		this.calFar = [];
		this.calSampleCount = 0;
	}

	/** Feed a batch of WebView-captured frames; resolves once VAD has processed them. */
	async ingest(frames: AudioFrameEvent[]): Promise<void> {
		// The AEC evidence seam — delay self-calibration and the armed near/far
		// capture — is pure TypeScript and is the actual subject of #9583/#11373.
		// Diarization is a separate, native-only concern: builds that ship no
		// fused voice lib (e.g. iOS, which embeds only ElizaBunEngine) must still
		// serve the AEC path rather than 500 the whole transport. So the fused
		// consumer is best-effort — its build failure is recorded in buildError
		// (surfaced by status()) and never blocks capture.
		let consumerReady = false;
		try {
			await this.ensureBuilt();
			consumerReady = this.consumer != null;
		} catch {
			// Fused diarizer unavailable; the pure-TS AEC seam below still runs.
		}
		for (const frame of frames) {
			this.framesReceived += 1;
			if (!this.echoDelayCalibrated || this.aecCaptureArmed) {
				try {
					const near = decodeAudioFramePcm(frame);
					if (!this.echoDelayCalibrated) {
						this.observeForDelayCalibration(near, frame.timestamp);
					}
					this.captureAecFrame(near, frame.timestamp);
				} catch {
					// Let AudioFrameConsumer own decode-error accounting below.
				}
			}
			if (consumerReady && this.consumer) {
				await this.consumer.onAudioFrame(frame);
			}
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
				// Truthful wiring signal (#9583): a host provider is registered, or a
				// real far-end source actually delivered samples. A merely-built
				// consumer is NOT a far-end — with no delivery the reference reads
				// zeros and the NLMS canceller is a passthrough.
				echoReferenceWired:
					this.options.echoReference != null ||
					this.playbackSamplesReceived > 0,
				playbackFramesReceived: this.playbackFramesReceived,
				playbackSamplesReceived: this.playbackSamplesReceived,
				lastPlaybackFrameAt: this.lastPlaybackFrameAt,
				echoDelaySamples: this.echoDelaySamples,
				echoDelayConfidence: this.echoDelayConfidence,
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
