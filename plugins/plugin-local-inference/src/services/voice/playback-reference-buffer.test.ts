/**
 * PlaybackReferenceBuffer + createEchoReferenceProvider tests (#9583).
 *
 * Covers the caller-side far-end store and provider in isolation (write/read
 * alignment, gaps → null, eviction, the delay offset), plus an END-TO-END proof
 * that the buffer → provider → AudioFrameConsumer → NlmsEchoCanceller wiring
 * actually cancels the agent's echo on the live consumer path.
 */

import { describe, expect, it } from "vitest";
import {
	type AttributionPipelineLike,
	AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
	AudioFrameConsumer,
	type RuntimeEventSink,
	type VadSegmenter,
} from "./audio-frame-consumer";
import {
	createEchoReferenceProvider,
	PlaybackReferenceBuffer,
} from "./playback-reference-buffer";
import type { VoiceAttributionOutput } from "./speaker/attribution-pipeline";
import type { PcmFrame, VadEvent } from "./types";

const SR = AUDIO_FRAME_PIPELINE_SAMPLE_RATE;

function ramp(n: number, base = 0): Float32Array {
	const a = new Float32Array(n);
	for (let i = 0; i < n; i++) a[i] = (base + i) / 1000;
	return a;
}

function energy(a: Float32Array): number {
	let e = 0;
	for (let i = 0; i < a.length; i++) e += a[i] * a[i];
	return e / Math.max(1, a.length);
}

describe("PlaybackReferenceBuffer", () => {
	it("reads back the exact playback window written at a timestamp", () => {
		const buf = new PlaybackReferenceBuffer();
		const pcm = ramp(320, 1);
		buf.write(pcm, 1000);
		const got = buf.read(1000, 320);
		expect(got).not.toBeNull();
		expect(Array.from(got as Float32Array)).toEqual(Array.from(pcm));
	});

	it("returns null for a window with no playback (agent silent)", () => {
		const buf = new PlaybackReferenceBuffer();
		buf.write(ramp(320, 1), 1000);
		// A window entirely after the written chunk → no overlap → null.
		expect(buf.read(2000, 320)).toBeNull();
		// A window entirely before → null.
		expect(buf.read(0, 320)).toBeNull();
	});

	it("fills only the covered samples and zeros the gap on partial overlap", () => {
		const buf = new PlaybackReferenceBuffer();
		// 10 ms (160 samples) of 0.5 starting at t=1000 ms.
		buf.write(new Float32Array(160).fill(0.5), 1000);
		// Query a 20 ms (320-sample) window aligned to t=1000: first 160 covered,
		// last 160 are silence (gap) → zeros.
		const got = buf.read(1000, 320);
		expect(got).not.toBeNull();
		const out = got as Float32Array;
		expect(out[0]).toBeCloseTo(0.5, 5);
		expect(out[159]).toBeCloseTo(0.5, 5);
		expect(out[160]).toBe(0);
		expect(out[319]).toBe(0);
	});

	it("does not bridge one burst's audio into a later burst's silence", () => {
		const buf = new PlaybackReferenceBuffer();
		buf.write(new Float32Array(320).fill(0.4), 1000); // burst A
		buf.write(new Float32Array(320).fill(0.9), 3000); // burst B, after a gap
		// The 1500 ms window sits in the gap between A and B → null.
		expect(buf.read(1500, 320)).toBeNull();
		// Each burst still reads back its own value.
		expect((buf.read(1000, 320) as Float32Array)[0]).toBeCloseTo(0.4, 5);
		expect((buf.read(3000, 320) as Float32Array)[0]).toBeCloseTo(0.9, 5);
	});

	it("evicts oldest playback once over the retained history budget", () => {
		const buf = new PlaybackReferenceBuffer({ historySeconds: 0.5 }); // 8000 samples
		let t = 0;
		for (let i = 0; i < 100; i++) {
			buf.write(new Float32Array(320).fill(0.1), t);
			t += 20;
		}
		// 100 * 320 = 32000 samples written; retained capped near 8000.
		expect(buf.bufferedSamples).toBeLessThanOrEqual(8000 + 320);
		expect(buf.bufferedSamples).toBeGreaterThan(0);
	});

	it("provider offsets the read by the bulk playback→mic delay", () => {
		const buf = new PlaybackReferenceBuffer();
		// 10 ms (160 samples) of playback at t=1000, covering [1000, 1010) ms.
		buf.write(new Float32Array(160).fill(0.7), 1000);
		// 10 ms delay = 160 samples @ 16 kHz. A mic frame at t=1010 ms echoes the
		// playback from t=1000 ms, so the provider must read t=1000 → covered.
		const provider = createEchoReferenceProvider(buf, { delaySamples: 160 });
		const got = provider(1010, 320);
		expect(got).not.toBeNull();
		expect((got as Float32Array)[0]).toBeCloseTo(0.7, 5);
		// With zero delay the same mic time reads the [1010, 1030) window, which the
		// [1000, 1010) playback does not reach → null.
		const noDelay = createEchoReferenceProvider(buf, { delaySamples: 0 });
		expect(noDelay(1010, 320)).toBeNull();
	});

	it("provider re-reads a live delay getter so re-calibration takes effect", () => {
		const buf = new PlaybackReferenceBuffer();
		buf.write(new Float32Array(160).fill(0.3), 1000); // [1000, 1010) ms
		let delaySamples = 0;
		const provider = createEchoReferenceProvider(buf, () => ({ delaySamples }));
		expect(provider(1010, 320)).toBeNull(); // delay 0 → reads [1010,1030) → empty
		delaySamples = 160; // a re-calibration lands
		expect(provider(1010, 320)).not.toBeNull(); // now reads [1000,…) → covered
	});
});

