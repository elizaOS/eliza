/**
 * AEC (#9455) — sample-level acoustic echo cancellation.
 *
 * Deterministic, model-free DSP verification on synthetic echo paths:
 *   1. Pure echo (far-end convolved with a decaying room IR) must be cancelled
 *      to ERLE >= 20 dB after the NLMS filter converges.
 *   2. Double-talk (echo + an independent near-end speaker) must pass the
 *      near-end speech through (high correlation), freeze adaptation, and NOT
 *      diverge — a following echo-only segment stays well-cancelled.
 *
 * No models, no hardware — pure linear algebra, fully CI-able on Linux CPU.
 */

import { describe, expect, it } from "vitest";
import { Aec, erle } from "../aec";

const SR = 16000;

/** Deterministic LCG so the fixtures are reproducible across runs/CI. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (1664525 * s + 1013904223) >>> 0;
		return s / 0xffffffff;
	};
}

/** A decaying random room impulse response (the echo path speaker→room→mic). */
function roomIr(taps: number, decay: number, rand: () => number): Float64Array {
	const h = new Float64Array(taps);
	for (let i = 0; i < taps; i++) {
		h[i] = (rand() * 2 - 1) * Math.exp(-decay * i);
	}
	return h;
}

/** Convolve far through the IR to produce the echo at the mic. */
function convolve(far: Float32Array, h: Float64Array): Float32Array {
	const out = new Float32Array(far.length);
	for (let n = 0; n < far.length; n++) {
		let acc = 0;
		for (let k = 0; k < h.length && k <= n; k++) acc += h[k] * far[n - k];
		out[n] = acc;
	}
	return out;
}

/** A band-limited noise-ish far-end (the agent's TTS playback). */
function farSignal(len: number, rand: () => number): Float32Array {
	const x = new Float32Array(len);
	let lp = 0;
	for (let i = 0; i < len; i++) {
		lp = 0.85 * lp + 0.15 * (rand() * 2 - 1);
		x[i] = lp * 0.8;
	}
	return x;
}

/** A distinct tonal near-end speaker (the human barging in). */
function speech(len: number, hz: number): Float32Array {
	const s = new Float32Array(len);
	for (let i = 0; i < len; i++) {
		const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * 3 * i) / SR); // 3 Hz syllabic env
		s[i] = 0.5 * env * Math.sin((2 * Math.PI * hz * i) / SR);
	}
	return s;
}

function corr(a: Float32Array, b: Float32Array): number {
	let sa = 0, sb = 0, sab = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		sa += a[i] * a[i];
		sb += b[i] * b[i];
		sab += a[i] * b[i];
	}
	if (sa <= 0 || sb <= 0) return 0;
	return sab / Math.sqrt(sa * sb);
}

describe("Aec — sample-level echo cancellation", () => {
	it("cancels a synthetic echo path to >= 20 dB ERLE after convergence", () => {
		const rand = lcg(12345);
		const ir = roomIr(200, 0.02, rand);
		const far = farSignal(SR, rand); // 1 s
		const echo = convolve(far, ir);

		const aec = new Aec({ filterLength: 512, mu: 0.5 });
		// A few passes to let NLMS converge (a real stream is continuous).
		let out = echo;
		for (let pass = 0; pass < 6; pass++) out = aec.process(echo, far);

		// Measure ERLE on the converged tail (last 250 ms).
		const tail = (a: Float32Array) => a.subarray(a.length - SR / 4);
		const got = erle(tail(echo), tail(out));
		expect(got).toBeGreaterThanOrEqual(20);
	});

	it("preserves near-end speech during double-talk and freezes adaptation", () => {
		const rand = lcg(67890);
		const ir = roomIr(200, 0.02, rand);
		const far = farSignal(SR, rand);
		const echo = convolve(far, ir);

		const aec = new Aec({ filterLength: 512, mu: 0.5 });
		// Converge on echo-only first.
		for (let pass = 0; pass < 5; pass++) aec.process(echo, far);

		// Double-talk: echo + an independent near-end talker.
		const user = speech(SR, 440);
		const near = new Float32Array(SR);
		for (let i = 0; i < SR; i++) near[i] = echo[i] + user[i];

		const out = aec.process(near, far);
		// The user's voice survives the cancellation (echo removed, speech kept).
		expect(corr(out, user)).toBeGreaterThan(0.7);
		// The double-talk detector fired on the strong near-end region.
		expect(aec.lastDoubleTalk).toBe(true);

		// And the filter did not diverge: a following echo-only segment is still
		// well-cancelled.
		const post = aec.process(echo, far);
		const tail = (a: Float32Array) => a.subarray(a.length - SR / 4);
		expect(erle(tail(echo), tail(post))).toBeGreaterThanOrEqual(15);
	});

	it("erle() reports +Inf for a perfect residual and 0 for no cancellation", () => {
		const near = new Float32Array([0.3, -0.4, 0.5]);
		expect(erle(near, new Float32Array([0, 0, 0]))).toBe(Number.POSITIVE_INFINITY);
		expect(erle(near, near)).toBeCloseTo(0, 6);
	});

	it("process() returns exactly near.length samples and never NaN", () => {
		const aec = new Aec({ filterLength: 64 });
		const near = new Float32Array(1000).map((_, i) => Math.sin(i / 10));
		const far = new Float32Array(1000).map((_, i) => Math.sin(i / 7));
		const out = aec.process(near, far);
		expect(out.length).toBe(near.length);
		expect(out.every((v) => Number.isFinite(v))).toBe(true);
	});
});
