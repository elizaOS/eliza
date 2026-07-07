// Fuzz / hardening pass for the local-inference TTS + ASR HTTP input
// contracts. Drives the REAL route handlers and the REAL pure parsers
// (sanitizeLocalInferenceSpeechText / normalizeAudioBytes /
// sniffAudioContentType) - the only substituted seam is the model boundary
// itself (`runtime.useModel` / the native FFI engine), which cannot run in a
// unit lane. Invariants under any input:
//
//   - the pure helpers never throw on arbitrary strings/bytes and always
//     honor their declared output contracts,
//   - the route handlers always answer POSTs on their path (return true)
//     with a terminal JSON/audio response in the documented status set,
//     and never leak an exception to the server loop,
//   - malformed bodies are 400s, oversized bodies are 413s, absent runtime
//     is a 503 - never a hang, never a 200.
//
// A seeded LCG makes failures reproducible (same pattern as
// voice-hardening.fuzz.test.ts).

import * as http from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-helpers";
import { handleLocalInferenceAsrRoute } from "./local-inference-asr-route";
import {
	handleLocalInferenceTtsRoute,
	normalizeAudioBytes,
	sanitizeLocalInferenceSpeechText,
	sniffAudioContentType,
} from "./local-inference-tts-route";

// The ASR route consults the native FFI engine before falling back to the
// runtime model chain; the engine cannot load in the unit lane, so pin it
// unavailable and let the REAL transcribeWavWithWords model-chain path run.
const engineMock = vi.hoisted(() => ({
	available: vi.fn(async () => false),
	canTranscribeLocally: vi.fn(async () => false),
}));
vi.mock("../services/engine", () => ({ localInferenceEngine: engineMock }));

beforeEach(() => {
	vi.clearAllMocks();
	engineMock.available.mockResolvedValue(false);
	engineMock.canTranscribeLocally.mockResolvedValue(false);
});

// Desktop AEC verdict (#12256) attached to every WAV transcription response;
// with no playback far-end reference pushed in this lane it is the honest
// passthrough case. Mirrors local-inference-asr-route.test.ts.
const AEC_NO_FAR_END = {
	applied: false,
	reason: "no-far-end",
	erleDb: null,
	confidence: null,
};

function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

function wavBytes(): Uint8Array {
	// Minimal RIFF/WAVE header + a few PCM16 samples.
	const pcm = new Int16Array([0, 900, -900, 0]);
	const buffer = new ArrayBuffer(44 + pcm.length * 2);
	const view = new DataView(buffer);
	const ascii = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i++)
			view.setUint8(offset + i, value.charCodeAt(i));
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + pcm.length * 2, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 16_000, true);
	view.setUint32(28, 16_000 * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, pcm.length * 2, true);
	for (let i = 0; i < pcm.length; i++)
		view.setInt16(44 + i * 2, pcm[i] ?? 0, true);
	return new Uint8Array(buffer);
}

function fakeReq(opts: {
	method?: string;
	url: string;
	contentType?: string;
	body?: unknown;
	streamChunks?: Buffer[];
}): http.IncomingMessage {
	const req = new http.IncomingMessage(new Socket());
	req.method = opts.method ?? "POST";
	req.url = opts.url;
	req.headers = {
		host: "localhost:2138",
		...(opts.contentType ? { "content-type": opts.contentType } : {}),
	};
	Object.defineProperty(req.socket, "remoteAddress", {
		value: "127.0.0.1",
		configurable: true,
	});
	if (opts.body !== undefined) {
		(req as { body?: unknown }).body = opts.body;
	}
	if (opts.streamChunks) {
		for (const chunk of opts.streamChunks) req.push(chunk);
		req.push(null);
	}
	return req;
}

