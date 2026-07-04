/**
 * Shared per-process far-end (agent TTS playback) reference for the desktop
 * speak-back loop's echo cancellation (#12256).
 *
 * The renderer already POSTs rendered playback as 16 kHz LE-s16 frames to
 * `/api/voice/playback-frames` (packages/ui playback-frame-pump). Pipeline A
 * (live diarization) consumes them per mic frame; the desktop ASR ingest
 * (`/api/asr/local-inference`) had NO consumer, so the agent transcribed its
 * own echo. This service is the second consumer: it retains a 30 s timestamped
 * history of playback PCM and cancels the echo out of whole recorded
 * utterances before transcription.
 *
 * Alignment: playback frames are timestamped in the renderer's
 * `performance.now()` domain; the mic WAV carries no timestamps at all. The
 * epoch offset between the two clocks is tracked as the running minimum of
 * (server arrival − frame timestamp) — a tight anchor on loopback — and the
 * residual (acoustic + transport + anchor-jitter) alignment is recovered from
 * the audio itself per utterance via `estimateEchoAlignment`. A low peak
 * correlation means the utterance carries no detectable echo, in which case
 * the input is passed through BIT-EXACT (same honesty contract as Pipeline A:
 * cancellation is only ever applied against a proven reference, and
 * `echoReferenceWired` flips only once real playback samples arrived).
 *
 * Unlike Pipeline A's streaming buffer, the history here deliberately survives
 * `playback reset` (the pump posts `reset:true` at the end of every playback
 * segment — usually BEFORE the echoed utterance's WAV arrives). Timestamped
 * writes zero-fill gaps, so stale audio can never masquerade as a live
 * reference, and a renderer reload (timestamps jumping backwards) re-origins
 * the buffer and drops the learned epoch offset.
 */

import { logger } from "@elizaos/core";
import {
	computeFarActiveErle,
	ECHO_CAL_FAR_ENERGY_FLOOR,
	ECHO_CAL_MIN_CONFIDENCE,
	estimateEchoAlignment,
} from "@elizaos/shared/voice/aec";
import {
	type AudioFrameEvent,
	decodeAudioFramePcm,
} from "./audio-frame-consumer.js";
import { EchoReferenceBuffer } from "./echo-reference-buffer.js";
import { NlmsEchoCanceller } from "./nlms-echo-canceller.js";
import { resampleLinear } from "./transcriber.js";
import { decodeMonoPcm16Wav, encodeMonoPcm16Wav } from "./wav-codec.js";

const SAMPLE_RATE = 16_000;
/** Playback history retained for utterance-level cancellation (30 s @16 kHz). */
const FAR_HISTORY_SAMPLES = 30 * SAMPLE_RATE;
/** Half-width of the per-utterance alignment search: covers the acoustic +
 * transport delay (≤500 ms measured on device paths) plus the epoch-anchor
 * jitter of the arrival-clock mapping. */
const ALIGN_SLACK_MS = 1000;
const ALIGN_SLACK_SAMPLES = (ALIGN_SLACK_MS / 1000) * SAMPLE_RATE;
/** Cap the audio used for alignment/cancellation context to the utterance's
 * trailing 15 s — the far history only holds 30 s and clocks don't drift
 * meaningfully over a single utterance. */
const MAX_ALIGN_NEAR_SAMPLES = 15 * SAMPLE_RATE;
/** A renderer reload restarts performance.now(); a backwards jump larger than
 * this invalidates the learned epoch offset. */
const TIMESTAMP_BACKWARD_JUMP_MS = 10_000;
/** Recent per-utterance cancellation results retained for telemetry. */
const MAX_RECENT_CANCELLATIONS = 20;

/**
 * Opt-in residual-echo suppressor, off by default (#9583/#9649). Device-tunable
 * via `ELIZA_VOICE_RESIDUAL_SUPPRESSION`:
 *   - `"1"` / `"true"` / `"on"` → enable with the canceller's default gain;
 *   - a number in (0,1] → enable with that residual gain (lower = stronger);
 *   - unset / anything else → disabled (the canceller does linear NLMS only).
 */
export function resolveResidualSuppression():
	| boolean
	| { gain: number }
	| undefined {
	const raw =
		process.env.ELIZA_VOICE_RESIDUAL_SUPPRESSION?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "1" || raw === "true" || raw === "on") return true;
	const gain = Number(raw);
	if (Number.isFinite(gain) && gain > 0 && gain <= 1) return { gain };
	return undefined;
}

/** Why an utterance was passed through instead of cancelled. */
export type DesktopAecPassthroughReason =
	| "no-far-end"
	| "no-overlap"
	| "low-confidence";

