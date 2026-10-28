/**
 * `POST /api/asr/local-inference` body limits through the real route and a
 * real runtime. The UI (`transcribeLocalInferenceWav`) always posts
 * `{ audioBase64 }` JSON, and the capture encodes the WAV at the AudioContext
 * rate (usually 48 kHz), so the JSON body must carry the same audio bound as a
 * raw WAV body. The engine has no loaded backend here, so the route
 * transcribes through the registered TRANSCRIPTION handler.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { type AgentRuntime, ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it } from "vitest";
import { encodeMonoPcm16Wav } from "../services/voice/wav-codec";
import { handleLocalInferenceAsrRoute } from "./local-inference-asr-route";

class FakeRes {
	statusCode = 200;
	headersSent = false;
	destroyed = false;
	writableEnded = false;
	body = "";
	setHeader(): void {}
	on(): this {
		return this;
	}
	off(): this {
		return this;
	}
	end(chunk?: string): void {
		if (chunk) this.body += chunk;
		this.headersSent = true;
		this.writableEnded = true;
	}
	json(): Record<string, unknown> {
		return JSON.parse(this.body);
	}
}

function makeReq(body: Buffer, contentType: string): http.IncomingMessage {
	const req = Readable.from([body]) as unknown as http.IncomingMessage &
		Record<string, unknown>;
	req.method = "POST";
	req.url = "/api/asr/local-inference";
	req.headers = { host: "127.0.0.1:31337", "content-type": contentType };
	req.socket = { remoteAddress: "127.0.0.1" } as never;
	return req;
}

function makeRuntime(received: number[]): AgentRuntime {
	const runtime = createSQLiteTestRuntime({
		character: {
			name: "LocalAsrRouteTest",
			bio: "local asr route test",
			settings: {},
		} as never,
		logLevel: "fatal",
	});
	runtime.registerModel(
		ModelType.TRANSCRIPTION,
		async (_runtime: unknown, params: unknown) => {
			received.push((params as { audio: Uint8Array }).audio.byteLength);
			return "turn on the kitchen lights";
		},
		"eliza-local-inference",
		0,
	);
	return runtime;
}

async function post(
	runtime: AgentRuntime,
	body: Buffer,
	contentType: string,
): Promise<FakeRes> {
	const res = new FakeRes();
	const handled = await handleLocalInferenceAsrRoute(
		makeReq(body, contentType),
		res as unknown as http.ServerResponse,
		{ current: runtime, authorizeRequest: async () => true },
	);
	expect(handled).toBe(true);
	return res;
}

function jsonBody(audio: Uint8Array): Buffer {
	return Buffer.from(
		JSON.stringify({ audioBase64: Buffer.from(audio).toString("base64") }),
	);
}

/** A 10 s utterance as the UI capture encodes it at 48 kHz (~960 KB WAV). */
const tenSecondWav = encodeMonoPcm16Wav(new Float32Array(48_000 * 10), 48_000);

describe("POST /api/asr/local-inference body limits", () => {
	it("transcribes a 10 s 48 kHz utterance posted as { audioBase64 } JSON", async () => {
		const received: number[] = [];
		const runtime = makeRuntime(received);
		const body = jsonBody(tenSecondWav);
		expect(body.byteLength).toBeGreaterThan(1_048_576);

		const res = await post(runtime, body, "application/json");

		expect({ status: res.statusCode, body: res.json() }).toMatchObject({
			status: 200,
			body: { text: "turn on the kitchen lights", words: [] },
		});
		expect(received).toEqual([tenSecondWav.byteLength]);
	});

	it("transcribes the same utterance posted as a raw WAV body", async () => {
		const received: number[] = [];
		const runtime = makeRuntime(received);

		const res = await post(runtime, Buffer.from(tenSecondWav), "audio/wav");

		expect(res.statusCode).toBe(200);
		expect(received).toEqual([tenSecondWav.byteLength]);
	});

	it("refuses JSON audio over the 16 MiB raw-body bound", async () => {
		const received: number[] = [];
		const runtime = makeRuntime(received);
		const body = jsonBody(new Uint8Array(16 * 1024 * 1024 + 1));

		const res = await post(runtime, body, "application/json");

		expect({ status: res.statusCode, body: res.json() }).toEqual({
			status: 413,
			body: { error: "Audio body too large" },
		});
		expect(received).toEqual([]);
	});
});
