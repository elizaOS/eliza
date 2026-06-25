/**
 * PlaybackEchoReference unit tests (#9583) — the far-end provider that captures
 * the agent's TTS playback PCM and answers a mic frame's `(timestampMs,
 * samples)` window with the time-aligned playback, so the NLMS canceller in
 * `echo-canceller.ts` can subtract the agent's own voice off the mic.
 *
 * Pure store: no models, no FFI — runs in the fast lane. Asserts the windowed
 * read (exact alignment, chunk-spanning, zero-padded partial overlap, silent
 * gaps), the playback→mic delay shift, retention eviction, and rate guard.
 */

import { describe, expect, it } from "vitest";
import { PlaybackEchoReference } from "./playback-echo-reference";

const SR = 16_000;

/** A ramp `[atIndex, atIndex+n)` so a returned window is identifiable by value. */
function ramp(start: number, n: number): Float32Array {
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = (start + i) / 1000;
	return out;
}

/** ms at which playback-timeline sample `idx` plays, given an origin ms. */
function msOf(originMs: number, idx: number): number {
	return originMs + (idx / SR) * 1000;
}

describe("PlaybackEchoReference", () => {
	it("returns the exact playback window for an aligned mic frame", () => {
		const store = new PlaybackEchoReference();
		// One 320-sample chunk played at t=1000 ms.
		store.observePlayback(ramp(0, 320), SR, 1000);
		const out = store.reference(1000, 320);
		expect(out).not.toBeNull();
		expect(out?.length).toBe(320);
		expect(Array.from(out as Float32Array)).toEqual(Array.from(ramp(0, 320)));
	});

	it("returns null when the agent was silent over the queried window", () => {
		const store = new PlaybackEchoReference();
		store.observePlayback(ramp(0, 320), SR, 1000);
		// A window entirely before the playback started.
		expect(store.reference(500, 320)).toBeNull();
		// A window entirely after the single chunk ended (320 samples = 20 ms).
		expect(store.reference(2000, 320)).toBeNull();
		// And the empty store answers null for anything.
		expect(new PlaybackEchoReference().reference(1000, 320)).toBeNull();
	});

	it("spans contiguous chunks into one window", () => {
		const store = new PlaybackEchoReference();
		// Two back-to-back 160-sample chunks: [0,160) at 1000ms, [160,320) at the
		// ms 160 samples later. A 320-sample read from 1000ms must stitch both.
		store.observePlayback(ramp(0, 160), SR, 1000);
		store.observePlayback(ramp(160, 160), SR, msOf(1000, 160));
		const out = store.reference(1000, 320);
		expect(out).not.toBeNull();
		expect(Array.from(out as Float32Array)).toEqual(Array.from(ramp(0, 320)));
	});

	it("zero-pads a partial overlap (silence where nothing played)", () => {
		const store = new PlaybackEchoReference();
		// 160 samples played at 1000ms. A 320-sample window from 1000ms overlaps
		// the first 160 and is silent (0) for the trailing 160.
		store.observePlayback(ramp(1, 160), SR, 1000);
		const out = store.reference(1000, 320);
		expect(out).not.toBeNull();
		const arr = out as Float32Array;
		expect(arr.length).toBe(320);
		expect(Array.from(arr.subarray(0, 160))).toEqual(Array.from(ramp(1, 160)));
		for (let i = 160; i < 320; i++) expect(arr[i]).toBe(0);
	});

	it("shifts the query back by the playback→mic transport delay", () => {
		// 10 ms (160 samples) of delay: a mic frame timestamped 10ms later than the
		// playback start must read the playback's first samples (the echo arrives
		// at the mic 10ms after it left the speaker).
		const store = new PlaybackEchoReference({ playbackToMicDelayMs: 10 });
		store.observePlayback(ramp(0, 320), SR, 1000);
		// Without the shift, a 1010ms query would land 160 samples in; with the
		// 10ms shift it realigns to the playback start.
		const out = store.reference(1010, 160);
		expect(out).not.toBeNull();
		expect(Array.from(out as Float32Array)).toEqual(Array.from(ramp(0, 160)));
	});

	it("evicts old playback past the retention budget but keeps recent reads", () => {
		// 1 s retention: ~50 chunks of 320 samples = 1 s. Push well past it.
		const store = new PlaybackEchoReference({ retentionSeconds: 1 });
		let originMs = 1000;
		let idx = 0;
		for (let c = 0; c < 100; c++) {
			store.observePlayback(ramp(idx, 320), SR, msOf(1000, idx));
			idx += 320;
			originMs = msOf(1000, idx);
		}
		// Retained span is bounded ~1 s (≤ retention + one chunk).
		expect(store.samples).toBeLessThanOrEqual(SR + 320);
		// The most recent chunk is still readable...
		const lastStartMs = msOf(1000, idx - 320);
		const out = store.reference(lastStartMs, 320);
		expect(out).not.toBeNull();
		expect(Array.from(out as Float32Array)).toEqual(
			Array.from(ramp(idx - 320, 320)),
		);
		// ...while the very first chunk (long evicted) reads as silence.
		expect(store.reference(1000, 320)).toBeNull();
		void originMs;
	});

	it("reset() drops all buffered playback", () => {
		const store = new PlaybackEchoReference();
		store.observePlayback(ramp(0, 320), SR, 1000);
		expect(store.samples).toBe(320);
		store.reset();
		expect(store.samples).toBe(0);
		expect(store.reference(1000, 320)).toBeNull();
	});

	it("ignores empty chunks and rejects a wrong sample rate", () => {
		const store = new PlaybackEchoReference();
		store.observePlayback(new Float32Array(0), SR, 1000);
		expect(store.samples).toBe(0);
		expect(() => store.observePlayback(ramp(0, 8), 48_000, 1000)).toThrow(
			/16000 Hz/,
		);
	});
});
