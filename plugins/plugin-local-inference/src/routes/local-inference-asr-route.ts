import type http from "node:http";
import { type AgentRuntime, ModelType } from "@elizaos/core";
import {
	type CompatRuntimeState,
	ensureRouteAuthorized,
	readCompatJsonBody,
	sendJson,
} from "./compat-helpers";

const MAX_LOCAL_ASR_AUDIO_BYTES = 16 * 1024 * 1024;

const LOCAL_TRANSCRIPTION_PROVIDER_IDS = [
	"eliza-local-inference",
	"capacitor-llama",
	"eliza-device-bridge",
	"eliza-aosp-llama",
] as const;

function isMissingTranscriptionProviderError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/No handler found for delegate type: TRANSCRIPTION/.test(error.message)
	);
}

function normalizeTranscriptResult(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (value && typeof value === "object") {
		const text = (value as { text?: unknown }).text;
		if (typeof text === "string") return text.trim();
	}
	throw new Error("TRANSCRIPTION returned an invalid transcript");
}

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

async function useLocalInferenceAsr(
	runtime: AgentRuntime,
	audio: Uint8Array,
	signal?: AbortSignal,
): Promise<string> {
	let lastError: unknown;
	for (const provider of LOCAL_TRANSCRIPTION_PROVIDER_IDS) {
		try {
			const transcript = normalizeTranscriptResult(
				await runtime.useModel(
					ModelType.TRANSCRIPTION,
					{ audio, ...(signal ? { signal } : {}) },
					provider,
				),
			);
			if (!transcript) {
				throw new Error("TRANSCRIPTION returned an empty transcript");
			}
			return transcript;
		} catch (err) {
			lastError = err;
			if (!isMissingTranscriptionProviderError(err)) throw err;
		}
	}
	if (lastError instanceof Error) throw lastError;
	throw new Error("No local-inference TRANSCRIPTION provider is registered");
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
	if (method !== "POST" || url.pathname !== "/api/asr/local-inference") {
		return false;
	}

	if (!(await ensureRouteAuthorized(req, res, state))) return true;

	const runtime = state.current;
	if (!runtime) {
		sendJson(res, 503, {
			error: "Local inference TRANSCRIPTION is not available",
		});
		return true;
	}

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
		const text = await useLocalInferenceAsr(
			runtime,
			audio,
			abortController.signal,
		);
		completed = true;
		sendJson(res, 200, { text });
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
