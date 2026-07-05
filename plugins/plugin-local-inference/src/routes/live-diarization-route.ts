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
 *   POST /api/voice/playback-frames     body: { frames?: AudioFrameEvent[],
 *                                               reset?: boolean }
 *                                       → { ok, framesPushed }
 *     The agent's own TTS playback (far-end) in the same base64 LE-s16 16 kHz
 *     mono wire format, streamed in real time so the session's NLMS canceller
 *     removes the agent's echo before VAD/attribution (#9455/#9583). Send
 *     `reset: true` when playback stops / on barge-in.
 *   GET  /api/voice/audio-frames/status → LiveDiarizationStatus (device evidence)
 *   POST /api/voice/aec-capture         body: { arm?: boolean, disarm?: boolean,
 *                                               maxSeconds?: number }
 *                                       → { ok, capture: AecCaptureStatus }
 *   GET  /api/voice/aec-capture         → { ok, capture: AecCaptureSnapshot }
 *     Bounded on-device AEC evidence window (#11373): while armed, the session
 *     buffers every ingested mic frame (near) plus the delay-0 far-end
 *     reference at its timestamp, so real device ERLE / double-talk
 *     measurements can replay the exact production canceller offline.
 *
 * Auth follows the compat pattern: trusted-loopback OR the compat API token.
 * The WebView reaches this over 127.0.0.1 (trusted local), matching the rest of
 * the on-device agent surface.
 */

import { writeFileSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { readAliasedEnv } from "@elizaos/shared";
import type {
	AudioFrameEvent,
	EchoReferenceProvider,
} from "../services/voice/audio-frame-consumer.js";
import { replayAecCaptureErle } from "../services/voice/echo-metrics.js";
import { getSharedFarEndReference } from "../services/voice/far-end-reference.js";
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

/**
 * Best-effort mirror of the agent-side AEC evidence (near/far PCM + live
 * counters) to `$ELIZA_STATE_DIR/eliza-aec-capture.json` (#11373). This is the
 * bridge-free retrieval path for on-device runs where the WebView's Capacitor
 * Filesystem sink cannot land the harness result — the bun agent owns the
 * capture, so it writes it straight to disk where host tooling pulls it. Inert
 * with no state dir set (dev/desktop) and never throws.
 */
async function persistAecEvidence(
	capture: { sampleCount?: number } | null | undefined,
	status: unknown,
): Promise<void> {
	const stateDir = readAliasedEnv("ELIZA_STATE_DIR");
	// Only mirror a capture that actually holds samples — an incidental GET with
	// nothing captured must not clobber a real prior capture or write noise.
	if (!stateDir || !capture || (capture.sampleCount ?? 0) <= 0) return;
	try {
		writeFileSync(
			path.join(stateDir, "eliza-aec-capture.json"),
			JSON.stringify({ capture, status, writtenAt: new Date().toISOString() }),
		);
	} catch {
		// Retrieval mirror is best-effort; the HTTP response already carries the
		// capture for callers that can read it.
	}
}

type RuntimeEchoReferenceSource = RuntimeEventSink & {
	/**
	 * Optional live far-end playback provider. Hosts that can tap agent TTS PCM
	 * expose this so the diarization consumer can run AEC before VAD.
	 */
	voiceEchoReferenceProvider?: EchoReferenceProvider | null;
	getVoiceEchoReferenceProvider?: () =>
		| EchoReferenceProvider
		| null
		| undefined;
};

function resolveRuntimeEchoReference(
	runtime: RuntimeEventSink,
): EchoReferenceProvider | null {
	const source = runtime as RuntimeEchoReferenceSource;
	if (typeof source.getVoiceEchoReferenceProvider === "function") {
		return source.getVoiceEchoReferenceProvider() ?? null;
	}
	return source.voiceEchoReferenceProvider ?? null;
}

/** Lazily own one session per agent process, bound to the live runtime. */
function getSession(state: CompatRuntimeState): LiveDiarizationSession | null {
	const runtime = state.current as RuntimeEventSink | null;
	if (!runtime || typeof runtime.emitEvent !== "function") return null;
	if (!session) {
		// Thread a host-supplied echo reference (if any) into the live AEC path
		// so the NLMS canceller has a far-end signal without the playback-frames
		// ingest route (#9583).
		const echoReference = resolveRuntimeEchoReference(runtime);
		session = new LiveDiarizationSession(
			runtime,
			echoReference ? { echoReference } : {},
		);
	}
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

	if (url.pathname === "/api/voice/aec-capture" && method === "POST") {
		if (!ensureCompatApiAuthorized(req, res)) return true;
		const current = getSession(state);
		if (!current) {
			sendJsonError(res, 503, "Runtime not ready");
			return true;
		}
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		if (body.arm !== true && body.disarm !== true) {
			sendJsonError(
				res,
				400,
				"Expected { arm?: true, disarm?: true, maxSeconds?: number }",
			);
			return true;
		}
		const capture =
			body.disarm === true
				? current.disarmAecCapture()
				: current.armAecCapture(
						typeof body.maxSeconds === "number" ? body.maxSeconds : undefined,
					);
		sendJson(res, 200, { ok: true, capture });
		return true;
	}

	if (url.pathname === "/api/voice/aec-capture" && method === "GET") {
		if (!ensureCompatApiAuthorized(req, res)) return true;
		const current = getSession(state);
		if (!current) {
			sendJsonError(res, 503, "Runtime not ready");
			return true;
		}
		const capture = current.aecCaptureSnapshot();
		// Persist the snapshot to the agent state dir via Node fs (#11373). On
		// physical iOS the WebView's Capacitor Filesystem sink is the harness's
		// only off-device channel and it is unreliable for multi-MB payloads;
		// the bun agent can write the near/far PCM + counters straight to
		// $ELIZA_STATE_DIR, which host tooling pulls with
		// `devicectl device copy from` — the robust, bridge-free retrieval path.
		await persistAecEvidence(capture, await current.status());
		// On-demand ERLE (#12256): replay the captured near/far window through
		// the production canceller so the capture read carries the measured
		// number, not just raw PCM. Null when nothing was captured.
		const erle = capture.sampleCount > 0 ? replayAecCaptureErle(capture) : null;
		sendJson(res, 200, { ok: true, capture, erle });
		return true;
	}

	if (url.pathname === "/api/voice/playback-frames" && method === "POST") {
		if (!ensureCompatApiAuthorized(req, res)) return true;
		const current = getSession(state);
		if (!current) {
			sendJsonError(res, 503, "Runtime not ready");
			return true;
		}
		const body = await readCompatJsonBody(req, res);
		if (!body) return true;
		if (body.reset === true) {
			current.resetPlayback();
			getSharedFarEndReference().notePlaybackReset();
		}
		const rawFrames = body.frames;
		if (rawFrames !== undefined && !Array.isArray(rawFrames)) {
			sendJsonError(
				res,
				400,
				"Expected { frames?: AudioFrameEvent[], reset?: boolean }",
			);
			return true;
		}
		const frames = Array.isArray(rawFrames)
			? rawFrames.filter(isAudioFrameEvent)
			: [];
		if (Array.isArray(rawFrames) && frames.length !== rawFrames.length) {
			sendJsonError(
				res,
				400,
				`Malformed playback frame(s): ${rawFrames.length - frames.length} of ${rawFrames.length} did not match AudioFrameEvent`,
			);
			return true;
		}
		current.pushPlayback(frames);
		// One ingest, two consumers (#12256): the same rendered-playback frames
		// feed Pipeline A's per-frame canceller (above) and the desktop
		// utterance-level far-end reference used by /api/asr/local-inference.
		getSharedFarEndReference().pushPlayback(frames);
		sendJson(res, 200, { ok: true, framesPushed: frames.length });
		return true;
	}

	return false;
}
