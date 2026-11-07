/**
 * Live streaming ASR over HTTP — `POST /api/asr/local-inference/live` plus
 * `GET /api/asr/local-inference/live/status`.
 *
 * The client streams mic PCM in short batches (the same `AudioFrameEvent`
 * wire format as `/api/voice/audio-frames`: base64 LE-s16, 16 kHz mono) and
 * the Silero VAD segment edges for that audio. Each `sessionId` owns one
 * `LiveStreamingAsrSession` over the loader's streaming transcriber
 * (`BionicHostLoader.createStreamingTranscriber({ vad })` on Android: the
 * host's Phonon-2 streaming decoder, batch op="asr" only on
 * STREAM_UNSUPPORTED).
 *
 * Request body:
 *   {
 *     sessionId: string,               // client-chosen, ≤ 128 chars
 *     roomId?: string,                 // conversation room, for event routing
 *     frames?: AudioFrameEvent[],
 *     vad?: Array<{ type: "speech-start" | "speech-end", timestampMs?: number }>,
 *     close?: boolean                  // end the session (finalizes an open turn)
 *   }
 * Within one request the session applies `speech-start` edges, then the
 * frames, then `speech-end` edges, so a request that carries the last audio
 * of an utterance and its `speech-end` finalizes that utterance.
 *
 * Response: `{ ok, sessionId, mode, framesReceived, final? }` where `final`
 * (`{ turnId, text, mode, asrFinalFromSpeechEndMs }`) is present when the
 * request closed a segment. Interim partials are not in the response: they go
 * to WebSocket clients as `voice-transcript` agent events
 * (`services/voice/live-transcript-events.ts`).
 *
 * Sessions: at most 4 (the host's open-stream cap); a session idle for 60 s
 * is disposed. Auth follows the ASR route (`ensureRouteAuthorized`).
 */

import type http from "node:http";
import { logger } from "@elizaos/core";
import {
	AudioFrameDecodeError,
	type AudioFrameEvent,
	decodeAudioFramePcm,
} from "../services/voice/audio-frame-consumer.js";
import {
	LiveStreamingAsrSession,
	PushVadEventSource,
} from "../services/voice/live-streaming-asr-session.js";
import { createVoiceTranscriptEmitter } from "../services/voice/live-transcript-events.js";
import type {
	StreamingTranscriber,
	VadEventSource,
} from "../services/voice/types.js";
import {
	type CompatRuntimeState,
	ensureRouteAuthorized,
	readCompatJsonBody,
	sendJson,
} from "./compat-helpers.js";

export const LIVE_ASR_PATH = "/api/asr/local-inference/live";
export const LIVE_ASR_STATUS_PATH = "/api/asr/local-inference/live/status";
export const LIVE_ASR_MAX_SESSIONS = 4;
export const LIVE_ASR_IDLE_MS = 60_000;
const MAX_SESSION_ID_CHARS = 128;

/** The loader surface the live route needs (`BionicHostLoader` satisfies it). */
interface LiveAsrLoader {
	createStreamingTranscriber(opts: {
		vad?: VadEventSource;
	}): StreamingTranscriber;
	asrStreamSupported?(): Promise<boolean>;
}

