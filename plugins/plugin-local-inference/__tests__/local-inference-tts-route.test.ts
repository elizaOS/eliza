import * as http from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "../src/routes/compat-helpers";
import {
	handleLocalInferenceTtsRoute,
	sanitizeLocalInferenceSpeechText,
} from "../src/routes/local-inference-tts-route";

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

function fakeRes(): {
	res: http.ServerResponse;
	bodyBuffer: () => Buffer;
	bodyJson: () => unknown;
	status: () => number;
	header: (name: string) => string | undefined;
} {
	const req = new http.IncomingMessage(new Socket());
	const res = new http.ServerResponse(req);
	let body = Buffer.alloc(0);
	let status = 200;
	const headers = new Map<string, string>();
	res.setHeader = ((name: string, value: number | string | readonly string[]) => {
		headers.set(String(name).toLowerCase(), String(value));
		return res;
	}) as typeof res.setHeader;
	res.writeHead = ((code: number, values?: http.OutgoingHttpHeaders) => {
		status = code;
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
		bodyJson: () => (body.length ? JSON.parse(body.toString("utf8")) : null),
		status: () => status,
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

		expect(handled).toBe(true);
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(useModel.mock.calls[1]?.[2]).toBe("capacitor-llama");
		expect(useModel.mock.calls[1]?.[1]).toMatchObject({ text: "Hello" });
		expect(useModel.mock.calls[1]?.[1].signal).toBeInstanceOf(AbortSignal);
		expect(out.status()).toBe(200);
		expect(out.header("content-type")).toBe("audio/wav");
		expect(out.bodyBuffer()).toEqual(Buffer.from(wavBytes()));
	});

	it("aborts TTS on client close without writing a synthetic 502", async () => {
		let aborted = false;
		const req = fakeReq({ text: "Hello" });
		const useModel = vi.fn((_type, params: { signal?: AbortSignal }) => {
			return new Promise<Uint8Array>((_resolve, reject) => {
				params.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(new Error("aborted"));
					},
					{ once: true },
				);
				queueMicrotask(() => req.emit("close"));
			});
		});
		const state: CompatRuntimeState = {
			current: { useModel } as unknown as CompatRuntimeState["current"],
		};
		const out = fakeRes();

		const handledPromise = handleLocalInferenceTtsRoute(req, out.res, state);
		await expect(handledPromise).resolves.toBe(true);

		expect(aborted).toBe(true);
		expect(out.bodyBuffer().length).toBe(0);
	});
});
