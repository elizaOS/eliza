/**
 * Acoustic echo cancellation — the duplex-voice front-end's anti-feedback stage.
 *
 * When the agent speaks while the mic is open (barge-in / full-duplex), the
 * loudspeaker's output leaks back into the microphone as an attenuated, delayed,
 * room-coloured copy of the playback. Left in, that echo re-triggers the VAD,
 * pollutes ASR, and (worst case) makes the agent talk over itself. This module
 * removes it at the sample level with a normalized-LMS (NLMS) adaptive FIR
 * filter that models the echo path far-end → mic and subtracts the modelled
 * echo from the near-end.
 *
 *   near[n]  — the captured mic sample (desired user speech + echo + noise).
 *   far[n]   — the reference: the exact PCM the agent sent to the speaker.
 *   w        — the adaptive filter's `filterLength` taps, the estimated impulse
 *              response of the echo path.
 *   x        — the most recent `filterLength` delay-aligned far-end samples,
 *              held in a circular buffer.
 *
 * Per sample: `echo_hat = w · x`; the error `e = near − echo_hat` is the
 * echo-cancelled output. When the path is being learned (far-end active, user
 * silent) we adapt the taps with the NLMS update; when the user is *also*
 * talking ("double-talk") we FREEZE adaptation — otherwise the filter would try
 * to model the user's voice as echo and diverge — but keep subtracting, so
 * residual echo is still removed while the user speaks.
 *
 * Double-talk detection is suppression-floor based: track the best echo-only
 * residual-to-near energy ratio the converged filter achieves, and flag
 * double-talk when the instantaneous ratio jumps well above that floor (the
 * residual suddenly carries energy the filter cannot explain — i.e. the user's
 * voice). A short hangover holds the freeze through brief dips. This is robust
 * at cold start: the floor begins permissive (1.0) so the filter is free to
 * converge before any freeze can engage.
 *
 * Pure and dependency-free: no FFI, no model, no I/O. The far-end delay (the
 * measured mic-vs-playback latency) is supplied by the caller via
 * {@link Aec.setDelaySamples}; everything else is fixed-cost per sample
 * (O(filterLength)).
 */

export interface AecOptions {
	/** Adaptive-filter length in taps. Longer = models a longer / more
	 *  reverberant echo tail, at O(filterLength) cost per sample. Default 512
	 *  (≈ 32 ms of impulse response @ 16 kHz). */
	filterLength?: number;
	/** NLMS step size (0..2). Larger = faster convergence but more
	 *  misadjustment and a higher divergence risk under double-talk. Default
	 *  0.3. */
	mu?: number;
	/** NLMS regularization added to the reference energy in the denominator —
	 *  bounds the step when the far-end is quiet so a near-silent reference
	 *  cannot blow up the update. Default 1e-3. */
	delta?: number;
	/** Mic / playback sample rate (Hz). Default 16 000. Scales the short-term
	 *  energy windows and the double-talk hangover. */
	sampleRate?: number;
}

/** Per-call adaptation statistics, exposed for tests and telemetry. */
export interface AecStats {
	/** Whether double-talk was detected on the most recent sample (adaptation
	 *  frozen). Includes the hangover hold. */
	doubleTalk: boolean;
	/** Instantaneous suppression ratio on the last sample: short-term residual
	 *  energy / short-term near-end energy. Low = the filter is explaining the
	 *  near-end (good cancellation); a sharp rise signals double-talk. */
	suppression: number;
	/** Learned echo-only suppression floor (best ratio the converged filter has
	 *  achieved). Double-talk is `suppression > DT_MARGIN × floor`. */
	suppressionFloor: number;
	/** Short-term near-end energy (leaky average of near²). */
	nearEnergy: number;
	/** Short-term residual energy (leaky average of e²). */
	residualEnergy: number;
}

/**
 * Echo Return Loss Enhancement (dB): how much echo energy the canceller
 * removed, `10·log10(Σ near² / Σ residual²)`. Higher is better; a working
 * linear AEC on a converged path reaches 20–40 dB. Guards divide-by-zero
 * (a perfectly silent residual returns `+Infinity`; a silent near returns 0).
 */
export function erle(near: Float32Array, residual: Float32Array): number {
	const n = Math.min(near.length, residual.length);
	let nearPow = 0;
	let resPow = 0;
	for (let i = 0; i < n; i++) {
		nearPow += near[i] * near[i];
		resPow += residual[i] * residual[i];
	}
	if (nearPow <= 0) return 0;
	if (resPow <= 0) return Number.POSITIVE_INFINITY;
	return 10 * Math.log10(nearPow / resPow);
}

/**
 * Sample-level NLMS acoustic echo canceller.
 *
 * Hold one `Aec` per duplex mic stream. Feed it equal-length near (mic) and far
 * (playback reference) blocks; it returns the echo-cancelled near-end of the
 * same length. The far-end window and filter state persist across calls, so the
 * filter keeps converging block to block — call {@link reset} at a stream
 * boundary (new call / device change) to clear it.
 */
