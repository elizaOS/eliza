import { describe, expect, it } from "vitest";
import { computeErle, NlmsEchoCanceller } from "./echo-canceller.ts";
import { applyReverb } from "./corpus-augment.ts";

/** Deterministic PRNG so the test is reproducible. */
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

/** White-noise far-end in [-amp, amp]. */
function whiteNoise(n: number, amp: number, rng: () => number): Float32Array {
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = (rng() * 2 - 1) * amp;
	return out;
}

/** Convolve `signal` with a short FIR room impulse to synthesize the echo. */
function applyEcho(signal: Float32Array, impulse: number[]): Float32Array {
	const out = new Float32Array(signal.length);
	for (let n = 0; n < signal.length; n++) {
		let acc = 0;
		for (let k = 0; k < impulse.length; k++) {
			if (n - k >= 0) acc += impulse[k] * signal[n - k];
		}
		out[n] = acc;
	}
	return out;
}

const ROOM_IMPULSE = [
	0.0, 0.0, 0.0, 0.0, 0.0, 0.6, 0.0, -0.3, 0.15, 0.0, -0.05,
];

describe("NlmsEchoCanceller", () => {
	it("converges to high ERLE on single-talk (echo only)", () => {
		const rng = mulberry32(1);
		const far = whiteNoise(16_000, 0.3, rng);
		const near = applyEcho(far, ROOM_IMPULSE); // pure echo, no near speech
		const aec = new NlmsEchoCanceller({ tailMs: 16, mu: 0.7 }); // 256 taps @16k
		const residual = aec.process(far, near);

		// Measure on the converged tail (last quarter).
		const start = Math.floor(near.length * 0.75);
		const erle = computeErle(near.subarray(start), residual.subarray(start));
		expect(erle).toBeGreaterThanOrEqual(15);
	});

	it("preserves near-end speech during double-talk (adaptation freezes)", () => {
		const rng = mulberry32(2);
		const far = whiteNoise(16_000, 0.3, rng);
		const echo = applyEcho(far, ROOM_IMPULSE);
		// Loud near-end speech present from the start -> Geigel should freeze.
		const nearSpeech = new Float32Array(far.length);
		for (let i = 0; i < far.length; i++) {
			nearSpeech[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / 16_000);
		}
		const near = new Float32Array(far.length);
		for (let i = 0; i < far.length; i++) near[i] = echo[i] + nearSpeech[i];

		const aec = new NlmsEchoCanceller({ tailMs: 16, mu: 0.7 });
		const residual = aec.process(far, near);

		// With adaptation frozen, the canceller must NOT cancel the user: the
		// near speech survives, so ERLE stays low (output ~= input).
		const start = Math.floor(near.length * 0.75);
		const dtErle = computeErle(near.subarray(start), residual.subarray(start));
		expect(dtErle).toBeLessThan(6);
		// The user's speech energy is retained in the output (not adapted away).
		let residualSpeechEnergy = 0;
		let speechEnergy = 0;
		for (let i = start; i < near.length; i++) {
			residualSpeechEnergy += residual[i] * residual[i];
			speechEnergy += nearSpeech[i] * nearSpeech[i];
		}
		expect(residualSpeechEnergy).toBeGreaterThan(speechEnergy * 0.5);
	});

	it("computeErle returns dB and handles edge cases", () => {
		const near = new Float32Array([1, 1, 1, 1]);
		const halfResidual = new Float32Array([0.5, 0.5, 0.5, 0.5]);
		// near energy / residual energy = 4 -> 10*log10(4) ~= 6.02 dB
		expect(computeErle(near, halfResidual)).toBeCloseTo(6.0206, 2);
		expect(
			computeErle(new Float32Array([0, 0]), new Float32Array([1, 1])),
		).toBe(0);
		expect(
			computeErle(new Float32Array([1, 1]), new Float32Array([0, 0])),
		).toBe(Number.POSITIVE_INFINITY);
	});

	it("rejects mismatched frame lengths", () => {
		const aec = new NlmsEchoCanceller();
		expect(() => aec.process(new Float32Array(4), new Float32Array(8))).toThrow(
			/same length/,
		);
	});

	it("scores a reverberant (Freeverb) echo path — the hard case — alongside the clean FIR", () => {
		const far = whiteNoise(16_000, 0.3, mulberry32(3));

		// Clean path: a short FIR room impulse (same family as the single-talk test).
		const cleanNear = applyEcho(far, ROOM_IMPULSE);
		const cleanResidual = new NlmsEchoCanceller({ tailMs: 16, mu: 0.7 }).process(
			far,
			cleanNear,
		);

		// Reverberant path: Freeverb/Schroeder leaves a long decaying tail, so the
		// echo is no longer a short FIR — the hard case for a fixed-tail NLMS. Trim
		// the reverb tail back to far.length so frames stay aligned.
		const revNear = applyReverb(far, 16_000, { room: 0.6, wet: 0.5 }).subarray(
			0,
			far.length,
		);
		const revResidual = new NlmsEchoCanceller({ tailMs: 50, mu: 0.5 }).process(
			far,
			revNear,
		);

		const start = Math.floor(far.length * 0.75);
		const cleanErle = computeErle(
			cleanNear.subarray(start),
			cleanResidual.subarray(start),
		);
		const revErle = computeErle(
			revNear.subarray(start),
			revResidual.subarray(start),
		);

		// Calibrated to the observed ~1.11 dB: the canceller still achieves modest,
		// STABLE cancellation on the reverberant tail (it does not diverge), but it
		// is materially worse than the clean short-FIR path — exactly why the
		// reverberant playback path is the load-bearing corpus case for #9455.
		expect(revErle).toBeGreaterThanOrEqual(0.8);
		expect(revErle).toBeLessThan(cleanErle);
	});

});
