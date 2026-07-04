/**
 * HTTP route for on-device speech-to-text — `POST /api/asr/local-inference`
 * plus its `…/status` readiness probe.
 *
 * Accepts raw audio bytes or a base64 `audioBase64` JSON body and transcribes
 * through the registered TRANSCRIPTION model handler via `transcribeWavWithWords`
 * (fused Gemma ASR runtime). Status reports ready only when both a TRANSCRIPTION
 * handler is registered and the active Eliza-1 bundle can transcribe locally.
 * Request/response `close` events abort the in-flight decode so a disconnecting
 * client frees the model promptly.
 */

import type http from "node:http";
import { logger, ModelType } from "@elizaos/core";
import { localInferenceEngine } from "../services/engine";
import {
	cancelEchoInWavUtterance,
	getSharedFarEndReference,
} from "../services/voice/far-end-reference";
import {
	type CompatRuntimeState,
	ensureRouteAuthorized,
	readCompatJsonBody,
	sendJson,
} from "./compat-helpers";
import { transcribeWavWithWords } from "./local-inference-asr-transcribe";

const MAX_LOCAL_ASR_AUDIO_BYTES = 16 * 1024 * 1024;

function toUint8Array(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function coercePreParsedAudio(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return toUint8Array(value);
	if (value instanceof ArrayBuffer) return toUint8Array(value);
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	return null;
}

async function readRawAudioBody(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<Uint8Array | null> {
	const preParsed = coercePreParsedAudio((req as { body?: unknown }).body);
	if (preParsed) return preParsed;

	const chunks: Buffer[] = [];
	let totalBytes = 0;
	try {
		for await (const chunk of req) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			totalBytes += buf.byteLength;
			if (totalBytes > MAX_LOCAL_ASR_AUDIO_BYTES) {
				req.destroy();
				sendJson(res, 413, { error: "Audio body too large" });
				return null;
			}
			chunks.push(buf);
		}
	} catch {
		sendJson(res, 400, { error: "Invalid audio body" });
		return null;
	}

	return new Uint8Array(Buffer.concat(chunks));
}

function firstHeaderValue(value: string | string[] | undefined): string {
	return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function readLocalInferenceAsrAudio(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<Uint8Array | null> {
	const contentType = firstHeaderValue(req.headers["content-type"])
		.toLowerCase()
		.split(";", 1)[0]
		.trim();

	if (contentType === "application/json") {
		const body = await readCompatJsonBody(req, res);
		if (!body) return null;
		if (typeof body.audioBase64 === "string") {
			return new Uint8Array(Buffer.from(body.audioBase64, "base64"));
		}
		sendJson(res, 400, { error: "Missing audioBase64" });
		return null;
	}

	return readRawAudioBody(req, res);
}

function isClosed(res: http.ServerResponse): boolean {
	return res.destroyed || res.writableEnded;
}

export async function handleLocalInferenceAsrRoute(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	state: CompatRuntimeState,
): Promise<boolean> {
	const method = req.method?.toUpperCase() ?? "GET";
	const url = new URL(req.url ?? "/", "http://localhost");
	if (method === "GET" && url.pathname === "/api/asr/local-inference/status") {
		if (!(await ensureRouteAuthorized(req, res, state))) return true;
		// Transcription runs through the registered TRANSCRIPTION model handler,
		// backed by the fused Gemma ASR runtime. A handler alone is not enough:
		// the active or assigned Eliza-1 bundle must stage an eligible ASR model.
		const getModel = state.current?.getModel;
		const runtimeAsr =
			typeof getModel === "function" &&
			Boolean(getModel.call(state.current, ModelType.TRANSCRIPTION));
		const ready =
			runtimeAsr && (await localInferenceEngine.canTranscribeLocally());
		sendJson(res, 200, {
			ready,
			provider: ready ? "local-inference" : null,
		});
		return true;
	}

	if (method !== "POST" || url.pathname !== "/api/asr/local-inference") {
		return false;
	}

	if (!(await ensureRouteAuthorized(req, res, state))) return true;

	const audio = await readLocalInferenceAsrAudio(req, res);
	if (!audio) return true;
	if (audio.byteLength === 0) {
		sendJson(res, 400, { error: "Missing audio" });
		return true;
	}

	const abortController = new AbortController();
	let completed = false;
	let clientClosed = false;
	const abortOnClose = () => {
		clientClosed = true;
		if (!completed && !abortController.signal.aborted) {
			abortController.abort();
		}
	};
	req.on("close", abortOnClose);
	res.on("close", abortOnClose);

	try {
		const runtime = state.current;
		if (!runtime) {
			completed = true;
			sendJson(res, 503, {
				error: "Local inference TRANSCRIPTION is not available",
			});
			return true;
		}
		// Desktop speak-back AEC (#12256 layer 2): cancel the agent's own TTS
		// playback (streamed to /api/voice/playback-frames by the renderer) out
		// of the utterance before transcription, so the agent stops transcribing
		// its echo. Passthrough is bit-exact whenever no correlated far-end
		// reference exists — cancellation is never applied speculatively.
		const aec = cancelEchoInWavUtterance(getSharedFarEndReference(), audio);
		if (aec.result?.applied) {
			logger.info(
				{
					erleDb: aec.result.erleDb,
					offsetSamples: aec.result.offsetSamples,
					confidence: aec.result.confidence,
					farActiveSamples: aec.result.farActiveSamples,
				},
				"[LocalInferenceAsrRoute] echo-cancelled utterance before ASR",
			);
		}
		const { text, words } = await transcribeWavWithWords(
			runtime,
			aec.bytes,
			abortController.signal,
		);
		completed = true;
		sendJson(res, 200, {
			text,
			words,
			...(aec.result
				? {
						aec: {
							applied: aec.result.applied,
							...(aec.result.reason ? { reason: aec.result.reason } : {}),
							erleDb: aec.result.erleDb,
							confidence: aec.result.confidence,
						},
					}
				: {}),
		});
	} catch (err) {
		if (!clientClosed && !abortController.signal.aborted && !isClosed(res)) {
			sendJson(res, 502, {
				error: `Local inference ASR error: ${
					err instanceof Error ? err.message : String(err)
				}`,
			});
		}
	} finally {
		completed = true;
		req.off("close", abortOnClose);
		res.off("close", abortOnClose);
	}

	return true;
}