function fakeRes(): {
	res: http.ServerResponse;
	body: () => Buffer;
	bodyJson: () => Record<string, unknown>;
	status: () => number;
	header: (name: string) => string | undefined;
} {
	const req = new http.IncomingMessage(new Socket());
	const res = new http.ServerResponse(req);
	let body = Buffer.alloc(0);
	let status = 200;
	const headers = new Map<string, string>();
	res.setHeader = ((name: string, value: string) => {
		headers.set(name.toLowerCase(), String(value));
		return res;
	}) as typeof res.setHeader;
	res.writeHead = ((
		code: number,
		maybeHeaders?: Record<string, string | number>,
	) => {
		status = code;
		res.statusCode = code;
		if (maybeHeaders) {
			for (const [k, v] of Object.entries(maybeHeaders))
				headers.set(k.toLowerCase(), String(v));
		}
		return res;
	}) as typeof res.writeHead;
	res.end = ((chunk?: string | Uint8Array | Buffer) => {
		if (typeof chunk === "string")
			body = Buffer.concat([body, Buffer.from(chunk)]);
		else if (chunk) body = Buffer.concat([body, Buffer.from(chunk)]);
		return res;
	}) as typeof res.end;
	return {
		res,
		body: () => body,
		bodyJson: () => JSON.parse(body.toString("utf8")),
		status: () => {
			// sendJson assigns statusCode directly without writeHead.
			return res.statusCode !== 200 ? res.statusCode : status;
		},
		header: (name: string) => headers.get(name.toLowerCase()),
	};
}

function ttsRuntimeState(
	useModel: (...args: unknown[]) => Promise<unknown>,
): CompatRuntimeState {
	return {
		current: { useModel } as unknown as CompatRuntimeState["current"],
	};
}

// ---------------------------------------------------------------------------
// Pure input parsers
// ---------------------------------------------------------------------------

describe("sanitizeLocalInferenceSpeechText - fuzz", () => {
	const FRAGMENTS = [
		"hello world",
		"<think>secret chain of thought</think>",
		"<think attr='x'>unterminated think",
		"<analysis>internal</analysis>",
		"<tool_calls>{}</tool_calls>",
		"```js\nconsole.log(1)\n```",
		"```unterminated fence",
		"`inline`",
		"[label](https://evil.example/track)",
		"https://example.com/path?q=1",
		"HTTP://UPPER.example",
		"<div onclick=x>tag</div>",
		"\0\x07control",
		"\ufb01ligature \u3392 unit", // NFKC-normalizable
		"\u591a\u8bed\u8a00\u6587\u672c \ud83d\ude42 emoji",
		"   \t\n\r  ",
		"a".repeat(5000),
		"<",
		">",
		"<>",
	];

	it("never throws; output is trimmed, single-spaced, and free of think-tags/fences/URLs", () => {
		const rng = makeRng(0x7757e);
		for (let i = 0; i < 3000; i++) {
			const parts = Array.from(
				{ length: 1 + Math.floor(rng() * 6) },
				() => FRAGMENTS[Math.floor(rng() * FRAGMENTS.length)],
			);
			const input = parts.join(rng() < 0.5 ? " " : "");
			const out = sanitizeLocalInferenceSpeechText(input);
			expect(typeof out).toBe("string");
			expect(out).toBe(out.trim());
			expect(out).not.toMatch(/\s{2,}/);
			expect(out.toLowerCase()).not.toContain("<think");
			expect(out).not.toContain("```");
			expect(out).not.toMatch(/\bhttps?:\/\//i);
			expect(out.toLowerCase()).not.toContain("chain of thought");
		}
	});

	it("strips an unterminated think-tag to the end of input", () => {
		expect(
			sanitizeLocalInferenceSpeechText("say this <think>never closed"),
		).toBe("say this");
	});
});

describe("sniffAudioContentType - fuzz", () => {
	const KNOWN = new Set([
		"audio/wav",
		"audio/mpeg",
		"application/octet-stream",
	]);

	it("returns one of the three declared types for arbitrary bytes", () => {
		const rng = makeRng(0x51ff);
		for (let i = 0; i < 3000; i++) {
			const len = Math.floor(rng() * 16);
			const bytes = new Uint8Array(len);
			for (let b = 0; b < len; b++) bytes[b] = Math.floor(rng() * 256);
			expect(KNOWN.has(sniffAudioContentType(bytes))).toBe(true);
		}
	});

	it("classifies real headers", () => {
		expect(sniffAudioContentType(wavBytes())).toBe("audio/wav");
		expect(
			sniffAudioContentType(new Uint8Array([0x49, 0x44, 0x33, 0x04])),
		).toBe("audio/mpeg");
		expect(sniffAudioContentType(new Uint8Array([0xff, 0xfb, 0x90]))).toBe(
			"audio/mpeg",
		);
		expect(sniffAudioContentType(new Uint8Array(0))).toBe(
			"application/octet-stream",
		);
	});
});

describe("normalizeAudioBytes - contract", () => {
	it("round-trips typed-array views including non-zero byteOffset", () => {
		const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9]);
		const view = backing.subarray(2, 6);
		expect(Array.from(normalizeAudioBytes(view))).toEqual([1, 2, 3, 4]);
		const dv = new DataView(backing.buffer, 2, 4);
		expect(Array.from(normalizeAudioBytes(dv))).toEqual([1, 2, 3, 4]);
		expect(Array.from(normalizeAudioBytes(backing.buffer.slice(2, 6)))).toEqual(
			[1, 2, 3, 4],
		);
	});

	it("throws on every non-binary payload", () => {
		for (const bad of [
			"YXVkaW8=",
			42,
			null,
			undefined,
			{},
			[],
			[1, 2, 3],
			{ buffer: new ArrayBuffer(4) },
			true,
		]) {
			expect(() => normalizeAudioBytes(bad)).toThrow(/non-binary payload/);
		}
	});
});

