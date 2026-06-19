/**
 * live-diarization-route unit tests (HTTP-level, no GGUF models).
 *
 * Exercises the WebView → agent transport route's request/response contract:
 *   - loopback (trusted-local) auth pass-through;
 *   - non-loopback rejection (401);
 *   - frame-shape validation (rejects malformed frames);
 *   - the status route surfaces the model/lib resolution (and, on a host with
 *     no on-device GGUFs, the precise "voice GGUFs missing" blocker — the same
 *     readiness payload the device read returns).
 *
 * The model-heavy path (real ggml VAD/encoder/diarizer) is covered by the
 * host smoke harness (`packages/app-core/scripts/voice-attribution-smoke.ts`),
 * which exercises the same AudioFrameConsumer with real models.
 */

import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { CompatRuntimeState } from "./compat-helpers.js";
import {
	handleLiveDiarizationRoute,
	resetLiveDiarizationSession,
} from "./live-diarization-route.js";

class FakeRes {
	statusCode = 200;
	headersSent = false;
	private readonly headers = new Map<string, string>();
	body = "";
	ended = false;
	setHeader(name: string, value: string): void {
		this.headers.set(name.toLowerCase(), value);
	}
	end(chunk?: string): void {
		if (chunk) this.body += chunk;
		this.ended = true;
		this.headersSent = true;
	}
	json(): unknown {
		return JSON.parse(this.body);
	}
}

function makeReq(opts: {
	method: string;
	url: string;
	body?: unknown;
	remoteAddress?: string;
	host?: string;
}): http.IncomingMessage {
	const payload = opts.body !== undefined ? JSON.stringify(opts.body) : "";
	const stream = Readable.from(payload ? [Buffer.from(payload)] : []);
	const req = stream as unknown as http.IncomingMessage & {
		method: string;
		url: string;
		headers: Record<string, string>;
		socket: { remoteAddress: string };
	};
	req.method = opts.method;
	req.url = opts.url;
	req.headers = { host: opts.host ?? "127.0.0.1:31337" };
	req.socket = { remoteAddress: opts.remoteAddress ?? "127.0.0.1" } as never;
	return req;
}

const runtimeState = (): CompatRuntimeState => ({
	current: {
		emitEvent: async () => {},
	} as never,
});

/** A well-formed AudioFrameEvent (20 ms silence frame). */
function silentFrame(frameIndex: number) {
	const samples = 320;
	const pcm16 = Buffer.alloc(samples * 2).toString("base64");
	return {
		pcm16,
		sampleRate: 16_000,
		channels: 1,
		samples,
		rms: 0,
		timestamp: frameIndex * 20,
		frameIndex,
	};
}

afterEach(async () => {
	await resetLiveDiarizationSession();
});

describe("handleLiveDiarizationRoute", () => {
	it("returns false for an unrelated path (passes through)", async () => {
		const res = new FakeRes();
		const handled = await handleLiveDiarizationRoute(
			makeReq({ method: "GET", url: "/api/unrelated" }),
			res as unknown as http.ServerResponse,
			runtimeState(),
		);
		expect(handled).toBe(false);
		expect(res.ended).toBe(false);
	});

	it("rejects a non-loopback caller with 401", async () => {
		const res = new FakeRes();
		const handled = await handleLiveDiarizationRoute(
			makeReq({
				method: "GET",
				url: "/api/voice/audio-frames/status",
				remoteAddress: "10.0.0.5",
				host: "example.com",
			}),
			res as unknown as http.ServerResponse,
			runtimeState(),
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(401);
	});

	it("status route surfaces model/lib resolution (blocker on a host without device GGUFs)", async () => {
		const res = new FakeRes();
		const handled = await handleLiveDiarizationRoute(
			makeReq({ method: "GET", url: "/api/voice/audio-frames/status" }),
			res as unknown as http.ServerResponse,
			runtimeState(),
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const status = res.json() as {
			ready: boolean;
			libs: { fusedInference: string | null };
			models: { dir: string };
			framesReceived: number;
			turnsObserved: number;
			error?: string;
		};
		// On CI/host there is no fused libelizainference, so readiness fails with
		// a precise blocker rather than a silent default — the device-evidence
		// read. The session now runs the whole stack (VAD/encoder/diarizer)
		// through the one fused FFI handle, not separate bun:ffi-musl libs.
		expect(typeof status.models.dir).toBe("string");
		expect("fusedInference" in status.libs).toBe(true);
		expect(status.framesReceived).toBe(0);
		expect(status.turnsObserved).toBe(0);
		if (!status.ready) {
			expect(status.error).toMatch(
				/fused libelizainference|ABI|FFI|libelizainference/i,
			);
		}
	});

	it("rejects a malformed frame batch with 400", async () => {
		const res = new FakeRes();
		const handled = await handleLiveDiarizationRoute(
			makeReq({
				method: "POST",
				url: "/api/voice/audio-frames",
				body: { frames: [{ pcm16: "AA==" /* missing fields */ }] },
			}),
			res as unknown as http.ServerResponse,
			runtimeState(),
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		expect((res.json() as { error: string }).error).toMatch(/Malformed/);
	});

	it("rejects a non-array frames field with 400", async () => {
		const res = new FakeRes();
		const handled = await handleLiveDiarizationRoute(
			makeReq({
				method: "POST",
				url: "/api/voice/audio-frames",
				body: { frames: "nope" },
			}),
			res as unknown as http.ServerResponse,
			runtimeState(),
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("accepts a well-formed batch shape (validation passes before model build)", async () => {
		// Well-formed frames clear the route's shape gate. Without on-device GGUFs
		// the session build then throws; the route surfaces that as a 500-class
		// failure, NOT a 400 — proving the wire contract is satisfied.
		const res = new FakeRes();
		const handled = await handleLiveDiarizationRoute(
			makeReq({
				method: "POST",
				url: "/api/voice/audio-frames",
				body: { frames: [silentFrame(0), silentFrame(1)] },
			}),
			res as unknown as http.ServerResponse,
			runtimeState(),
		).catch(() => "threw");
		// Either it threw inside ingest (no models) or returned true; either way
		// the request was NOT rejected as malformed (no 400).
		expect(res.statusCode).not.toBe(400);
		expect(handled === true || handled === "threw").toBe(true);
	});

	it("returns 503 when the runtime is not ready", async () => {
		const res = new FakeRes();
		const handled = await handleLiveDiarizationRoute(
			makeReq({ method: "GET", url: "/api/voice/audio-frames/status" }),
			res as unknown as http.ServerResponse,
			{ current: null },
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(503);
	});
});
