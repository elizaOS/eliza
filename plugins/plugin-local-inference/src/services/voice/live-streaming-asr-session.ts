/**
 * One live voice session: PCM frames in, Silero-VAD-gated streaming ASR,
 * interim partials out as `voice-transcript` events, one final transcript per
 * VAD segment.
 *
 *   frames → StreamingTranscriber.feed (gated by the VAD event source)
 *   VAD speech-start → open a turn (latency t0, `speech-start` event)
 *   transcriber partial → `partial` event (full running text)
 *   VAD speech-end → mark the last audio frame, `flush()` → `final` event,
 *                    then wait for the reply's first LLM token
 *
 * The transcriber comes from `createTranscriber(vad)`; on Android that is
 * `BionicHostLoader.createStreamingTranscriber({ vad })`, which streams on the
 * host's Phonon-2 decoder and uses batch op="asr" only when the host answers
 * STREAM_UNSUPPORTED. The VAD is any `VadEventSource`: the agent-side Silero
 * `VadDetector` where the fused library loads in-process, or a
 * `PushVadEventSource` fed with the Silero segment edges the app process
 * computed (the Android musl agent cannot load the fused VAD).
 *
 * Partial text lives only in the emitted events; this class keeps the latest
 * partial in memory for the current turn and never logs or stores it.
 */

import { logger } from "@elizaos/core";
import type {
	LiveTranscriptMode,
	VoiceTranscriptEvent,
} from "./live-transcript-events";
import {
	awaitLlmFirstToken,
	beginLiveVoiceTurn,
	closeLiveVoiceTurn,
	markLiveVoice,
	peekLiveVoiceTurn,
} from "./live-voice-latency";
import type {
	PcmFrame,
	StreamingTranscriber,
	VadEvent,
	VadEventListener,
	VadEventSource,
} from "./types";

/** A VAD event source fed by the caller (Silero edges computed elsewhere). */
export class PushVadEventSource implements VadEventSource {
	private readonly listeners = new Set<VadEventListener>();

