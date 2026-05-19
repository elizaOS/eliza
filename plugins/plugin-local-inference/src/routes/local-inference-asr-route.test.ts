import * as http from "node:http";
import { Socket } from "node:net";
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-helpers";
import { handleLocalInferenceAsrRoute } from "./local-inference-asr-route";

function wavBytes(): Uint8Array {
	return new Uint8Array([
		0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
		0x66, 0x6d, 0x74, 0x20,
	]);
}

function fakeReq(body?: unknown): http.IncomingMessage {
	const req = new http.IncomingMessage(new Socket());
	req.method = "POST";
	req.url = "/api/asr/local-inference";
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
