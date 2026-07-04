/**
 * HTTP-contract tests for the ASR route: auth, audio-body decoding, and the
 * status probe. `transcribeWavWithWords` and the engine are stubbed — no real
 * model runs.
 */

import * as http from "node:http";
import { Socket } from "node:net";
import { ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioFrameEvent } from "../services/voice/audio-frame-consumer";
import { AUDIO_FRAME_PIPELINE_SAMPLE_RATE } from "../services/voice/audio-frame-consumer";
import {
	getSharedFarEndEchoReference,
	resetSharedFarEndEchoReferenceForTesting,
} from "../services/voice/far-end-echo-reference";
import { encodeMonoPcm16Wav } from "../services/voice/wav-codec";
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
	resetSharedFarEndEchoReferenceForTesting();
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

function syntheticSpeech(samples: number): Float32Array {
	const out = new Float32Array(samples);
	let seed = 0x9e3779b9;
	for (let index = 0; index < samples; index += 1) {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		out[index] =
			Math.sin((2 * Math.PI * 180 * index) / AUDIO_FRAME_PIPELINE_SAMPLE_RATE) *
				0.18 +
			(seed / 0xffffffff - 0.5) * 0.06;
	}
	return out;
}

function encodeFramePcm16(pcm: Float32Array): string {
	const bytes = Buffer.alloc(pcm.length * 2);
	for (let index = 0; index < pcm.length; index += 1) {
		const sample = Math.max(-1, Math.min(1, pcm[index] ?? 0));
		bytes.writeInt16LE(Math.round(sample * 32767), index * 2);
	}
	return bytes.toString("base64");
}

function rms(pcm: Float32Array): number {
	let sum = 0;
	for (const sample of pcm) sum += sample * sample;
	return Math.sqrt(sum / Math.max(1, pcm.length));
}

function playbackFrames(
	pcm: Float32Array,
	startedAtMs: number,
): AudioFrameEvent[] {
	const frames: AudioFrameEvent[] = [];
	const frameSamples = 320;
	for (let offset = 0; offset < pcm.length; offset += frameSamples) {
		const chunk = pcm.subarray(
			offset,
			Math.min(pcm.length, offset + frameSamples),
		);
		frames.push({
			pcm16: encodeFramePcm16(chunk),
			sampleRate: AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
			channels: 1,
			samples: chunk.length,
			rms: rms(chunk),
			timestamp:
				startedAtMs + (offset / AUDIO_FRAME_PIPELINE_SAMPLE_RATE) * 1000,
			frameIndex: frames.length,
		});
	}
	return frames;
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
			aec: expect.objectContaining({
				echoReferenceWired: false,
				playbackFramesReceived: 0,
				playbackSamplesReceived: 0,
				asrFramesCancelled: 0,
			}),
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
		expect(out.bodyJson()).toEqual({
			ready: false,
			provider: null,
			aec: expect.objectContaining({
				echoReferenceWired: false,
				asrFramesCancelled: 0,
			}),
		});
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
		expect(out.bodyJson()).toEqual({
			ready: false,
			provider: null,
			aec: expect.objectContaining({
				echoReferenceWired: false,
				asrFramesCancelled: 0,
			}),
		});
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

	it("applies the shared playback reference to timed JSON audio before transcription", async () => {
		transcribeWavWithWordsMock.mockResolvedValue({
			text: "cleaned local voice",
			words: [],
		});
		const startedAtMs = 1_500;
		const far = syntheticSpeech(AUDIO_FRAME_PIPELINE_SAMPLE_RATE * 2);
		const wav = encodeMonoPcm16Wav(far, AUDIO_FRAME_PIPELINE_SAMPLE_RATE);
		getSharedFarEndEchoReference().pushPlayback(
			playbackFrames(far, startedAtMs),
		);
		const state: CompatRuntimeState = {
			current: {} as unknown as CompatRuntimeState["current"],
		};
		const req = fakeReq({
			audioBase64: Buffer.from(wav).toString("base64"),
			captureStartedAtMs: startedAtMs,
			captureEndedAtMs: startedAtMs + 2_000,
		});
		req.headers["content-type"] = "application/json";
		const out = fakeRes();

		await handleLocalInferenceAsrRoute(req, out.res, state);

		const forwarded = transcribeWavWithWordsMock.mock
			.calls[0]?.[1] as Uint8Array;
		expect(Array.from(forwarded)).not.toEqual(Array.from(wav));
		expect(
			getSharedFarEndEchoReference().status().asrFramesCancelled,
		).toBeGreaterThan(0);
		expect(out.bodyJson()).toEqual({
			text: "cleaned local voice",
			words: [],
		});
	});
});