// ---------------------------------------------------------------------------
// TTS route input contract
// ---------------------------------------------------------------------------

describe("POST /api/tts/local-inference - input-contract fuzz", () => {
	const TTS_URL = "/api/tts/local-inference";

	it("ignores other methods/paths (returns false, writes nothing)", async () => {
		for (const opts of [
			{ method: "GET", url: TTS_URL },
			{ method: "POST", url: "/api/tts/other" },
			{ method: "DELETE", url: TTS_URL },
		]) {
			const out = fakeRes();
			const handled = await handleLocalInferenceTtsRoute(
				fakeReq(opts),
				out.res,
				ttsRuntimeState(async () => wavBytes()),
			);
			expect(handled).toBe(false);
			expect(out.body().length).toBe(0);
		}
	});

	it("400s when text is missing, non-string, or sanitizes to empty", async () => {
		const bodies: unknown[] = [
			{},
			{ text: 42 },
			{ text: null },
			{ text: ["a"] },
			{ text: "" },
			{ text: "   \n\t " },
			{ text: "<think>only internal monologue</think>" },
			{ text: "```\nonly code\n```" },
			{ text: "https://only.a.url/x" },
			{ voice: "af_bella" },
		];
		for (const body of bodies) {
			const useModel = vi.fn(async () => wavBytes());
			const out = fakeRes();
			const handled = await handleLocalInferenceTtsRoute(
				fakeReq({ url: TTS_URL, contentType: "application/json", body }),
				out.res,
				ttsRuntimeState(useModel),
			);
			expect(handled).toBe(true);
			expect(out.status(), JSON.stringify(body)).toBe(400);
			expect(out.bodyJson().error).toBe("Missing text");
			expect(useModel).not.toHaveBeenCalled();
		}
	});

	it("400s on a raw non-JSON body and 413s past the 1MB JSON cap", async () => {
		const badJson = fakeRes();
		await handleLocalInferenceTtsRoute(
			fakeReq({
				url: TTS_URL,
				contentType: "application/json",
				streamChunks: [Buffer.from('{"text": "trunca')],
			}),
			badJson.res,
			ttsRuntimeState(async () => wavBytes()),
		);
		expect(badJson.status()).toBe(400);

		const big = fakeRes();
		await handleLocalInferenceTtsRoute(
			fakeReq({
				url: TTS_URL,
				contentType: "application/json",
				streamChunks: [Buffer.from('{"text":"'), Buffer.alloc(1_100_000, 0x61)],
			}),
			big.res,
			ttsRuntimeState(async () => wavBytes()),
		);
		expect(big.status()).toBe(413);
	});

	it("503s when no runtime is active; 502s on empty audio, string payloads, and model errors", async () => {
		const noRuntime = fakeRes();
		await handleLocalInferenceTtsRoute(
			fakeReq({ url: TTS_URL, body: { text: "hi" } }),
			noRuntime.res,
			{ current: null },
		);
		expect(noRuntime.status()).toBe(503);

		const cases: Array<{ result: () => Promise<unknown>; want: number }> = [
			{ result: async () => new Uint8Array(0), want: 502 },
			{ result: async () => "not-bytes", want: 502 },
			{
				result: async () => {
					throw new Error("synth exploded");
				},
				want: 502,
			},
		];
		for (const c of cases) {
			const out = fakeRes();
			await handleLocalInferenceTtsRoute(
				fakeReq({ url: TTS_URL, body: { text: "hi" } }),
				out.res,
				ttsRuntimeState(c.result),
			);
			expect(out.status()).toBe(c.want);
		}
	});

	it("200s with sniffed content-type and exact length on valid input", async () => {
		const out = fakeRes();
		await handleLocalInferenceTtsRoute(
			fakeReq({
				url: TTS_URL,
				body: { text: "hello", speed: 1.25, voice: "af_bella" },
			}),
			out.res,
			ttsRuntimeState(async () => wavBytes()),
		);
		expect(out.status()).toBe(200);
		expect(out.header("content-type")).toBe("audio/wav");
		expect(Number(out.header("content-length"))).toBe(out.body().length);
		expect(out.body().length).toBeGreaterThan(0);
	});

	it("fuzz: 2000 random body shapes always terminate in {200,400,502,503} and never throw", async () => {
		const rng = makeRng(0x77f5);
		const VALUES: unknown[] = [
			"hi there",
			"",
			"   ",
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			null,
			true,
			[],
			{},
			["x"],
			{ nested: true },
			"a".repeat(20_000),
			"<think>x</think>",
		];
		const KEYS = [
			"text",
			"voice",
			"voiceId",
			"model",
			"modelId",
			"speed",
			"sampleRate",
			"format",
			"junk",
		];
		for (let i = 0; i < 2000; i++) {
			const body: Record<string, unknown> = {};
			const n = Math.floor(rng() * 5);
			for (let k = 0; k < n; k++) {
				body[KEYS[Math.floor(rng() * KEYS.length)]] =
					VALUES[Math.floor(rng() * VALUES.length)];
			}
			const modelFails = rng() < 0.2;
			const out = fakeRes();
			const handled = await handleLocalInferenceTtsRoute(
				fakeReq({ url: TTS_URL, body }),
				out.res,
				ttsRuntimeState(async () => {
					if (modelFails) throw new Error("model failure");
					return wavBytes();
				}),
			);
			expect(handled).toBe(true);
			const status = out.status();
			expect(
				[200, 400, 502, 503].includes(status),
				`status ${status} for ${JSON.stringify(body)}`,
			).toBe(true);
			// 200 only ever carries real audio bytes.
			if (status === 200) expect(out.body().length).toBeGreaterThan(0);
		}
	});
});

