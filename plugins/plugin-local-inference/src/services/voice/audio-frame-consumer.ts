/**
 * AudioFrameConsumer — turn the Android `audioFrame` PCM stream into live,
 * VAD-segmented, speaker-attributed voice turns.
 *
 * The Android native capture path (`plugin-native-talkmode`) streams an
 * `audioFrame` Capacitor event: base64 little-endian s16 mono PCM at 16 kHz,
 * 20 ms per frame, plus `{ sampleRate, channels, samples, rms, timestamp,
 * frameIndex }`. This module is the platform-agnostic consumer that subscribes
 * to that stream (wherever the bun:ffi voice libs are present) and runs:
 *
 *   audioFrame (base64 LE-s16) → decode → VadDetector (turn segmentation)
 *     → on speech-end: VoiceAttributionPipeline.attribute(turn PCM)
 *       → handleLiveVoiceAttribution → VOICE_TURN_OBSERVED + voiceTurnSignal
 *
 * Design notes:
 *  - It does NOT reinvent VAD: it drives the existing `VadDetector` state
 *    machine (`speech-start` / `speech-pause` / `speech-end`), reusing its
 *    Silero onset/offset/hangover logic. It buffers the turn's PCM between
 *    `speech-start` and `speech-end`, then attributes the whole utterance.
 *  - Every native dependency (`VadDetector`, `VoiceAttributionPipeline`, the
 *    runtime) is INJECTED, so the consumer is fully unit-testable with fakes
 *    and has no static import of bun:ffi. A `build*` factory in the smoke
 *    harness wires the real ggml-backed deps.
 *  - The decode boundary (`decodeAudioFramePcm`) is the ONLY place that knows
 *    the wire format (base64 LE-s16). Internally everything is Float32 [-1,1].
 *
 * What this module does NOT do: it does not transcribe (ASR text is the
 * separate streaming-ASR path) and it does not own the WebView→agent
 * transport — see `android/AUDIO_FRAMES.md` and `LIVE_PIPELINE.md` for the
 * remaining device wiring.
 */

import {
	type EmitVoiceTurnObservedArgs,
	type HandleLiveVoiceAttributionOptions,
	handleLiveVoiceAttribution,
} from "../../runtime/voice-entity-binding.js";
import type { VoiceTurnSignal } from "./eot-classifier.js";
import {
	NlmsEchoCanceller,
	type ResidualSuppressionOptions,
} from "./nlms-echo-canceller.js";
import type {
	IncrementalTurnAttributor,
	VoiceAttributionOutput,
	VoiceAttributionPipeline,
} from "./speaker/attribution-pipeline.js";
import { PYANNOTE_WINDOW_SECONDS } from "./speaker/diarizer.js";
import type { PcmFrame, VadEvent, VoiceInputSource } from "./types.js";

// ---------------------------------------------------------------------------
// Wire format → Float32 boundary
// ---------------------------------------------------------------------------

/**
 * The `audioFrame` event payload, mirroring `TalkModeAudioFrameEvent` in
 * `@elizaos/capacitor-talkmode`. Re-declared structurally here so this
 * package does not take a build dep on the Capacitor plugin.
 */
export interface AudioFrameEvent {
	/** Base64-encoded little-endian signed 16-bit mono PCM for this frame. */
	pcm16: string;
	/** Sample rate of the captured PCM in Hz (e.g. 16000). */
	sampleRate: number;
	/** Channel count (always 1 — mono). */
	channels: number;
	/** Number of PCM samples in this frame (`pcm16` byte length / 2). */
	samples: number;
	/** RMS amplitude of this frame, normalized 0..1. */
	rms: number;
	/** Monotonic capture timestamp for this frame, ms. */
	timestamp: number;
	/** Running index of this frame since capture started (0-based). */
	frameIndex: number;
}

/** The sample rate every voice model in this pipeline is dimensioned for. */
export const AUDIO_FRAME_PIPELINE_SAMPLE_RATE = 16_000;

export class AudioFrameDecodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AudioFrameDecodeError";
	}
}

