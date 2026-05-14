/**
 * Unit tests for the streaming ASR adapters (`voice/transcriber.ts`).
 *
 * No native binary, no real fused library: the fused adapters take a fake
 * `ElizaInferenceFfi`. A tiny fake PCM source drives `feed()`.
 */

import { describe, expect, it } from "vitest";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
	ElizaInferenceRegion,
} from "./ffi-bindings";
import {
	ASR_SAMPLE_RATE,
	AsrUnavailableError,
	createStreamingTranscriber,
	FfiBatchTranscriber,
	FfiStreamingTranscriber,
	resampleLinear,
} from "./transcriber";
import type {
	PcmFrame,
	TranscriberEvent,
	VadEvent,
	VadEventSource,
} from "./types";

/* ---- test doubles -------------------------------------------------- */

/** Emits N frames of `framesSamples` samples each at `sampleRate`. */
function makeFrames(
	count: number,
	samplesPerFrame: number,
	sampleRate = ASR_SAMPLE_RATE,
): PcmFrame[] {
	return Array.from({ length: count }, (_v, i) => ({
		pcm: new Float32Array(samplesPerFrame).fill(0.01),
		sampleRate,
		timestampMs: i,
	}));
}

/** A minimal VAD source whose `emit` the test drives manually. */
class FakeVad implements VadEventSource {
	private listeners = new Set<(e: VadEvent) => void>();
	onVadEvent(l: (e: VadEvent) => void): () => void {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}
	emit(e: VadEvent): void {
		for (const l of this.listeners) l(e);
	}
}

/** Collect all transcriber events for assertions. */
function collect(t: {
	on(l: (e: TranscriberEvent) => void): () => void;
}): TranscriberEvent[] {
	const out: TranscriberEvent[] = [];
	t.on((e) => out.push(e));
	return out;
}

/* ---- adapter selection -------------------------------------------- */

describe("createStreamingTranscriber — adapter chain", () => {
	it("throws AsrUnavailableError when no backend is available (no ffi)", () => {
		expect(() => createStreamingTranscriber()).toThrow(AsrUnavailableError);
	});

	it("throws AsrUnavailableError when prefer=fused but no fused streaming ASR", () => {
		expect(() => createStreamingTranscriber({ prefer: "fused" })).toThrow(
			AsrUnavailableError,
		);
		// ffi present but reports no working decoder → still unavailable for `fused`.
		const ffi = makeFakeFfi({ streamSupported: false });
		expect(() =>
			createStreamingTranscriber({
				prefer: "fused",
				ffi,
				getContext: () => 1n,
				asrBundlePresent: true,
			}),
		).toThrow(AsrUnavailableError);
	});

	it("selects the fused adapter when the library advertises a working streaming decoder", () => {
		const ffi = makeFakeFfi({ streamSupported: true });
		const t = createStreamingTranscriber({
			ffi,
			getContext: () => 1n,
			asrBundlePresent: true,
		});
		expect(t).toBeInstanceOf(FfiStreamingTranscriber);
		t.dispose();
	});

	it("selects the fused-batch interim when the fused build is loaded but advertises no streaming decoder", () => {
		const ffi = makeFakeFfi({
			streamSupported: false,
			transcribe: () => "interim",
		});
		const t = createStreamingTranscriber({
			ffi,
			getContext: () => 1n,
			asrBundlePresent: true,
		});
		expect(t).toBeInstanceOf(FfiBatchTranscriber);
		t.dispose();
	});

	it("prefer=ffi-batch selects the fused-batch interim", () => {
		const ffi = makeFakeFfi({
			streamSupported: false,
			transcribe: () => "interim",
		});
		const t = createStreamingTranscriber({
			prefer: "ffi-batch",
			ffi,
			getContext: () => 1n,
			asrBundlePresent: true,
		});
		expect(t).toBeInstanceOf(FfiBatchTranscriber);
		t.dispose();
		// No fused handle → ffi-batch is unavailable, hard error (no silent degrade).
		expect(() => createStreamingTranscriber({ prefer: "ffi-batch" })).toThrow(
			AsrUnavailableError,
		);
	});
});