export interface DesktopAecResult {
	/** True when the NLMS canceller ran and `pcm` is the residual. */
	applied: boolean;
	/** Set when `applied` is false — the honest no-cancel reason. */
	reason?: DesktopAecPassthroughReason;
	/** The echo-cancelled residual, or the UNTOUCHED input when not applied. */
	pcm: Float32Array;
	/** Far-active-masked ERLE for this utterance (null when not applied or the
	 * aligned reference carried no active blocks). */
	erleDb: number | null;
	/** Winning near-inside-far alignment offset (samples), when estimated. */
	offsetSamples: number | null;
	/** Peak alignment correlation [0,1], when estimated. */
	confidence: number | null;
	/** Samples of the utterance where the aligned far-end was active. */
	farActiveSamples: number;
}

/** JSON-safe telemetry snapshot for the dev observability surface. */
export interface FarEndReferenceStatus {
	/** True only once real playback samples were delivered (#9583 honesty). */
	echoReferenceWired: boolean;
	playbackFramesReceived: number;
	playbackSamplesReceived: number;
	lastPlaybackFrameAt: number | null;
	playbackResets: number;
	/** True once the renderer↔server clock anchor has been learned. */
	epochOffsetKnown: boolean;
	utterancesCancelled: number;
	utterancesPassedThrough: number;
	/** ERLE of the most recent cancelled utterance (null before any). */
	lastErleDb: number | null;
	lastCancellation: DesktopAecUtteranceSummary | null;
	recentCancellations: DesktopAecUtteranceSummary[];
}

export interface DesktopAecUtteranceSummary {
	atEpochMs: number;
	applied: boolean;
	reason?: DesktopAecPassthroughReason;
	erleDb: number | null;
	offsetSamples: number | null;
	confidence: number | null;
	farActiveSamples: number;
	nearSamples: number;
}

export class FarEndReference {
	private readonly buffer = new EchoReferenceBuffer({
		capacitySamples: FAR_HISTORY_SAMPLES,
		sampleRateHz: SAMPLE_RATE,
	});
	private readonly canceller: NlmsEchoCanceller;
	private playbackFramesReceived = 0;
	private playbackSamplesReceived = 0;
	private lastPlaybackFrameAt: number | null = null;
	private lastFrameTimestampMs: number | null = null;
	private playbackResets = 0;
	/** Running min of (server arrival − renderer frame timestamp): the tightest
	 * observed delivery maps the renderer clock into the server clock. */
	private epochOffsetMs: number | null = null;
	private utterancesCancelled = 0;
	private utterancesPassedThrough = 0;
	private readonly recent: DesktopAecUtteranceSummary[] = [];

	constructor() {
		const residualSuppression = resolveResidualSuppression();
		this.canceller = new NlmsEchoCanceller(
			residualSuppression ? { residualSuppression } : {},
		);
	}

	/** Feed a batch of rendered-playback frames (base64 LE-s16 16 kHz mono). */
	pushPlayback(frames: AudioFrameEvent[], nowMs = Date.now()): void {
		for (const frame of frames) {
			const pcm = decodeAudioFramePcm(frame);
			if (
				this.lastFrameTimestampMs !== null &&
				frame.timestamp < this.lastFrameTimestampMs - TIMESTAMP_BACKWARD_JUMP_MS
			) {
				// Renderer reload: new performance.now() epoch. The buffer re-origins
				// itself on the backwards write; the learned anchor must be dropped.
				this.epochOffsetMs = null;
			}
			this.lastFrameTimestampMs = frame.timestamp;
			this.buffer.pushAt(frame.timestamp, pcm);
			const offset = nowMs - frame.timestamp;
			if (this.epochOffsetMs === null || offset < this.epochOffsetMs) {
				this.epochOffsetMs = offset;
			}
			this.playbackFramesReceived += 1;
			this.playbackSamplesReceived += pcm.length;
			this.lastPlaybackFrameAt = nowMs;
		}
	}

	/**
	 * A playback segment ended (the pump posts `reset:true`). The history is
	 * deliberately KEPT — the echoed utterance's WAV usually arrives after this
	 * signal, and timestamped writes already zero-fill the silence gap.
	 */
	notePlaybackReset(): void {
		this.playbackResets += 1;
	}