/**
 * Decode an `audioFrame` payload into a Float32 [-1, 1] window. This is the
 * single boundary that understands the base64 LE-s16 wire format.
 *
 * The native capture path only ever produces 16 kHz mono; this asserts that
 * invariant rather than resampling silently (the downstream Silero/WeSpeaker
 * graphs are 16 kHz-only — a wrong rate is a bug to surface, not paper over).
 */
export function decodeAudioFramePcm(frame: AudioFrameEvent): Float32Array {
	if (frame.channels !== 1) {
		throw new AudioFrameDecodeError(
			`[audio-frame-consumer] expected mono (channels=1); got channels=${frame.channels}`,
		);
	}
	if (frame.sampleRate !== AUDIO_FRAME_PIPELINE_SAMPLE_RATE) {
		throw new AudioFrameDecodeError(
			`[audio-frame-consumer] expected ${AUDIO_FRAME_PIPELINE_SAMPLE_RATE} Hz; got ${frame.sampleRate} Hz. Capture at 16 kHz (startAudioFrames default).`,
		);
	}
	const bytes = base64ToBytes(frame.pcm16);
	if (bytes.length % 2 !== 0) {
		throw new AudioFrameDecodeError(
			`[audio-frame-consumer] PCM byte length ${bytes.length} is odd — not a whole number of s16 samples`,
		);
	}
	const sampleCount = bytes.length >> 1;
	// Read LE-s16 over the decoded bytes. A DataView reads the bytes regardless
	// of the host's native endianness, so this is correct on any platform.
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out = new Float32Array(sampleCount);
	for (let i = 0; i < sampleCount; i += 1) {
		out[i] = view.getInt16(i * 2, true) / 32_768;
	}
	return out;
}

/**
 * Decode base64 → bytes without assuming a runtime global. Prefers Node/Bun
 * `Buffer`; falls back to `atob` (browsers / web workers).
 */
