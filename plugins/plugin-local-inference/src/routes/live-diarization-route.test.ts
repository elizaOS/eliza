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

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { buildLiveDiarizationConsumerDeps } from "../services/voice/live-diarization-session.js";
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
	it("builds AudioFrameConsumer deps with an optional echoReference provider", () => {
		const echoReference = () => new Float32Array(320);
		const deps = buildLiveDiarizationConsumerDeps({
			vad: {
				inSpeech: false,
				onVadEvent: () => () => {},
				pushFrame: async () => {},
				flush: async () => {},
				reset: () => {},
			},
			pipeline: {
				attribute: async () => {
					throw new Error("not used");
				},
			},
			runtime: { emitEvent: async () => {} },
			echoReference,
		});
		expect(deps.echoReference).toBe(echoReference);
		expect(
			buildLiveDiarizationConsumerDeps({
				vad: deps.vad,
				pipeline: deps.pipeline,
				runtime: deps.runtime,
			}),
		).not.toHaveProperty("echoReference");
	});

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
			aec: {
				echoReferenceWired: boolean;
				playbackFramesReceived: number;
				playbackSamplesReceived: number;
				lastPlaybackFrameAt: number | null;
			};
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
		expect(status.aec.echoReferenceWired).toBe(false);
		expect(status.aec.playbackFramesReceived).toBe(0);
		expect(status.aec.playbackSamplesReceived).toBe(0);
		expect(status.aec.lastPlaybackFrameAt).toBeNull();
		if (!status.ready) {
			expect(status.error).toMatch(
				/fused libelizainference|ABI|FFI|libelizainference/i,
			);
		}
	});

	it("threads a runtime echoReference provider into live AEC status", async () => {
		const res = new FakeRes();
		const echoReference = () => new Float32Array(320);
		const handled = await handleLiveDiarizationRoute(
			makeReq({ method: "GET", url: "/api/voice/audio-frames/status" }),
			res as unknown as http.ServerResponse,
			{
				current: {
					emitEvent: async () => {},
					voiceEchoReferenceProvider: echoReference,
				} as never,
			},
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const status = res.json() as {
			aec: { echoReferenceWired: boolean; playbackFramesReceived: number };
		};
		// Provider-based wiring is truthful with zero playback frames: the host
		// owns the far-end capture, so no /api/voice/playback-frames traffic is
		// expected on this path.
		expect(status.aec.echoReferenceWired).toBe(true);
		expect(status.aec.playbackFramesReceived).toBe(0);
	});

	it("reports echoReferenceWired only after playback frames are actually delivered (#9583)", async () => {
		// Before any playback delivery the status must NOT claim a wired far-end.
		const statusBefore = new FakeRes();
		await handleLiveDiarizationRoute(
			makeReq({ method: "GET", url: "/api/voice/audio-frames/status" }),
			statusBefore as unknown as http.ServerResponse,
			runtimeState(),
		);
		expect(statusBefore.statusCode).toBe(200);
		const before = statusBefore.json() as {
			aec: {
				echoReferenceWired: boolean;
				playbackFramesReceived: number;
				lastPlaybackFrameAt: number | null;
			};
		};
		expect(before.aec.echoReferenceWired).toBe(false);
		expect(before.aec.playbackFramesReceived).toBe(0);
		expect(before.aec.lastPlaybackFrameAt).toBeNull();

		const push = new FakeRes();
		await handleLiveDiarizationRoute(
			makeReq({
				method: "POST",
				url: "/api/voice/playback-frames",
				body: { frames: [silentFrame(0), silentFrame(1)] },
			}),
			push as unknown as http.ServerResponse,
			runtimeState(),
		);
		expect(push.statusCode).toBe(200);
		expect(push.json()).toMatchObject({ ok: true, framesPushed: 2 });

		const statusAfter = new FakeRes();
		await handleLiveDiarizationRoute(
			makeReq({ method: "GET", url: "/api/voice/audio-frames/status" }),
			statusAfter as unknown as http.ServerResponse,
			runtimeState(),
		);
		expect(statusAfter.statusCode).toBe(200);
		const after = statusAfter.json() as {
			aec: {
				echoReferenceWired: boolean;
				playbackFramesReceived: number;
				playbackSamplesReceived: number;
				lastPlaybackFrameAt: number | null;
			};
		};
		expect(after.aec.echoReferenceWired).toBe(true);
		expect(after.aec.playbackFramesReceived).toBe(2);
		expect(after.aec.playbackSamplesReceived).toBe(640);
		expect(typeof after.aec.lastPlaybackFrameAt).toBe("number");
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

	it("accepts agent-playback (far-end) frames for echo cancellation", async () => {
		// Unlike the mic path, pushing playback needs no model build — it only
		// decodes + appends to the alignment buffer — so this exercises the full
		// route end-to-end on a host with no on-device GGUFs.
		const res = new FakeRes();
		const handled = await handleLiveDiarizationRoute(
			makeReq({
				method: "POST",
				url: "/api/voice/playback-frames",
				body: { frames: [silentFrame(0), silentFrame(1)] },
			}),
			res as unknown as http.ServerResponse,
			runtimeState(),
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ ok: true, framesPushed: 2 });
	});

	it("accepts a reset-only playback request (barge-in / playback stop)", async () => {
		const res = new FakeRes();
		const handled = await handleLiveDiarizationRoute(
			makeReq({
				method: "POST",
				url: "/api/voice/playback-frames",
				body: { reset: true },
			}),
			res as unknown as http.ServerResponse,
			runtimeState(),
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ ok: true, framesPushed: 0 });
	});

	it("resets stale playback before accepting a fresh playback batch", async () => {
		const res = new FakeRes();
		const handled = await handleLiveDiarizationRoute(
			makeReq({
				method: "POST",
				url: "/api/voice/playback-frames",
				body: { reset: true, frames: [silentFrame(0)] },
			}),
			res as unknown as http.ServerResponse,
			runtimeState(),
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ ok: true, framesPushed: 1 });
	});

	it("rejects malformed playback frames with 400", async () => {
		const res = new FakeRes();
		const handled = await handleLiveDiarizationRoute(
			makeReq({
				method: "POST",
				url: "/api/voice/playback-frames",
				body: { frames: [{ pcm16: "AA==" /* missing fields */ }] },
			}),
			res as unknown as http.ServerResponse,
			runtimeState(),
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
		expect((res.json() as { error: string }).error).toMatch(/Malformed/);
	});

	it("rejects a non-array playback frames field with 400", async () => {
		const res = new FakeRes();
		const handled = await handleLiveDiarizationRoute(
			makeReq({
				method: "POST",
				url: "/api/voice/playback-frames",
				body: { frames: "nope" },
			}),
			res as unknown as http.ServerResponse,
			runtimeState(),
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	describe("AEC evidence capture routes (#11373)", () => {
		it("arms, reports status, and snapshots the near/far window", async () => {
			// Arm — like playback push, arming needs no model build.
			const armRes = new FakeRes();
			await handleLiveDiarizationRoute(
				makeReq({
					method: "POST",
					url: "/api/voice/aec-capture",
					body: { arm: true, maxSeconds: 5 },
				}),
				armRes as unknown as http.ServerResponse,
				runtimeState(),
			);
			expect(armRes.statusCode).toBe(200);
			expect(armRes.json()).toMatchObject({
				ok: true,
				capture: { armed: true, sampleCount: 0, maxSamples: 80_000 },
			});

			const getRes = new FakeRes();
			const handled = await handleLiveDiarizationRoute(
				makeReq({ method: "GET", url: "/api/voice/aec-capture" }),
				getRes as unknown as http.ServerResponse,
				runtimeState(),
			);
			expect(handled).toBe(true);
			expect(getRes.statusCode).toBe(200);
			const snapshot = (
				getRes.json() as {
					capture: {
						armed: boolean;
						sampleRate: number;
						nearPcm16: string;
						farPcm16: string;
						echoDelaySamples: number;
					};
				}
			).capture;
			expect(snapshot.armed).toBe(true);
			expect(snapshot.sampleRate).toBe(16_000);
			expect(snapshot.nearPcm16).toBe("");
			expect(snapshot.farPcm16).toBe("");
			expect(typeof snapshot.echoDelaySamples).toBe("number");
		});

		it("disarms via { disarm: true }", async () => {
			const armRes = new FakeRes();
			await handleLiveDiarizationRoute(
				makeReq({
					method: "POST",
					url: "/api/voice/aec-capture",
					body: { arm: true },
				}),
				armRes as unknown as http.ServerResponse,
				runtimeState(),
			);
			const disarmRes = new FakeRes();
			await handleLiveDiarizationRoute(
				makeReq({
					method: "POST",
					url: "/api/voice/aec-capture",
					body: { disarm: true },
				}),
				disarmRes as unknown as http.ServerResponse,
				runtimeState(),
			);
			expect(disarmRes.statusCode).toBe(200);
			expect(disarmRes.json()).toMatchObject({
				ok: true,
				capture: { armed: false },
			});
		});

		it("rejects a body with neither arm nor disarm with 400", async () => {
			const res = new FakeRes();
			const handled = await handleLiveDiarizationRoute(
				makeReq({
					method: "POST",
					url: "/api/voice/aec-capture",
					body: { maxSeconds: 5 },
				}),
				res as unknown as http.ServerResponse,
				runtimeState(),
			);
			expect(handled).toBe(true);
			expect(res.statusCode).toBe(400);
		});

		it("rejects a non-loopback caller with 401", async () => {
			const res = new FakeRes();
			await handleLiveDiarizationRoute(
				makeReq({
					method: "GET",
					url: "/api/voice/aec-capture",
					remoteAddress: "203.0.113.7",
					host: "203.0.113.7:31337",
				}),
				res as unknown as http.ServerResponse,
				runtimeState(),
			);
			expect(res.statusCode).toBe(401);
		});

		it("mirrors a real capture to $ELIZA_STATE_DIR for bridge-free retrieval (#11373)", async () => {
			// The on-device iOS harness cannot land its result via the WebView
			// Capacitor Filesystem sink; the agent instead writes the near/far PCM
			// straight to the state dir where host tooling pulls it.
			const stateDir = mkdtempSync(path.join(tmpdir(), "aec-state-"));
			const prev = process.env.ELIZA_STATE_DIR;
			process.env.ELIZA_STATE_DIR = stateDir;
			const evidencePath = path.join(stateDir, "eliza-aec-capture.json");
			try {
				const state = runtimeState();
				const arm = new FakeRes();
				await handleLiveDiarizationRoute(
					makeReq({
						method: "POST",
						url: "/api/voice/aec-capture",
						body: { arm: true, maxSeconds: 5 },
					}),
					arm as unknown as http.ServerResponse,
					state,
				);
				expect(arm.statusCode).toBe(200);

				// Ingest a few frames while armed so the capture holds real samples
				// (the pure-TS AEC seam runs even without the fused diarizer).
				const frames = new FakeRes();
				await handleLiveDiarizationRoute(
					makeReq({
						method: "POST",
						url: "/api/voice/audio-frames",
						body: { frames: [silentFrame(0), silentFrame(1)] },
					}),
					frames as unknown as http.ServerResponse,
					state,
				);
				expect(frames.statusCode).toBe(200);

				// A GET with no samples must NOT write; here samples exist, so it does.
				expect(existsSync(evidencePath)).toBe(false);
				const get = new FakeRes();
				await handleLiveDiarizationRoute(
					makeReq({ method: "GET", url: "/api/voice/aec-capture" }),
					get as unknown as http.ServerResponse,
					state,
				);
				expect(get.statusCode).toBe(200);
				expect(existsSync(evidencePath)).toBe(true);
				const mirrored = JSON.parse(readFileSync(evidencePath, "utf8"));
				expect(mirrored.capture.sampleCount).toBeGreaterThan(0);
				expect(typeof mirrored.capture.nearPcm16).toBe("string");
				expect(typeof mirrored.writtenAt).toBe("string");
			} finally {
				if (prev === undefined) delete process.env.ELIZA_STATE_DIR;
				else process.env.ELIZA_STATE_DIR = prev;
				rmSync(stateDir, { recursive: true, force: true });
			}
		});
	});
});
