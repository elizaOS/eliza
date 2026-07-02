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

/**
 * Per-platform SEED playback→mic delay, in milliseconds. This is the initial
 * pre-alignment applied *before* any echo has been observed; the adaptive
 * {@link estimateEchoDelaySamples} cross-correlation refines it at runtime once
 * enough playback-active audio is seen. Until then a platform-appropriate seed
 * converges faster than starting from zero — most visibly on iOS/macOS, where
 * the CoreAudio / AVAudioEngine transport delay is small but non-zero and a
 * 0-sample seed leaves the first barge-in's echo un-aligned.
 *
 * These are conservative starting points (they still benefit from per-device
 * tuning); the goal is only to put the adaptive filter in the right ballpark on
 * the first turn, not to be exact.
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
  /** Desktop Linux ALSA/PulseAudio/PipeWire. */
  linux: 30,
};

/** Fallback seed (ms) for an unrecognized platform id. */
export const DEFAULT_PLAYBACK_DELAY_MS = 25;

/**
 * Seed playback→mic delay in milliseconds for a platform id (e.g.
 * `process.platform`, or the `"ios"` / `"android"` ids the mobile shells
 * report). Unknown ids fall back to {@link DEFAULT_PLAYBACK_DELAY_MS}.
 */
export function platformPlaybackDelayMs(platform: string): number {
  return (
    PLATFORM_PLAYBACK_DELAY_DEFAULTS[platform] ?? DEFAULT_PLAYBACK_DELAY_MS
  );
}

/**
 * Seed playback→mic delay in samples for a platform id. `sampleRate` defaults to
 * the 16 kHz voice-pipeline rate.
 */
export function platformPlaybackDelaySamples(
  platform: string,
  sampleRate = 16_000,
): number {
  return Math.round((platformPlaybackDelayMs(platform) / 1000) * sampleRate);
}
