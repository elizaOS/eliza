/**
 * HTTP-contract tests for the ASR route: auth, audio-body decoding, and the
 * status probe. `transcribeWavWithWords` and the engine are stubbed — no real
 * model runs.
 */

import * as http from "node:http";
import { Socket } from "node:net";
import { ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-helpers";
import { handleLocalInferenceAsrRoute } from "./local-inference-asr-route";
import { transcribeWavWithWords } from "./local-inference-asr-transcribe";

const engineMock = vi.hoisted(() => ({
	canTranscribeLocally: vi.fn(async () => true),
}));

vi.mock("../services/engine", () => ({
	localInferenceEngine: engineMock,
}));

vi.mock("./local-inference-asr-transcribe", () => ({
	transcribeWavWithWords: vi.fn(),
}));

const transcribeWavWithWordsMock = vi.mocked(transcribeWavWithWords);

beforeEach(() => {
	vi.clearAllMocks();
	engineMock.canTranscribeLocally.mockResolvedValue(true);
});

function wavBytes(): Uint8Array {
	const pcm = new Int16Array([0, 900, -900, 0]);
	const buffer = new ArrayBuffer(44 + pcm.length * 2);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index += 1) {
			view.setUint8(offset + index, value.charCodeAt(index));
		}
	};
	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + pcm.length * 2, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 16_000, true);
	view.setUint32(28, 16_000 * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(36, "data");
	view.setUint32(40, pcm.length * 2, true);
	for (let index = 0; index < pcm.length; index += 1) {
		view.setInt16(44 + index * 2, pcm[index] ?? 0, true);
	}
	return new Uint8Array(buffer);
}

function fakeReq(
	body?: unknown,
	opts?: { method?: string; url?: string },
): http.IncomingMessage {
	const req = new http.IncomingMessage(new Socket());
	req.method = opts?.method ?? "POST";
	req.url = opts?.url ?? "/api/asr/local-inference";
	req.headers = {
		host: "localhost:2138",
		"content-type": "audio/wav",
	};
	Object.defineProperty(req.socket, "remoteAddress", {
		value: "127.0.0.1",
		configurable: true,
	});
	if (body !== undefined) {
		(req as { body?: unknown }).body = body;
	}
	return req;
}

function fakeRes(): {
	res: http.ServerResponse;
	bodyJson: () => Record<string, unknown>;
	status: () => number;
} {
	const req = new http.IncomingMessage(new Socket());
	const res = new http.ServerResponse(req);
	let body = Buffer.alloc(0);
	let status = 200;
	res.setHeader = (() => res) as typeof res.setHeader;
	res.writeHead = ((code: number) => {
		status = code;
		res.statusCode = code;
		return res;
	}) as typeof res.writeHead;
	res.end = ((chunk?: string | Uint8Array | Buffer) => {
		if (typeof chunk === "string") {
			body = Buffer.concat([body, Buffer.from(chunk)]);
		} else if (chunk) {
			body = Buffer.concat([body, Buffer.from(chunk)]);
		}
		return res;
	}) as typeof res.end;
	return {
		res,
		bodyJson: () => JSON.parse(body.toString("utf8")),
		status: () => status,
	};
}

describe("local inference ASR route", () => {
	it("reports readiness from the registered handler and eligible ASR bundle", async () => {
		engineMock.canTranscribeLocally.mockResolvedValue(true);
		const getModel = vi.fn(() => () => "transcript");
		const useModel = vi.fn();
		const state: CompatRuntimeState = {
			current: {
				getModel,
				useModel,
			} as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		const handled = await handleLocalInferenceAsrRoute(
			fakeReq(undefined, {
				method: "GET",
				url: "/api/asr/local-inference/status",
			}),
			out.res,
			state,
		);

		expect(handled).toBe(true);
		expect(out.status()).toBe(200);
		expect(out.bodyJson()).toEqual({
			ready: true,
			provider: "local-inference",
		});
		expect(getModel).toHaveBeenCalledWith(ModelType.TRANSCRIPTION);
		expect(engineMock.canTranscribeLocally).toHaveBeenCalledTimes(1);
		expect(useModel).not.toHaveBeenCalled();
	});

	it("reports not-ready when the handler is registered but no ASR bundle is eligible", async () => {
		engineMock.canTranscribeLocally.mockResolvedValue(false);
		const getModel = vi.fn(() => () => "transcript");
		const state: CompatRuntimeState = {
			current: {
				getModel,
			} as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		const handled = await handleLocalInferenceAsrRoute(
			fakeReq(undefined, {
				method: "GET",
				url: "/api/asr/local-inference/status",
			}),
			out.res,
			state,
		);

		expect(handled).toBe(true);
		expect(out.status()).toBe(200);
		expect(out.bodyJson()).toEqual({ ready: false, provider: null });
		expect(engineMock.canTranscribeLocally).toHaveBeenCalledTimes(1);
	});

	it("reports not-ready when no TRANSCRIPTION handler is registered", async () => {
		const getModel = vi.fn(() => undefined);
		const state: CompatRuntimeState = {
			current: {
				getModel,
			} as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		const handled = await handleLocalInferenceAsrRoute(
			fakeReq(undefined, {
				method: "GET",
				url: "/api/asr/local-inference/status",
			}),
			out.res,
			state,
		);

		expect(handled).toBe(true);
		expect(out.status()).toBe(200);
		expect(out.bodyJson()).toEqual({ ready: false, provider: null });
		expect(engineMock.canTranscribeLocally).not.toHaveBeenCalled();
	});

	it("transcribes raw WAV audio and returns text + per-word timings", async () => {
		transcribeWavWithWordsMock.mockResolvedValue({
			text: "hello local voice",
			words: [
				{ text: "hello", startMs: 0, endMs: 400 },
				{ text: "local", startMs: 400, endMs: 700 },
				{ text: "voice", startMs: 700, endMs: 1000 },
			],
		});
		const state: CompatRuntimeState = {
			current: {} as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		const handled = await handleLocalInferenceAsrRoute(
			fakeReq(wavBytes()),
			out.res,
			state,
		);

		expect(handled).toBe(true);
		// The raw WAV bytes are forwarded to the single FFI-pipe transcriber.
		expect(
			Array.from(transcribeWavWithWordsMock.mock.calls[0]?.[1] as Uint8Array),
		).toEqual(Array.from(wavBytes()));
		expect(out.status()).toBe(200);
		expect(out.bodyJson()).toEqual({
			text: "hello local voice",
			words: [
				{ text: "hello", startMs: 0, endMs: 400 },
				{ text: "local", startMs: 400, endMs: 700 },
				{ text: "voice", startMs: 700, endMs: 1000 },
			],
		});
	});

	it("accepts JSON base64 audio for route clients that cannot send raw WAV", async () => {
		transcribeWavWithWordsMock.mockResolvedValue({
			text: "hello from json",
			words: [],
		});
		const state: CompatRuntimeState = {
			current: {} as unknown as CompatRuntimeState["current"],
		};
		const req = fakeReq({
			audioBase64: Buffer.from(wavBytes()).toString("base64"),
		});
		req.headers["content-type"] = "application/json";
		const out = fakeRes();

		await handleLocalInferenceAsrRoute(req, out.res, state);

		expect(
			Array.from(transcribeWavWithWordsMock.mock.calls[0]?.[1] as Uint8Array),
		).toEqual(Array.from(wavBytes()));
		expect(out.bodyJson()).toEqual({ text: "hello from json", words: [] });
	});
});
