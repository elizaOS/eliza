import type http from "node:http";
import { type AgentRuntime, ModelType } from "@elizaos/core";
import { KokoroInputTooLongError } from "../services/voice/kokoro/types";
import {
	type CompatRuntimeState,
	ensureRouteAuthorized,
	readCompatJsonBody,
	sendJson,
} from "./compat-helpers";

const LOCAL_TTS_PROVIDER_IDS = [
	"eliza-local-inference",
	"capacitor-llama",
	"eliza-device-bridge",
	"eliza-aosp-llama",
] as const;

export function sanitizeLocalInferenceSpeechText(input: string): string {
	let text = input.normalize("NFKC");
	text = text.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, " ");
	text = text.replace(
		/<(analysis|reasoning|tool_calls?|tools?)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi,
		" ",
	);
	text = text.replace(/```[\s\S]*?```/g, " ");
	text = text.replace(/`([^`]+)`/g, "$1");
	text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
	text = text.replace(/<[^>\n]+>/g, " ");
	text = text.replace(/\bhttps?:\/\/\S+/gi, " ");
	return text.replace(/\s+/g, " ").trim();
}

export function normalizeAudioBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	throw new Error("TEXT_TO_SPEECH returned a non-binary payload");
}

export function sniffAudioContentType(bytes: Uint8Array): string {
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x41 &&
		bytes[10] === 0x56 &&
		bytes[11] === 0x45
	) {
		return "audio/wav";
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0x49 &&
		bytes[1] === 0x44 &&
		bytes[2] === 0x33
	) {
		return "audio/mpeg";
	}
	if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
		return "audio/mpeg";
	}
	return "application/octet-stream";
}

function isMissingTtsProviderError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/No handler found for delegate type: TEXT_TO_SPEECH/.test(error.message)
	);
}

async function useLocalInferenceTts(
	runtime: AgentRuntime,
	text: string,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	let lastError: unknown;
	for (const provider of LOCAL_TTS_PROVIDER_IDS) {
		try {
			return normalizeAudioBytes(
				await runtime.useModel(
					ModelType.TEXT_TO_SPEECH,
					{ text, ...(signal ? { signal } : {}) },
					provider,
				),
			);
		} catch (err) {
			lastError = err;
			if (!isMissingTtsProviderError(err)) throw err;
		}
	}
	if (lastError instanceof Error) throw lastError;
	throw new Error("No local-inference TEXT_TO_SPEECH provider is registered");
}

function isClosed(res: http.ServerResponse): boolean {
	return res.destroyed || res.writableEnded;
}

export async function handleLocalInferenceTtsRoute(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	state: CompatRuntimeState,
): Promise<boolean> {
	const method = req.method?.toUpperCase() ?? "GET";
	const url = new URL(req.url ?? "/", "http://localhost");
	if (method !== "POST" || url.pathname !== "/api/tts/local-inference") {
		return false;
	}

	if (!(await ensureRouteAuthorized(req, res, state))) return true;

	const body = await readCompatJsonBody(req, res);
	if (!body || typeof body !== "object") return true;

	const rawText = body.text;
	const text =
		typeof rawText === "string"
			? sanitizeLocalInferenceSpeechText(rawText)
			: "";
	if (!text) {
		sendJson(res, 400, { error: "Missing text" });
		return true;
	}

	const runtime = state.current;
	if (!runtime) {
		sendJson(res, 503, {
			error: "Local inference TEXT_TO_SPEECH is not available",
		});
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
		const bytes = await useLocalInferenceTts(
			runtime,
			text,
			abortController.signal,
		);
		if (bytes.length === 0) {
			sendJson(res, 502, {
				error: "Local inference TEXT_TO_SPEECH returned empty audio",
			});
			return true;
		}
		completed = true;
		res.writeHead(200, {
			"Content-Type": sniffAudioContentType(bytes),
			"Cache-Control": "no-store",
			"Content-Length": String(bytes.byteLength),
		});
		res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
	} catch (err) {
		if (!clientClosed && !abortController.signal.aborted && !isClosed(res)) {
			sendJson(res, err instanceof KokoroInputTooLongError ? 413 : 502, {
				error: `Local inference TTS error: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	} finally {
		completed = true;
		req.off("close", abortOnClose);
		res.off("close", abortOnClose);
	}
	return true;
}
