import { describe, expect, it } from "vitest";
import {
	createStdioBridge,
	type StdioBridgeResponseFrame,
} from "./stdio-bridge.ts";

/**
 * Unit tests for the platform-neutral NDJSON stdio kernel (#12180). These drive
 * the framing/dispatch loop directly with a fake buffered request handler
 * standing in for the in-process `dispatchRoute` kernel, so they run with no
 * runtime boot and no device. The full iOS CLI wiring is exercised by
 * `../ios/bridge.routes.test.ts` (which must stay green after this extraction).
 */

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