describe("FfiBatchTranscriber — windowed batch ASR (interim)", () => {
	it("commits a prefix in window-sized chunks and re-decodes only the tail; flush finalizes", async () => {
		const calls: number[] = [];
		const ffi = makeFakeFfi({
			streamSupported: false,
			transcribe: (pcm) => {
				calls.push(pcm.length);
				return "x";
			},
		});
		const t = new FfiBatchTranscriber({
			ffi,
			getContext: () => 1n,
			// small window so a couple of frames overflow it
			windowSeconds: 1,
			overlapSeconds: 0.25,
			stepSeconds: 0.5,
		});
		// ~2.4 s of audio at 16 kHz, fed in 0.6 s frames → at least one commit + a tail decode.
		for (let i = 0; i < 4; i++) {
			t.feed({
				pcm: new Float32Array(ASR_SAMPLE_RATE * 0.6).fill(0.05),
				sampleRate: ASR_SAMPLE_RATE,
				timestampMs: i * 600,
			});
		}
		const final = await t.flush();
		expect(typeof final.partial).toBe("string");
		expect(final.isFinal).toBe(true);
		// Every batch decode was bounded by ≈ window + overlap (≤ ~1.25 s), never the whole 2.4 s buffer.
		expect(calls.length).toBeGreaterThan(0);
		for (const n of calls) expect(n).toBeLessThanOrEqual(ASR_SAMPLE_RATE * 1.3);
		t.dispose();
	});

	it("resamples non-16 kHz frames before the batch decode", async () => {
		const fed: number[] = [];
		const ffi = makeFakeFfi({
			streamSupported: false,
			transcribe: (pcm) => {
				fed.push(pcm.length);
				return "x";
			},
		});
		const t = new FfiBatchTranscriber({
			ffi,
			getContext: () => 1n,
			stepSeconds: 0.01,
		});
		// 48 kHz frame of 4800 samples (0.1 s) → ~1600 samples at 16 kHz.
		t.feed({
			pcm: new Float32Array(4800).fill(0.05),
			sampleRate: 48_000,
			timestampMs: 0,
		});
		await t.flush();
		expect(fed.some((n) => n === 1600)).toBe(true);
		t.dispose();
	});
});

/* ---- fused adapter (against a fake FFI) --------------------------- */

describe("FfiStreamingTranscriber", () => {
	it("feeds frames through the streaming ABI and surfaces partials + tokens; flush finalizes + closes", async () => {
		let feeds = 0;
		let closed = false;
		const ffi = makeFakeFfi({
			streamSupported: true,
			onFeed: () => {
				feeds++;
			},
			partial: () => ({
				partial: feeds === 1 ? "hi" : "hi there",
				tokens: [1, 2],
			}),
			finish: () => ({ partial: "hi there friend", tokens: [1, 2, 3] }),
			onClose: () => {
				closed = true;
			},
		});
		const t = new FfiStreamingTranscriber({ ffi, getContext: () => 1n });
		const events = collect(t);

		t.feed({
			pcm: new Float32Array(160).fill(0.05),
			sampleRate: ASR_SAMPLE_RATE,
			timestampMs: 0,
		});
		t.feed({
			pcm: new Float32Array(160).fill(0.05),
			sampleRate: ASR_SAMPLE_RATE,
			timestampMs: 10,
		});
		expect(feeds).toBe(2);
		const partials = events.filter((e) => e.kind === "partial");
		expect(partials.at(-1)).toMatchObject({
			kind: "partial",
			update: { partial: "hi there", isFinal: false, tokens: [1, 2] },
		});
		// First non-empty partial also produced a `words` event.
		expect(events.some((e) => e.kind === "words")).toBe(true);

		const final = await t.flush();
		expect(final).toMatchObject({
			partial: "hi there friend",
			isFinal: true,
			tokens: [1, 2, 3],
		});
		expect(closed).toBe(true);
		expect(events.some((e) => e.kind === "final")).toBe(true);
		t.dispose();
	});

	it("resamples non-16 kHz frames before feeding", () => {
		const fed: number[] = [];
		const ffi = makeFakeFfi({
			streamSupported: true,
			onFeed: (pcm) => fed.push(pcm.length),
			partial: () => ({ partial: "x" }),
		});
		const t = new FfiStreamingTranscriber({ ffi, getContext: () => 1n });
		// 48 kHz frame of 480 samples (10 ms) → ~160 samples at 16 kHz.
		t.feed({
			pcm: new Float32Array(480).fill(0.05),
			sampleRate: 48_000,
			timestampMs: 0,
		});
		expect(fed[0]).toBe(160);
		t.dispose();
	});

	it("gates on the VAD stream — frames outside an active speech window are dropped", async () => {
		const fed: number[] = [];
		const ffi = makeFakeFfi({
			streamSupported: true,
			onFeed: (pcm) => fed.push(pcm.length),
			partial: () => ({ partial: "x" }),
		});
		const vad = new FakeVad();
		const t = new FfiStreamingTranscriber({
			ffi,
			getContext: () => 1n,
			vad,
		});
		// VAD has not reported speech yet → feeds are dropped.
		for (const f of makeFrames(3, 160)) t.feed(f);
		expect(fed.length).toBe(0);

		// Speech becomes active → feeds are now decoded (preroll drain + new frames).
		vad.emit({ type: "speech-start", timestampMs: 0, probability: 1 });
		for (const f of makeFrames(2, 160)) t.feed(f);
		expect(fed.length).toBeGreaterThan(0);

		// Speech ends → feeds are dropped again.
		const before = fed.length;
		vad.emit({ type: "speech-end", timestampMs: 0, speechDurationMs: 1000 });
		for (const f of makeFrames(3, 160)) t.feed(f);
		expect(fed.length).toBe(before);
		t.dispose();
	});

	it("rejects feed/flush after dispose", async () => {
		const ffi = makeFakeFfi({
			streamSupported: true,
			partial: () => ({ partial: "x" }),
		});
		const t = new FfiStreamingTranscriber({ ffi, getContext: () => 1n });
		t.dispose();
		expect(() =>
			t.feed({
				pcm: new Float32Array([0.1]),
				sampleRate: ASR_SAMPLE_RATE,
				timestampMs: 0,
			}),
		).toThrow(/disposed/);
		await expect(t.flush()).rejects.toThrow(/disposed/);
	});

	it("throws AsrUnavailableError when constructed against a library without a working decoder", () => {
		const ffi = makeFakeFfi({ streamSupported: false });
		expect(
			() => new FfiStreamingTranscriber({ ffi, getContext: () => 1n }),
		).toThrow(AsrUnavailableError);
	});
});