export class Aec {
	readonly filterLength: number;
	readonly mu: number;
	readonly delta: number;
	readonly sampleRate: number;

	/** Adaptive FIR taps (the estimated echo-path impulse response). */
	private readonly w: Float32Array;
	/** Circular buffer of the last `filterLength` delay-aligned far-end samples.
	 *  `head` points at the slot the NEXT far sample will overwrite (i.e. one
	 *  past the most recent sample). */
	private readonly history: Float32Array;
	private head = 0;
	/** Running Σx² of the samples currently in `history`, maintained
	 *  incrementally so the NLMS denominator is O(1) instead of O(filterLength). */
	private refEnergy = 0;
	/** Integer far-end delay (samples) aligning the reference to the mic. */
	private delaySamples = 0;
	/** Pending far-end samples not yet shifted into `history` because of the
	 *  delay (a small FIFO of length `delaySamples`). */
	private delayLine: Float32Array;
	private delayHead = 0;

	// Double-talk detector state.
	/** Leaky short-term near-end energy (near²). */
	private nearEnergy = 0;
	/** Leaky short-term residual energy (e²). */
	private residualEnergy = 0;
	/** Leaky short-term far-end (reference) energy. Gates the detector so it can
	 *  only fire while the speaker is actually playing. */
	private farEnergy = 0;
	/** Best echo-only suppression ratio (residual/near) achieved so far — the
	 *  converged-filter floor the detector compares against. Starts permissive
	 *  (1.0) so cold-start convergence is never frozen. */
	private suppressionFloor = 1;
	/** Per-sample leak factor for the short-term energies (~12 ms window). */
	private readonly energyLeak: number;
	/** Per-sample factor (>1) by which the suppression floor is allowed to
	 *  recover upward, so a genuine echo-path change can re-raise it instead of
	 *  pinning the detector to a stale, unreachably-low floor. */
	private readonly floorRecover: number;
	/** Remaining hangover samples: while >0 adaptation stays frozen. */
	private hangover = 0;
	private readonly hangoverSamples: number;
	private lastDt = false;
	private lastSuppression = 0;

	/** Suppression must exceed `DT_MARGIN × suppressionFloor` to trigger
	 *  double-talk. 6× ≈ the residual carries 7–8 dB more energy than a
	 *  converged echo-only residual — comfortably above filter misadjustment,
	 *  comfortably below a real interfering talker. */
	private static readonly DT_MARGIN = 6;
	/** Short-term energy window for the detector, in ms. */
	private static readonly ENERGY_WINDOW_MS = 12;
	/** Time constant for the suppression floor's upward recovery, in ms. */
	private static readonly FLOOR_RECOVER_MS = 3000;
	/** Freeze hold after the last double-talk trigger, in ms. */
	private static readonly HANGOVER_MS = 100;
	/** Far-end energy below this counts as "speaker idle" — no echo to cancel,
	 *  so the double-talk detector is disarmed. */
	private static readonly FAR_ACTIVE_ENERGY = 1e-6;
	/** Lower clamp on the learned suppression floor — keeps the DT margin from
	 *  collapsing to zero on a (near-)perfect synthetic cancellation. */
	private static readonly FLOOR_MIN = 1e-4;

	constructor(opts: AecOptions = {}) {
		this.filterLength = Math.max(1, Math.floor(opts.filterLength ?? 512));
		this.mu = opts.mu ?? 0.3;
		this.delta = opts.delta ?? 1e-3;
		this.sampleRate = opts.sampleRate ?? 16_000;
		this.w = new Float32Array(this.filterLength);
		this.history = new Float32Array(this.filterLength);
		this.delayLine = new Float32Array(0);

		const energyWindowSamples = Math.max(
			1,
			Math.round((Aec.ENERGY_WINDOW_MS / 1000) * this.sampleRate),
		);
		this.energyLeak = Math.exp(-1 / energyWindowSamples);
		const floorRecoverSamples = Math.max(
			1,
			Math.round((Aec.FLOOR_RECOVER_MS / 1000) * this.sampleRate),
		);
		this.floorRecover = Math.exp(1 / floorRecoverSamples);
		this.hangoverSamples = Math.max(
			0,
			Math.round((Aec.HANGOVER_MS / 1000) * this.sampleRate),
		);
	}

	/** True iff the most recent processed sample was classified as double-talk
	 *  (includes the hangover hold). */
	get lastDoubleTalk(): boolean {
		return this.lastDt;
	}

	/** Snapshot of the double-talk detector state after the last sample. */
	get stats(): AecStats {
		return {
			doubleTalk: this.lastDt,
			suppression: this.lastSuppression,
			suppressionFloor: this.suppressionFloor,
			nearEnergy: this.nearEnergy,
			residualEnergy: this.residualEnergy,
		};
	}

