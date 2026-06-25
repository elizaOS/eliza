/**
 * Playback→mic echo-delay calibration (#9583, follow-up to #9455).
 *
 * The NLMS echo canceller's adaptive taps model only the room impulse response;
 * the bulk transport delay between TTS playback and the mic capture window
 * (audio-HAL buffering, Bluetooth, resampling, …) should be removed FIRST so the
 * finite tap span (and the adaptation budget) isn't spent modelling pure
 * latency. This finds that bulk lag by normalized cross-correlation of the mic
 * (near-end) against the playback reference (far-end): the lag that maximizes
 * correlation is the playback→mic delay, which the caller then applies as a
 * fixed pre-alignment before the adaptive filter.
 *
 * Pure DSP — no FFI, no device. The per-platform default delay still needs to be
 * tuned on hardware, but the estimator itself is deterministic and testable.
 */

export interface EchoDelayEstimate {
	/** Best playback→mic delay in samples (far leads near by this much). */
	lagSamples: number;
	/** Peak normalized cross-correlation at that lag, in [0, 1]. */
	confidence: number;
}

export interface EchoDelayOptions {
	/** Largest lag to search, in samples. Default 4800 (300 ms @ 16 kHz). */
	maxLagSamples?: number;
	/** Smallest lag to search, in samples. Default 0. */
	minLagSamples?: number;
}

/**
 * Estimate the bulk playback→mic delay: the lag `d` (in samples) that best
 * aligns the far-end reference into the near-end mic signal, i.e.
 * `near[n] ≈ g · far[n - d]`. Returns that lag plus its normalized
 * cross-correlation as a `[0, 1]` confidence.
 *
 * Normalized correlation is scale-invariant, so the playback gain `g` does not
 * bias the result. A low confidence (e.g. `< 0.3`) means no detectable echo
 * (the signals are independent) — the caller should keep its previous
 * calibration rather than trust a spurious peak.
 */
export function estimateEchoDelaySamples(
	near: Float32Array,
	far: Float32Array,
	options: EchoDelayOptions = {},
): EchoDelayEstimate {
	const maxLag = Math.max(0, Math.floor(options.maxLagSamples ?? 4800));
	const minLag = Math.max(0, Math.floor(options.minLagSamples ?? 0));
	const n = Math.min(near.length, far.length);
	if (n === 0 || minLag > maxLag) {
		return { lagSamples: 0, confidence: 0 };
	}

	// Per-lag normalized cross-correlation over the overlapping window. O((maxLag
	// − minLag) · n) — fine for a short calibration burst (a few hundred ms of
	// audio, run rarely, not per-frame).
	let bestLag = minLag;
	let bestCorr = -Infinity;
	for (let lag = minLag; lag <= maxLag; lag++) {
		let dot = 0;
		let nearEnergy = 0;
		let farEnergy = 0;
		for (let i = lag; i < n; i++) {
			const a = near[i];
			const b = far[i - lag];
			dot += a * b;
			nearEnergy += a * a;
			farEnergy += b * b;
		}
		const denom = Math.sqrt(nearEnergy * farEnergy);
		const corr = denom > 0 ? dot / denom : 0;
		if (corr > bestCorr) {
			bestCorr = corr;
			bestLag = lag;
		}
	}

	return {
		lagSamples: bestLag,
		confidence: bestCorr === -Infinity ? 0 : Math.max(0, Math.min(1, bestCorr)),
	};
}