	onVadEvent(listener: VadEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	push(event: VadEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

export interface LiveTurnResult {
	turnId: string;
	text: string;
	mode: LiveTranscriptMode;
	asrFinalFromSpeechEndMs: number | null;
}

export interface LiveStreamingAsrSessionOptions {
	sessionId: string;
	roomId?: string | null;
	vad: VadEventSource;
	createTranscriber: (vad: VadEventSource) => StreamingTranscriber;
	emit: (event: VoiceTranscriptEvent) => void;
	/** Clock for latency marks. Default `Date.now`. */
	now?: () => number;
}

type TranscriberWithMode = StreamingTranscriber & { backendMode?: string };

export class LiveStreamingAsrSession {
	readonly sessionId: string;
	readonly roomId: string | null;
	private readonly transcriber: TranscriberWithMode;
	private readonly emit: (event: VoiceTranscriptEvent) => void;
	private readonly now: () => number;
	private readonly unsubs: Array<() => void> = [];

	private turnId: string | null = null;
	private partialSeq = 0;
	private lastPartial = "";
	private pendingFinal: Promise<LiveTurnResult | null> | null = null;
	private disposed = false;
	framesReceived = 0;
	turnsFinalized = 0;

	constructor(opts: LiveStreamingAsrSessionOptions) {
		this.sessionId = opts.sessionId;
		this.roomId = opts.roomId ?? null;
		this.emit = opts.emit;
		this.now = opts.now ?? Date.now;
		// The transcriber subscribes to the VAD first, so on speech-start it
		// opens its gate (and drains pre-roll) before this session reacts, and
		// on speech-end it closes the gate before flush().
		this.transcriber = opts.createTranscriber(opts.vad) as TranscriberWithMode;
		this.unsubs.push(opts.vad.onVadEvent((ev) => this.onVad(ev)));
		this.unsubs.push(
			this.transcriber.on((ev) => {
				if (ev.kind === "partial") this.onPartial(ev.update.partial);
			}),
		);
	}

	get mode(): LiveTranscriptMode {
		const mode = this.transcriber.backendMode;
		return mode === "stream" || mode === "batch" ? mode : "unknown";
	}

	get inTurn(): boolean {
		return this.turnId !== null;
	}

	feed(frame: PcmFrame): void {
		if (this.disposed)
			throw new Error("[live-asr] feed() on a disposed session");
		this.framesReceived += 1;
		this.transcriber.feed(frame);
	}

	/** The final for the most recent speech-end, or null when none is pending. */
	waitForFinal(): Promise<LiveTurnResult | null> {
		return this.pendingFinal ?? Promise.resolve(null);
	}

	/**
	 * Close an open segment as if the VAD reported speech-end (client hang-up
	 * or explicit end). Resolves the final, or null when no turn was open.
	 */
	endTurn(): Promise<LiveTurnResult | null> {
		if (!this.turnId) return this.waitForFinal();
		this.onVad({
			type: "speech-end",
			timestampMs: this.now(),
			speechDurationMs: 0,
		});
		return this.waitForFinal();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsub of this.unsubs.splice(0)) unsub();
		if (this.turnId) {
			closeLiveVoiceTurn(this.turnId, "session-closed");
			this.turnId = null;
		}
		this.transcriber.dispose();
	}

	private onVad(ev: VadEvent): void {
		if (this.disposed) return;
		if (ev.type === "speech-start") {
			if (this.turnId) return; // already in a segment
			const turnId = beginLiveVoiceTurn(this.roomId);
			const at = this.now();
			markLiveVoice(turnId, "vad-trigger", at);
			markLiveVoice(turnId, "vad-speech-start", at);
			this.turnId = turnId;
			this.partialSeq = 0;
			this.lastPartial = "";
			this.emit({
				type: "voice-transcript",
				phase: "speech-start",
				sessionId: this.sessionId,
				turnId,
			});
			return;
		}
		if (ev.type === "speech-end") {
			const turnId = this.turnId;
			if (!turnId) return;
			this.turnId = null;
			markLiveVoice(turnId, "vad-speech-end", this.now());
			this.pendingFinal = this.finishTurn(turnId);
			// The caller may never await it (no HTTP request carried the edge).
			this.pendingFinal.catch(() => {});
		}
	}

	private onPartial(text: string): void {
		const turnId = this.turnId;
		if (!turnId || this.disposed || text === this.lastPartial) return;
		this.lastPartial = text;
		this.partialSeq += 1;
		if (this.partialSeq === 1)
			markLiveVoice(turnId, "asr-first-partial", this.now());
		this.emit({
			type: "voice-transcript",
			phase: "partial",
			sessionId: this.sessionId,
			turnId,
			text,
			seq: this.partialSeq,
		});
	}

	private async finishTurn(turnId: string): Promise<LiveTurnResult | null> {
		let text: string;
		try {
			text = (await this.transcriber.flush()).partial;
		} catch (err) {
			closeLiveVoiceTurn(turnId, "asr-failed");
			logger.warn(
				{
					sessionId: this.sessionId,
					turnId,
					error: err instanceof Error ? err.message : String(err),
				},
				"[live-asr] final transcript failed",
			);
			if (!this.disposed) {
				this.emit({
					type: "voice-transcript",
					phase: "error",
					sessionId: this.sessionId,
					turnId,
					code: "ASR_FAILED",
				});
			}
			throw err;
		}
		markLiveVoice(turnId, "asr-final", this.now());
		const asrFinalFromSpeechEndMs =
			peekLiveVoiceTurn(turnId)?.derived.asrFinalFromSpeechEndMs ?? null;
		this.turnsFinalized += 1;
		const result: LiveTurnResult = {
			turnId,
			text,
			mode: this.mode,
			asrFinalFromSpeechEndMs,
		};
		logger.info(
			{
				sessionId: this.sessionId,
				turnId,
				mode: result.mode,
				chars: text.length,
				partials: this.partialSeq,
				asrFinalFromSpeechEndMs,
			},
			"[live-asr] turn final",
		);
		if (this.disposed) {
			closeLiveVoiceTurn(turnId, "session-closed");
			return result;
		}
		this.emit({
			type: "voice-transcript",
			phase: "final",
			sessionId: this.sessionId,
			turnId,
			text,
			mode: result.mode,
			asrFinalFromSpeechEndMs,
		});
		if (text.trim().length > 0) {
			awaitLlmFirstToken(turnId, this.roomId);
		} else {
			closeLiveVoiceTurn(turnId, "empty-transcript");
		}
		return result;
	}
}