function base64ToBytes(b64: string): Uint8Array {
	const maybeBuffer = (
		globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }
	).Buffer;
	if (maybeBuffer) {
		const buf = maybeBuffer.from(b64, "base64");
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	const atobFn = (globalThis as { atob?: (s: string) => string }).atob;
	if (!atobFn) {
		throw new AudioFrameDecodeError(
			"[audio-frame-consumer] no base64 decoder available (neither Buffer nor atob)",
		);
	}
	const binary = atobFn(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
	return out;
}

// ---------------------------------------------------------------------------
// VadDetector structural view (injectable)
// ---------------------------------------------------------------------------

/**
 * The structural slice of `VadDetector` the consumer needs. Taking the
 * structural view (not the concrete class) keeps the consumer testable with a
 * fake VAD and avoids pulling the optional native VAD surface into callers
 * that only want to feed frames.
 */
export interface VadSegmenter {
	/** True while a speech segment (incl. its pause hangover) is open. */
	readonly inSpeech: boolean;
	/** Subscribe to the authoritative VAD timeline. Returns an unsubscribe fn. */
	onVadEvent(listener: (event: VadEvent) => void): () => void;
	/** Feed one mic frame; resolves once its windows are processed. */
	pushFrame(frame: PcmFrame): Promise<void>;
	/** Flush trailing samples and finalize any open segment. */
	flush(): Promise<void>;
	/** Clear all state at a hard boundary. */
	reset(): void;
}

/**
 * The structural slice of `VoiceAttributionPipeline` the consumer needs.
 * `beginTurn` is optional: when the injected pipeline exposes it, the consumer
 * diarizes long turns window-by-window during capture (#12257); otherwise it
 * falls back to the one-shot whole-turn `attribute` (fakes in tests, older
 * callers).
 */
export interface AttributionPipelineLike {
	attribute(
		req: Parameters<VoiceAttributionPipeline["attribute"]>[0],
	): Promise<VoiceAttributionOutput>;
	beginTurn?(
		init: Parameters<VoiceAttributionPipeline["beginTurn"]>[0],
	): IncrementalTurnAttributor;
}

/**
 * The structural slice of `IAgentRuntime` the consumer needs:
 * `handleLiveVoiceAttribution` calls `emitEvent`.
 */
export interface RuntimeEventSink {
	emitEvent(type: unknown, payload: Record<string, unknown>): Promise<void>;
	/**
	 * Optional host-supplied far-end (agent TTS playback) reference for the live
	 * AEC path (#9583). When a host wires this, the live diarization route threads
	 * it into the session's NLMS echo canceller instead of relying on the
	 * playback-frames ingest route. Absent on headless/core runtimes.
	 */
	voiceEchoReferenceProvider?: EchoReferenceProvider;
	/**
	 * `IAgentRuntime.reportError` when the sink is a real runtime (#12263 J7).
	 * Threaded into the attribution pipeline so the detached speech-start
	 * speculative match's failures surface into RECENT_ERRORS / owner-escalation
	 * (#12894). Absent on headless/core sinks — the pipeline then logs instead.
	 */
	reportError?(
		scope: string,
		error: unknown,
		context?: Record<string, unknown>,
	): void;
}

/**
 * Transcribe a finalized turn's buffered PCM to text (#8786). When injected, the
 * consumer joins the ASR transcript into the diarization attribution so
 * `VOICE_TURN_OBSERVED` carries the real text, letting name/partner extraction
 * (`VoiceObserver.ingestTurn`) fire from live audio. Without a transcriber the
 * live audio-frame path attributes *who* spoke but emits `text: ""`.
 *
 * Returns the transcript, or `null`/empty for silence / no decode. Best-effort:
 * the consumer swallows a rejection (counted in `transcriptionErrors`) and falls
 * back to a transcript-less turn rather than dropping the diarized turn.
 */
export type TurnTranscriber = (
	pcm: Float32Array,
	sampleRate: number,
) => Promise<string | null> | string | null;

export type SelfVoiceSimilarityResolver = (
	embedding: Float32Array,
	output: VoiceAttributionOutput,
) => Promise<number | null | undefined> | number | null | undefined;

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

export interface AudioFrameConsumerDeps {
	/** Turn-segmentation VAD (drives speech-start/pause/end). */
	vad: VadSegmenter;
	/** Diarization + speaker-attribution pipeline. */
	pipeline: AttributionPipelineLike;
	/** Runtime event sink for VOICE_TURN_OBSERVED. */
	runtime: RuntimeEventSink;
	/**
	 * Optional ASR for the finalized turn's PCM (#8786). When present, its text
	 * rides on `VOICE_TURN_OBSERVED` so live name/entity extraction runs. When
	 * absent the path stays diarization-only (transcript `""`, as before).
	 */
	transcribe?: TurnTranscriber;
	/**
	 * Optional live acoustic self-voice resolver. When wired, the consumer passes
	 * the turn's WeSpeaker embedding to the host's agent-TTS centroid matcher and
	 * forwards the resulting cosine into the ambient gate.
	 */
	resolveSelfVoiceSimilarity?: SelfVoiceSimilarityResolver;
	/**
	 * Decision threshold for the resolver's similarity, forwarded with the value
	 * so the gate compares it on the right scale (a WeSpeaker-embedding cosine
	 * sits far below the MFCC default — see AGENT_SELF_VOICE_IMPRINT_THRESHOLD).
	 */
	selfVoiceThreshold?: number;
	/**
	 * Optional agent-playback (far-end) reference for acoustic echo cancellation
	 * (#9455). Given a mic frame's clock timestamp and sample count, returns the
	 * agent's TTS playback PCM for that exact window (Float32 16 kHz), or null
	 * when the agent is not playing. When wired, the consumer runs an NLMS echo
	 * canceller on every mic frame BEFORE VAD/attribution so the agent never
	 * transcribes its own TTS. Absent → no AEC (unchanged behavior). The caller
	 * owns the playback capture + the playback→mic delay calibration.
	 */
	echoReference?: EchoReferenceProvider;
}

/**
 * Returns the agent's TTS playback PCM (the far-end echo reference) aligned to a
 * mic frame's time window, or null when the agent is silent. See #9455.
 */
export type EchoReferenceProvider = (
	timestampMs: number,
	samples: number,
) => Float32Array | null;

export interface AudioFrameConsumerConfig {
	/** Source metadata stamped onto every attributed turn. */
	source?: VoiceInputSource;
	/** Gating options forwarded to `handleLiveVoiceAttribution` per turn. */
	attributionOptions?: HandleLiveVoiceAttributionOptions;
	/**
	 * Hard cap on a single buffered turn, in seconds. A speaker who never
	 * triggers `speech-end` (e.g. continuous noise) must not grow the buffer
	 * without bound. When exceeded the turn is force-finalized. Default 30 s.
	 */
	maxTurnSeconds?: number;
	/**
	 * Pre-roll seconds of audio kept before `speech-start` so the onset of the
	 * first word (which the VAD only confirms a window or two in) is not clipped
	 * out of the attribution buffer. Default 0.3 s.
	 */
	preRollSeconds?: number;
	/**
	 * Opt-in nonlinear residual-echo suppressor forwarded to the NLMS canceller
	 * (#9583/#9649). Default-off; only meaningful when an `echoReference` is wired
	 * (no canceller exists otherwise). See {@link NlmsEchoCancellerOptions.residualSuppression}.
	 */
	residualSuppression?: boolean | ResidualSuppressionOptions;
}

/** A finalized, attributed turn the consumer surfaces to its caller. */
export interface AttributedTurn {
	turnId: string;
	output: VoiceAttributionOutput;
	signal: VoiceTurnSignal;
	/** Turn span in the mic-clock (frame `timestamp`) domain. */
	startedAtMs: number;
	endedAtMs: number;
	/** Total buffered turn samples that were attributed. */
	samples: number;
}

export type AttributedTurnListener = (turn: AttributedTurn) => void;

/**
 * Drives the `audioFrame` → VAD turn-segmentation → attribution → signal
 * pipeline. One instance per capture session.
 *
 * Frame ingestion is serialized through the injected VAD's `pushFrame`
 * (which itself serializes the Silero forward pass), so `onAudioFrame` is
 * safe to fire-and-forget from a Capacitor event listener; turns surface in
 * order via `onTurn`.
 */
export class AudioFrameConsumer {
	private readonly vad: VadSegmenter;
	private readonly pipeline: AttributionPipelineLike;
	private readonly runtime: RuntimeEventSink;
	private readonly transcribe: TurnTranscriber | null;
	private readonly resolveSelfVoiceSimilarity: SelfVoiceSimilarityResolver | null;
	private readonly selfVoiceThreshold: number | null;
	private readonly echoReference: EchoReferenceProvider | null;
	/** NLMS echo canceller, instantiated only when an `echoReference` is wired. */
	private readonly echoCanceller: NlmsEchoCanceller | null;
	private readonly source: VoiceInputSource | undefined;
	private readonly attributionOptions: HandleLiveVoiceAttributionOptions;
	private readonly maxTurnSamples: number;
	private readonly preRollSamples: number;
	private readonly unsubscribeVad: () => void;
	private readonly turnListeners = new Set<AttributedTurnListener>();

	/** Float32 chunks of the in-flight turn, oldest first. */
	private turnChunks: Float32Array[] = [];
	private turnSamples = 0;
	/** Rolling pre-roll ring (frames captured before speech-start). */
	private preRoll: Float32Array[] = [];
	private preRollSampleCount = 0;
	private capturing = false;
	private turnSeq = 0;
	private turnStartedAtMs = 0;
	private lastFrameEndMs = 0;
	/** Serialized attribution chain so turns finalize one at a time, in order. */
	private attributing: Promise<void> = Promise.resolve();
	private closed = false;

	// ---- windowed long-turn attribution (#12257) --------------------------
	/** True when the injected pipeline supports incremental `beginTurn` windowing. */
	private readonly incrementalCapable: boolean;
	/** Samples per pyannote decode window (5 s @ 16 kHz). */
	private readonly windowSamples: number;
	/** The in-flight windowed turn, or null on the one-shot fallback path. */
	private incrementalTurn: IncrementalTurnAttributor | null = null;
	/** Turn-relative sample count already handed to `pushWindow` this turn. */
	private diarizedSamples = 0;
	/** Turn id allocated at speech-start (both incremental + one-shot paths). */
	private currentTurnId = "";

	/** Count of frames that failed to decode (surfaced via getters, not thrown). */
	droppedFrames = 0;

	/** Count of turns whose ASR transcribe threw (degraded to a transcript-less
	 *  turn rather than dropping the diarized turn). */
	transcriptionErrors = 0;

	/** Count of mic frames the echo canceller actually processed (i.e. the agent
	 *  was playing). Frames skipped while the agent is silent do not count, so
	 *  this also measures how often AEC took the cheap passthrough path. */
	echoFramesCancelled = 0;

	constructor(
		deps: AudioFrameConsumerDeps,
		config: AudioFrameConsumerConfig = {},
	) {
		this.vad = deps.vad;
		this.pipeline = deps.pipeline;
		this.runtime = deps.runtime;
		this.transcribe = deps.transcribe ?? null;
		this.resolveSelfVoiceSimilarity = deps.resolveSelfVoiceSimilarity ?? null;
		this.selfVoiceThreshold = deps.selfVoiceThreshold ?? null;
		this.echoReference = deps.echoReference ?? null;
		this.echoCanceller = this.echoReference
			? new NlmsEchoCanceller(
					config.residualSuppression
						? { residualSuppression: config.residualSuppression }
						: {},
				)
			: null;
		this.source = config.source;
		this.attributionOptions = config.attributionOptions ?? {};
		const sr = AUDIO_FRAME_PIPELINE_SAMPLE_RATE;
		this.maxTurnSamples = Math.max(
			sr,
			Math.round((config.maxTurnSeconds ?? 30) * sr),
		);
		this.preRollSamples = Math.max(
			0,
			Math.round((config.preRollSeconds ?? 0.3) * sr),
		);
		this.windowSamples = PYANNOTE_WINDOW_SECONDS * sr;
		this.incrementalCapable = typeof deps.pipeline.beginTurn === "function";
		this.unsubscribeVad = this.vad.onVadEvent((event) =>
			this.onVadEvent(event),
		);
	}

	/** True while a turn is being buffered (between speech-start and speech-end). */
	get inTurn(): boolean {
		return this.capturing;
	}

	/** Subscribe to finalized attributed turns. Returns an unsubscribe fn. */
	onTurn(listener: AttributedTurnListener): () => void {
		this.turnListeners.add(listener);
		return () => this.turnListeners.delete(listener);
	}

	/**
	 * Feed one decoded-or-raw `audioFrame`. Accepts either the wire-format
	 * `AudioFrameEvent` (decoded here) or a pre-decoded Float32 window with the
	 * frame's mic-clock timestamp. Resolves once the frame's VAD windows are
	 * processed.
	 */
	async onAudioFrame(frame: AudioFrameEvent): Promise<void> {
		if (this.closed) return;
		let pcm: Float32Array;
		try {
			pcm = decodeAudioFramePcm(frame);
		} catch (err) {
			this.droppedFrames += 1;
			throw err instanceof AudioFrameDecodeError
				? err
				: new AudioFrameDecodeError(
						`[audio-frame-consumer] frame decode failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
		}
		await this.pushDecodedFrame(pcm, frame.timestamp);
	}

	/**
	 * Feed a pre-decoded Float32 16 kHz window with its mic-clock timestamp
	 * (ms). The decode boundary already ran; used by transports that decode
	 * upstream and by the host harness.
	 */
	async pushDecodedFrame(
		pcm: Float32Array,
		timestampMs: number,
	): Promise<void> {
		if (this.closed) return;
		// #9455/#9649: cancel the agent's TTS echo before VAD/attribution so the
		// agent never transcribes its own playback. When the reference provider
		// returns null/empty the agent is silent — skip the FIR canceller so AEC
		// is cheap and exactly passthrough on the common no-playback path.
		const micPcm = this.cancelEcho(pcm, timestampMs);
		this.lastFrameEndMs =
			timestampMs + (micPcm.length / AUDIO_FRAME_PIPELINE_SAMPLE_RATE) * 1000;
		if (this.capturing) {
			this.appendTurnChunk(micPcm);
		} else {
			this.appendPreRoll(micPcm);
		}
		await this.vad.pushFrame({
			pcm: micPcm,
			sampleRate: AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
			timestampMs,
		});
	}

	/**
	 * Run the echo canceller on one mic frame when (and only when) the agent is
	 * playing. The reference provider returns null while the agent is silent, in
	 * which case the mic frame is passed through verbatim and the FIR
	 * `process()` loop is not invoked. The canceller still observes the silent
	 * far-end so stale playback history is cleared before playback resumes.
	 * Returns the echo-cancelled (or untouched) mic frame.
	 */
	private cancelEcho(pcm: Float32Array, timestampMs: number): Float32Array {
		if (!this.echoCanceller || !this.echoReference) return pcm;
		const reference = this.echoReference(timestampMs, pcm.length);
		if (!reference || reference.length === 0) {
			this.echoCanceller.observeFarEndSilence(pcm);
			return pcm;
		}
		this.echoFramesCancelled += 1;
		return this.echoCanceller.process(pcm, reference);
	}

	/**
	 * Flush the VAD (finalize any open segment) and await all pending
	 * attribution. Call at end-of-capture so a trailing utterance is not lost.
	 */
	async flush(): Promise<void> {
		if (this.closed) return;
		await this.vad.flush();
		await this.attributing;
	}

	/** Release listeners and clear all buffers. Idempotent. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribeVad();
		// A turn left open at close never reaches speech-end: abandon it so its
		// speech-start speculative `embed()` unwinds (settles `firstWindow`) rather
		// than hanging on an await that never resolves (#12896).
		this.incrementalTurn?.cancel();
		this.incrementalTurn = null;
		await this.attributing;
		this.turnListeners.clear();
		this.turnChunks = [];
		this.preRoll = [];
		this.turnSamples = 0;
		this.preRollSampleCount = 0;
	}

	// ---- VAD event handling ------------------------------------------------

	private onVadEvent(event: VadEvent): void {
		switch (event.type) {
			case "speech-start":
				this.beginTurn(event.timestampMs);
				break;
			case "speech-end":
				this.finalizeTurn(event.timestampMs);
				break;
			// speech-active / speech-pause / blip do not alter buffering: PCM
			// keeps accumulating through pauses (mid-utterance micro-silences are
			// part of the turn), and a `blip` never opened a turn.
			default:
				break;
		}
	}

	private beginTurn(startedAtMs: number): void {
		if (this.capturing) return;
		this.capturing = true;
		this.turnStartedAtMs = startedAtMs;
		// Seed the turn with the pre-roll so the leading word isn't clipped.
		this.turnChunks = this.preRoll;
		this.turnSamples = this.preRollSampleCount;
		this.preRoll = [];
		this.preRollSampleCount = 0;
		this.currentTurnId = `aframe_${this.turnSeq++}`;
		this.diarizedSamples = 0;
		// Windowed long-turn attribution (#12257): begin the incremental turn so
		// the speech-start speculative match fires and each 5 s window decodes as
		// it fills (see `emitFilledWindows`) instead of one whole-turn decode at
		// speech-end. Falls back to one-shot `attribute` when the pipeline has no
		// `beginTurn` (test fakes / older callers).
		this.incrementalTurn =
			this.incrementalCapable && this.pipeline.beginTurn
				? this.pipeline.beginTurn({
						turnId: this.currentTurnId,
						...(this.source ? { source: this.source } : {}),
						startedAtMs,
					})
				: null;
	}

	private finalizeTurn(endedAtMs: number): void {
		if (!this.capturing) return;
		this.capturing = false;
		const chunks = this.turnChunks;
		const total = this.turnSamples;
		const turnId = this.currentTurnId;
		const startedAtMs = this.turnStartedAtMs;
		const incrementalTurn = this.incrementalTurn;
		const diarizedSamples = this.diarizedSamples;
		this.turnChunks = [];
		this.turnSamples = 0;
		this.incrementalTurn = null;
		this.diarizedSamples = 0;
		if (total === 0) {
			// No buffered audio — abandon the turn so its speculative `embed()`
			// unwinds (settles `firstWindow`) instead of suspending forever (#12896).
			incrementalTurn?.cancel();
			return;
		}
		const pcm = concatFloat32(chunks, total);
		// Serialize attribution so turns surface in order and a slow turn can't
		// interleave with the next one's buffer.
		if (incrementalTurn) {
			// Only the trailing (< 5 s) window is left to decode — the full windows
			// were already decoded during capture (#12257).
			const finalWindow =
				total > diarizedSamples
					? sliceFromChunks(chunks, diarizedSamples, total)
					: undefined;
			const finalWindowStartMs =
				(diarizedSamples / AUDIO_FRAME_PIPELINE_SAMPLE_RATE) * 1000;
			this.attributing = this.attributing.then(() =>
				this.finalizeIncrementalTurn({
					turnId,
					incrementalTurn,
					fullPcm: pcm,
					finalWindow,
					finalWindowStartMs,
					startedAtMs,
					endedAtMs,
				}),
			);
		} else {
			this.attributing = this.attributing.then(() =>
				this.attributeTurn({ turnId, pcm, startedAtMs, endedAtMs }),
			);
		}
	}

	private async attributeTurn(args: {
		turnId: string;
		pcm: Float32Array;
		startedAtMs: number;
		endedAtMs: number;
	}): Promise<void> {
		const output = await this.pipeline.attribute({
			turnId: args.turnId,
			pcm: args.pcm,
			startedAtMs: args.startedAtMs,
			endedAtMs: args.endedAtMs,
			...(this.source ? { source: this.source } : {}),
		});
		await this.emitAttributedTurn({
			turnId: args.turnId,
			output,
			pcm: args.pcm,
			startedAtMs: args.startedAtMs,
			endedAtMs: args.endedAtMs,
		});
	}

	/**
	 * Finalize a windowed turn: decode only the trailing partial window plus the
	 * one embedding/profile-match over the already-diarized windows (#12257),
	 * then emit the attributed turn exactly as the one-shot path does.
	 */
	private async finalizeIncrementalTurn(args: {
		turnId: string;
		incrementalTurn: IncrementalTurnAttributor;
		fullPcm: Float32Array;
		finalWindow: Float32Array | undefined;
		finalWindowStartMs: number;
		startedAtMs: number;
		endedAtMs: number;
	}): Promise<void> {
		const output = await args.incrementalTurn.finalize({
			fullPcm: args.fullPcm,
			...(args.finalWindow ? { finalWindowPcm: args.finalWindow } : {}),
			finalWindowStartMs: args.finalWindowStartMs,
			endedAtMs: args.endedAtMs,
		});
		await this.emitAttributedTurn({
			turnId: args.turnId,
			output,
			pcm: args.fullPcm,
			startedAtMs: args.startedAtMs,
			endedAtMs: args.endedAtMs,
		});
	}

	/**
	 * Join the ASR transcript for this turn (#8786) so VOICE_TURN_OBSERVED
	 * carries the real text and live name/entity extraction can fire, run the
	 * live-attribution gate, and surface the finalized turn to listeners. ASR is
	 * best-effort: a decode failure degrades to a transcript-less turn (the
	 * diarized speaker is still emitted), never a dropped turn.
	 */
	private async emitAttributedTurn(args: {
		turnId: string;
		output: VoiceAttributionOutput;
		pcm: Float32Array;
		startedAtMs: number;
		endedAtMs: number;
	}): Promise<void> {
		const opts = await this.resolveTurnOptions(args.pcm, args.output);
		const signal = await handleLiveVoiceAttribution(
			this.runtime as Parameters<typeof handleLiveVoiceAttribution>[0],
			args.output,
			opts,
		);
		const turn: AttributedTurn = {
			turnId: args.turnId,
			output: args.output,
			signal,
			startedAtMs: args.startedAtMs,
			endedAtMs: args.endedAtMs,
			samples: args.pcm.length,
		};
		for (const listener of this.turnListeners) listener(turn);
	}

	/**
	 * Merge the per-turn ASR transcript into the attribution options. Returns the
	 * base options unchanged when no transcriber is wired or the decode yields no
	 * text; a thrown decode is swallowed (counted in `transcriptionErrors`) so a
	 * diarized turn is never dropped over an ASR failure.
	 */
	private async resolveTurnOptions(
		pcm: Float32Array,
		output: VoiceAttributionOutput,
	): Promise<HandleLiveVoiceAttributionOptions> {
		let options = this.attributionOptions;
		try {
			if (this.transcribe) {
				const transcript = await this.transcribe(
					pcm,
					AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
				);
				const trimmed = transcript?.trim();
				if (trimmed) {
					options = { ...options, transcript: trimmed };
				}
			}
		} catch {
			this.transcriptionErrors += 1;
		}
		const embedding = output.observation?.embedding;
		if (this.resolveSelfVoiceSimilarity && embedding) {
			const similarity = await this.resolveSelfVoiceSimilarity(
				embedding,
				output,
			);
			if (typeof similarity === "number" && Number.isFinite(similarity)) {
				options = {
					...options,
					selfVoiceSimilarity: similarity,
					...(this.selfVoiceThreshold !== null
						? { selfVoiceThreshold: this.selfVoiceThreshold }
						: {}),
				};
			}
		}
		return options;
	}

	// ---- buffering ---------------------------------------------------------

	private appendTurnChunk(pcm: Float32Array): void {
		this.turnChunks.push(pcm);
		this.turnSamples += pcm.length;
		this.emitFilledWindows();
		// Hard cap: force-finalize a runaway turn at the current frame edge.
		if (this.turnSamples >= this.maxTurnSamples) {
			this.finalizeTurn(this.lastFrameEndMs);
			this.vad.reset();
		}
	}

	/**
	 * Decode each 5 s window through the diarizer the moment it fills, so a long
	 * turn's diarization is already done by speech-end (#12257). Slices the
	 * turn-relative window [diarizedSamples, +windowSamples) out of the running
	 * buffer and chains it onto the serialized attribution queue; the trailing
	 * partial window is decoded in `finalizeTurn`. No-op on the one-shot path.
	 */
	private emitFilledWindows(): void {
		const turn = this.incrementalTurn;
		if (!turn) return;
		while (this.turnSamples - this.diarizedSamples >= this.windowSamples) {
			const start = this.diarizedSamples;
			const window = sliceFromChunks(
				this.turnChunks,
				start,
				start + this.windowSamples,
			);
			const windowStartMs = (start / AUDIO_FRAME_PIPELINE_SAMPLE_RATE) * 1000;
			this.diarizedSamples += this.windowSamples;
			this.attributing = this.attributing.then(() =>
				turn.pushWindow(window, windowStartMs),
			);
		}
	}

	private appendPreRoll(pcm: Float32Array): void {
		if (this.preRollSamples === 0) return;
		this.preRoll.push(pcm);
		this.preRollSampleCount += pcm.length;
		// Drop oldest pre-roll chunks once over the pre-roll budget.
		while (
			this.preRoll.length > 1 &&
			this.preRollSampleCount - this.preRoll[0].length >= this.preRollSamples
		) {
			const dropped = this.preRoll.shift();
			if (dropped) this.preRollSampleCount -= dropped.length;
		}
	}
}

/** Concatenate Float32 chunks into a single buffer of known total length. */
function concatFloat32(
	chunks: readonly Float32Array[],
	total: number,
): Float32Array {
	const out = new Float32Array(total);
	let cursor = 0;
	for (const c of chunks) {
		out.set(c, cursor);
		cursor += c.length;
	}
	return out;
}

/**
 * Copy samples [start, end) out of a list of Float32 chunks (oldest first),
 * walking across chunk boundaries — carves a diarization window out of the
 * in-flight turn buffer without flattening the whole turn each time (#12257).
 */
function sliceFromChunks(
	chunks: readonly Float32Array[],
	start: number,
	end: number,
): Float32Array {
	const length = Math.max(0, end - start);
	const out = new Float32Array(length);
	if (length === 0) return out;
	let chunkStart = 0;
	let written = 0;
	for (const chunk of chunks) {
		const chunkEnd = chunkStart + chunk.length;
		if (chunkEnd > start && chunkStart < end) {
			const from = Math.max(start, chunkStart) - chunkStart;
			const to = Math.min(end, chunkEnd) - chunkStart;
			out.set(chunk.subarray(from, to), written);
			written += to - from;
		}
		chunkStart = chunkEnd;
		if (chunkStart >= end) break;
	}
	return out;
}

/**
 * Re-export of the producer's emit args, so a consumer caller can construct a
 * VOICE_TURN_OBSERVED payload directly when wiring a custom transport without
 * importing the runtime subpath twice.
 */
export type { EmitVoiceTurnObservedArgs };
