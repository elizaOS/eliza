/**
 * Tests for the TTS route and `sanitizeLocalInferenceSpeechText`: markup/tag
 * stripping and the provider-chain dispatch. The TEXT_TO_SPEECH model is stubbed
 * via a fake runtime; no audio is synthesized.
 */

import * as http from "node:http";
import { Socket } from "node:net";
import { addLogListener, type LogEntry, ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// The logger freezes its level at module init and the repo test setup defaults
// LOG_LEVEL to "error", which would gate the info-level tts lines (and their
// listener delivery) off. vi.hoisted runs before the imports above evaluate,
// so the logger initializes at "info" — the production default the
// ELIZA_TTS_DEBUG diagnostic is documented against.
vi.hoisted(() => {
	process.env.LOG_LEVEL = "info";
});

import type { CompatRuntimeState } from "./compat-helpers";
import {
	handleLocalInferenceTtsRoute,
	sanitizeLocalInferenceSpeechText,
} from "./local-inference-tts-route";

function wavBytes(): Uint8Array {
	return new Uint8Array([
		0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
		0x66, 0x6d, 0x74, 0x20,
	]);
}

function fakeReq(body?: unknown): http.IncomingMessage {
	const req = new http.IncomingMessage(new Socket());
	req.method = "POST";
	req.url = "/api/tts/local-inference";
	req.headers = { host: "localhost:2138" };
	Object.defineProperty(req.socket, "remoteAddress", {
		value: "127.0.0.1",
		configurable: true,
	});
	if (body !== undefined) {
		(req as { body?: unknown }).body = body;
	}
	return req;
}

function fakeStatusReq(): http.IncomingMessage {
	const req = new http.IncomingMessage(new Socket());
	req.method = "GET";
	req.url = "/api/tts/local-inference/status";
	req.headers = { host: "localhost:2138" };
	Object.defineProperty(req.socket, "remoteAddress", {
		value: "127.0.0.1",
		configurable: true,
	});
	return req;
}

function fakeRes(): {
	res: http.ServerResponse;
	bodyBuffer: () => Buffer;
	status: () => number;
	header: (name: string) => string | undefined;
} {
	const req = new http.IncomingMessage(new Socket());
	const res = new http.ServerResponse(req);
	let body = Buffer.alloc(0);
	const headers = new Map<string, string>();
	res.setHeader = ((
		name: string,
		value: number | string | readonly string[],
	) => {
		headers.set(String(name).toLowerCase(), String(value));
		return res;
	}) as typeof res.setHeader;
	res.writeHead = ((code: number, values?: http.OutgoingHttpHeaders) => {
		res.statusCode = code;
		if (values) {
			for (const [key, value] of Object.entries(values)) {
				headers.set(key.toLowerCase(), String(value));
			}
		}
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
		bodyBuffer: () => body,
		status: () => res.statusCode,
		header: (name) => headers.get(name.toLowerCase()),
	};
}

describe("local inference TTS route", () => {
	it("sanitizes assistant markup before synthesis", () => {
		expect(
			sanitizeLocalInferenceSpeechText(
				"<think>hidden</think>Hello `there` [friend](https://example.com) https://example.com",
			),
		).toBe("Hello there friend");
	});

	it("falls through missing providers and returns WAV bytes", async () => {
		const useModel = vi
			.fn()
			.mockRejectedValueOnce(
				new Error("No handler found for delegate type: TEXT_TO_SPEECH"),
			)
			.mockResolvedValueOnce(wavBytes());
		const state: CompatRuntimeState = {
			current: { useModel } as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		const handled = await handleLocalInferenceTtsRoute(
			fakeReq({ text: "Hello" }),
			out.res,
			state,
		);

		const secondParams = useModel.mock.calls[1]?.[1] as
			| { text?: string; signal?: AbortSignal; voice?: string }
			| undefined;
		expect(handled).toBe(true);
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(useModel.mock.calls[1]?.[2]).toBe("capacitor-llama");
		expect(secondParams).toMatchObject({ text: "Hello" });
		expect(secondParams?.signal).toBeInstanceOf(AbortSignal);
		expect(out.status()).toBe(200);
		expect(out.header("content-type")).toBe("audio/wav");
		expect(out.bodyBuffer()).toEqual(Buffer.from(wavBytes()));
	});

	it("forwards voice, model, speed, sample rate, and format hints", async () => {
		const useModel = vi.fn().mockResolvedValue(wavBytes());
		const state: CompatRuntimeState = {
			current: { useModel } as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		await handleLocalInferenceTtsRoute(
			fakeReq({
				text: "Hello",
				voiceId: "narrator",
				modelId: "omnivoice-q4",
				speed: 1.15,
				sampleRate: 24_000,
				format: "wav",
			}),
			out.res,
			state,
		);

		expect(useModel.mock.calls[0]?.[1]).toMatchObject({
			text: "Hello",
			voice: "narrator",
			modelId: "omnivoice-q4",
			speed: 1.15,
			sampleRate: 24_000,
			format: "wav",
		});
	});

	it("status reports ready when a TEXT_TO_SPEECH handler is registered", async () => {
		const getModel = vi.fn((type: string) =>
			type === ModelType.TEXT_TO_SPEECH ? () => new Uint8Array() : undefined,
		);
		const state: CompatRuntimeState = {
			current: { getModel } as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		const handled = await handleLocalInferenceTtsRoute(
			fakeStatusReq(),
			out.res,
			state,
		);

		expect(handled).toBe(true);
		expect(out.status()).toBe(200);
		expect(JSON.parse(out.bodyBuffer().toString())).toEqual({
			ready: true,
			provider: "local-inference",
		});
	});

	it("accepts one host session handoff while a cookie alone stays unauthorized", async () => {
		const getModel = vi.fn((type: string) =>
			type === ModelType.TEXT_TO_SPEECH ? () => new Uint8Array() : undefined,
		);
		const req = fakeStatusReq();
		req.headers = {
			host: "dashboard.example.test",
			cookie: "eliza_session=valid-host-session",
		};
		Object.defineProperty(req.socket, "remoteAddress", {
			value: "203.0.113.9",
			configurable: true,
		});

		const direct = fakeRes();
		await expect(
			handleLocalInferenceTtsRoute(req, direct.res, {
				current: { getModel } as unknown as CompatRuntimeState["current"],
			}),
		).resolves.toBe(true);
		expect(direct.status()).toBe(401);
		expect(JSON.parse(direct.bodyBuffer().toString())).toEqual({
			error: "Unauthorized",
		});

		const delegated = fakeRes();
		await expect(
			handleLocalInferenceTtsRoute(req, delegated.res, {
				current: { getModel } as unknown as CompatRuntimeState["current"],
				requestAuthorizedByHost: true,
			}),
		).resolves.toBe(true);
		expect(delegated.status()).toBe(200);
		expect(JSON.parse(delegated.bodyBuffer().toString())).toEqual({
			ready: true,
			provider: "local-inference",
		});
		expect(getModel).toHaveBeenCalledOnce();
	});

	it("status reports not-ready when no TEXT_TO_SPEECH handler exists", async () => {
		const getModel = vi.fn(() => undefined);
		const state: CompatRuntimeState = {
			current: { getModel } as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		const handled = await handleLocalInferenceTtsRoute(
			fakeStatusReq(),
			out.res,
			state,
		);

		expect(handled).toBe(true);
		expect(out.status()).toBe(200);
		expect(JSON.parse(out.bodyBuffer().toString())).toEqual({
			ready: false,
			provider: null,
		});
	});

	it("status reports not-ready when the runtime is absent", async () => {
		const state: CompatRuntimeState = { current: null };
		const out = fakeRes();

		const handled = await handleLocalInferenceTtsRoute(
			fakeStatusReq(),
			out.res,
			state,
		);

		expect(handled).toBe(true);
		expect(JSON.parse(out.bodyBuffer().toString())).toEqual({
			ready: false,
			provider: null,
		});
	});

	it("aborts TTS on client close without writing a synthetic 502", async () => {
		let aborted = false;
		let signalReady!: (signal: AbortSignal | undefined) => void;
		const signalReceived = new Promise<AbortSignal | undefined>((resolve) => {
			signalReady = resolve;
		});
		const useModel = vi.fn((_type, params: { signal?: AbortSignal }) => {
			signalReady(params.signal);
			return new Promise<Uint8Array>((_resolve, reject) => {
				params.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
		});
		const state: CompatRuntimeState = {
			current: { useModel } as unknown as CompatRuntimeState["current"],
		};
		const req = fakeReq({ text: "Hello" });
		const out = fakeRes();

		const handledPromise = handleLocalInferenceTtsRoute(req, out.res, state);
		await expect(signalReceived).resolves.toBeInstanceOf(AbortSignal);
		req.emit("close");
		await expect(handledPromise).resolves.toBe(true);

		expect(aborted).toBe(true);
		expect(out.bodyBuffer().length).toBe(0);
	});
});

// #16347: with ELIZA_TTS_DEBUG set the route traces `server:local-tts:*`
// through the real structured logger; entries observed via the listener
// stream, silent when the flag is unset.
describe("ELIZA_TTS_DEBUG tracing on /api/tts/local-inference", () => {
	const prevFlag = process.env.ELIZA_TTS_DEBUG;
	let entries: LogEntry[] = [];
	let unsubscribe: (() => void) | null = null;

	const ttsLines = () =>
		entries.filter((entry) => entry.msg.includes("[eliza][tts]"));

	const listen = () => {
		entries = [];
		unsubscribe?.();
		unsubscribe = addLogListener((entry) => entries.push(entry));
	};

	afterEach(() => {
		unsubscribe?.();
		unsubscribe = null;
		if (prevFlag === undefined) delete process.env.ELIZA_TTS_DEBUG;
		else process.env.ELIZA_TTS_DEBUG = prevFlag;
	});

	it("traces request and success phases on a successful synthesis", async () => {
		process.env.ELIZA_TTS_DEBUG = "1";
		listen();
		const useModel = vi.fn().mockResolvedValue(wavBytes());
		const state: CompatRuntimeState = {
			current: { useModel } as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		await handleLocalInferenceTtsRoute(
			fakeReq({ text: "Trace this line", voiceId: "narrator" }),
			out.res,
			state,
		);

		expect(out.status()).toBe(200);
		const msgs = ttsLines().map((entry) => entry.msg);
		expect(
			msgs.some((m) => m.includes("[eliza][tts] server:local-tts:request")),
		).toBe(true);
		expect(
			msgs.some((m) => m.includes("[eliza][tts] server:local-tts:success")),
		).toBe(true);
		expect(msgs.some((m) => m.includes("Trace this line"))).toBe(true);
		expect(msgs.some((m) => m.includes("narrator"))).toBe(true);
	});

	it("traces a reject phase when synthesis fails", async () => {
		process.env.ELIZA_TTS_DEBUG = "1";
		listen();
		const useModel = vi.fn().mockRejectedValue(new Error("kokoro exploded"));
		const state: CompatRuntimeState = {
			current: { useModel } as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		await handleLocalInferenceTtsRoute(
			fakeReq({ text: "Hello" }),
			out.res,
			state,
		);

		expect(out.res.statusCode).toBe(502);
		const reject = ttsLines().find((entry) =>
			entry.msg.includes("server:local-tts:reject"),
		);
		expect(reject).toBeDefined();
		expect(reject?.msg).toContain("synthesis_failed");
		expect(reject?.msg).toContain("kokoro exploded");
	});

	it("traces a reject phase when the runtime is unavailable", async () => {
		process.env.ELIZA_TTS_DEBUG = "1";
		listen();
		const state: CompatRuntimeState = { current: null };
		const out = fakeRes();

		await handleLocalInferenceTtsRoute(
			fakeReq({ text: "Hello" }),
			out.res,
			state,
		);

		expect(out.res.statusCode).toBe(503);
		const reject = ttsLines().find((entry) =>
			entry.msg.includes("server:local-tts:reject"),
		);
		expect(reject?.msg).toContain("runtime_unavailable");
	});

	it("stays silent when the flag is unset", async () => {
		delete process.env.ELIZA_TTS_DEBUG;
		listen();
		const useModel = vi.fn().mockResolvedValue(wavBytes());
		const state: CompatRuntimeState = {
			current: { useModel } as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		await handleLocalInferenceTtsRoute(
			fakeReq({ text: "Quiet run" }),
			out.res,
			state,
		);

		expect(out.status()).toBe(200);
		expect(ttsLines()).toHaveLength(0);
	});
});