// ---------------------------------------------------------------------------
// End-to-end: buffer → provider → AudioFrameConsumer → NlmsEchoCanceller
// ---------------------------------------------------------------------------

/** Speech-like signal: two-pole low-passed pseudo-random noise (deterministic). */
function speechLike(n: number, seed: number): Float32Array {
	const x = new Float32Array(n);
	let s = seed >>> 0;
	let p1 = 0;
	let p2 = 0;
	for (let i = 0; i < n; i++) {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		const w = s / 0x3fffffff - 1;
		p1 = 0.92 * p1 + 0.08 * w;
		p2 = 0.85 * p2 + 0.15 * p1;
		x[i] = p2 * 3;
	}
	return x;
}

/** Attenuated playback→mic path: bulk delay + decaying reverb tail. */
function echoOf(x: Float32Array, gain = 0.22): Float32Array {
	const delay = 35;
	const tail = 90;
	const h = new Float32Array(delay + tail);
	for (let k = 0; k < tail; k++) {
		h[delay + k] = Math.exp(-k / 25) * (k % 2 ? -0.6 : 0.8) * gain;
	}
	const y = new Float32Array(x.length);
	for (let n = 0; n < x.length; n++) {
		let acc = 0;
		for (let k = 0; k < h.length; k++) if (n - k >= 0) acc += h[k] * x[n - k];
		y[n] = acc;
	}
	return y;
}

/** Captures the (post-AEC) PCM frames the consumer feeds to VAD. Emits no VAD
 *  events, so no turn finalizes — we only inspect the mic stream the AEC produced. */
class CapturingVad implements VadSegmenter {
	readonly inSpeech = false;
	readonly frames: Float32Array[] = [];
	onVadEvent(_listener: (event: VadEvent) => void): () => void {
		return () => {};
	}
	async pushFrame(frame: PcmFrame): Promise<void> {
		this.frames.push(frame.pcm);
	}
	async flush(): Promise<void> {}
	reset(): void {}
}

class InertPipeline implements AttributionPipelineLike {
	async attribute(
		req: Parameters<AttributionPipelineLike["attribute"]>[0],
	): Promise<VoiceAttributionOutput> {
		return {
			turnId: req.turnId,
			segments: [],
			turn: { turnId: req.turnId },
		} as VoiceAttributionOutput;
	}
}

class InertRuntime implements RuntimeEventSink {
	async emitEvent(): Promise<void> {}
}

describe("AudioFrameConsumer AEC wiring (#9583)", () => {
	it("cancels the agent echo through the wired buffer+provider path", async () => {
		const SECONDS = 4;
		const N = SR * SECONDS;
		const BLOCK = 320; // 20 ms mic frame
		const far = speechLike(N, 1);
		const echo = echoOf(far);

		const buffer = new PlaybackReferenceBuffer();
		const echoReference = createEchoReferenceProvider(buffer, {
			delaySamples: 0, // the 35-sample path delay is absorbed by the NLMS taps
		});
		const vad = new CapturingVad();
		const consumer = new AudioFrameConsumer({
			vad,
			pipeline: new InertPipeline(),
			runtime: new InertRuntime(),
			echoReference,
		});

		for (let off = 0; off + BLOCK <= N; off += BLOCK) {
			const tMs = (off / SR) * 1000;
			// The device supplies the far-end playback aligned to this mic window…
			buffer.write(far.subarray(off, off + BLOCK), tMs);
			// …then the mic frame (which contains the echo) arrives.
			await consumer.pushDecodedFrame(echo.subarray(off, off + BLOCK), tMs);
		}

		// Every frame had playback → the canceller ran on all of them.
		expect(consumer.echoFramesCancelled).toBe(vad.frames.length);

		// After convergence (ignore the first 2 s), the mic stream the consumer
		// handed to VAD is >=10 dB quieter than the raw echo it was fed.
		const fromFrame = Math.floor((SR * 2) / BLOCK);
		const cancelled = new Float32Array((vad.frames.length - fromFrame) * BLOCK);
		let c = 0;
		for (let f = fromFrame; f < vad.frames.length; f++) {
			cancelled.set(vad.frames[f], c);
			c += vad.frames[f].length;
		}
		const erleDb =
			10 * Math.log10(energy(echo.subarray(SR * 2)) / energy(cancelled));
		expect(erleDb).toBeGreaterThan(10);
	});

	it("passes the mic through and never invokes the canceller when no playback arrives", async () => {
		const buffer = new PlaybackReferenceBuffer();
		const echoReference = createEchoReferenceProvider(buffer, {
			delaySamples: 0,
		});
		const vad = new CapturingVad();
		const consumer = new AudioFrameConsumer({
			vad,
			pipeline: new InertPipeline(),
			runtime: new InertRuntime(),
			echoReference,
		});
		const mic = speechLike(320, 42);
		await consumer.pushDecodedFrame(mic, 1000); // buffer empty → provider null
		expect(consumer.echoFramesCancelled).toBe(0);
		expect(Array.from(vad.frames[0])).toEqual(Array.from(mic)); // exact passthrough
	});
});
