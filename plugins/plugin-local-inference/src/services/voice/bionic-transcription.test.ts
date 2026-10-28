/** transcribeViaBionicHost: streaming when the host reports it, batch otherwise. */
import { describe, expect, it } from "vitest";
import {
	type BionicAsrHost,
	type BionicAsrStreamHandle,
	BionicStreamingTranscriber,
} from "./bionic-streaming-transcriber";
import {
	type BionicTranscriptionHost,
	transcribeViaBionicHost,
} from "./bionic-transcription";

class Stream implements BionicAsrStreamHandle {
	fed = 0;
	constructor(private readonly fail: Error | null = null) {}
	async feed(pcm: Float32Array) {
		this.fed += pcm.length;
		return pcm.length;
	}
	async partial() {
		return this.fed >= 16000 ? "hello" : "";
	}
	async finish() {
		if (this.fail) throw this.fail;
		return "hello world";
	}
	async cancel() {
		return true;
	}
	async close() {}
}

function makeHost(opts: {
	supported: boolean;
	finishError?: Error;
}): BionicTranscriptionHost & { batch: number; streams: Stream[] } {
	const streams: Stream[] = [];
	const asrHost: BionicAsrHost = {
		async openAsrStream() {
			const s = new Stream(opts.finishError ?? null);
			streams.push(s);
			return s;
		},
		async transcribe() {
			return "unused";
		},
	};
	const host = {
		batch: 0,
		streams,
		async asrStreamSupported() {
			return opts.supported;
		},
		createStreamingTranscriber(o: { maxQueuedSeconds?: number }) {
			return new BionicStreamingTranscriber({ host: asrHost, ...o });
		},
		async transcribe() {
			host.batch++;
			return "batch text";
		},
	};
	return host;
}

const pcm = new Float32Array(16000 * 12).fill(0.05); // 12 s, longer than the default queue

describe("transcribeViaBionicHost", () => {
	it("streams the whole clip without dropping audio and forwards partial deltas", async () => {
		const host = makeHost({ supported: true });
		const deltas: string[] = [];
		const out = await transcribeViaBionicHost(host, {
			pcm,
			sampleRate: 16000,
			toBase64: () => "",
			onPartial: (d) => deltas.push(d),
		});
		expect(out).toEqual({ text: "hello world", mode: "stream" });
		expect(host.streams[0]?.fed).toBe(pcm.length);
		expect(deltas.join("")).toBe("hello world");
		expect(host.batch).toBe(0);
	});

	it("uses batch op=asr when the host reports no streaming backend", async () => {
		const host = makeHost({ supported: false });
		const out = await transcribeViaBionicHost(host, {
			pcm,
			sampleRate: 16000,
			toBase64: () => "AAAA",
		});
		expect(out).toEqual({ text: "batch text", mode: "batch" });
		expect(host.streams).toHaveLength(0);
	});

	it("surfaces stream failures instead of degrading to batch", async () => {
		const host = makeHost({
			supported: true,
			finishError: new Error("asr_stream_finish: decode failed"),
		});
		await expect(
			transcribeViaBionicHost(host, {
				pcm,
				sampleRate: 16000,
				toBase64: () => "",
			}),
		).rejects.toThrow("decode failed");
		expect(host.batch).toBe(0);
	});

	it("rejects an already-aborted request before touching the host", async () => {
		const host = makeHost({ supported: true });
		const ac = new AbortController();
		ac.abort();
		await expect(
			transcribeViaBionicHost(host, {
				pcm,
				sampleRate: 16000,
				toBase64: () => "",
				signal: ac.signal,
			}),
		).rejects.toThrow();
		expect(host.streams).toHaveLength(0);
	});
});
