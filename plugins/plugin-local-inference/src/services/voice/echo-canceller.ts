/**
 * Sample-level acoustic echo cancellation (AEC) for the half-duplex voice path.
 *
 * Part (1) of #9455: a pure, dependency-free block/sample NLMS adaptive filter
 * with a Geigel double-talk detector and a quantified ERLE metric. Given an
 * aligned far-end reference (what the agent is playing through the speaker) and
 * the near-end microphone capture, it subtracts the linear echo of the far-end
 * from the mic so the agent can be cleanly barged-in while it is speaking.
 *
 * No FFI, no fs, no network — runs in the fast unit-test lane. Part (2) (wiring
 * a live far-end playback tap into mic-source/audio-frame-consumer) is separate
 * and is the real engineering; it is NOT implemented here.
 *
 * The adaptive filter is NLMS (normalized least-mean-squares): for each sample
 *   echoEst[n] = wᵀ · x[n-L+1 .. n]              (x = far-end tap-delay line)
 *   e[n]       = near[n] - echoEst[n]            (echo-cancelled output)
 *   w         += (mu · e[n] / (‖x‖² + delta)) · x   (only when NOT double-talk)
 * A Geigel detector freezes adaptation when near-end speech is present, so a
 * real barge-in passes through uncancelled instead of being adapted away.
 */

export interface NlmsEchoCancellerConfig {
	/** Sample rate of both far/near streams (Hz). Default 16000. */
	sampleRate?: number;
	/** Adaptive filter tail length in ms (echo path length). Default 150ms. */
	tailMs?: number;
	/** NLMS step size (0<mu<=1). Smaller = slower but more stable. Default 0.5. */
	mu?: number;
	/** Regularization added to the far-end energy to avoid div-by-zero. Default 1e-3. */
	delta?: number;
	/**
	 * Geigel double-talk threshold: near-end is considered active (freeze
	 * adaptation) when |near[n]| exceeds this fraction of the recent far-end
	 * peak. Default 0.5.
	 */
	doubleTalkThreshold?: number;
}

const DEFAULTS = {
	sampleRate: 16_000,
	tailMs: 150,
	mu: 0.5,
	delta: 1e-3,
	doubleTalkThreshold: 0.5,
} as const;

export class NlmsEchoCanceller {
	private readonly taps: number;
	private readonly mu: number;
	private readonly delta: number;
	private readonly doubleTalkThreshold: number;
	/** Adaptive filter weights (length = taps). */
	private readonly w: Float32Array;
	/** Far-end tap-delay line (most-recent-last). */
	private readonly x: Float32Array;
	/** Running max |far-end| over the tap window, for the Geigel detector. */
	private farPeak = 0;

	constructor(config: NlmsEchoCancellerConfig = {}) {
		const sampleRate = config.sampleRate ?? DEFAULTS.sampleRate;
		const tailMs = config.tailMs ?? DEFAULTS.tailMs;
		this.taps = Math.max(1, Math.round((sampleRate * tailMs) / 1000));
		this.mu = config.mu ?? DEFAULTS.mu;
		this.delta = config.delta ?? DEFAULTS.delta;
		this.doubleTalkThreshold =
			config.doubleTalkThreshold ?? DEFAULTS.doubleTalkThreshold;
		this.w = new Float32Array(this.taps);
		this.x = new Float32Array(this.taps);
	}

	/**
	 * Process one aligned far/near frame and return the echo-cancelled near-end.
	 * `farEnd` and `nearEnd` must be the same length and time-aligned.
	 */
	process(farEnd: Float32Array, nearEnd: Float32Array): Float32Array {
		if (farEnd.length !== nearEnd.length) {
			throw new Error(
				"[NlmsEchoCanceller] far-end and near-end frames must be the same length",
			);
		}
		const out = new Float32Array(nearEnd.length);
		const { w, x, taps, mu, delta, doubleTalkThreshold } = this;

		for (let n = 0; n < nearEnd.length; n++) {
			// Shift the far-end sample into the tap-delay line (most-recent-last).
			x.copyWithin(0, 1);
			x[taps - 1] = farEnd[n];

			// Echo estimate = wᵀ·x, plus the far-end energy for normalization.
			let echoEst = 0;
			let energy = 0;
			for (let k = 0; k < taps; k++) {
				const xv = x[k];
				echoEst += w[k] * xv;
				energy += xv * xv;
			}

			const error = nearEnd[n] - echoEst;
			out[n] = error;

			// Geigel double-talk: freeze adaptation when near-end clearly exceeds
			// the far-end's recent peak (i.e. the user is talking over the agent),
			// so the user's speech survives instead of being adapted out.
			this.farPeak = Math.max(this.farPeak * 0.999, Math.abs(farEnd[n]));
			const nearActive =
				Math.abs(nearEnd[n]) > doubleTalkThreshold * this.farPeak;

			if (!nearActive) {
				const norm = mu / (energy + delta);
				const step = norm * error;
				for (let k = 0; k < taps; k++) {
					w[k] += step * x[k];
				}
			}
		}
		return out;
	}

	/** Reset the adaptive state (weights, delay line, peak tracker). */
	reset(): void {
		this.w.fill(0);
		this.x.fill(0);
		this.farPeak = 0;
	}
}

/**
 * Echo Return Loss Enhancement in dB: 10·log10(Σ near² / Σ residual²). Higher is
 * better (more echo removed). Returns +Infinity if the residual is silent and 0
 * when there is no near-end energy to enhance.
 */
export function computeErle(
	nearEnd: Float32Array,
	residual: Float32Array,
): number {
	let nearEnergy = 0;
	let residualEnergy = 0;
	const len = Math.min(nearEnd.length, residual.length);
	for (let i = 0; i < len; i++) {
		nearEnergy += nearEnd[i] * nearEnd[i];
		residualEnergy += residual[i] * residual[i];
	}
	if (nearEnergy === 0) return 0;
	if (residualEnergy === 0) return Number.POSITIVE_INFINITY;
	return 10 * Math.log10(nearEnergy / residualEnergy);
}
