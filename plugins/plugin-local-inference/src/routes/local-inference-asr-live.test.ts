/**
 * `/api/asr/local-inference/live` over HTTP with a fake bionic host stream:
 * VAD edges + frames in, partials out on the agent-event bus (stream
 * "voice-transcript"), the final in the response, batch only on
 * STREAM_UNSUPPORTED.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { ServiceType } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BionicAsrHost,
	type BionicAsrStreamHandle,
	BionicStreamingTranscriber,
} from "../services/voice/bionic-streaming-transcriber.js";
import { resetLiveVoiceLatency } from "../services/voice/live-voice-latency.js";
import type { VadEventSource } from "../services/voice/types.js";
import type { CompatRuntimeState } from "./compat-helpers.js";
import {
	liveAsrSessionCount,
	resetLiveAsrSessions,
} from "./local-inference-asr-live.js";
import { handleLocalInferenceAsrRoute } from "./local-inference-asr-route.js";

class FakeRes {
	statusCode = 200;
	headersSent = false;
	body = "";
	setHeader(): void {}
	end(chunk?: string): void {
		if (chunk) this.body += chunk;
		this.headersSent = true;
	}
	json(): Record<string, unknown> {
		return JSON.parse(this.body);
	}
}

function makeReq(
	method: string,
	url: string,
	body?: unknown,
): http.IncomingMessage {
	const payload = body !== undefined ? JSON.stringify(body) : "";
	const req = Readable.from(
		payload ? [Buffer.from(payload)] : [],
	) as unknown as http.IncomingMessage & Record<string, unknown>;
	req.method = method;
	req.url = url;
	req.headers = { host: "127.0.0.1:31337", "content-type": "application/json" };
	req.socket = { remoteAddress: "127.0.0.1" } as never;
	return req;
}

class HostStream implements BionicAsrStreamHandle {
	fed = 0;
	async feed(pcm: Float32Array) {
		this.fed += pcm.length;
		return pcm.length;
	}
	async partial() {
		return ["what", "time", "is", "it"]
			.slice(0, Math.floor(this.fed / 5120))
			.join(" ");
	}
	async finish() {
		return "what time is it";
	}
	async cancel() {
		return true;
	}
	async close() {}
}

function makeState(streaming: boolean) {
	const events: Array<{
		stream: string;
		runId: string;
		data: Record<string, unknown>;
	}> = [];
	let batch = 0;
	const host: BionicAsrHost = {
		async openAsrStream() {
			return streaming ? new HostStream() : null;
		},
		async transcribe() {
			batch++;
			return "what time is it";
		},
	};
	const loader = {
		createStreamingTranscriber: (o: { vad?: VadEventSource }) =>
			new BionicStreamingTranscriber({ host, ...o }),
		asrStreamSupported: async () => streaming,
	};
	const bus = {
		emit: (e: {
			stream: string;
			runId: string;
			data: Record<string, unknown>;
		}) => events.push(e),
		clearRunContext: () => {},
	};
	const state: CompatRuntimeState = {
		current: {
			agentId: "agent-1",
			getService: (name: string) =>
				name === "localInferenceLoader"
					? loader
					: name === ServiceType.AGENT_EVENT
						? bus
						: null,
		} as never,
	};
	return { state, events, batches: () => batch };
}

function frames(count: number, start = 0) {
	const samples = 320;
	const buf = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i++) buf.writeInt16LE(3000, i * 2);
	return Array.from({ length: count }, (_, i) => ({
		pcm16: buf.toString("base64"),
		sampleRate: 16000,
		channels: 1,
		samples,
		rms: 0.1,
		timestamp: (start + i) * 20,
		frameIndex: start + i,
	}));
}

async function post(state: CompatRuntimeState, body: unknown) {
	const res = new FakeRes();
	const handled = await handleLocalInferenceAsrRoute(
		makeReq("POST", "/api/asr/local-inference/live", body),
		res as unknown as http.ServerResponse,
		state,
	);
	expect(handled).toBe(true);
	return res;
}

afterEach(() => {
	resetLiveAsrSessions();
	resetLiveVoiceLatency();
});

describe("POST /api/asr/local-inference/live", () => {
	it("streams partials as voice-transcript events and returns the final on speech-end", async () => {
		const { state, events, batches } = makeState(true);
		const first = await post(state, {
			sessionId: "phone-1",
			vad: [{ type: "speech-start" }],
			frames: frames(50),
		});
		expect(first.statusCode).toBe(200);
		expect(first.json()).toMatchObject({ ok: true, sessionId: "phone-1" });
		expect(first.json().final).toBeUndefined();
		for (let i = 1; i < 4; i++) {
			await post(state, {
				sessionId: "phone-1",
				frames: frames(25, 25 * (i + 1)),
			});
			await new Promise((r) => setImmediate(r));
		}
		const last = await post(state, {
			sessionId: "phone-1",
			frames: frames(5, 200),
			vad: [{ type: "speech-end" }],
		});
		const body = last.json();
		expect(body.final).toMatchObject({
			text: "what time is it",
			mode: "stream",
		});
		expect(batches()).toBe(0);

		expect(new Set(events.map((e) => e.stream))).toEqual(
			new Set(["voice-transcript"]),
		);
		expect(new Set(events.map((e) => e.runId))).toEqual(
			new Set(["voice-transcript:phone-1"]),
		);
		const phases = events.map((e) => e.data.phase);
		expect(phases[0]).toBe("speech-start");
		expect(phases.at(-1)).toBe("final");
		expect(phases.filter((p) => p === "partial").length).toBeGreaterThanOrEqual(
			1,
		);
		for (const e of events) {
			expect(e.data).toMatchObject({
				type: "voice-transcript",
				sessionId: "phone-1",
			});
		}
	});

	it("uses batch op=asr only when the host answers STREAM_UNSUPPORTED", async () => {
		const { state, events, batches } = makeState(false);
		await post(state, {
			sessionId: "q",
			vad: [{ type: "speech-start" }],
			frames: frames(50),
		});
		const res = await post(state, {
			sessionId: "q",
			vad: [{ type: "speech-end" }],
		});
		expect(res.json().final).toMatchObject({
			text: "what time is it",
			mode: "batch",
		});
		expect(batches()).toBe(1);
		expect(events.some((e) => e.data.phase === "partial")).toBe(false);
	});

	it("close finalizes an open turn and frees the session", async () => {
		const { state } = makeState(true);
		await post(state, {
			sessionId: "c",
			vad: [{ type: "speech-start" }],
			frames: frames(30),
		});
		expect(liveAsrSessionCount()).toBe(1);
		const res = await post(state, { sessionId: "c", close: true });
		expect(res.json()).toMatchObject({
			closed: true,
			final: { text: "what time is it" },
		});
		expect(liveAsrSessionCount()).toBe(0);
	});

	it("validates the body and caps concurrent sessions", async () => {
		const { state } = makeState(true);
		expect((await post(state, { frames: [] })).statusCode).toBe(400);
		expect(
			(await post(state, { sessionId: "x", vad: [{ type: "nope" }] }))
				.statusCode,
		).toBe(400);
		expect(
			(await post(state, { sessionId: "x", frames: [{ pcm16: 1 }] }))
				.statusCode,
		).toBe(400);
		for (const id of ["a", "b", "c", "d"]) {
			expect((await post(state, { sessionId: id })).statusCode).toBe(200);
		}
		const full = await post(state, { sessionId: "e" });
		expect(full.statusCode).toBe(429);
		expect(full.json().code).toBe("LIVE_ASR_SESSIONS_FULL");
	});

	it("answers 503 without a streaming loader", async () => {
		const res = await post(
			{ current: { getService: () => null } as never },
			{ sessionId: "z" },
		);
		expect(res.statusCode).toBe(503);
		expect(res.json().code).toBe("LIVE_ASR_UNAVAILABLE");
	});

	it("reports streaming support on the status route", async () => {
		const { state } = makeState(true);
		const res = new FakeRes();
		await handleLocalInferenceAsrRoute(
			makeReq("GET", "/api/asr/local-inference/live/status"),
			res as unknown as http.ServerResponse,
			state,
		);
		expect(res.json()).toMatchObject({
			ready: true,
			streaming: true,
			sessions: 0,
		});
	});
});
