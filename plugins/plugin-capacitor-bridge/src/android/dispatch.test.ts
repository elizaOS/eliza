import type { IAgentRuntime, RouteHandlerResult } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { StdioBridgeStreamSink } from "../shared/stdio-bridge.ts";
import {
	type AndroidDispatchRoute,
	dispatchBufferedRequest,
	dispatchStreamingRequest,
} from "./dispatch.ts";

/**
 * Unit tests for the Android in-process route dispatch (#12352). They drive
 * `dispatchBufferedRequest` / `dispatchStreamingRequest` against a fake
 * `dispatchRoute` standing in for the real in-process kernel — no runtime boot,
 * no device — asserting the loopback-shaped buffered envelope and the
 * incremental streaming sink lifecycle the WebView contract depends on.
 */

const runtime = {} as IAgentRuntime;

/** A dispatchRoute that returns a fixed buffered result for the matched path. */
function fixedRoute(
	result: RouteHandlerResult | null,
): { route: AndroidDispatchRoute; calls: Array<Record<string, unknown>> } {
	const calls: Array<Record<string, unknown>> = [];
	const route: AndroidDispatchRoute = async (args) => {
		calls.push(args as unknown as Record<string, unknown>);
		return result;
	};
	return { route, calls };
}

function collectSink(): {
	sink: StdioBridgeStreamSink;
	events: Array<Record<string, unknown>>;
} {
	const events: Array<Record<string, unknown>> = [];
	const sink: StdioBridgeStreamSink = {
		emitResponse: (head) => events.push({ kind: "response", ...head }),
		emitChunk: (dataBase64) => events.push({ kind: "chunk", dataBase64 }),
		emitComplete: () => events.push({ kind: "complete" }),
		emitError: (message) => events.push({ kind: "error", message }),
	};
	return { sink, events };
}

describe("dispatchBufferedRequest", () => {
	it("returns the loopback-shaped envelope for a JSON route", async () => {
		const { route, calls } = fixedRoute({
			status: 200,
			headers: { "content-type": "application/json; charset=utf-8" },
			body: { ok: true },
		});
		const res = await dispatchBufferedRequest(runtime, route, {
			method: "GET",
			path: "/api/health",
		});
		expect(res.status).toBe(200);
		expect(res.statusText).toBe("OK");
		expect(res.bodyEncoding).toBe("base64");
		// body is stringified JSON; bodyBase64 round-trips to the same bytes.
		expect(JSON.parse(res.body)).toEqual({ ok: true });
		expect(Buffer.from(res.bodyBase64, "base64").toString("utf8")).toBe(
			res.body,
		);
		// dispatchRoute saw an authorized in-process call on the parsed path.
		expect(calls[0]?.inProcess).toBe(true);
		expect(calls[0]?.path).toBe("/api/health");
	});

	it("splits query params off the path", async () => {
		const { route, calls } = fixedRoute({ status: 204 });
		await dispatchBufferedRequest(runtime, route, {
			method: "GET",
			path: "/api/memories?table=facts&limit=5",
		});
		expect(calls[0]?.path).toBe("/api/memories");
		expect(calls[0]?.query).toEqual({ table: "facts", limit: "5" });
	});

	it("returns a 404 envelope when no route matches", async () => {
		const { route } = fixedRoute(null);
		const res = await dispatchBufferedRequest(runtime, route, {
			method: "GET",
			path: "/api/nope",
		});
		expect(res.status).toBe(404);
		expect(JSON.parse(res.body).code).toBe("not_found");
	});

	it("rejects an absolute or unsafe path", async () => {
		const { route } = fixedRoute({ status: 200 });
		await expect(
			dispatchBufferedRequest(runtime, route, {
				method: "GET",
				path: "http://evil/api",
			}),
		).rejects.toThrow(/path that starts with/);
		await expect(
			dispatchBufferedRequest(runtime, route, {
				method: "GET",
				path: "//evil",
			}),
		).rejects.toThrow(/path that starts with/);
	});

	it("preserves raw binary bytes losslessly through bodyBase64", async () => {
		// A non-UTF-8 byte sequence (e.g. WAV/PNG) must survive the bridge.
		const raw = Buffer.from([0xff, 0x00, 0x80, 0x7f]);
		const { route } = fixedRoute({ status: 200, body: raw });
		const res = await dispatchBufferedRequest(runtime, route, {
			method: "GET",
			path: "/api/tts/local-inference",
		});
		expect(Buffer.from(res.bodyBase64, "base64").equals(raw)).toBe(true);
	});
});

describe("dispatchStreamingRequest", () => {
	it("emits response head then base64 chunks for a return-shape stream", async () => {
		async function* frames(): AsyncGenerator<string> {
			yield "data: hello\n\n";
			yield "data: world\n\n";
		}
		const { route } = fixedRoute({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			stream: frames(),
		});
		const { sink, events } = collectSink();
		await dispatchStreamingRequest(
			runtime,
			route,
			{ method: "POST", path: "/api/conversations/c/messages/stream" },
			sink,
		);
		expect(events[0]).toMatchObject({ kind: "response", status: 200 });
		expect(events.slice(1).map((e) => e.kind)).toEqual(["chunk", "chunk"]);
		expect(
			Buffer.from(events[1]?.dataBase64 as string, "base64").toString("utf8"),
		).toBe("data: hello\n\n");
	});

	it("forwards a legacy SSE handler's res.write fragments live via onChunk", async () => {
		// Simulate a legacy handler: dispatchRoute flushes fragments through the
		// onChunk sink before resolving (the real chat-stream handler's shape).
		const route: AndroidDispatchRoute = async (args) => {
			args.onChunk?.(Buffer.from("data: a\n\n", "utf8"));
			args.onChunk?.(Buffer.from("data: b\n\n", "utf8"));
			return { status: 200, headers: {}, body: "" };
		};
		const { sink, events } = collectSink();
		await dispatchStreamingRequest(
			runtime,
			route,
			{ method: "POST", path: "/api/conversations/c/messages/stream" },
			sink,
		);
		// Head emitted on the first write, then one chunk per fragment.
		expect(events[0]?.kind).toBe("response");
		const chunks = events.filter((e) => e.kind === "chunk");
		expect(chunks).toHaveLength(2);
		expect(
			Buffer.from(chunks[0]?.dataBase64 as string, "base64").toString("utf8"),
		).toBe("data: a\n\n");
	});

	it("streams a non-streaming buffered result as a single chunk", async () => {
		const { route } = fixedRoute({
			status: 200,
			headers: { "content-type": "application/json" },
			body: { done: true },
		});
		const { sink, events } = collectSink();
		await dispatchStreamingRequest(
			runtime,
			route,
			{ method: "POST", path: "/api/agents/x/message" },
			sink,
		);
		expect(events[0]?.kind).toBe("response");
		const chunks = events.filter((e) => e.kind === "chunk");
		expect(chunks).toHaveLength(1);
		expect(
			JSON.parse(
				Buffer.from(chunks[0]?.dataBase64 as string, "base64").toString("utf8"),
			),
		).toEqual({ done: true });
	});

	it("emits a 404 head + body when no route matches a stream", async () => {
		const { route } = fixedRoute(null);
		const { sink, events } = collectSink();
		await dispatchStreamingRequest(
			runtime,
			route,
			{ method: "POST", path: "/api/nope/stream" },
			sink,
		);
		expect(events[0]).toMatchObject({ kind: "response", status: 404 });
	});
});