// ---------------------------------------------------------------------------
// ASR route input contract
// ---------------------------------------------------------------------------

describe("POST /api/asr/local-inference - input-contract fuzz", () => {
	const ASR_URL = "/api/asr/local-inference";

	function asrRuntimeState(transcript: unknown): CompatRuntimeState {
		return {
			current: {
				useModel: vi.fn(async () => transcript),
				getModel: vi.fn(() => () => "handler"),
			} as unknown as CompatRuntimeState["current"],
		};
	}

	it("400s JSON bodies without a string audioBase64", async () => {
		const bodies: unknown[] = [
			{},
			{ audioBase64: 42 },
			{ audioBase64: null },
			{ audioBase64: ["QUJD"] },
			{ audio: "QUJD" },
		];
		for (const body of bodies) {
			const out = fakeRes();
			const handled = await handleLocalInferenceAsrRoute(
				fakeReq({ url: ASR_URL, contentType: "application/json", body }),
				out.res,
				asrRuntimeState("hello"),
			);
			expect(handled).toBe(true);
			expect(out.status(), JSON.stringify(body)).toBe(400);
			expect(out.bodyJson().error).toBe("Missing audioBase64");
		}
	});

	it("400s empty / non-decodable audioBase64 as missing audio", async () => {
		for (const audioBase64 of ["", "!!!!", "@@"]) {
			const out = fakeRes();
			await handleLocalInferenceAsrRoute(
				fakeReq({
					url: ASR_URL,
					contentType: "application/json",
					body: { audioBase64 },
				}),
				out.res,
				asrRuntimeState("hello"),
			);
			expect(out.status(), JSON.stringify(audioBase64)).toBe(400);
			expect(out.bodyJson().error).toBe("Missing audio");
		}
	});

	it("413s a raw audio body past the 16MB cap", async () => {
		const chunk = Buffer.alloc(4 * 1024 * 1024, 0x42);
		const out = fakeRes();
		const handled = await handleLocalInferenceAsrRoute(
			fakeReq({
				url: ASR_URL,
				contentType: "audio/wav",
				streamChunks: [chunk, chunk, chunk, chunk, Buffer.from([0x00])],
			}),
			out.res,
			asrRuntimeState("hello"),
		);
		expect(handled).toBe(true);
		expect(out.status()).toBe(413);
		expect(out.bodyJson().error).toBe("Audio body too large");
	});

	it("400s a zero-byte raw body", async () => {
		const out = fakeRes();
		await handleLocalInferenceAsrRoute(
			fakeReq({ url: ASR_URL, contentType: "audio/wav", streamChunks: [] }),
			out.res,
			asrRuntimeState("hello"),
		);
		expect(out.status()).toBe(400);
		expect(out.bodyJson().error).toBe("Missing audio");
	});

	it("transcribes via the real model-chain path, preserving byteOffset views", async () => {
		const backing = new Uint8Array(4 + wavBytes().length);
		backing.set(wavBytes(), 4);
		const view = backing.subarray(4); // non-zero byteOffset
		const state = asrRuntimeState("  hello world  ");
		const out = fakeRes();
		await handleLocalInferenceAsrRoute(
			fakeReq({ url: ASR_URL, contentType: "audio/wav", body: view }),
			out.res,
			state,
		);
		expect(out.status()).toBe(200);
		expect(out.bodyJson()).toEqual({
			text: "hello world",
			words: [],
			aec: AEC_NO_FAR_END,
		});
	});

	it("502s when the transcription model misbehaves (invalid shape, empty, throw)", async () => {
		for (const transcript of [42, {}, { text: 7 }, "", "   "]) {
			const out = fakeRes();
			await handleLocalInferenceAsrRoute(
				fakeReq({ url: ASR_URL, contentType: "audio/wav", body: wavBytes() }),
				out.res,
				asrRuntimeState(transcript),
			);
			expect(out.status(), JSON.stringify(transcript)).toBe(502);
			expect(String(out.bodyJson().error)).toMatch(/Local inference ASR error/);
		}
	});

	it("503s when no runtime is active", async () => {
		const out = fakeRes();
		await handleLocalInferenceAsrRoute(
			fakeReq({ url: ASR_URL, contentType: "audio/wav", body: wavBytes() }),
			out.res,
			{ current: null },
		);
		expect(out.status()).toBe(503);
	});

	it("fuzz: 1500 random JSON/raw payloads always terminate in {200,400,413,502,503}", async () => {
		const rng = makeRng(0xa5ec);
		for (let i = 0; i < 1500; i++) {
			const useJson = rng() < 0.5;
			const transcriptOk = rng() < 0.5;
			const out = fakeRes();
			let req: http.IncomingMessage;
			if (useJson) {
				const roll = rng();
				const body =
					roll < 0.25
						? {}
						: roll < 0.5
							? { audioBase64: Buffer.from(wavBytes()).toString("base64") }
							: roll < 0.75
								? { audioBase64: "***garbage***" }
								: { audioBase64: rng() < 0.5 ? 42 : null };
				req = fakeReq({
					url: ASR_URL,
					contentType: "application/json",
					body,
				});
			} else {
				const len = Math.floor(rng() * 128);
				const bytes = new Uint8Array(len);
				for (let b = 0; b < len; b++) bytes[b] = Math.floor(rng() * 256);
				req = fakeReq({
					url: ASR_URL,
					contentType: rng() < 0.5 ? "audio/wav" : "application/octet-stream",
					body: bytes,
				});
			}
			const handled = await handleLocalInferenceAsrRoute(
				req,
				out.res,
				asrRuntimeState(transcriptOk ? "ok transcript" : { bogus: true }),
			);
			expect(handled).toBe(true);
			const status = out.status();
			expect(
				[200, 400, 413, 502, 503].includes(status),
				`status ${status} (iteration ${i})`,
			).toBe(true);
		}
	});
});
