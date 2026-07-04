/**
 * Unit tests for the platform-neutral NDJSON stdio bridge.
 *
 * They drive the framing and dispatch loop with fake buffered and streaming
 * handlers, while the full iOS CLI wiring remains covered by the bridge route
 * tests.
 */

import { describe, expect, it } from "vitest";
import {
	createStdioBridge,
	type StdioBridgeResponseFrame,
	type StdioBridgeStreamHandler,
} from "./stdio-bridge.ts";

/** Collect written frames and feed NDJSON input in one shot. */
function harness(
	handler: (request: unknown) => Promise<unknown>,
	opts: { intercept?: (line: string) => boolean } = {},
) {
	const frames: StdioBridgeResponseFrame[] = [];
	const bridge = createStdioBridge({
		request: handler,
		writeFrame: (frame) => frames.push(frame),
		interceptLine: opts.intercept,
	});
	return { frames, bridge };
}

/** Collect frames from a bridge with both buffered + streaming handlers. */
function streamHarness(
	streamHandler: StdioBridgeStreamHandler,
	bufferedHandler: (request: unknown) => Promise<unknown> = async () => ({
		status: 200,
	}),
) {
	const frames: StdioBridgeResponseFrame[] = [];
	const bridge = createStdioBridge({
		request: bufferedHandler,
		requestStream: streamHandler,
		writeFrame: (frame) => frames.push(frame),
	});
	return { frames, bridge };
}

describe("createStdioBridge — buffered NDJSON round-trip", () => {
	it("dispatches an http_request for /api/health and writes the response frame", async () => {
		const { frames, bridge } = harness(async (request) => {
			const req = request as { method?: string; payload?: { path?: string } };
			// Fake in-process dispatchRoute: only /api/health here.
			if (
				req.method === "http_request" &&
				req.payload?.path === "/api/health"
			) {
				return { status: 200, body: JSON.stringify({ ok: true }) };
			}
			throw new Error("unexpected route");
		});

		await bridge.handleLine(
			JSON.stringify({
				id: "req-1",
				method: "http_request",
				payload: { path: "/api/health", method: "GET" },
			}),
		);
		await bridge.drain();

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({
			id: "req-1",
			ok: true,
			result: { status: 200, body: JSON.stringify({ ok: true }) },
		});
	});

	it("preserves the request id (null when absent) on the response frame", async () => {
		const { frames, bridge } = harness(async () => ({ status: 204 }));
		await bridge.handleLine(JSON.stringify({ method: "http_request" }));
		await bridge.drain();
		expect(frames[0]?.id).toBeNull();
		expect(frames[0]?.ok).toBe(true);
	});

	it("ignores blank lines", async () => {
		const { frames, bridge } = harness(async () => ({ status: 200 }));
		await bridge.handleLine("");
		await bridge.handleLine("   ");
		await bridge.drain();
		expect(frames).toHaveLength(0);
	});

	it("emits an error frame for malformed JSON without dispatching", async () => {
		let dispatched = false;
		const { frames, bridge } = harness(async () => {
			dispatched = true;
			return {};
		});
		await bridge.handleLine("{ not json");
		await bridge.drain();
		expect(dispatched).toBe(false);
		expect(frames).toHaveLength(1);
		expect(frames[0]?.ok).toBe(false);
		expect(frames[0]?.id).toBeNull();
		expect(typeof frames[0]?.error).toBe("string");
	});

	it("translates a handler throw into an error frame keyed to the request id", async () => {
		const { frames, bridge } = harness(async () => {
			throw new Error("route blew up");
		});
		await bridge.handleLine(JSON.stringify({ id: 7, method: "http_request" }));
		await bridge.drain();
		expect(frames[0]).toEqual({ id: 7, ok: false, error: "route blew up" });
	});

	it("dispatches lines in request order", async () => {
		const seen: number[] = [];
		const { frames, bridge } = harness(async (request) => {
			const id = (request as { id: number }).id;
			// Reverse the natural resolution order to prove serialization.
			await new Promise((r) => setTimeout(r, id === 1 ? 20 : 0));
			seen.push(id);
			return { status: 200 };
		});
		void bridge.handleLine(JSON.stringify({ id: 1, method: "http_request" }));
		void bridge.handleLine(JSON.stringify({ id: 2, method: "http_request" }));
		await bridge.drain();
		expect(seen).toEqual([1, 2]);
		expect(frames.map((f) => f.id)).toEqual([1, 2]);
	});

	it("skips dispatch for lines claimed by interceptLine", async () => {
		let dispatched = 0;
		const { frames, bridge } = harness(
			async () => {
				dispatched += 1;
				return { status: 200 };
			},
			{ intercept: (line) => line.startsWith("HOSTRESULT ") },
		);
		await bridge.handleLine("HOSTRESULT {}");
		await bridge.handleLine(JSON.stringify({ id: 1, method: "http_request" }));
		await bridge.drain();
		expect(dispatched).toBe(1);
		expect(frames.map((f) => f.id)).toEqual([1]);
	});
});

