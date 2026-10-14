/**
 * LiveStreamingAsrSession: VAD-gated streaming ASR, ephemeral partial events,
 * flush() on speech-end, end-of-turn latency marks. Unit tests use a scripted
 * transcriber; the integration tests run the real BionicStreamingTranscriber
 * over a fake host stream (and a host that answers STREAM_UNSUPPORTED).
 */
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EndToEndLatencyTracer } from "../latency-trace";
import {
	type BionicAsrHost,
	type BionicAsrStreamHandle,
	BionicStreamingTranscriber,
} from "./bionic-streaming-transcriber";
import {
	LiveStreamingAsrSession,
	PushVadEventSource,
} from "./live-streaming-asr-session";
import type { VoiceTranscriptEvent } from "./live-transcript-events";
import {
	hasLiveVoiceTurnAwaitingToken,
	noteLlmFirstToken,
	resetLiveVoiceLatency,
	setLiveVoiceLatencyTracer,
} from "./live-voice-latency";
import type {
	PcmFrame,
	StreamingTranscriber,
	TranscriberEventListener,
	TranscriptUpdate,
	VadEventSource,
} from "./types";

const SECRET = "my bank pin is four four two one";

class ScriptedTranscriber implements StreamingTranscriber {
	listeners = new Set<TranscriberEventListener>();
	fed: PcmFrame[] = [];
	flushes = 0;
	disposed = false;
	gateOpen = false;
	finalText = SECRET;
	failFlush: Error | null = null;
	backendMode = "stream";
	constructor(vad: VadEventSource) {
		vad.onVadEvent((ev) => {
			if (ev.type === "speech-start") this.gateOpen = true;
			if (ev.type === "speech-end") this.gateOpen = false;
		});
	}
	on(listener: TranscriberEventListener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	feed(frame: PcmFrame) {
		if (this.gateOpen) this.fed.push(frame);
	}
	partial(text: string) {
		for (const l of this.listeners)
			l({ kind: "partial", update: { partial: text, isFinal: false } });
	}
	async flush(): Promise<TranscriptUpdate> {
		this.flushes++;
		if (this.failFlush) throw this.failFlush;
		return { partial: this.finalText, isFinal: true };
	}
	dispose() {
		this.disposed = true;
	}
}

const frame = (samples = 320): PcmFrame => ({
	pcm: new Float32Array(samples).fill(0.1),
	sampleRate: 16000,
	timestampMs: 0,
});

let tracer: EndToEndLatencyTracer;
let prevTracer: EndToEndLatencyTracer;
let clock = 1_000;
const now = () => clock;

beforeEach(() => {
	tracer = new EndToEndLatencyTracer();
	prevTracer = setLiveVoiceLatencyTracer(tracer);
	clock = 1_000;
});
afterEach(() => {
	resetLiveVoiceLatency();
	setLiveVoiceLatencyTracer(prevTracer);
	vi.restoreAllMocks();
});

function makeSession(opts: { roomId?: string } = {}) {
	const vad = new PushVadEventSource();
	const events: VoiceTranscriptEvent[] = [];
	let transcriber!: ScriptedTranscriber;
	const session = new LiveStreamingAsrSession({
		sessionId: "s1",
		roomId: opts.roomId ?? null,
		vad,
		createTranscriber: (source) => {
			transcriber = new ScriptedTranscriber(source);
			return transcriber;
		},
		emit: (e) => events.push(e),
		now,
	});
	return { session, vad, events, transcriber };
}

describe("LiveStreamingAsrSession (unit)", () => {
	it("gates on the VAD, emits partials, flushes on speech-end and waits for the LLM token", async () => {
		const { session, vad, events, transcriber } = makeSession();
		session.feed(frame()); // before speech-start: gated out
		vad.push({ type: "speech-start", timestampMs: 0, probability: 0.9 });
		session.feed(frame());
		clock = 1_100;
		transcriber.partial("my bank");
		transcriber.partial("my bank"); // unchanged → no event
		transcriber.partial("my bank pin");
		clock = 1_500;
		vad.push({ type: "speech-end", timestampMs: 0, speechDurationMs: 500 });
		clock = 1_540; // flush resolves on the next tick
		const final = await session.waitForFinal();

		expect(transcriber.fed).toHaveLength(1);
		expect(transcriber.flushes).toBe(1);
		expect(final?.text).toBe(SECRET);
		expect(final?.mode).toBe("stream");
		expect(events.map((e) => e.phase)).toEqual([
			"speech-start",
			"partial",
			"partial",
			"final",
		]);
		const partials = events.filter((e) => e.phase === "partial");
		expect(partials.map((e) => ("seq" in e ? e.seq : 0))).toEqual([1, 2]);
		const turnIds = new Set(events.map((e) => e.turnId));
		expect(turnIds.size).toBe(1);
		expect(hasLiveVoiceTurnAwaitingToken()).toBe(true);

		clock = 1_900;
		const turnId = noteLlmFirstToken(null, 1_900);
		expect(turnId).toBe(final?.turnId);
		const [trace] = tracer.recentTraces(1);
		expect(trace.derived.asrFinalFromSpeechEndMs).toBe(40);
		expect(trace.derived.ttftFromSpeechEndMs).toBe(400);
		expect(trace.derived.llmFirstTokenAfterAsrMs).toBe(360);
		expect(hasLiveVoiceTurnAwaitingToken()).toBe(false);
		session.dispose();
		expect(transcriber.disposed).toBe(true);
	});

	it("never logs partial or final text", async () => {
		const logged: string[] = [];
		for (const level of ["info", "debug", "warn", "error"] as const) {
			vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
				logged.push(JSON.stringify(args));
			}) as never);
		}
		const { session, vad, transcriber } = makeSession();
		vad.push({ type: "speech-start", timestampMs: 0, probability: 1 });
		transcriber.partial("my bank pin");
		vad.push({ type: "speech-end", timestampMs: 0, speechDurationMs: 1 });
		await session.waitForFinal();
		noteLlmFirstToken(null);
		session.dispose();
		expect(logged.length).toBeGreaterThan(0);
		expect(logged.join("\n")).not.toContain("bank");
	});

	it("emits an error event and closes the turn when flush fails", async () => {
		const { session, vad, events, transcriber } = makeSession();
		transcriber.failFlush = new Error("host gone");
		vad.push({ type: "speech-start", timestampMs: 0, probability: 1 });
		vad.push({ type: "speech-end", timestampMs: 0, speechDurationMs: 1 });
		await expect(session.waitForFinal()).rejects.toThrow("host gone");
		expect(events.at(-1)).toMatchObject({ phase: "error", code: "ASR_FAILED" });
		expect(hasLiveVoiceTurnAwaitingToken()).toBe(false);
		expect(tracer.recentTraces()).toHaveLength(1);
	});

	it("attributes the first token by room and ignores other rooms", async () => {
		const { session, vad } = makeSession({ roomId: "room-a" });
		vad.push({ type: "speech-start", timestampMs: 0, probability: 1 });
		vad.push({ type: "speech-end", timestampMs: 0, speechDurationMs: 1 });
		await session.waitForFinal();
		expect(noteLlmFirstToken("room-b")).toBeNull();
		expect(noteLlmFirstToken("room-a")).not.toBeNull();
	});

	it("endTurn() finalizes an open segment without a VAD edge", async () => {
		const { session, vad, transcriber } = makeSession();
		vad.push({ type: "speech-start", timestampMs: 0, probability: 1 });
		const final = await session.endTurn();
		expect(final?.text).toBe(SECRET);
		expect(transcriber.flushes).toBe(1);
		expect(await session.endTurn()).toEqual(final);
	});
});

