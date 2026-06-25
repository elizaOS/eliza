/**
 * echo-delay-calibrator tests (#9583): cross-correlation delay recovery +
 * per-platform seed table.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_PLAYBACK_DELAY_MS,
	estimatePlaybackDelaySamples,
	PLATFORM_PLAYBACK_DELAY_DEFAULTS,
	platformPlaybackDelayMs,
	platformPlaybackDelaySamples,
} from "./echo-delay-calibrator";

const SR = 16_000;

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

describe("estimatePlaybackDelaySamples", () => {
	it("recovers a known bulk playback→mic delay", () => {
		const N = SR; // 1 s
		const far = speechLike(N, 7);
		const D = 120; // the delay we expect to recover
		const mic = new Float32Array(N);
		for (let i = D; i < N; i++) mic[i] = 0.5 * far[i - D]; // echo = attenuated, delayed far
		const result = estimatePlaybackDelaySamples(mic, far, {
			maxLagSamples: 400,
		});
		expect(Math.abs(result.delaySamples - D)).toBeLessThanOrEqual(2);
		expect(result.confidence).toBeGreaterThan(0.7);
		expect(result.delayMs).toBeCloseTo((result.delaySamples / SR) * 1000, 3);
	});

	it("recovers a zero delay (reference already aligned)", () => {
		const N = SR;
		const far = speechLike(N, 11);
		const mic = new Float32Array(N);
		for (let i = 0; i < N; i++) mic[i] = 0.4 * far[i];
		const result = estimatePlaybackDelaySamples(mic, far, {
			maxLagSamples: 400,
		});
		expect(result.delaySamples).toBeLessThanOrEqual(2);
		expect(result.confidence).toBeGreaterThan(0.7);
	});

	it("returns zero confidence for silence", () => {
		const result = estimatePlaybackDelaySamples(
			new Float32Array(SR),
			new Float32Array(SR),
		);
		expect(result.confidence).toBe(0);
		expect(result.delaySamples).toBe(0);
	});

	it("is not fooled into a high-confidence lock by uncorrelated near-end speech", () => {
		const N = SR;
		const far = speechLike(N, 3);
		const nearOnly = speechLike(N, 9999); // user speech, no echo of `far`
		const result = estimatePlaybackDelaySamples(nearOnly, far, {
			maxLagSamples: 400,
		});
		expect(result.confidence).toBeLessThan(0.3);
	});
});

describe("platform playback-delay seeds", () => {
	it("maps known platforms to their seed and samples", () => {
		expect(platformPlaybackDelayMs("darwin")).toBe(
			PLATFORM_PLAYBACK_DELAY_DEFAULTS.darwin,
		);
		expect(platformPlaybackDelaySamples("darwin")).toBe(
			Math.round((PLATFORM_PLAYBACK_DELAY_DEFAULTS.darwin / 1000) * SR),
		);
		expect(platformPlaybackDelayMs("ios")).toBe(
			PLATFORM_PLAYBACK_DELAY_DEFAULTS.ios,
		);
	});

	it("falls back to the default for an unknown platform", () => {
		expect(platformPlaybackDelayMs("plan9")).toBe(DEFAULT_PLAYBACK_DELAY_MS);
		expect(platformPlaybackDelaySamples("plan9")).toBe(
			Math.round((DEFAULT_PLAYBACK_DELAY_MS / 1000) * SR),
		);
	});
});