	/**
	 * Cancel the agent's playback echo out of one whole recorded utterance
	 * (Float32 16 kHz mono, most recent sample ≈ `nowMs`). Passthrough contract:
	 * when no playback was ever delivered, when the anchored far window carries
	 * no energy, or when the alignment correlation stays under the Pipeline A
	 * confidence bar (no detectable echo), the INPUT array is returned untouched.
	 */
	cancelUtterance(near: Float32Array, nowMs = Date.now()): DesktopAecResult {
		if (
			near.length === 0 ||
			this.playbackSamplesReceived === 0 ||
			this.epochOffsetMs === null
		) {
			return this.recordPassthrough(near, "no-far-end");
		}

		const trim = Math.max(0, near.length - MAX_ALIGN_NEAR_SAMPLES);
		const alignNear = trim > 0 ? near.subarray(trim) : near;
		const nearEndTs = nowMs - this.epochOffsetMs;
		const nearStartTs = nearEndTs - (near.length / SAMPLE_RATE) * 1000;
		const alignStartTs = nearStartTs + (trim / SAMPLE_RATE) * 1000;

		const farWindow = this.buffer.referenceAt(
			alignStartTs - ALIGN_SLACK_MS,
			alignNear.length + 2 * ALIGN_SLACK_SAMPLES,
			0,
		);
		let farEnergy = 0;
		for (let i = 0; i < farWindow.length; i++) {
			farEnergy += farWindow[i] * farWindow[i];
		}
		if (farEnergy / Math.max(1, farWindow.length) < ECHO_CAL_FAR_ENERGY_FLOOR) {
			return this.recordPassthrough(near, "no-overlap");
		}

		const alignment = estimateEchoAlignment(alignNear, farWindow, {
			maxOffsetSamples: 2 * ALIGN_SLACK_SAMPLES,
		});
		if (alignment.confidence < ECHO_CAL_MIN_CONFIDENCE) {
			return this.recordPassthrough(near, "low-confidence", alignment);
		}

		// Re-read the reference aligned to the FULL utterance at the winning
		// offset. farWindow[0] sits at (alignStartTs − slack); near[0] maps to
		// window index (offset − trim), which may be negative for a long
		// utterance whose head predates the window — referenceAt zero-fills it.
		const alignedFarStartTs =
			alignStartTs -
			ALIGN_SLACK_MS +
			((alignment.offsetSamples - trim) / SAMPLE_RATE) * 1000;
		const alignedFar = this.buffer.referenceAt(
			alignedFarStartTs,
			near.length,
			0,
		);

		// Warm-up pass over the far-active span, then the real pass. The batch
		// path can afford this offline luxury: the NLMS filter converges on the
		// echo before the samples that matter are produced, instead of leaking
		// the first few hundred ms of echo while adapting from cold.
		const activeSpan = farActiveSpan(alignedFar);
		if (!activeSpan) {
			return this.recordPassthrough(near, "no-overlap", alignment);
		}
		this.canceller.observeFarEndSilence(new Float32Array(0));
		this.canceller.process(
			near.subarray(activeSpan.start, activeSpan.end),
			alignedFar.subarray(activeSpan.start, activeSpan.end),
		);
		this.canceller.observeFarEndSilence(new Float32Array(0));
		const residual = this.canceller.process(near, alignedFar);

		const { erleDb, farActiveSamples } = computeFarActiveErle(
			near,
			residual,
			alignedFar,
		);
		this.utterancesCancelled += 1;
		const summary: DesktopAecUtteranceSummary = {
			atEpochMs: nowMs,
			applied: true,
			erleDb,
			offsetSamples: alignment.offsetSamples,
			confidence: alignment.confidence,
			farActiveSamples,
			nearSamples: near.length,
		};
		this.pushRecent(summary);
		return {
			applied: true,
			pcm: residual,
			erleDb,
			offsetSamples: alignment.offsetSamples,
			confidence: alignment.confidence,
			farActiveSamples,
		};
	}

	status(): FarEndReferenceStatus {
		const lastCancellation = this.recent[this.recent.length - 1] ?? null;
		const lastApplied = [...this.recent]
			.reverse()
			.find((entry) => entry.applied);
		return {
			echoReferenceWired: this.playbackSamplesReceived > 0,
			playbackFramesReceived: this.playbackFramesReceived,
			playbackSamplesReceived: this.playbackSamplesReceived,
			lastPlaybackFrameAt: this.lastPlaybackFrameAt,
			playbackResets: this.playbackResets,
			epochOffsetKnown: this.epochOffsetMs !== null,
			utterancesCancelled: this.utterancesCancelled,
			utterancesPassedThrough: this.utterancesPassedThrough,
			lastErleDb: lastApplied?.erleDb ?? null,
			lastCancellation,
			recentCancellations: [...this.recent],
		};
	}