interface SessionEntry {
	session: LiveStreamingAsrSession;
	vad: PushVadEventSource;
	disposeEmitter: () => void;
	idleTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, SessionEntry>();

function resolveLoader(state: CompatRuntimeState): LiveAsrLoader | null {
	const svc = (
		state.current as { getService?: (name: string) => unknown } | null
	)?.getService?.("localInferenceLoader");
	return svc &&
		typeof (svc as LiveAsrLoader).createStreamingTranscriber === "function"
		? (svc as LiveAsrLoader)
		: null;
}

function disposeSession(sessionId: string): void {
	const entry = sessions.get(sessionId);
	if (!entry) return;
	sessions.delete(sessionId);
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.session.dispose();
	entry.disposeEmitter();
}

function touch(sessionId: string, entry: SessionEntry): void {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = setTimeout(() => {
		logger.info({ sessionId }, "[live-asr] idle session disposed");
		disposeSession(sessionId);
	}, LIVE_ASR_IDLE_MS);
	(entry.idleTimer as { unref?: () => void }).unref?.();
}

/** Dispose every live session (tests, runtime swap). */
export function resetLiveAsrSessions(): void {
	for (const id of [...sessions.keys()]) disposeSession(id);
}

export function liveAsrSessionCount(): number {
	return sessions.size;
}

function isAudioFrameEvent(value: unknown): value is AudioFrameEvent {
	if (!value || typeof value !== "object") return false;
	const f = value as Partial<AudioFrameEvent>;
	return (
		typeof f.pcm16 === "string" &&
		typeof f.sampleRate === "number" &&
		typeof f.channels === "number" &&
		typeof f.samples === "number" &&
		typeof f.timestamp === "number"
	);
}

type VadEdge = { type: "speech-start" | "speech-end"; timestampMs?: number };

function parseVadEdges(value: unknown): VadEdge[] | string {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return "vad must be an array of VAD edges";
	const out: VadEdge[] = [];
	for (const raw of value) {
		const edge = raw as Partial<VadEdge> | null;
		if (
			!edge ||
			(edge.type !== "speech-start" && edge.type !== "speech-end") ||
			(edge.timestampMs !== undefined && typeof edge.timestampMs !== "number")
		) {
			return 'vad entries must be { type: "speech-start" | "speech-end", timestampMs?: number }';
		}
		out.push({ type: edge.type, timestampMs: edge.timestampMs });
	}
	return out;
}

export async function handleLiveAsrRoute(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	state: CompatRuntimeState,
): Promise<boolean> {
	const method = req.method?.toUpperCase() ?? "GET";
	const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

	if (method === "GET" && pathname === LIVE_ASR_STATUS_PATH) {
		if (!(await ensureRouteAuthorized(req, res, state))) return true;
		const loader = resolveLoader(state);
		let streaming: boolean | null = null;
		if (loader?.asrStreamSupported) {
			try {
				streaming = await loader.asrStreamSupported();
			} catch {
				streaming = null;
			}
		}
		sendJson(res, 200, {
			ready: loader !== null,
			streaming,
			sessions: sessions.size,
			maxSessions: LIVE_ASR_MAX_SESSIONS,
		});
		return true;
	}

	if (method !== "POST" || pathname !== LIVE_ASR_PATH) return false;
	if (!(await ensureRouteAuthorized(req, res, state))) return true;

	const runtime = state.current;
	const loader = resolveLoader(state);
	if (!runtime || !loader) {
		sendJson(res, 503, {
			error: "Live ASR needs the local-inference streaming loader",
			code: "LIVE_ASR_UNAVAILABLE",
		});
		return true;
	}

	const body = await readCompatJsonBody(req, res);
	if (!body) return true;
	const sessionId =
		typeof body.sessionId === "string" ? body.sessionId.trim() : "";
	if (!sessionId || sessionId.length > MAX_SESSION_ID_CHARS) {
		sendJson(res, 400, {
			error: "sessionId must be a non-empty string ≤ 128 chars",
		});
		return true;
	}
	const rawFrames = body.frames ?? [];
	if (!Array.isArray(rawFrames) || !rawFrames.every(isAudioFrameEvent)) {
		sendJson(res, 400, { error: "frames must be AudioFrameEvent[]" });
		return true;
	}
	const edges = parseVadEdges(body.vad);
	if (typeof edges === "string") {
		sendJson(res, 400, { error: edges });
		return true;
	}
	let pcmFrames: Array<{ pcm: Float32Array; timestamp: number }>;
	try {
		pcmFrames = rawFrames.map((f) => ({
			pcm: decodeAudioFramePcm(f),
			timestamp: f.timestamp,
		}));
	} catch (err) {
		if (err instanceof AudioFrameDecodeError) {
			sendJson(res, 400, { error: err.message });
			return true;
		}
		throw err;
	}

	let entry = sessions.get(sessionId);
	if (!entry) {
		if (body.close === true) {
			sendJson(res, 200, { ok: true, sessionId, closed: true });
			return true;
		}
		if (sessions.size >= LIVE_ASR_MAX_SESSIONS) {
			sendJson(res, 429, {
				error: `At most ${LIVE_ASR_MAX_SESSIONS} live ASR sessions`,
				code: "LIVE_ASR_SESSIONS_FULL",
			});
			return true;
		}
		const roomId =
			typeof body.roomId === "string" && body.roomId.trim()
				? body.roomId.trim()
				: null;
		const vad = new PushVadEventSource();
		const emitter = createVoiceTranscriptEmitter(runtime, {
			sessionId,
			roomId,
		});
		let session: LiveStreamingAsrSession;
		try {
			session = new LiveStreamingAsrSession({
				sessionId,
				roomId,
				vad,
				createTranscriber: (source) =>
					loader.createStreamingTranscriber({ vad: source }),
				emit: emitter.emit,
			});
		} catch (err) {
			emitter.dispose();
			sendJson(res, 503, {
				error: `Live ASR unavailable: ${err instanceof Error ? err.message : String(err)}`,
				code: "LIVE_ASR_UNAVAILABLE",
			});
			return true;
		}
		entry = { session, vad, disposeEmitter: emitter.dispose, idleTimer: null };
		sessions.set(sessionId, entry);
	}
	touch(sessionId, entry);

	const { session, vad } = entry;
	const now = Date.now();
	for (const edge of edges) {
		if (edge.type === "speech-start") {
			vad.push({
				type: "speech-start",
				timestampMs: edge.timestampMs ?? now,
				probability: 1,
			});
		}
	}
	for (const frame of pcmFrames) {
		session.feed({
			pcm: frame.pcm,
			sampleRate: 16_000,
			timestampMs: frame.timestamp,
		});
	}
	let closesTurn = false;
	for (const edge of edges) {
		if (edge.type === "speech-end" && session.inTurn) {
			closesTurn = true;
			vad.push({
				type: "speech-end",
				timestampMs: edge.timestampMs ?? now,
				speechDurationMs: 0,
			});
		}
	}
	const closing = body.close === true;
	try {
		const final = closing
			? await session.endTurn()
			: closesTurn
				? await session.waitForFinal()
				: null;
		sendJson(res, 200, {
			ok: true,
			sessionId,
			mode: session.mode,
			framesReceived: session.framesReceived,
			...(final ? { final } : {}),
			...(closing ? { closed: true } : {}),
		});
	} catch (err) {
		sendJson(res, 502, {
			error: `Live ASR error: ${err instanceof Error ? err.message : String(err)}`,
			code: "ASR_FAILED",
		});
	} finally {
		if (closing) disposeSession(sessionId);
	}
	return true;
}
