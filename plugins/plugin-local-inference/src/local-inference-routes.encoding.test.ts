/** Exercises malformed request input with deterministic route collaborators. */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type http from "node:http";
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

describe("local-inference model path encoding", () => {
	test.each([
		["DELETE", "/api/local-inference/downloads/%ZZ"],
		["DELETE", "/api/local-inference/downloads/%"],
		["POST", "/api/local-inference/installed/%ZZ/verify"],
		["DELETE", "/api/local-inference/installed/%ZZ"],
	])("returns 400 for malformed path input on %s %s", async (method, path) => {
		const res = makeRes();
		await expect(
			handleLocalInferenceRoutes(makeReq(method, path), res),
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
				makeReq("DELETE", "/api/local-inference/downloads/demo%2Dmodel"),
				res,
			),
		).resolves.toBe(true);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ cancelled: true });
	});
});