	/**
	 * Set the integer far-end delay (samples) — the measured latency between the
	 * playback reference and when its echo appears in the mic. The reference is
	 * pushed through a FIFO of this length before it reaches the filter, so tap 0
	 * aligns with the first echoing sample. Resets the delay FIFO; the filter
	 * taps are untouched.
	 */
	setDelaySamples(d: number): void {
		const next = Math.max(0, Math.floor(d));
		if (next === this.delaySamples && this.delayLine.length === next) {
			this.delayLine.fill(0);
			this.delayHead = 0;
			return;
		}
		this.delaySamples = next;
		this.delayLine = new Float32Array(next);
		this.delayHead = 0;
	}

	/**
	 * Cancel echo from `near` using the far-end reference `far`. Both must be the
	 * same length; the result has that length too. Mutates no input.
	 */
	process(near: Float32Array, far: Float32Array): Float32Array {
		if (near.length !== far.length) {
			throw new Error(
				`[voice] Aec.process expects equal-length near/far blocks; got near=${near.length} far=${far.length}`,
			);
		}
		const len = near.length;
		const L = this.filterLength;
		const leak = this.energyLeak;
		const out = new Float32Array(len);

		for (let n = 0; n < len; n++) {
			// Delay-align the reference, then shift it into the circular history.
			const farSample = this.pushFar(far[n]);

			// echo_hat = w · x. history[head] is the OLDEST sample; the newest sits
			// at head-1. Walk newest→oldest so w[0] multiplies the most recent
			// reference sample (the direct-path tap).
			let echoHat = 0;
			let idx = this.head;
			for (let i = 0; i < L; i++) {
				idx = idx === 0 ? L - 1 : idx - 1;
				echoHat += this.w[i] * this.history[idx];
			}

			const nearSample = near[n];
			const e = nearSample - echoHat;
			out[n] = e;

			// Short-term energies for the double-talk detector.
			this.nearEnergy =
				leak * this.nearEnergy + (1 - leak) * nearSample * nearSample;
			this.residualEnergy = leak * this.residualEnergy + (1 - leak) * e * e;
			this.farEnergy =
				leak * this.farEnergy + (1 - leak) * farSample * farSample;

			// Suppression = residual/near. Low while the filter explains the
			// near-end (echo-only); spikes when the user's voice enters the
			// residual the filter cannot model (double-talk).
			const suppression = this.residualEnergy / (this.nearEnergy + 1e-12);
			this.lastSuppression = suppression;
			const farActive = this.farEnergy > Aec.FAR_ACTIVE_ENERGY;
			const trigger =
				farActive && suppression > Aec.DT_MARGIN * this.suppressionFloor;
			if (trigger) {
				this.hangover = this.hangoverSamples;
			} else if (this.hangover > 0) {
				this.hangover--;
			}
			const doubleTalk = this.hangover > 0;
			this.lastDt = doubleTalk;

			// NLMS tap update — only when learning (not during double-talk) and
			// when the reference carries energy. Normalizing by Σx²+δ makes the
			// step independent of the far-end level, so convergence is stable
			// across loud and quiet playback alike.
			if (!doubleTalk && farSample !== 0) {
				const step = (this.mu / (this.refEnergy + this.delta)) * e;
				idx = this.head;
				for (let i = 0; i < L; i++) {
					idx = idx === 0 ? L - 1 : idx - 1;
					this.w[i] += step * this.history[idx];
				}
				// Track the best echo-only suppression: a slowly-recovering
				// minimum. Only updated while adapting (echo-only) and far active.
				if (farActive) {
					const recovered = Math.min(
						1,
						this.suppressionFloor * this.floorRecover,
					);
					this.suppressionFloor = Math.max(
						Aec.FLOOR_MIN,
						Math.min(recovered, suppression),
					);
				}
			}
		}
		return out;
	}

	/** Clear the adaptive taps, far-end history, delay FIFO, and DT detector. */
	reset(): void {
		this.w.fill(0);
		this.history.fill(0);
		this.head = 0;
		this.refEnergy = 0;
		this.delayLine.fill(0);
		this.delayHead = 0;
		this.nearEnergy = 0;
		this.residualEnergy = 0;
		this.farEnergy = 0;
		this.suppressionFloor = 1;
		this.hangover = 0;
		this.lastDt = false;
		this.lastSuppression = 0;
	}

	/**
	 * Push one far-end sample through the delay FIFO and into the circular
	 * history, maintaining the running reference energy incrementally. Returns
	 * the (delayed) sample that actually entered the filter window.
	 */
	private pushFar(sample: number): number {
		let delayed = sample;
		if (this.delaySamples > 0) {
			delayed = this.delayLine[this.delayHead];
			this.delayLine[this.delayHead] = sample;
			this.delayHead = (this.delayHead + 1) % this.delaySamples;
		}
		// Evict the oldest history sample (at `head`) and write the new one.
		const evicted = this.history[this.head];
		this.refEnergy += delayed * delayed - evicted * evicted;
		if (this.refEnergy < 0) this.refEnergy = 0; // guard FP drift
		this.history[this.head] = delayed;
		this.head = (this.head + 1) % this.filterLength;
		return delayed;
	}
}