describe("createStdioBridge — incremental streaming", () => {
	it("routes a stream:true frame to requestStream and emits head/chunk/complete in order", async () => {
		const { frames, bridge } = streamHarness(async (_request, sink) => {
			sink.emitResponse({
				status: 200,
				statusText: "OK",
				headers: { "content-type": "text/event-stream" },
			});
			sink.emitChunk("Zm9v"); // "foo"
			sink.emitChunk("YmFy"); // "bar"
		});
		await bridge.handleLine(
			JSON.stringify({
				id: "s-1",
				method: "http_request_stream",
				stream: true,
				payload: { path: "/api/conversations/c/messages/stream" },
			}),
		);
		await bridge.drain();

		expect(frames).toEqual([
			{
				id: "s-1",
				stream: "response",
				status: 200,
				statusText: "OK",
				headers: { "content-type": "text/event-stream" },
			},
			{ id: "s-1", stream: "chunk", dataBase64: "Zm9v" },
			{ id: "s-1", stream: "chunk", dataBase64: "YmFy" },
			{ id: "s-1", stream: "complete" },
		]);
	});

	it("emits a terminal complete-with-error frame when the stream handler throws", async () => {
		const { frames, bridge } = streamHarness(async (_request, sink) => {
			sink.emitResponse({ status: 200, statusText: "OK", headers: {} });
			throw new Error("stream blew up");
		});
		await bridge.handleLine(
			JSON.stringify({ id: 9, method: "http_request_stream", stream: true }),
		);
		await bridge.drain();

		expect(frames.at(-1)).toEqual({
			id: 9,
			stream: "complete",
			error: "stream blew up",
		});
		// The head still made it out before the failure.
		expect(frames[0]?.stream).toBe("response");
	});

	it("does not double-terminate when a handler both completes and later emits", async () => {
		const { frames, bridge } = streamHarness(async (_request, sink) => {
			sink.emitResponse({ status: 200, statusText: "OK", headers: {} });
			sink.emitComplete();
			// Late writes after completion must be dropped, not re-terminate.
			sink.emitChunk("bGF0ZQ==");
			sink.emitError("late error");
		});
		await bridge.handleLine(
			JSON.stringify({
				id: "s-2",
				method: "http_request_stream",
				stream: true,
			}),
		);
		await bridge.drain();

		const completeFrames = frames.filter((f) => f.stream === "complete");
		expect(completeFrames).toHaveLength(1);
		expect(completeFrames[0]).toEqual({ id: "s-2", stream: "complete" });
	});

	it("falls back to the buffered handler when no requestStream is wired", async () => {
		const frames: StdioBridgeResponseFrame[] = [];
		const bridge = createStdioBridge({
			request: async () => ({ status: 200, body: "buffered" }),
			writeFrame: (frame) => frames.push(frame),
		});
		await bridge.handleLine(
			JSON.stringify({ id: "s-3", method: "http_request", stream: true }),
		);
		await bridge.drain();
		expect(frames).toEqual([
			{ id: "s-3", ok: true, result: { status: 200, body: "buffered" } },
		]);
	});
});
