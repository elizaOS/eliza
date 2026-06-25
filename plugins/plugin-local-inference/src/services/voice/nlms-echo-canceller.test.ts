import { describe, expect, it } from "vitest";
import { NlmsEchoCanceller } from "./nlms-echo-canceller";

const SR = 16000;
const BLOCK = 320; // 20 ms @ 16 kHz — the pipeline's frame size

/** Speech-like signal: two-pole low-passed pseudo-random noise (deterministic). */
function signal(n: number, seed: number): Float32Array {
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

/** Realistic (attenuated) playback→mic path: bulk delay + decaying reverb. */
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

function power(a: Float32Array, from = 0, to = a.length): number {
	let p = 0;
	for (let i = from; i < to; i++) p += a[i] * a[i];
	return p / Math.max(1, to - from);
}

function runBlocks(
	aec: NlmsEchoCanceller,
	near: Float32Array,
	far: Float32Array,
): Float32Array {
	const out = new Float32Array(near.length);
	for (let off = 0; off + BLOCK <= near.length; off += BLOCK) {
		out.set(
			aec.process(
				near.subarray(off, off + BLOCK),
				far.subarray(off, off + BLOCK),
			),
			off,
		);
	}
	return out;
}

describe("NlmsEchoCanceller", () => {
	it("cancels the agent's echo by >=10 dB ERLE after convergence (echo-only)", () => {
		const N = SR * 4;
		const far = signal(N, 1);
		const echo = echoOf(far);
		const out = runBlocks(
			new NlmsEchoCanceller({ filterTaps: 256, mu: 0.5 }),
			echo,
			far,
		);
		const from = SR * 2; // ignore the first 2 s of adaptation
		const to = N - (N % BLOCK);
		const erleDb =
			10 * Math.log10(power(echo, from, to) / power(out, from, to));
		expect(erleDb).toBeGreaterThan(10);
	});

	it("passes the mic through unchanged while the agent is silent", () => {
		const aec = new NlmsEchoCanceller({ filterTaps: 256 });
		const micOnly = signal(BLOCK, 777);
		const out = aec.process(micOnly, new Float32Array(BLOCK)); // far-end = silence
		let maxDiff = 0;
		for (let i = 0; i < BLOCK; i++) {
			maxDiff = Math.max(maxDiff, Math.abs(out[i] - micOnly[i]));
		}
		expect(maxDiff).toBeLessThan(1e-6);
	});

	it("never touches the user's voice when only the user is speaking (no playback)", () => {
		// Pure near-end speech, agent silent for the whole run → exact passthrough,
		// so the canceller can never suppress a barge-in while no echo exists.
		const N = SR * 2;
		const speech = signal(N, 99);
		const out = runBlocks(
			new NlmsEchoCanceller({ filterTaps: 256 }),
			speech,
			new Float32Array(N),
		);
		let maxDiff = 0;
		for (let i = 0; i < out.length; i++) {
			maxDiff = Math.max(maxDiff, Math.abs(out[i] - speech[i]));
		}
		expect(maxDiff).toBeLessThan(1e-6);
	});

	it("stays stable (does not diverge) under sustained double-talk", () => {
		// Agent speaks the whole time; the user also speaks from 2 s. The filter
		// must not blow up — the output power stays bounded near the input power.
		const N = SR * 4;
		const far = signal(N, 1);
		const echo = echoOf(far);
		const speech = signal(N, 99);
		const near = new Float32Array(N);
		for (let i = 0; i < N; i++)
			near[i] = echo[i] + (i >= SR * 2 ? speech[i] : 0);
		const out = runBlocks(
			new NlmsEchoCanceller({ filterTaps: 256, mu: 0.5, dtdRatio: 1.5 }),
			near,
			far,
		);
		const from = SR * 2;
		const to = N - (N % BLOCK);
		// No divergence: output energy is the same order as the input, not exploding.
		expect(power(out, from, to)).toBeLessThan(power(near, from, to) * 4);
		for (let i = from; i < to; i++) expect(Number.isFinite(out[i])).toBe(true);
	});

	it("reset() clears adaptation (first post-reset sample is exact passthrough)", () => {
		const far = signal(SR, 1);
		const echo = echoOf(far);
		const aec = new NlmsEchoCanceller({ filterTaps: 128 });
		runBlocks(aec, echo, far);
		aec.reset();
		const out = aec.process(echo.subarray(0, BLOCK), far.subarray(0, BLOCK));
		// weights + reference history are zero → ŷ[0]=0 → out[0]==in[0] exactly.
		expect(out[0]).toBe(echo[0]);
	});
});
