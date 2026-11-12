/** BionicStreamingTranscriber: partials from the host stream, batch only when it cannot stream. */
import { describe, expect, it } from "vitest";
import {
	type BionicAsrHost,
	type BionicAsrStreamHandle,
	BionicStreamingTranscriber,
} from "./bionic-streaming-transcriber";
import type { TranscriberEvent } from "./types";

class FakeStream implements BionicAsrStreamHandle {
	fed = 0;
	feeds = 0;
	partials = 0;
	finished = false;
	closed = false;
	cancelled = false;
	failFeed: Error | null = null;
	constructor(private readonly words: string[]) {}
	async feed(pcm: Float32Array): Promise<number> {
		if (this.failFeed) throw this.failFeed;
		if (this.finished) throw new Error("feed after finish");
		this.feeds++;
		this.fed += pcm.length;
		return pcm.length;
	}
	private text(): string {
		// One word per 0.32 s of 16 kHz audio.
		return this.words.slice(0, Math.floor(this.fed / 5120)).join(" ");
	}
	async partial(): Promise<string> {
		this.partials++;
		return this.text();
	}
	async finish(): Promise<string> {
		this.finished = true;
		return this.words.join(" ");
	}
	async cancel(): Promise<boolean> {
		this.cancelled = true;
		return true;
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

class FakeHost implements BionicAsrHost {
	streams: FakeStream[] = [];
	batchCalls: { samples: number; sampleRate: number }[] = [];
	constructor(private readonly streaming: boolean) {}
	async openAsrStream(): Promise<BionicAsrStreamHandle | null> {
		if (!this.streaming) return null;
		const s = new FakeStream(["set", "a", "timer", "for", "ten", "minutes"]);
		this.streams.push(s);
		return s;
	}
	async transcribe(args: {
		pcmBase64: string;
		sampleRate: number;
	}): Promise<string> {
		this.batchCalls.push({
			samples: Buffer.from(args.pcmBase64, "base64").length / 4,
			sampleRate: args.sampleRate,
		});
		return "batch transcript";
	}
}

const frame = (samples: number, sampleRate = 16000) => ({
	pcm: new Float32Array(samples).fill(0.1),
	sampleRate,
	timestampMs: 0,
});

async function feedSeconds(
	t: BionicStreamingTranscriber,
	seconds: number,
	sampleRate = 16000,
) {
	const per = sampleRate / 50; // 20 ms frames
	for (let i = 0; i < seconds * 50; i++) {
		t.feed(frame(per, sampleRate));
		// Let the serialized host chain run, as real time would.
		await new Promise((r) => setImmediate(r));
	}
}

describe("BionicStreamingTranscriber", () => {
	it("emits growing partials, a words event and the final from the stream", async () => {
		const host = new FakeHost(true);
		const t = new BionicStreamingTranscriber({ host, partialIntervalMs: 320 });
		const events: TranscriberEvent[] = [];
		t.on((e) => events.push(e));
		await feedSeconds(t, 2);
		const final = await t.flush();
		expect(final).toMatchObject({
			partial: "set a timer for ten minutes",
			isFinal: true,
		});
		const partials = events
			.filter((e) => e.kind === "partial")
			.map((e) => (e.kind === "partial" ? e.update.partial : ""));
		expect(partials.length).toBeGreaterThanOrEqual(3);
		expect(partials[0]).toBe("set");
		expect(new Set(partials).size).toBe(partials.length);
		expect(events.find((e) => e.kind === "words")).toMatchObject({
			words: ["set"],
		});
		expect(events.at(-1)?.kind).toBe("final");
		expect(t.backendMode).toBe("stream");
		const [stream] = host.streams;
		expect(stream?.fed).toBe(32000);
		expect(stream?.closed).toBe(true);
		expect(host.batchCalls).toHaveLength(0);
		t.dispose();
	});

	it("resamples to 16 kHz and opens a fresh stream per segment", async () => {
		const host = new FakeHost(true);
		const t = new BionicStreamingTranscriber({ host });
		await feedSeconds(t, 1, 48000);
		await t.flush();
		await feedSeconds(t, 1);
		await t.flush();
		expect(host.streams).toHaveLength(2);
		expect(host.streams[0]?.fed).toBe(16000);
		expect(host.streams.every((s) => s.closed)).toBe(true);
		t.dispose();
	});

	it("falls back to batch op=asr only when the host cannot stream", async () => {
		const host = new FakeHost(false);
		const t = new BionicStreamingTranscriber({ host });
		const events: TranscriberEvent[] = [];
		t.on((e) => events.push(e));
		await feedSeconds(t, 1);
		const final = await t.flush();
		expect(final.partial).toBe("batch transcript");
		expect(host.batchCalls).toEqual([{ samples: 16000, sampleRate: 16000 }]);
		expect(events.some((e) => e.kind === "partial")).toBe(false);
		expect(t.backendMode).toBe("batch");
		// An empty segment does not call the host.
		expect((await t.flush()).partial).toBe("");
		expect(host.batchCalls).toHaveLength(1);
		t.dispose();
	});

	it("surfaces a host failure from flush instead of degrading to batch", async () => {
		const host = new FakeHost(true);
		const t = new BionicStreamingTranscriber({ host });
		t.feed(frame(320));
		await new Promise((r) => setImmediate(r));
		const s = host.streams[0];
		if (!s) throw new Error("expected a stream");
		s.failFeed = new Error("socket error: EPIPE");
		await feedSeconds(t, 1);
		await expect(t.flush()).rejects.toThrow("EPIPE");
		expect(host.batchCalls).toHaveLength(0);
		expect(s.closed).toBe(true);
		// The next segment starts clean on a new stream.
		await feedSeconds(t, 1);
		expect((await t.flush()).partial).toBe("set a timer for ten minutes");
		t.dispose();
	});

	it("bounds the audio waiting for a slow host", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const stream = new FakeStream(["x"]);
		const host: BionicAsrHost = {
			openAsrStream: async () => {
				await gate;
				return stream;
			},
			transcribe: async () => "",
		};
		const t = new BionicStreamingTranscriber({ host, maxQueuedSeconds: 1 });
		for (let i = 0; i < 150; i++) t.feed(frame(320)); // 3 s while the host is stuck
		release();
		await t.flush();
		// The first frame was taken before the host stalled; at most 1 s queued after.
		expect(stream.fed).toBeLessThanOrEqual(16000 + 320);
		expect(stream.fed).toBeGreaterThan(15000);
		t.dispose();
	});

	it("cancels and closes the host stream on dispose", async () => {
		const host = new FakeHost(true);
		const t = new BionicStreamingTranscriber({ host });
		await feedSeconds(t, 1);
		t.dispose();
		await new Promise((r) => setImmediate(r));
		expect(host.streams[0]?.cancelled).toBe(true);
		expect(host.streams[0]?.closed).toBe(true);
	});
});
