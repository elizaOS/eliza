/**
 * End-of-turn latency for live voice turns, on the shared
 * `voiceLatencyTracer` (`latency-trace.ts`).
 *
 * A live session opens one tracer turn per VAD segment and marks
 * `vad-trigger` / `vad-speech-start`, `asr-first-partial`, `vad-speech-end`
 * (the last audio frame of the utterance has arrived and the segment
 * closed) and `asr-final`. The turn then waits for the first streamed LLM
 * token of the reply: the local text handler calls `noteLlmFirstToken()` on
 * its first chunk, which marks `llm-first-token` and closes the turn. A turn
 * that sees no token within `AWAIT_FIRST_TOKEN_MS` closes with that
 * checkpoint missing (never estimated).
 *
 * Derived spans: `asrFinalFromSpeechEndMs` (last audio frame → final
 * transcript) and `ttftFromSpeechEndMs` (last audio frame → first LLM
 * token). One info log line per closed turn carries the numbers, never text.
 */

import { logger } from "@elizaos/core";
import {
	type EndToEndLatencyTracer,
	type LatencyTrace,
	type VoiceCheckpoint,
	voiceLatencyTracer,
} from "../latency-trace";

export const AWAIT_FIRST_TOKEN_MS = 60_000;

interface AwaitingTurn {
	roomId: string | null;
	timer: ReturnType<typeof setTimeout>;
}

let tracer: EndToEndLatencyTracer = voiceLatencyTracer;
const awaiting = new Map<string, AwaitingTurn>();

/** Test seam: route marks to another tracer. Returns the previous one. */
export function setLiveVoiceLatencyTracer(
	next: EndToEndLatencyTracer,
): EndToEndLatencyTracer {
	const prev = tracer;
	tracer = next;
	return prev;
}

/** Test seam: forget turns waiting for a first token. */
export function resetLiveVoiceLatency(): void {
	for (const turn of awaiting.values()) clearTimeout(turn.timer);
	awaiting.clear();
}

export function beginLiveVoiceTurn(roomId: string | null): string {
	return tracer.beginTurn({ roomId });
}

export function markLiveVoice(
	turnId: string,
	checkpoint: VoiceCheckpoint,
	atEpochMs?: number,
): void {
	try {
		tracer.mark(turnId, checkpoint, atEpochMs);
	} catch (err) {
		// Instrumentation never throws into the voice loop.
		logger.warn(
			`[voice-latency] mark ${checkpoint} failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Peek a turn's derived numbers without closing it. */
export function peekLiveVoiceTurn(turnId: string): LatencyTrace | null {
	return tracer.peekTurn(turnId);
}

function logTrace(trace: LatencyTrace | null, outcome: string): void {
	if (!trace) return;
	const d = trace.derived;
	logger.info(
		{
			turnId: trace.turnId,
			outcome,
			asrFinalFromSpeechEndMs: d.asrFinalFromSpeechEndMs,
			ttftFromSpeechEndMs: d.ttftFromSpeechEndMs,
			asrFirstPartialMs: d.asrFirstPartialMs,
			llmFirstTokenAfterAsrMs: d.llmFirstTokenAfterAsrMs,
		},
		"[voice-latency] live voice turn closed",
	);
}

/** Close a turn now (failure, cancel, session end). */
export function closeLiveVoiceTurn(
	turnId: string,
	outcome = "closed",
): LatencyTrace | null {
	const pending = awaiting.get(turnId);
	if (pending) {
		clearTimeout(pending.timer);
		awaiting.delete(turnId);
	}
	const trace = tracer.endTurn(turnId);
	logTrace(trace, outcome);
	return trace;
}

/** After `asr-final`: keep the turn open until the reply's first LLM token. */
export function awaitLlmFirstToken(
	turnId: string,
	roomId: string | null,
): void {
	const prev = awaiting.get(turnId);
	if (prev) clearTimeout(prev.timer);
	const timer = setTimeout(() => {
		awaiting.delete(turnId);
		logTrace(tracer.endTurn(turnId), "no-llm-token");
	}, AWAIT_FIRST_TOKEN_MS);
	(timer as { unref?: () => void }).unref?.();
	awaiting.set(turnId, { roomId, timer });
}

/** True while some live voice turn waits for its first LLM token. */
export function hasLiveVoiceTurnAwaitingToken(): boolean {
	return awaiting.size > 0;
}

/**
 * The text handler saw the first streamed token of a generation. Attributes
 * it to the newest waiting turn in `roomId`, or, when no turn waits in that
 * room, to the newest waiting turn opened without a room. Returns the turn id
 * it closed, or null when no turn was waiting.
 */
export function noteLlmFirstToken(
	roomId?: string | null,
	atEpochMs: number = Date.now(),
): string | null {
	if (awaiting.size === 0) return null;
	let match: string | null = null;
	let roomless: string | null = null;
	for (const [turnId, turn] of awaiting) {
		if (roomId && turn.roomId === roomId) match = turnId;
		if (turn.roomId === null) roomless = turnId;
	}
	const turnId = match ?? roomless;
	if (!turnId) return null;
	markLiveVoice(turnId, "llm-first-token", atEpochMs);
	closeLiveVoiceTurn(turnId, "llm-first-token");
	return turnId;
}
