/**
 * Streaming one-shot playback→mic delay calibration (#9583/#9586, extracted
 * from the live diarization session for the desktop AEC work in #12256).
 *
 * While the far-end (agent TTS playback) is active, near/far windows are
 * accumulated; once ~1 s of playback-active audio is buffered, the bulk
 * transport lag is recovered by normalized cross-correlation
 * (`estimateEchoDelaySamples`) and — if confident and not pinned at the search
 * ceiling — replaces the static seed. One-shot: a device's speaker→mic path is
 * stable, so the first confident estimate is locked and re-measurement stops.
 *
 * Constants are shared verbatim with Pipeline A's historical values; both the
 * live diarization session and the desktop far-end service calibrate through
 * this class so the contract (confidence ≥0.3, 500 ms search, cap-edge
 * rejection) cannot drift between consumers.
 */

import { estimateEchoDelaySamples } from "./echo-delay.js";

/** Accumulate this many playback-active samples before estimating the delay
 * (1 s @16 kHz — enough correlated echo overlap for a stable cross-correlation
 * even when the transport lag eats several hundred ms of the window). */
export const ECHO_CAL_TARGET_SAMPLES = 16_000;
/** Bound the rolling calibration window so a long talk-over doesn't grow it. */
export const ECHO_CAL_MAX_SAMPLES = 24_000;
/** Accept a calibrated delay only above this normalized cross-correlation; below
 * it the near/far are independent (user talking, no echo) — keep the seed. */
export const ECHO_CAL_MIN_CONFIDENCE = 0.3;
/** Largest playback→mic delay to search (500 ms @16 kHz). The Pixel 6a WebView
 * pump path measured ~381–408 ms end-to-end (#11373 device evidence). */
export const ECHO_CAL_MAX_LAG_SAMPLES = 8_000;
/** Reject locks within one frame of the search ceiling: a cap-edge peak means
 * the true delay is likely beyond the searched range, and a one-shot lock on
 * it would pin a wrong alignment forever. Keep observing instead. */
export const ECHO_CAL_CAP_EDGE_SAMPLES = 320;
/** Far-end mean-square floor below which a frame is "no playback" (skip). */
export const ECHO_CAL_FAR_ENERGY_FLOOR = 1e-7;

function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export interface EchoDelayState {
  delaySamples: number;
  confidence: number;
  calibrated: boolean;
}

export class StreamingEchoDelayCalibrator {
  private delay: number;
  private conf = 0;
  private locked = false;
  /** Rolling near/far windows accumulated only while the far-end is active,
   * used once to estimate the delay. Cleared after an estimate and on
   * {@link resetWindow}. */
  private calNear: Float32Array[] = [];
  private calFar: Float32Array[] = [];
  private calSampleCount = 0;

  constructor(seedDelaySamples: number) {
    this.delay = Math.max(0, Math.floor(seedDelaySamples));
  }

  get delaySamples(): number {
    return this.delay;
  }

  get confidence(): number {
    return this.conf;
  }

  get calibrated(): boolean {
    return this.locked;
  }

  state(): EchoDelayState {
    return {
      delaySamples: this.delay,
      confidence: this.conf,
      calibrated: this.locked,
    };
  }

  /**
   * Feed one mic frame plus the RAW (delay-0) far-end read for the same window.
   * Calibration recovers the delay, so callers must not pre-apply the value
   * under measurement. No-op once locked or when the far-end is silent.
   */
  observe(nearPcm: Float32Array, farPcm: Float32Array): void {
    if (this.locked || nearPcm.length === 0) return;
    let farEnergy = 0;
    for (let i = 0; i < farPcm.length; i++) farEnergy += farPcm[i] * farPcm[i];
    if (farEnergy / Math.max(1, farPcm.length) < ECHO_CAL_FAR_ENERGY_FLOOR) {
      return; // no playback → nothing to calibrate against
    }

    this.calNear.push(nearPcm.slice());
    this.calFar.push(farPcm);
    this.calSampleCount += nearPcm.length;
    while (
      this.calSampleCount > ECHO_CAL_MAX_SAMPLES &&
      this.calNear.length > 1
    ) {
      this.calSampleCount -= (this.calNear.shift() as Float32Array).length;
      this.calFar.shift();
    }
    if (this.calSampleCount < ECHO_CAL_TARGET_SAMPLES) return;

    const near = concatFloat32(this.calNear);
    const farWin = concatFloat32(this.calFar);
    const est = estimateEchoDelaySamples(near, farWin, {
      maxLagSamples: ECHO_CAL_MAX_LAG_SAMPLES,
    });
    if (
      est.confidence >= ECHO_CAL_MIN_CONFIDENCE &&
      est.lagSamples < ECHO_CAL_MAX_LAG_SAMPLES - ECHO_CAL_CAP_EDGE_SAMPLES
    ) {
      this.delay = est.lagSamples;
      this.conf = est.confidence;
      this.locked = true;
    }
    this.calNear = [];
    this.calFar = [];
    this.calSampleCount = 0;
  }

  /** Drop the in-progress accumulation window (playback stopped / barge-in —
   * it would otherwise straddle a playback gap). The learned delay is kept. */
  resetWindow(): void {
    this.calNear = [];
    this.calFar = [];
    this.calSampleCount = 0;
  }
}
