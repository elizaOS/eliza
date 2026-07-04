/**
 * Tests for the native-PCM voice-turn route: PCM/sample-rate validation and
 * engine dispatch. `localInferenceEngine` is mocked, so no real voice turn runs.
 */

import type http from "node:http";
import { Readable } from "node:stream";
import { logger } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleNativePcmTurnRoute } from "./native-pcm-turn-route";

const engineMock = vi.hoisted(() => ({
	ensureActiveBundleAsrReady: vi.fn(async () => undefined),
	runVoiceTurn: vi.fn(
		async (): Promise<"done" | "token-cap" | "cancelled"> => "done",
	),
}));

vi.mock("../services/engine", () => ({
	localInferenceEngine: engineMock,
}));

class FakeRes {
	statusCode = 200;
	headersSent = false;
	private readonly headers = new Map<string, string>();
	body = "";
	setHeader(name: string, value: string): void {
		this.headers.set(name.toLowerCase(), value);
	}
	end(chunk?: string): void {
		if (chunk) this.body += chunk;
		this.headersSent = true;
	}
	json(): unknown {
		return JSON.parse(this.body);
	}
}

function makeReq(opts: {
	method?: string;
	url?: string;
	body?: unknown;
}): http.IncomingMessage {
	const payload = opts.body !== undefined ? JSON.stringify(opts.body) : "";
	const stream = Readable.from(payload ? [Buffer.from(payload)] : []);
	const req = stream as unknown as http.IncomingMessage & {
		method: string;
		url: string;
		headers: Record<string, string>;
	};
	req.method = opts.method ?? "POST";
	req.url = opts.url ?? "/api/voice/native-pcm-turn";
	req.headers = {
		host: "127.0.0.1:31337",
		"content-type": "application/json",
	};
	return req;
}

function float32Base64(samples: ReadonlyArray<number>): string {
	const bytes = Buffer.alloc(samples.length * 4);
	samples.forEach((sample, index) => {
		bytes.writeFloatLE(sample, index * 4);
	});
	return bytes.toString("base64");
}

beforeEach(() => {
	vi.clearAllMocks();
	engineMock.ensureActiveBundleAsrReady.mockResolvedValue(undefined);
	engineMock.runVoiceTurn.mockResolvedValue("done");
});

describe("handleNativePcmTurnRoute", () => {
	it("runs completed native PCM turns through the local voice engine", async () => {
		const infoSpy = vi
			.spyOn(logger, "info")
			.mockImplementation(() => undefined);
		const res = new FakeRes();

		const handled = await handleNativePcmTurnRoute(
			makeReq({
				body: {
					turnId: "native-turn-1",
					pcm: float32Base64([0, 0.5, -0.25]),
					sampleRate: 24_000,
					signal: "end-of-speech",
				},
			}),
			res as unknown as http.ServerResponse,
		);

		expect(handled).toBe(true);
		expect(engineMock.ensureActiveBundleAsrReady).toHaveBeenCalledTimes(1);
		expect(engineMock.runVoiceTurn).toHaveBeenCalledTimes(1);
		const [audio, opts] = engineMock.runVoiceTurn.mock.calls[0] as [
			{ pcm: Float32Array; sampleRate: number },
			{ events?: { onComplete?: (reason: "done") => void } },
		];
		expect(audio.sampleRate).toBe(24_000);
		expect(Array.from(audio.pcm)).toEqual([0, 0.5, -0.25]);
		opts.events?.onComplete?.("done");
		expect(infoSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				turnId: "native-turn-1",
				exitReason: "done",
				nativeSignal: "end-of-speech",
			}),
			expect.stringContaining("completed native PCM voice turn"),
		);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({
			ok: true,
			turnId: "native-turn-1",
			exitReason: "done",
		});
	});

	it("rejects malformed Float32 PCM before touching the engine", async () => {
		const res = new FakeRes();

		const handled = await handleNativePcmTurnRoute(
			makeReq({
				body: {
					pcm: Buffer.from([0, 1]).toString("base64"),
					sampleRate: 16_000,
				},
			}),
			res as unknown as http.ServerResponse,
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		expect(res.json()).toEqual({
			error: "pcm byte length must be a multiple of 4 for Float32 PCM",
		});
		expect(engineMock.ensureActiveBundleAsrReady).not.toHaveBeenCalled();
		expect(engineMock.runVoiceTurn).not.toHaveBeenCalled();
	});
});
