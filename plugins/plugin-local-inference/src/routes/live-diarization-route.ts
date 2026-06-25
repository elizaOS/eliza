/**
 * `/api/voice/audio-frames` — WebView → agent transport for live on-device
 * speaker diarization.
 *
 * The Android `audioFrame` PCM stream is captured in the Capacitor WebView but
 * the bun:ffi voice libs run in the agent process. The WebView batches frames
 * (~49 fps) and POSTs them here; this route feeds them to the single
 * {@link LiveDiarizationSession}, which runs the real ggml VAD / encoder /
 * diarizer / attribution pipeline and emits VOICE_TURN_OBSERVED.
 *
 * Routes:
 *   POST /api/voice/audio-frames        body: { frames: AudioFrameEvent[],
 *                                               flush?: boolean }
 *                                       → { ok, framesReceived, turnsObserved }
 *   POST /api/voice/playback-frames     body: { frames: PlaybackFrameEvent[],
 *                                               reset?: boolean }
 *                                       → { ok, playbackSamplesObserved }
 *                                       (#9583: the agent's TTS playback PCM,
 *                                        the far-end echo reference the canceller
 *                                        subtracts from the mic)
 *   GET  /api/voice/audio-frames/status → LiveDiarizationStatus (device evidence)
 *
 * Auth follows the compat pattern: trusted-loopback OR the compat API token.
 * The WebView reaches this over 127.0.0.1 (trusted local), matching the rest of
 * the on-device agent surface.
 */

import type http from "node:http";
import {
	AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
	AudioFrameDecodeError,
	type AudioFrameEvent,
	decodePlaybackFramePcm,
	type PlaybackFrameEvent,
} from "../services/voice/audio-frame-consumer.js";
import {
	LiveDiarizationSession,
	type RuntimeEventSink,
} from "../services/voice/live-diarization-session.js";
import {
	type CompatRuntimeState,
	ensureCompatApiAuthorized,
	readCompatJsonBody,
	sendJson,
	sendJsonError,
} from "./compat-helpers.js";

let session: LiveDiarizationSession | null = null;

/** Lazily own one session per agent process, bound to the live runtime. */
function getSession(state: CompatRuntimeState): LiveDiarizationSession | null {
	const runtime = state.current as RuntimeEventSink | null;
	if (!runtime || typeof runtime.emitEvent !== "function") return null;
	if (!session) session = new LiveDiarizationSession(runtime);
	return session;
}

/** Reset the module-level session (tests + capture teardown). */
export async function resetLiveDiarizationSession(): Promise<void> {
	const current = session;
	session = null;
	if (current) await current.close();
}

function isAudioFrameEvent(value: unknown): value is AudioFrameEvent {
	if (!value || typeof value !== "object") return false;
	const f = value as Partial<AudioFrameEvent>;
	return (
		typeof f.pcm16 === "string" &&
		typeof f.sampleRate === "number" &&
		typeof f.channels === "number" &&
		typeof f.samples === "number" &&
		typeof f.rms === "number" &&
		typeof f.timestamp === "number" &&
		typeof f.frameIndex === "number"
	);
}

function isPlaybackFrameEvent(value: unknown): value is PlaybackFrameEvent {
	if (!value || typeof value !== "object") return false;
	const f = value as Partial<PlaybackFrameEvent>;
	return (
		typeof f.pcm16 === "string" &&
		typeof f.sampleRate === "number" &&
		typeof f.atMs === "number"
	);
}

export async function handleLiveDiarizationRoute(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	state: CompatRuntimeState,
): Promise<boolean> {
	const url = new URL(req.url ?? "/", "http://localhost");
	const method = req.method ?? "GET";

	if (url.pathname === "/api/voice/audio-frames/status" && method === "GET") {
		if (!ensureCompatApiAuthorized(req, res)) return true;
		const current = getSession(state);
		if (!current) {
			sendJsonError(res, 503, "Runtime not ready");
			return true;
		}
		sendJson(res, 200, await current.status());
		return true;
	}

	if (url.pathname === "/api/voice/playback-frames" && method === "POST") {
		// #9583: the far-end (agent TTS playback) report. The playback path POSTs
		// the PCM it actually played, time-stamped to the playback clock, so the
		// echo canceller can subtract the agent's own voice from the mic.
		if (!ensureCompatApiAuthorized(req, res)) return true;
		const current = getSession(state);
		if (!current) {
			sendJsonError(res, 503, "Runtime not ready");
			return true;
		}
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		const rawFrames = body.frames;
		if (!Array.isArray(rawFrames)) {
			sendJsonError(res, 400, "Expected { frames: PlaybackFrameEvent[] }");
			return true;
		}
		const frames = rawFrames.filter(isPlaybackFrameEvent);
		if (frames.length !== rawFrames.length) {
			sendJsonError(
				res,
				400,
				`Malformed frame(s): ${rawFrames.length - frames.length} of ${rawFrames.length} did not match PlaybackFrameEvent`,
			);
			return true;
		}
		let observed = 0;
		try {
			for (const frame of frames) {
				const pcm = decodePlaybackFramePcm(frame);
				current.observePlayback(pcm, AUDIO_FRAME_PIPELINE_SAMPLE_RATE, frame.atMs);
				observed += pcm.length;
			}
		} catch (err) {
			if (err instanceof AudioFrameDecodeError) {
				sendJsonError(res, 400, err.message);
				return true;
			}
			throw err;
		}
		if (body.reset === true) current.resetPlayback();
		sendJson(res, 200, { ok: true, playbackSamplesObserved: observed });
		return true;
	}

	if (url.pathname === "/api/voice/audio-frames" && method === "POST") {
		if (!ensureCompatApiAuthorized(req, res)) return true;
		const current = getSession(state);
		if (!current) {
			sendJsonError(res, 503, "Runtime not ready");
			return true;
		}
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		const rawFrames = body.frames;
		if (!Array.isArray(rawFrames)) {
			sendJsonError(res, 400, "Expected { frames: AudioFrameEvent[] }");
			return true;
		}
		const frames = rawFrames.filter(isAudioFrameEvent);
		if (frames.length !== rawFrames.length) {
			sendJsonError(
				res,
				400,
				`Malformed frame(s): ${rawFrames.length - frames.length} of ${rawFrames.length} did not match AudioFrameEvent`,
			);
			return true;
		}
		await current.ingest(frames);
		if (body.flush === true) await current.flush();
		const status = await current.status();
		sendJson(res, 200, {
			ok: true,
			framesReceived: status.framesReceived,
			framesDropped: status.framesDropped,
			turnsObserved: status.turnsObserved,
		});
		return true;
	}

	return false;
}