	private recordPassthrough(
		near: Float32Array,
		reason: DesktopAecPassthroughReason,
		alignment?: { offsetSamples: number; confidence: number },
	): DesktopAecResult {
		this.utterancesPassedThrough += 1;
		this.pushRecent({
			atEpochMs: Date.now(),
			applied: false,
			reason,
			erleDb: null,
			offsetSamples: alignment?.offsetSamples ?? null,
			confidence: alignment?.confidence ?? null,
			farActiveSamples: 0,
			nearSamples: near.length,
		});
		return {
			applied: false,
			reason,
			pcm: near,
			erleDb: null,
			offsetSamples: alignment?.offsetSamples ?? null,
			confidence: alignment?.confidence ?? null,
			farActiveSamples: 0,
		};
	}

	private pushRecent(summary: DesktopAecUtteranceSummary): void {
		this.recent.push(summary);
		if (this.recent.length > MAX_RECENT_CANCELLATIONS) this.recent.shift();
	}
}

/** First..last 20 ms block where the aligned far-end carries energy, or null
 * when it is silent throughout (nothing to cancel). */
function farActiveSpan(
	alignedFar: Float32Array,
): { start: number; end: number } | null {
	const block = 320;
	let start = -1;
	let end = -1;
	for (let at = 0; at < alignedFar.length; at += block) {
		const to = Math.min(alignedFar.length, at + block);
		let energy = 0;
		for (let i = at; i < to; i++) energy += alignedFar[i] * alignedFar[i];
		if (energy / (to - at) >= ECHO_CAL_FAR_ENERGY_FLOOR) {
			if (start === -1) start = at;
			end = to;
		}
	}
	return start === -1 ? null : { start, end };
}

/** RIFF/WAVE magic probe — cheap shape check before attempting a decode. */
function looksLikeRiffWav(bytes: Uint8Array): boolean {
	return (
		bytes.length > 44 &&
		bytes[0] === 0x52 && // R
		bytes[1] === 0x49 && // I
		bytes[2] === 0x46 && // F
		bytes[3] === 0x46 && // F
		bytes[8] === 0x57 && // W
		bytes[9] === 0x41 && // A
		bytes[10] === 0x56 && // V
		bytes[11] === 0x45 // E
	);
}

export interface WavAecOutcome {
	/** The bytes to transcribe: cancelled 16 kHz WAV, or the ORIGINAL input. */
	bytes: Uint8Array;
	/** Cancellation detail, or null when the payload was not a mono PCM16 WAV. */
	result: DesktopAecResult | null;
}

/**
 * Cancel the desktop playback echo out of a WAV utterance before ASR. Non-WAV
 * payloads (the model-chain fallback accepts other containers) and non-mono/
 * non-PCM16 WAVs skip AEC and pass the original bytes through untouched.
 * When cancellation applies, the residual is re-encoded as 16 kHz mono WAV.
 */
export function cancelEchoInWavUtterance(
	farEnd: FarEndReference,
	bytes: Uint8Array,
	nowMs = Date.now(),
): WavAecOutcome {
	if (!looksLikeRiffWav(bytes)) return { bytes, result: null };
	let pcm: Float32Array;
	let sampleRate: number;
	try {
		({ pcm, sampleRate } = decodeMonoPcm16Wav(bytes));
	} catch {
		// error-policy:J3 untrusted-input sanitizing — a RIFF-tagged payload that
		// is not mono PCM16 (or is malformed) is typed "not AEC-able"; the original
		// bytes flow to the transcription boundary, which owns rejecting them.
		return { bytes, result: null };
	}
	const near =
		sampleRate === SAMPLE_RATE
			? pcm
			: resampleLinear(pcm, sampleRate, SAMPLE_RATE);
	const result = farEnd.cancelUtterance(near, nowMs);
	if (!result.applied) {
		return { bytes, result };
	}
	return { bytes: encodeMonoPcm16Wav(result.pcm, SAMPLE_RATE), result };
}

// ---------------------------------------------------------------------------
// Shared per-process instance
// ---------------------------------------------------------------------------

let shared: FarEndReference | null = null;

/**
 * The one far-end reference for this agent process. `/api/voice/playback-frames`
 * feeds it; `/api/asr/local-inference` cancels against it; the dev voice
 * telemetry payload reads `status()`.
 */
export function getSharedFarEndReference(): FarEndReference {
	if (!shared) {
		shared = new FarEndReference();
		logger.info("[FarEndReference] desktop far-end echo reference created");
	}
	return shared;
}

/** Drop the shared instance. Test-only. */
export function __resetSharedFarEndReferenceForTest(): void {
	shared = null;
}
