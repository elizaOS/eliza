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
import {
	__resetSharedFarEndReferenceForTest,
	getSharedFarEndReference,
} from "../services/voice/far-end-reference";
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
	engineMock.canTranscribeLocally.mockResolvedValue(true);
	__resetSharedFarEndReferenceForTest();
});

/** The desktop AEC verdict attached to every WAV transcription response when
 * no playback reference exists (the honest passthrough case). */
const AEC_NO_FAR_END = {
	applied: false,
	reason: "no-far-end",
	erleDb: null,
	confidence: null,
};

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
			aec: AEC_NO_FAR_END,
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
		expect(out.bodyJson()).toEqual({
			text: "hello from json",
			words: [],
			aec: AEC_NO_FAR_END,
		});
	});

	it("cancels the desktop echo before transcription when the far-end reference is live (#12256)", async () => {
		transcribeWavWithWordsMock.mockResolvedValue({ text: "", words: [] });
		// 3 s of deterministic pseudo-speech playback, delivered as timestamped
		// renderer frames; the mic WAV is that playback attenuated + delayed.
		const SR = 16_000;
		const speech = (n: number, seed: number): Float32Array => {
			const outPcm = new Float32Array(n);
			let state = seed >>> 0 || 1;
			let lp = 0;
			for (let i = 0; i < n; i++) {
				state = (state * 1664525 + 1013904223) >>> 0;
				lp = 0.85 * lp + 0.15 * (state / 0xffffffff - 0.5);
				outPcm[i] =
					(0.55 + 0.45 * Math.sin((2 * Math.PI * 2.3 * i) / SR)) * lp * 2.5;
			}
			return outPcm;
		};
		const far = speech(48_000, 7);
		const baseTs = 5_000;
		const epochOffset = 1_000_000;
		const farEnd = getSharedFarEndReference();
		const frames: AudioFrameEvent[] = [];
		for (let index = 0; (index + 1) * 320 <= far.length; index += 1) {
			const framePcm = far.subarray(index * 320, (index + 1) * 320);
			const bytes = Buffer.alloc(320 * 2);
			for (let i = 0; i < 320; i++) {
				bytes.writeInt16LE(
					Math.round(Math.max(-1, Math.min(1, framePcm[i])) * 32767),
					i * 2,
				);
			}
			frames.push({
				pcm16: bytes.toString("base64"),
				sampleRate: SR,
				channels: 1,
				samples: 320,
				rms: 0.1,
				timestamp: baseTs + index * 20,
				frameIndex: index,
			});
		}
		for (let i = 0; i < frames.length; i += 12) {
			const batch = frames.slice(i, i + 12);
			farEnd.pushPlayback(
				batch,
				batch[batch.length - 1].timestamp + epochOffset + 5,
			);
		}
		const nearStartTs = 5_100;
		const nearLen = 40_000;
		const near = new Float32Array(nearLen);
		const srcBase = Math.round(((nearStartTs - 60 - baseTs) / 1000) * SR);
		for (let i = 0; i < nearLen; i++) {
			const k = srcBase + i;
			if (k >= 0 && k < far.length) near[i] = 0.22 * far[k];
		}
		const wav = encodeMonoPcm16Wav(near, SR);
		const nearEndTs = nearStartTs + (nearLen / SR) * 1000;
		const nowSpy = vi
			.spyOn(Date, "now")
			.mockReturnValue(nearEndTs + epochOffset + 15);
		try {
			const state: CompatRuntimeState = {
				current: {} as unknown as CompatRuntimeState["current"],
			};
			const out = fakeRes();
			await handleLocalInferenceAsrRoute(fakeReq(wav), out.res, state);

			expect(out.status()).toBe(200);
			const body = out.bodyJson() as {
				aec: { applied: boolean; erleDb: number };
			};
			expect(body.aec.applied).toBe(true);
			expect(body.aec.erleDb).toBeGreaterThanOrEqual(18);
			// The transcriber received the CANCELLED bytes, not the raw echo.
			const forwarded = transcribeWavWithWordsMock.mock
				.calls[0]?.[1] as Uint8Array;
			expect(forwarded).not.toEqual(wav);
			expect(forwarded.byteLength).toBe(wav.byteLength);
		} finally {
			nowSpy.mockRestore();
		}
	});
});