// ── Integration: the real BionicStreamingTranscriber over a fake host ──────

class FakeHostStream implements BionicAsrStreamHandle {
	fed = 0;
	finished = false;
	closed = false;
	constructor(private readonly words: string[]) {}
	async feed(pcm: Float32Array) {
		this.fed += pcm.length;
		return pcm.length;
	}
	async partial() {
		return this.words.slice(0, Math.floor(this.fed / 5120)).join(" ");
	}
	async finish() {
		this.finished = true;
		return this.words.join(" ");
	}
	async cancel() {
		return true;
	}
	async close() {
		this.closed = true;
	}
}

class FakeHost implements BionicAsrHost {
	streams: FakeHostStream[] = [];
	batchCalls = 0;
	constructor(private readonly streaming: boolean) {}
	async openAsrStream() {
		if (!this.streaming) return null; // STREAM_UNSUPPORTED
		const s = new FakeHostStream(["turn", "on", "the", "lights"]);
		this.streams.push(s);
		return s;
	}
	async transcribe() {
		this.batchCalls++;
		return "turn on the lights";
	}
}

async function runUtterance(host: FakeHost) {
	const vad = new PushVadEventSource();
	const events: VoiceTranscriptEvent[] = [];
	const session = new LiveStreamingAsrSession({
		sessionId: "int",
		vad,
		createTranscriber: (source) =>
			new BionicStreamingTranscriber({ host, vad: source }),
		emit: (e) => events.push(e),
	});
	vad.push({ type: "speech-start", timestampMs: 0, probability: 1 });
	for (let i = 0; i < 100; i++) {
		// 2 s of 20 ms frames, letting the host chain run as real time would.
		session.feed(frame(320));
		await new Promise((r) => setImmediate(r));
	}
	vad.push({ type: "speech-end", timestampMs: 2000, speechDurationMs: 2000 });
	const final = await session.waitForFinal();
	session.dispose();
	return { final, events };
}

describe("LiveStreamingAsrSession + BionicStreamingTranscriber (integration)", () => {
	it("streams partials from the host and finalizes with finish()", async () => {
		const host = new FakeHost(true);
		const { final, events } = await runUtterance(host);
		expect(final).toMatchObject({ text: "turn on the lights", mode: "stream" });
		const partials = events.filter((e) => e.phase === "partial");
		expect(partials.length).toBeGreaterThanOrEqual(2);
		expect(partials.at(-1)).toMatchObject({ text: "turn on the lights" });
		expect(host.streams[0]?.finished).toBe(true);
		expect(host.streams[0]?.closed).toBe(true);
		expect(host.batchCalls).toBe(0);
		expect(final?.asrFinalFromSpeechEndMs).not.toBeNull();
	});

	it("falls back to batch op=asr only when the host answers STREAM_UNSUPPORTED", async () => {
		const host = new FakeHost(false);
		const { final, events } = await runUtterance(host);
		expect(final).toMatchObject({ text: "turn on the lights", mode: "batch" });
		expect(events.filter((e) => e.phase === "partial")).toHaveLength(0);
		expect(host.batchCalls).toBe(1);
	});
});
