/**
 * DELETE /api/local-inference/downloads/:id decoded the raw URL.pathname
 * segment with decodeURIComponent. A malformed percent-escape threw URIError
 * into the agent route kernel, which maps unknown errors to HTTP 500.
 */
import { EventEmitter } from "node:events";
import type http from "node:http";
import { describe, expect, test } from "bun:test";
import { handleLocalInferenceRoutes } from "./local-inference-routes.ts";

function makeReq(method: string, url: string): http.IncomingMessage {
	const req = new EventEmitter() as EventEmitter & {
		method: string;
		url: string;
		headers: Record<string, string>;
	};
	req.method = method;
	req.url = url;
	req.headers = {};
	return req as unknown as http.IncomingMessage;
}

function makeRes(): http.ServerResponse & {
	json: () => unknown;
} {
	let body = "";
	const res = {
		statusCode: 200,
		setHeader() {},
		writeHead(statusCode: number) {
			this.statusCode = statusCode;
			return this;
		},
		end(chunk?: unknown) {
			if (chunk !== undefined) body += String(chunk);
			return this;
		},
		json() {
			return JSON.parse(body);
		},
	};
	return res as unknown as http.ServerResponse & { json: () => unknown };
}

describe("local-inference download path encoding", () => {
	test("returns 400 instead of 500 for a malformed download id", async () => {
		const res = makeRes();
		await expect(
			handleLocalInferenceRoutes(
				makeReq("DELETE", "/api/local-inference/downloads/%ZZ"),
				res,
			),
		).resolves.toBe(true);
		expect(res.statusCode).toBe(400);
		expect(res.json()).toEqual({
			error: "Invalid model id: malformed URL encoding",
		});
	});

	test("canonical download id still cancels", async () => {
		const res = makeRes();
		await expect(
			handleLocalInferenceRoutes(
				makeReq("DELETE", "/api/local-inference/downloads/demo-model"),
				res,
			),
		).resolves.toBe(true);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ cancelled: true });
	});
});
