/** Covers the NLMS adaptive echo canceller and its opt-in residual suppressor (#9583/#9649). Deterministic. */
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

	it("does not diverge when the far-end has quiet passages (real-TTS pauses)", () => {
		// Regression for the divergence found measuring real Kokoro/`say` TTS echo
		// on-device (#9455): real TTS has inter-word/sentence pauses where the
		// far-end energy collapses toward — but never reaches — zero (DAC dither,
		// room floor). Meanwhile the mic always carries a small noise floor. Before
		// the far-end-activity gate, ‖x‖²→ε during those pauses inflated the NLMS
		// step so the filter learned the MIC NOISE and blew up (‖w‖→100s, residual
		// RMS ≫ input). A purely-zero gap does NOT reproduce it (x[k]=0 → no update),
		// which is why the synthetic echo test missed it — the floor is essential.
		const N = SR * 6;
		const speech = signal(N, 1);
		const far = new Float32Array(N);
		for (let i = 0; i < N; i++) {
			const t = i / SR;
			const active = t % 0.6 < 0.4 ? 1 : 0; // 0.4 s on / 0.2 s pause, TTS-like
			// Quiet passage keeps a tiny non-zero floor (≈ −60 dBFS), as real audio does.
			far[i] = active ? speech[i] : speech[i] * 3e-4;
		}
		const echo = echoOf(far);
		const near = new Float32Array(N);
		let s = 4242 >>> 0;
		for (let i = 0; i < N; i++) {
			s = (s * 1103515245 + 12345) & 0x7fffffff;
			near[i] = echo[i] + (s / 0x3fffffff - 1) * 6e-3; // continuous mic noise floor
		}
		const out = runBlocks(new NlmsEchoCanceller(), near, far); // shipped defaults
		const from = SR * 2;
		const to = N - (N % BLOCK);
		for (let i = from; i < to; i++) expect(Number.isFinite(out[i])).toBe(true);
		// Stable: the cleaned signal stays at/below the mic level — it must never
		// amplify the input (divergence injected ~200× energy before the fix).
		expect(power(out, from, to)).toBeLessThan(power(near, from, to) * 1.5);
		let peak = 0;
		for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(out[i]));
		expect(peak).toBeLessThan(1); // pre-fix peaks reached >20
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

	describe("opt-in residual suppressor (#9583/#9649)", () => {
		it("further attenuates the residual on echo-only frames when enabled", () => {
			const far = signal(SR, 7);
			const near = echoOf(far); // user silent — echo only
			const base = runBlocks(
				new NlmsEchoCanceller({ filterTaps: 256, mu: 0.5 }),
				near,
				far,
			);
			const sup = runBlocks(
				new NlmsEchoCanceller({
					filterTaps: 256,
					mu: 0.5,
					residualSuppression: true,
				}),
				near,
				far,
			);
			const half = near.length >> 1; // measure after convergence
			// The suppressor only ever scales the residual down, so on echo-only
			// frames its output power must be strictly below the linear filter's.
			expect(power(sup, half)).toBeLessThan(power(base, half));
		});

		it("preserves the user's voice during double-talk (only touches echo-only sub-frames)", () => {
			const far = signal(SR, 3);
			const user = signal(SR, 99); // continuous local talker
			const echo = echoOf(far);
			const near = new Float32Array(far.length);
			for (let i = 0; i < near.length; i++) near[i] = user[i] + echo[i];
			const cfg = { filterTaps: 256, mu: 0.5, dtdRatio: 1.5 } as const;
			const base = runBlocks(new NlmsEchoCanceller(cfg), near, far);
			const sup = runBlocks(
				new NlmsEchoCanceller({ ...cfg, residualSuppression: { gain: 0.1 } }),
				near,
				far,
			);
			// With the user active, near-end power dominates far-end power, so the
			// gate (pFar > pNear) stays shut and the user's voice is left intact.
			// The suppressor only ever engages on the rare echo-only sub-frame (a
			// momentary user pause while the agent plays), so total output power is
			// preserved to well within 0.1% — never the aggressive `gain: 0.1` crush.
			const half = near.length >> 1;
			const pBase = power(base, half);
			const pSup = power(sup, half);
			expect(Math.abs(pSup - pBase) / pBase).toBeLessThan(0.001);
		});

		it("is off by default (no residualSuppression option ⇒ no extra attenuation)", () => {
			const far = signal(SR, 5);
			const near = echoOf(far);
			const a = runBlocks(
				new NlmsEchoCanceller({ filterTaps: 128 }),
				near,
				far,
			);
			const b = runBlocks(
				new NlmsEchoCanceller({ filterTaps: 128, residualSuppression: false }),
				near,
				far,
			);
			const half = near.length >> 1;
			expect(power(a, half)).toBeCloseTo(power(b, half), 12);
		});
	});
});
