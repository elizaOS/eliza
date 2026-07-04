/**
 * Whole-utterance echo alignment for the desktop batch ASR path (#12256).
 *
 * The streaming AEC path (Pipeline A) aligns per mic frame because both mic
 * and playback frames carry timestamps in the same clock. The desktop loop's
 * ASR ingest instead receives a whole recorded utterance with NO per-sample
 * timestamps, while the far-end (TTS playback tapped in the renderer) is
 * timestamped in the renderer's `performance.now()` domain — an epoch the
 * server does not share. The bulk near↔far alignment therefore has to be
 * recovered from the audio itself: this module finds the offset that best
 * places the near-end inside a far-end window by normalized cross-correlation,
 * decimated for a cheap coarse pass and refined at full rate.
 *
 * `estimateEchoDelaySamples` (echo-delay.ts) stays the per-frame streaming
 * calibrator; this is its offline, long-window sibling. Same confidence
 * contract: a low peak correlation means the two signals are independent (no
 * echo present) and the caller must not cancel against a spurious alignment.
 */

export interface EchoAlignmentEstimate {
  /** Best placement of the near-end inside `far`: near[i] ≈ g · far[i + offsetSamples]. */
  offsetSamples: number;
  /** Peak normalized cross-correlation at that offset, clamped to [0, 1]. */
  confidence: number;
  /** Samples of genuine near/far overlap at the winning offset. */
  overlapSamples: number;
}

export interface EchoAlignmentOptions {
  /** Largest `offsetSamples` to search. Default `far.length − minOverlapSamples`. */
  maxOffsetSamples?: number;
  /** Minimum near/far overlap for an offset to be considered. Default 4000 (250 ms @16 kHz). */
  minOverlapSamples?: number;
  /** Coarse-pass decimation factor (box mean). Default 16 (16 kHz → 1 kHz envelope). */
  coarseDecimation?: number;
}

/** Box-mean decimation by `factor` — a crude low-pass + downsample that keeps
 * the speech energy envelope, which is what the coarse correlation locks onto. */
function decimate(signal: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return signal;
  const out = new Float32Array(Math.floor(signal.length / factor));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    const base = i * factor;
    for (let k = 0; k < factor; k++) sum += signal[base + k];
    out[i] = sum / factor;
  }
  return out;
}

/** Normalized cross-correlation of `near` against `far` shifted by `offset`,
 * over their overlap. Returns `{ corr: -1 }` when the overlap is too short. */
function nccAtOffset(
  near: Float32Array,
  far: Float32Array,
  offset: number,
  minOverlap: number,
): { corr: number; overlap: number } {
  const overlap = Math.min(near.length, far.length - offset);
  if (overlap < minOverlap) return { corr: -1, overlap: Math.max(0, overlap) };
  let dot = 0;
  let nearEnergy = 0;
  let farEnergy = 0;
  for (let i = 0; i < overlap; i++) {
    const a = near[i];
    const b = far[i + offset];
    dot += a * b;
    nearEnergy += a * a;
    farEnergy += b * b;
  }
  const denom = Math.sqrt(nearEnergy * farEnergy);
  return { corr: denom > 0 ? dot / denom : 0, overlap };
}

/**
 * Find where the near-end utterance sits inside the far-end window:
 * `near[i] ≈ g · far[i + offset]`, searching `offset ∈ [0, maxOffsetSamples]`.
 * Two passes — decimated coarse search over the whole range, then a full-rate
 * refinement around the coarse peak — so a multi-second utterance against a
 * multi-second window stays tens of milliseconds of CPU, not seconds.
 */
export function estimateEchoAlignment(
  near: Float32Array,
  far: Float32Array,
  options: EchoAlignmentOptions = {},
): EchoAlignmentEstimate {
  const minOverlap = Math.max(
    1,
    Math.floor(options.minOverlapSamples ?? 4000),
  );
  const maxOffset = Math.max(
    0,
    Math.floor(options.maxOffsetSamples ?? far.length - minOverlap),
  );
  if (near.length === 0 || far.length < minOverlap) {
    return { offsetSamples: 0, confidence: 0, overlapSamples: 0 };
  }

  const decimation = Math.max(1, Math.floor(options.coarseDecimation ?? 16));
  const nearCoarse = decimate(near, decimation);
  const farCoarse = decimate(far, decimation);
  const coarseMinOverlap = Math.max(1, Math.floor(minOverlap / decimation));
  const coarseMaxOffset = Math.floor(maxOffset / decimation);

  let bestCoarse = 0;
  let bestCoarseCorr = -Infinity;
  for (let offset = 0; offset <= coarseMaxOffset; offset++) {
    const { corr } = nccAtOffset(
      nearCoarse,
      farCoarse,
      offset,
      coarseMinOverlap,
    );
    if (corr > bestCoarseCorr) {
      bestCoarseCorr = corr;
      bestCoarse = offset;
    }
  }

  // Full-rate refinement: the coarse (envelope) peak locates the offset to
  // within ~±1 decimated sample; sweep ±2 decimated samples at sample rate.
  const center = bestCoarse * decimation;
  const radius = 2 * decimation;
  const from = Math.max(0, center - radius);
  const to = Math.min(maxOffset, center + radius);
  let bestOffset = center;
  let bestCorr = -Infinity;
  let bestOverlap = 0;
  for (let offset = from; offset <= to; offset++) {
    const { corr, overlap } = nccAtOffset(near, far, offset, minOverlap);
    if (corr > bestCorr) {
      bestCorr = corr;
      bestOffset = offset;
      bestOverlap = overlap;
    }
  }

  if (bestCorr === -Infinity) {
    return { offsetSamples: 0, confidence: 0, overlapSamples: 0 };
  }
  return {
    offsetSamples: bestOffset,
    confidence: Math.max(0, Math.min(1, bestCorr)),
    overlapSamples: bestOverlap,
  };
}
