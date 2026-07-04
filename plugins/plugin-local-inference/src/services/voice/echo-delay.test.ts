/** Covers echo playback-delay estimation and per-platform seed defaults (#9583). Deterministic. */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_PLAYBACK_DELAY_MS,
	estimateEchoDelaySamples,
	PLATFORM_PLAYBACK_DELAY_DEFAULTS,
	platformPlaybackDelayMs,
	platformPlaybackDelaySamples,
} from "./echo-delay.ts";

/** Deterministic PRNG so fixtures are reproducible across runs/CI. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function whiteNoise(n: number, amp: number, rng: () => number): Float32Array {
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = (rng() * 2 - 1) * amp;
	return out;
}

describe("estimateEchoDelaySamples (#9583)", () => {
	it("recovers a known playback→mic delay", () => {
		const rng = mulberry32(7);
		const far = whiteNoise(8000, 0.5, rng);
		const delay = 137;
		const gain = 0.6;
		const near = new Float32Array(far.length);
		for (let i = delay; i < far.length; i++) {
			near[i] = gain * far[i - delay] + (rng() * 2 - 1) * 0.01; // tiny near noise
		}

		const est = estimateEchoDelaySamples(near, far, { maxLagSamples: 400 });
		expect(est.lagSamples).toBe(delay);
		// Scale-invariant correlation: the 0.6 gain does not lower confidence.
		expect(est.confidence).toBeGreaterThan(0.9);
	});

	it("recovers a zero delay (synchronous reference)", () => {
		const rng = mulberry32(3);
		const far = whiteNoise(8000, 0.5, rng);
		const near = new Float32Array(far.length);
		for (let i = 0; i < far.length; i++) near[i] = 0.7 * far[i];

		const est = estimateEchoDelaySamples(near, far, { maxLagSamples: 200 });
		expect(est.lagSamples).toBe(0);
		expect(est.confidence).toBeGreaterThan(0.95);
	});

	it("reports low confidence when near is independent of far (no echo)", () => {
		const far = whiteNoise(8000, 0.5, mulberry32(1));
		const near = whiteNoise(8000, 0.5, mulberry32(2)); // independent signal

		const est = estimateEchoDelaySamples(near, far, { maxLagSamples: 400 });
		expect(est.confidence).toBeLessThan(0.3);
	});

	it("returns zero on empty input", () => {
		expect(
			estimateEchoDelaySamples(new Float32Array(0), new Float32Array(0)),
		).toEqual({ lagSamples: 0, confidence: 0 });
	});

	it("honors a minLagSamples floor", () => {
		const rng = mulberry32(9);
		const far = whiteNoise(8000, 0.5, rng);
		const delay = 40;
		const near = new Float32Array(far.length);
		for (let i = delay; i < far.length; i++) near[i] = 0.5 * far[i - delay];

		// Floor above the true delay forces the search to start past it.
		const est = estimateEchoDelaySamples(near, far, {
			minLagSamples: 100,
			maxLagSamples: 400,
		});
		expect(est.lagSamples).toBeGreaterThanOrEqual(100);
	});
});

describe("platformPlaybackDelaySamples seed (#9583)", () => {
	it("maps known platforms to their seed delay (ms)", () => {
		expect(platformPlaybackDelayMs("darwin")).toBe(20);
		expect(platformPlaybackDelayMs("ios")).toBe(25);
		expect(platformPlaybackDelayMs("android")).toBe(45);
		expect(platformPlaybackDelayMs("win32")).toBe(30);
		expect(platformPlaybackDelayMs("linux")).toBe(30);
	});

	it("falls back to the default seed for an unrecognized platform", () => {
		expect(platformPlaybackDelayMs("haiku")).toBe(DEFAULT_PLAYBACK_DELAY_MS);
		// The table must not accidentally carry the unknown key.
		expect("haiku" in PLATFORM_PLAYBACK_DELAY_DEFAULTS).toBe(false);
	});

	it("converts the seed to samples at 16 kHz by default", () => {
		// 20 ms * 16000 / 1000 = 320 samples
		expect(platformPlaybackDelaySamples("darwin")).toBe(320);
		// unknown → 25 ms default → 400 samples
		expect(platformPlaybackDelaySamples("unknown")).toBe(400);
	});

	it("honours a custom sample rate", () => {
		// 30 ms * 48000 / 1000 = 1440 samples
		expect(platformPlaybackDelaySamples("win32", 48_000)).toBe(1440);
	});

	it("never returns a negative seed", () => {
		for (const p of ["darwin", "ios", "android", "win32", "linux", "??"]) {
			expect(platformPlaybackDelaySamples(p)).toBeGreaterThanOrEqual(0);
		}
	});
});
