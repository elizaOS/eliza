/**
 * Unit tests for the e2e HTTP helper: validates readConversationId extraction
 * and failure branches, req() wire behavior against a real loopback server
 * (content-type resolution, body serialization, extra headers, JSON parsing,
 * non-JSON fallback, status propagation, timeouts, refused connections), and
 * the createConversation / postConversationMessage wrappers.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createConversation,
	type HttpRequestOptions,
	postConversationMessage,
	readConversationId,
	req,
} from "./http.ts";

type RecordedRequest = {
	method: string;
	url: string | undefined;
	headers: http.IncomingHttpHeaders;
	rawBody: string;
};

type ResponderOutcome = {
	status?: number;
	contentType?: string;
	body: string;
};

let server: http.Server;
let port: number;
let lastRequest: RecordedRequest | undefined;
let responder: (request: RecordedRequest) => ResponderOutcome | undefined;

beforeAll(async () => {
	server = http.createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			lastRequest = {
				method: request.method ?? "",
				url: request.url,
				headers: request.headers,
				rawBody: Buffer.concat(chunks).toString("utf-8"),
			};
			if (lastRequest.url?.startsWith("/hold")) {
				return;
			}
			const outcome = responder(lastRequest);
			if (!outcome) {
				return;
			}
			response.statusCode = outcome.status ?? 200;
			if (outcome.contentType) {
				response.setHeader("Content-Type", outcome.contentType);
			}
			response.end(outcome.body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("loopback server did not report a numeric port");
	}
	port = address.port;
});

afterAll(() => {
	server.closeAllConnections();
	return new Promise<void>((resolve) => server.close(() => resolve()));
});

function jsonResponder(body: unknown, status?: number): ResponderOutcome {
	return {
		status,
		contentType: "application/json",
		body: JSON.stringify(body),
	};
}

describe("readConversationId", () => {
	it("returns the id from a well-formed conversation object", () => {
		expect(readConversationId({ conversation: { id: "conv-42" } })).toBe(
			"conv-42",
		);
	});

	it("throws when the conversation key is absent", () => {
		expect(() => readConversationId({})).toThrow(
			"Conversation response did not include an id",
		);
	});

	it("rejects arrays even when they contain an id field", () => {
		expect(() =>
			readConversationId({ conversation: [{ id: "conv-42" }] }),
		).toThrow("Conversation response did not include an id");
	});

	it("throws when the id is not a string", () => {
		expect(() => readConversationId({ conversation: { id: 7 } })).toThrow(
			"Conversation response did not include an id",
		);
	});

	it("throws when the id is an empty string", () => {
		expect(() => readConversationId({ conversation: { id: "" } })).toThrow(
			"Conversation response did not include an id",
		);
	});
});

describe("req", () => {
	it("serializes object bodies as JSON with the default content type and length", async () => {
		responder = () => jsonResponder({ ok: true });
		const payload = { hello: "world" };
		const response = await req(port, "POST", "/echo", payload);

		expect(response.status).toBe(200);
		expect(lastRequest?.method).toBe("POST");
		expect(lastRequest?.headers["content-type"]).toBe("application/json");
		expect(lastRequest?.rawBody).toBe(JSON.stringify(payload));
		expect(lastRequest?.headers["content-length"]).toBe(
			String(Buffer.byteLength(JSON.stringify(payload))),
		);
	});

	it("passes string bodies through verbatim", async () => {
		responder = () => jsonResponder({ ok: true });
		await req(port, "PUT", "/raw", "plain-text-body");

		expect(lastRequest?.rawBody).toBe("plain-text-body");
		expect(lastRequest?.headers["content-length"]).toBe(
			String(Buffer.byteLength("plain-text-body")),
		);
	});

	it("omits the body and content length when no body is given", async () => {
		responder = () => jsonResponder({ ok: true });
		const response = await req(port, "DELETE", "/nothing");

		expect(lastRequest?.method).toBe("DELETE");
		expect(lastRequest?.rawBody).toBe("");
		expect(lastRequest?.headers["content-length"]).toBeUndefined();
		expect(response.data).toEqual({ ok: true });
	});

	it("sends an empty string body with a zero content length", async () => {
		responder = () => jsonResponder({ ok: true });
		await req(port, "POST", "/empty", "");

		expect(lastRequest?.rawBody).toBe("");
		expect(lastRequest?.headers["content-length"]).toBe("0");
	});

	it("keeps application/json as content type when extra headers are an object", async () => {
		responder = () => jsonResponder({ ok: true });
		await req(port, "GET", "/h", undefined, { "X-Custom": "abc" });

		expect(lastRequest?.headers["content-type"]).toBe("application/json");
		expect(lastRequest?.headers["x-custom"]).toBe("abc");
	});

	it("uses a string header argument as the content type", async () => {
		responder = () => jsonResponder({ ok: true });
		await req(port, "POST", "/t", { a: 1 }, "text/plain");

		expect(lastRequest?.headers["content-type"]).toBe("text/plain");
	});

	it("parses JSON response payloads into data", async () => {
		responder = () => jsonResponder({ answer: 41, nested: { deep: true } });
		const response = await req(port, "GET", "/json");

		expect(response.status).toBe(200);
		expect(response.data).toEqual({ answer: 41, nested: { deep: true } });
		expect(response.headers["content-type"]).toBe("application/json");
	});

	it("wraps non-JSON response payloads under _raw", async () => {
		responder = () => ({
			contentType: "text/plain",
			body: "definitely not json",
		});
		const response = await req(port, "GET", "/text");

		expect(response.status).toBe(200);
		expect(response.data).toEqual({ _raw: "definitely not json" });
	});

	it("propagates non-2xx statuses and their parsed payloads", async () => {
		responder = () => jsonResponder({ error: "boom" }, 503);
		const response = await req(port, "GET", "/failing");

		expect(response.status).toBe(503);
		expect(response.data).toEqual({ error: "boom" });
	});

	it("rejects with a descriptive timeout error past timeoutMs", async () => {
		responder = () => undefined;
		const options: HttpRequestOptions = { timeoutMs: 60 };

		await expect(
			req(port, "GET", "/hold-connection", undefined, undefined, options),
		).rejects.toThrow("Request timed out after 60ms: GET /hold-connection");
	});

	it("rejects when nothing listens on the target port", async () => {
		const doomed = http.createServer();
		await new Promise<void>((resolve) =>
			doomed.listen(0, "127.0.0.1", resolve),
		);
		const deadAddress = doomed.address();
		if (!deadAddress || typeof deadAddress === "string") {
			throw new Error("probe server did not report a numeric port");
		}
		const deadPort = deadAddress.port;
		await new Promise<void>((resolve) => doomed.close(() => resolve()));

		responder = () => jsonResponder({ ok: true });
		await expect(req(deadPort, "GET", "/unreachable")).rejects.toThrow();
	});
});

describe("createConversation", () => {
	it("posts the options payload and surfaces the conversation id", async () => {
		responder = () => jsonResponder({ conversation: { id: "conv-9" } });
		const options = { title: "Hello", includeGreeting: true, lang: "en" };
		const response = await createConversation(port, options);

		expect(response.status).toBe(200);
		expect(response.conversationId).toBe("conv-9");
		expect(lastRequest?.method).toBe("POST");
		expect(lastRequest?.url).toBe("/api/conversations");
		expect(lastRequest?.rawBody).toBe(JSON.stringify(options));
	});

	it("forwards extra headers onto the request", async () => {
		responder = () => jsonResponder({ conversation: { id: "conv-9" } });
		await createConversation(
			port,
			{ title: "Hi" },
			{ Authorization: "Bearer t" },
		);

		expect(lastRequest?.headers.authorization).toBe("Bearer t");
	});

	it("rejects when the server response carries no conversation id", async () => {
		responder = () => jsonResponder({ unrelated: true });

		await expect(createConversation(port, {})).rejects.toThrow(
			"Conversation response did not include an id",
		);
	});
});

describe("postConversationMessage", () => {
	it("encodes the conversation id into the request path", async () => {
		responder = () => jsonResponder({ received: true });
		const body = { text: "hi there" };
		const response = await postConversationMessage(port, "a/b c", body);

		expect(response.status).toBe(200);
		expect(response.data).toEqual({ received: true });
		expect(lastRequest?.method).toBe("POST");
		expect(lastRequest?.url).toBe("/api/conversations/a%2Fb%20c/messages");
		expect(lastRequest?.rawBody).toBe(JSON.stringify(body));
	});

	it("passes raw string bodies and a string content type through", async () => {
		responder = () => jsonResponder({ received: true });
		await postConversationMessage(port, "c1", "line1\nline2", "text/csv");

		expect(lastRequest?.url).toBe("/api/conversations/c1/messages");
		expect(lastRequest?.rawBody).toBe("line1\nline2");
		expect(lastRequest?.headers["content-type"]).toBe("text/csv");
	});

	it("applies request options such as timeouts", async () => {
		responder = () => undefined;

		await expect(
			postConversationMessage(port, "c1", { text: "slow" }, undefined, {
				timeoutMs: 40,
			}),
		).rejects.toThrow(
			"Request timed out after 40ms: POST /api/conversations/c1/messages",
		);
	});
});
