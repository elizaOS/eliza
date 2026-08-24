/**
 * Exercises the shared HTTP body reader through real Node request streams,
 * including per-reader byte budgets after the request body has been memoized.
 */
import http from "node:http";
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.js";
import {
	isJsonObjectBody,
	readJsonBody,
	readRequestBody,
	readRequestBodyBuffer,
	sendJson,
	sendJsonError,
	writeJsonError,
	writeJsonResponse,
} from "./http-helpers.js";

interface IncomingRequestResult<T> {
	inspection: T;
	responseBody: string;
	status: number;
}

async function withIncomingRequest<T>(
	body: string,
	inspect: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<T>,
): Promise<IncomingRequestResult<T>> {
	let resolveInspection: (value: T) => void;
	let rejectInspection: (reason: unknown) => void;
	const inspection = new Promise<T>((resolve, reject) => {
		resolveInspection = resolve;
		rejectInspection = reject;
	});

	const server = http.createServer(async (req, res) => {
		try {
			resolveInspection(await inspect(req, res));
			if (!res.writableEnded) res.end("ok");
		} catch (error) {
			rejectInspection(error);
			res.statusCode = 500;
			res.end("inspection failed");
		}
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("HTTP test server did not expose a TCP address");
	}

	try {
		const response = await fetch(`http://127.0.0.1:${address.port}`, {
			body,
			method: "POST",
		});
		const responseBody = await response.text();
		return {
			inspection: await inspection,
			responseBody,
			status: response.status,
		};
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}

describe("readRequestBodyBuffer", () => {
	it("rejects a cached body that exceeds a later reader's byte budget without rewriting it", async () => {
		const { inspection: observation } = await withIncomingRequest(
			"12345678",
			async (req) => {
				const first = await readRequestBodyBuffer(req, { maxBytes: 16 });
				let strictError: unknown;
				try {
					await readRequestBodyBuffer(req, { maxBytes: 4 });
				} catch (error) {
					strictError = error;
				}
				const replay = await readRequestBodyBuffer(req, { maxBytes: 8 });
				return { first, replay, strictError };
			},
		);

		expect(observation.strictError).toBeInstanceOf(ElizaError);
		expect(observation.strictError).toMatchObject({
			code: "HTTP_REQUEST_BODY_TOO_LARGE",
			context: { maxBytes: 4, observedBytes: 8 },
		});
		expect(observation.first?.toString("utf8")).toBe("12345678");
		expect(observation.replay?.toString("utf8")).toBe("12345678");
	});

	it("returns null for an oversized cached body only when explicitly requested", async () => {
		const { inspection: observation } = await withIncomingRequest(
			"cached",
			async (req) => {
				await readRequestBodyBuffer(req, { maxBytes: 16 });
				const strict = await readRequestBodyBuffer(req, {
					maxBytes: 3,
					returnNullOnTooLarge: true,
				});
				const replay = await readRequestBodyBuffer(req, { maxBytes: 6 });
				return { replay, strict };
			},
		);

		expect(observation.strict).toBeNull();
		expect(observation.replay?.toString("utf8")).toBe("cached");
	});

	it("uses the same typed rejection for a first read over budget", async () => {
		const { inspection: error } = await withIncomingRequest(
			"uncached",
			async (req) => {
				try {
					await readRequestBodyBuffer(req, { maxBytes: 4 });
					return null;
				} catch (caught) {
					return caught;
				}
			},
		);

		expect(error).toBeInstanceOf(ElizaError);
		expect(error).toMatchObject({
			code: "HTTP_REQUEST_BODY_TOO_LARGE",
			context: { maxBytes: 4, observedBytes: 8 },
		});
	});

	it("rechecks a cached JSON body's byte budget before returning parsed data", async () => {
		const outcome = await withIncomingRequest(
			'{"message":"complete"}',
			async (req, res) => {
				const first = await readJsonBody(req, res, { maxBytes: 64 });
				const strict = await readJsonBody(req, res, {
					maxBytes: 4,
					readErrorMessage: "Request body exceeds this route's limit",
				});
				return { first, strict };
			},
		);

		expect(outcome.inspection.first).toEqual({ message: "complete" });
		expect(outcome.inspection.strict).toBeNull();
		expect(outcome.status).toBe(413);
		expect(outcome.responseBody).toBe(
			JSON.stringify({ error: "Request body exceeds this route's limit" }),
		);
	});
});

describe("isJsonObjectBody", () => {
	it("returns true for plain objects and false for arrays, null, or primitives", () => {
		expect(isJsonObjectBody({ key: "val" })).toBe(true);
		expect(isJsonObjectBody({})).toBe(true);
		expect(isJsonObjectBody([])).toBe(false);
		expect(isJsonObjectBody([1, 2, 3])).toBe(false);
		expect(isJsonObjectBody(null)).toBe(false);
		expect(isJsonObjectBody(undefined)).toBe(false);
		expect(isJsonObjectBody("string")).toBe(false);
		expect(isJsonObjectBody(123)).toBe(false);
	});
});

describe("writeJsonResponse and writeJsonError", () => {
	it("writes JSON payload and headers correctly", async () => {
		const outcome = await withIncomingRequest("", async (_req, res) => {
			await writeJsonResponse(res, { status: "ok" }, 201);
		});

		expect(outcome.status).toBe(201);
		expect(outcome.responseBody).toBe(JSON.stringify({ status: "ok" }));
	});

	it("writes structured error payload and default status 400", async () => {
		const outcome = await withIncomingRequest("", async (_req, res) => {
			await writeJsonError(res, "Bad request", 400);
		});

		expect(outcome.status).toBe(400);
		expect(outcome.responseBody).toBe(JSON.stringify({ error: "Bad request" }));
	});

	it("sendJson and sendJsonError fire-and-forget responders write responses safely", async () => {
		const outcomeSuccess = await withIncomingRequest("", async (_req, res) => {
			sendJson(res, { ack: true }, 200);
		});
		expect(outcomeSuccess.status).toBe(200);
		expect(outcomeSuccess.responseBody).toBe(JSON.stringify({ ack: true }));

		const outcomeError = await withIncomingRequest("", async (_req, res) => {
			sendJsonError(res, "Forbidden", 403);
		});
		expect(outcomeError.status).toBe(403);
		expect(outcomeError.responseBody).toBe(
			JSON.stringify({ error: "Forbidden" }),
		);
	});
});

describe("readRequestBody and readJsonBody error handling", () => {
	it("readRequestBody returns string body text", async () => {
		const outcome = await withIncomingRequest("hello world", async (req) =>
			readRequestBody(req),
		);
		expect(outcome.inspection).toBe("hello world");
	});

	it("readJsonBody handles malformed JSON and writes 400 parse error response", async () => {
		const outcome = await withIncomingRequest(
			"not-json-at-all",
			async (req, res) => readJsonBody(req, res),
		);
		expect(outcome.inspection).toBeNull();
		expect(outcome.status).toBe(400);
		expect(outcome.responseBody).toBe(
			JSON.stringify({ error: "Invalid JSON in request body" }),
		);
	});

	it("readJsonBody rejects non-object JSON when requireObject is true", async () => {
		const outcome = await withIncomingRequest(
			'["array","item"]',
			async (req, res) => readJsonBody(req, res, { requireObject: true }),
		);
		expect(outcome.inspection).toBeNull();
		expect(outcome.status).toBe(400);
		expect(outcome.responseBody).toBe(
			JSON.stringify({ error: "Request body must be a JSON object" }),
		);
	});

	it("readJsonBody permits array JSON when requireObject is false", async () => {
		const outcome = await withIncomingRequest(
			'["item1","item2"]',
			async (req, res) => readJsonBody(req, res, { requireObject: false }),
		);
		expect(outcome.inspection).toEqual(["item1", "item2"]);
	});
});
