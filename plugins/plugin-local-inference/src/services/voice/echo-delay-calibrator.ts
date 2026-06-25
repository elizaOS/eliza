/**
 * echo-delay-calibrator.ts — estimate the bulk playback→mic delay so the
 * acoustic echo canceller starts already aligned (#9583, follow-up to #9455).
 *
 * The {@link NlmsEchoCanceller} adapts a short FIR (default 256 taps ≈ 16 ms) to
 * the residual room impulse. It is NOT meant to model the much larger, mostly
 * constant playback→mic *transport* delay (capture buffering + speaker/mic
 * hardware latency), which on real devices ranges from ~15 ms (CoreAudio) to
 * ~80 ms (some Android stacks). Feeding the canceller a reference that is
 * already delay-aligned (see {@link createEchoReferenceProvider}) keeps the
 * adaptive taps small and convergence fast.
 *
 * Two layers:
 *  1. {@link PLATFORM_PLAYBACK_DELAY_DEFAULTS} / {@link platformPlaybackDelaySamples}
 *     — per-platform SEED delays, applied before any audio is seen.
 *  2. {@link estimatePlaybackDelaySamples} — a normalized cross-correlation
 *     (GCC-style) delay estimate over an *echo-only* window (agent speaking,
 *     user silent). The peak-lag is the measured delay; the peak value is a
 *     confidence the caller can gate on before replacing the seed.
 *
 * Pure DSP, zero dependencies — verified by echo-delay-calibrator.test.ts.
 */

import { AUDIO_FRAME_PIPELINE_SAMPLE_RATE } from "./audio-frame-consumer.js";

/**
 * Per-platform SEED playback→mic delays (ms). These are conservative starting
 * points used until an on-device {@link estimatePlaybackDelaySamples} calibrates
 * a real value; they are NOT precise device characterizations. Sources of the
 * delay: OS audio-capture buffering + speaker/mic hardware latency + (for the
 * device-bridge path) the WebView→agent frame batching. Refine per device.
 */
export const PLATFORM_PLAYBACK_DELAY_DEFAULTS: Readonly<
	Record<string, number>
> = {
	/** macOS CoreAudio — low, stable hardware path. */
	darwin: 20,
	/** iOS AVAudioEngine (when its voice-processing IO AEC is not the source). */
	ios: 25,
	/** Android AudioTrack/AudioRecord — variable; a mid seed. */
	android: 45,
	/** Windows WASAPI shared-mode. */
	win32: 30,
	/** Desktop Linux ALSA/Pulse/Pipewire. */
	linux: 30,
};

/** Fallback seed (ms) for an unrecognized platform. */
export const DEFAULT_PLAYBACK_DELAY_MS = 25;

/** Resolve the seed playback→mic delay (ms) for a platform id (e.g. `process.platform`). */
export function platformPlaybackDelayMs(platform: string): number {
	return (
		PLATFORM_PLAYBACK_DELAY_DEFAULTS[platform] ?? DEFAULT_PLAYBACK_DELAY_MS
	);
}

/** Resolve the seed playback→mic delay in samples (16 kHz) for a platform id. */
export function platformPlaybackDelaySamples(platform: string): number {
	return Math.round(
		(platformPlaybackDelayMs(platform) / 1000) *
			AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
	);
}

export interface DelayCalibrationOptions {
	/** Largest delay to search, samples. Default 1920 (120 ms @ 16 kHz). */
	maxLagSamples?: number;
	/** Smallest delay to search, samples. Default 0. */
	minLagSamples?: number;
	/** Sample rate of the supplied PCM (Hz). Default 16 000. */
	sampleRate?: number;
}

export interface DelayCalibrationResult {
	/** Estimated bulk playback→mic delay (samples) — the peak-correlation lag. */
	delaySamples: number;
	/** Same delay in milliseconds, for logging/diagnostics. */
	delayMs: number;
	/** Peak normalized cross-correlation in [0, 1]; a calibration confidence. */
	confidence: number;
}

/**
 * Estimate the playback→mic delay by normalized cross-correlation of an
 * echo-only mic window against the far-end (playback) reference for the same
 * nominal time window.
 *
 * For each candidate lag `L`, correlate `mic[n]` with `far[n − L]` (the echo at
 * `n` is the playback from `L` samples earlier). The lag maximizing the
 * normalized correlation is the delay; the peak value is the confidence. Call
 * this ONLY on an echo-only span (agent speaking, user silent) — near-end speech
 * decorrelates the estimate.
 *
 * Returns `{ delaySamples: 0, confidence: 0 }` when either signal is silent.
 */
export function estimatePlaybackDelaySamples(
	mic: Float32Array,
	far: Float32Array,
	opts: DelayCalibrationOptions = {},
): DelayCalibrationResult {
	const sampleRate = opts.sampleRate ?? AUDIO_FRAME_PIPELINE_SAMPLE_RATE;
	const n = Math.min(mic.length, far.length);
	const maxLag = Math.min(
		Math.max(0, Math.floor(opts.maxLagSamples ?? 1920)),
		Math.max(0, n - 1),
	);
	const minLag = Math.min(
		Math.max(0, Math.floor(opts.minLagSamples ?? 0)),
		maxLag,
	);

	const micEnergy = energy(mic, 0, n);
	if (micEnergy <= 0 || energy(far, 0, n) <= 0) {
		return { delaySamples: 0, delayMs: 0, confidence: 0 };
	}

	let bestLag = minLag;
	let bestCorr = -Infinity;
	for (let lag = minLag; lag <= maxLag; lag++) {
		// Sum over the overlap where both mic[i] and far[i - lag] exist.
		let dot = 0;
		let farEnergy = 0;
		for (let i = lag; i < n; i++) {
			const f = far[i - lag];
			dot += mic[i] * f;
			farEnergy += f * f;
		}
		if (farEnergy <= 0) continue;
		// Normalize by the lagged far energy and the (fixed) mic energy so the
		// correlation is a true [-1, 1] coefficient comparable across lags.
		const norm = Math.sqrt(micEnergy * farEnergy);
		const corr = norm > 0 ? dot / norm : 0;
		if (corr > bestCorr) {
			bestCorr = corr;
			bestLag = lag;
		}
	}

	const confidence = Number.isFinite(bestCorr)
		? Math.max(0, Math.min(1, bestCorr))
		: 0;
	return {
		delaySamples: bestLag,
		delayMs: (bestLag / sampleRate) * 1000,
		confidence,
	};
}

function energy(a: Float32Array, from: number, to: number): number {
	let e = 0;
	for (let i = from; i < to; i++) e += a[i] * a[i];
	return e;
}
