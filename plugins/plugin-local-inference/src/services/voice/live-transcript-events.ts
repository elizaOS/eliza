/**
 * `voice-transcript` agent events: live ASR text for clients.
 *
 * A live voice session (`LiveStreamingAsrSession`) emits these on the
 * AgentEventService bus. The API server forwards the stream to every
 * connected WebSocket client as an `agent_event` envelope, the same
 * server→client path the `voice-control` stream uses. The stream is
 * ephemeral: the server broadcasts it without adding it to the replay
 * buffer, nothing here writes it to memory or disk, and logs carry turn ids,
 * phases and lengths, never transcript text.
 *
 * Envelope a client receives (one JSON WebSocket frame):
 *
 *   {
 *     type: "agent_event", version: 1, ephemeral: true,
 *     eventId: "eph-<n>",          // not a replay cursor
 *     stream: "voice-transcript",
 *     ts, runId, seq, agentId?, roomId?,
 *     payload: VoiceTranscriptEvent
 *   }
 *
 * `payload` (see `VoiceTranscriptEvent`):
 *   - `speech-start`  the VAD opened a segment; clear any interim text.
 *   - `partial`       the full running transcript (not a delta) for the turn;
 *                     replace the interim text. `seq` increases per turn.
 *   - `final`         the final transcript for the turn; replace the interim
 *                     text and commit it (the client sends it as the user
 *                     message, as with batch ASR).
 *   - `error`         the turn produced no transcript; `code` says why.
 *
 * Every payload carries `sessionId` (the client's live session) and `turnId`
 * (one VAD segment) so a client can drop events from a stale turn.
 */

import { logger, ServiceType } from "@elizaos/core";

/** Bus stream name. Kept in sync with `EPHEMERAL_AGENT_EVENT_STREAMS` in `@elizaos/agent`. */
export const VOICE_TRANSCRIPT_STREAM = "voice-transcript";

/** How the turn's text was produced: the host's streaming decoder, or batch op="asr" (STREAM_UNSUPPORTED). */
export type LiveTranscriptMode = "stream" | "batch" | "unknown";

interface VoiceTranscriptEventBase {
	type: "voice-transcript";
	sessionId: string;
	turnId: string;
}

export type VoiceTranscriptEvent =
	| (VoiceTranscriptEventBase & { phase: "speech-start" })
	| (VoiceTranscriptEventBase & {
			phase: "partial";
			/** Full running transcript for this turn. */
			text: string;
			/** 1-based, increasing within a turn. */
			seq: number;
	  })
	| (VoiceTranscriptEventBase & {
			phase: "final";
			text: string;
			mode: LiveTranscriptMode;
			/** Last audio frame → final transcript, ms. */
			asrFinalFromSpeechEndMs: number | null;
	  })
	| (VoiceTranscriptEventBase & {
			phase: "error";
			code: "ASR_FAILED";
	  });

/** The slice of AgentEventService this module uses. */
interface AgentEventBus {
	emit(event: {
		runId: string;
		stream: string;
		data: Record<string, unknown>;
		agentId?: string;
		roomId?: string;
	}): void;
	clearRunContext?(runId: string): void;
}

export interface VoiceTranscriptRuntime {
	agentId?: string;
	getService(name: string): unknown;
}

function resolveBus(runtime: VoiceTranscriptRuntime): AgentEventBus | null {
	const svc = runtime.getService(ServiceType.AGENT_EVENT);
	return svc && typeof (svc as AgentEventBus).emit === "function"
		? (svc as AgentEventBus)
		: null;
}

/** The run id a session's events share (one `seq` counter per session). */
export function voiceTranscriptRunId(sessionId: string): string {
	return `voice-transcript:${sessionId}`;
}

/**
 * Build the emitter a session uses. Delivery is best-effort: with no event
 * bus the events are dropped (the final transcript still returns over HTTP).
 */
export function createVoiceTranscriptEmitter(
	runtime: VoiceTranscriptRuntime,
	opts: { sessionId: string; roomId?: string | null },
): {
	emit: (event: VoiceTranscriptEvent) => void;
	dispose: () => void;
} {
	const runId = voiceTranscriptRunId(opts.sessionId);
	return {
		emit(event) {
			const bus = resolveBus(runtime);
			if (!bus) return;
			try {
				bus.emit({
					runId,
					stream: VOICE_TRANSCRIPT_STREAM,
					data: { ...event },
					...(runtime.agentId ? { agentId: runtime.agentId } : {}),
					...(opts.roomId ? { roomId: opts.roomId } : {}),
				});
			} catch (err) {
				// error-policy:J6 event delivery is observational; the transcript
				// still reaches the client in the HTTP response.
				logger.warn(
					{
						phase: event.phase,
						turnId: event.turnId,
						error: err instanceof Error ? err.message : String(err),
					},
					"[live-asr] voice-transcript event not delivered",
				);
			}
		},
		dispose() {
			resolveBus(runtime)?.clearRunContext?.(runId);
		},
	};
}
