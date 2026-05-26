import * as http from "node:http";
import { Socket } from "node:net";
import { ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-helpers";
import { handleLocalInferenceAsrRoute } from "./local-inference-asr-route";

const whisperState = vi.hoisted(() => ({
	runtime: null as null | {
		libraryPath: string;
		modelPath: string;
		language: string;
		translate: boolean;
		nThreads: number;
		useGpu: boolean;
	},
}));

const transcriberState = vi.hoisted(() => ({
	createStreamingTranscriber: vi.fn(),
}));

vi.mock("../services/voice/whisper-cpp-asr", () => ({
	resolveWhisperCppRuntime: vi.fn(() => whisperState.runtime),
}));

vi.mock("../services/voice/transcriber", () => ({
	createStreamingTranscriber: transcriberState.createStreamingTranscriber,
}));

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
	beforeEach(() => {
		whisperState.runtime = null;
		transcriberState.createStreamingTranscriber.mockReset();
	});

	it("reports packaged Whisper readiness without starting transcription", async () => {
		whisperState.runtime = {
			libraryPath: "/bundle/voice/whisper/libwhisper_eliza_adapter.dylib",
			modelPath: "/bundle/voice/whisper/ggml-base.en.bin",
			language: "en",
			translate: false,
			nThreads: 4,
			useGpu: true,
		};
		const useModel = vi.fn();
		const state: CompatRuntimeState = {
			current: { useModel } as unknown as CompatRuntimeState["current"],
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
			provider: "whisper-cpp",
		});
		expect(useModel).not.toHaveBeenCalled();
	});

	it("uses packaged Whisper before runtime TRANSCRIPTION for first-run voice", async () => {
		const feed = vi.fn();
		const flush = vi
			.fn()
			.mockResolvedValue({ partial: "hello packaged whisper", isFinal: true });
		const dispose = vi.fn();
		transcriberState.createStreamingTranscriber.mockReturnValue({
			feed,
			flush,
			dispose,
		});
		whisperState.runtime = {
			libraryPath: "/bundle/voice/whisper/libwhisper_eliza_adapter.dylib",
			modelPath: "/bundle/voice/whisper/ggml-base.en.bin",
			language: "en",
			translate: false,
			nThreads: 4,
			useGpu: true,
		};
		const useModel = vi.fn();
		const state: CompatRuntimeState = {
			current: { useModel } as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		const handled = await handleLocalInferenceAsrRoute(
			fakeReq(wavBytes()),
			out.res,
			state,
		);

		expect(handled).toBe(true);
		expect(transcriberState.createStreamingTranscriber).toHaveBeenCalledWith({
			prefer: "whisper-cpp",
			allowWhisperCpp: true,
		});
		expect(feed).toHaveBeenCalledOnce();
		expect(flush).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(useModel).not.toHaveBeenCalled();
		expect(out.status()).toBe(200);
		expect(out.bodyJson()).toEqual({ text: "hello packaged whisper" });
	});

	it("falls through missing providers and returns a transcript", async () => {
		const useModel = vi
			.fn()
			.mockRejectedValueOnce(
				new Error("No handler found for delegate type: TRANSCRIPTION"),
			)
			.mockResolvedValueOnce({ text: "hello local voice" });
		const state: CompatRuntimeState = {
			current: { useModel } as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		const handled = await handleLocalInferenceAsrRoute(
			fakeReq(wavBytes()),
			out.res,
			state,
		);

		expect(handled).toBe(true);
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(useModel.mock.calls[1]?.[0]).toBe(ModelType.TRANSCRIPTION);
		expect(useModel.mock.calls[1]?.[2]).toBe("capacitor-llama");
		expect(
			Array.from((useModel.mock.calls[1]?.[1] as { audio: Uint8Array }).audio),
		).toEqual(Array.from(wavBytes()));
		expect(out.status()).toBe(200);
		expect(out.bodyJson()).toEqual({ text: "hello local voice" });
	});

	it("accepts JSON base64 audio for route clients that cannot send raw WAV", async () => {
		const useModel = vi.fn().mockResolvedValue("hello from json");
		const state: CompatRuntimeState = {
			current: { useModel } as unknown as CompatRuntimeState["current"],
		};
		const req = fakeReq({
			audioBase64: Buffer.from(wavBytes()).toString("base64"),
		});
		req.headers["content-type"] = "application/json";
		const out = fakeRes();

		await handleLocalInferenceAsrRoute(req, out.res, state);

		expect(useModel.mock.calls[0]?.[0]).toBe(ModelType.TRANSCRIPTION);
		expect(
			Array.from((useModel.mock.calls[0]?.[1] as { audio: Uint8Array }).audio),
		).toEqual(Array.from(wavBytes()));
		expect(useModel.mock.calls[0]?.[2]).toBe("eliza-local-inference");
		expect(out.bodyJson()).toEqual({ text: "hello from json" });
	});
});