/* ---- pure helpers ------------------------------------------------- */

describe("transcriber helpers", () => {
	it("resampleLinear is a no-op at the same rate and roughly preserves length on downsample", () => {
		const pcm = new Float32Array([0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5]);
		expect(resampleLinear(pcm, 16000, 16000)).toBe(pcm);
		const down = resampleLinear(pcm, 48000, 16000);
		expect(down.length).toBe(Math.round((pcm.length * 16000) / 48000));
	});
});

/* ---- fake ElizaInferenceFfi -------------------------------------- */

function makeFakeFfi(opts: {
	streamSupported: boolean;
	onFeed?: (pcm: Float32Array) => void;
	partial?: () => { partial: string; tokens?: number[] };
	finish?: () => { partial: string; tokens?: number[] };
	onClose?: () => void;
	transcribe?: (pcm: Float32Array) => string;
}): ElizaInferenceFfi {
	let streamHandle = 0n;
	return {
		libraryPath: "/tmp/fake-libelizainference",
		libraryAbiVersion: "2",
		create: (): ElizaInferenceContextHandle => 1n,
		destroy: () => {},
		mmapAcquire: (
			_ctx: ElizaInferenceContextHandle,
			_r: ElizaInferenceRegion,
		) => {},
		mmapEvict: (
			_ctx: ElizaInferenceContextHandle,
			_r: ElizaInferenceRegion,
		) => {},
		ttsSynthesize: () => {
			throw new Error("not used");
		},
		asrTranscribe: ({ pcm }) => {
			if (opts.transcribe) return opts.transcribe(pcm);
			throw new Error("not used");
		},
		ttsStreamSupported: () => false,
		ttsSynthesizeStream: () => {
			throw new Error("not used");
		},
		cancelTts: () => {},
		setVerifierCallback: () => ({ close: () => {} }),
		vadSupported: () => false,
		vadOpen: () => {
			throw new Error("not used");
		},
		vadProcess: () => {
			throw new Error("not used");
		},
		vadReset: () => {},
		vadClose: () => {},
		asrStreamSupported: () => opts.streamSupported,
		asrStreamOpen: () => {
			streamHandle += 1n;
			return streamHandle;
		},
		asrStreamFeed: ({ pcm }) => {
			opts.onFeed?.(pcm);
		},
		asrStreamPartial: () => opts.partial?.() ?? { partial: "" },
		asrStreamFinish: () => opts.finish?.() ?? { partial: "" },
		asrStreamClose: () => {
			opts.onClose?.();
		},
		close: () => {},
	};
}
