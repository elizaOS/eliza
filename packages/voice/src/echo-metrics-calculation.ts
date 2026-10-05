/**
 * Echo-return-loss-enhancement (ERLE) measurement for the AEC stack (#12256).
 *
 * ERLE compares the near-end (raw mic) energy against the canceller's residual
 * over the same window: 10·log10(Σnear² / Σresidual²). It is the single number
 * the layered echo defense is gated on (workbench ceiling: ≥18 dB on the
 * desktop loop; the NLMS canceller reaches ~29 dB on echo-only synthetic).
 * Meaningful only over windows where the far-end (agent playback) was actually
 * driving an echo — measuring over user-speech-only audio reads ~0 dB by
 * design, since the canceller must not touch the user's voice.
 */

/**
 * ERLE in dB: 10·log10(Σnear² / Σresidual²) over the overlapping length.
 * Higher is better. Returns +Infinity when the residual is silent and 0 when
 * there is no near-end energy to enhance.
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

/**
 * ERLE restricted to far-end-active blocks: only spans where the (aligned)
 * far-end reference carries energy contribute to the ratio. This is the honest
 * per-utterance measurement for double-talk audio — outside the far-active
 * region there is no echo, the canceller is passthrough, and folding those
 * samples in would dilute the number toward 0 dB.
 *
 * Returns `erleDb: null` when no block was far-active (no echo present).
 */
export function computeFarActiveErle(
  nearEnd: Float32Array,
  residual: Float32Array,
  alignedFarEnd: Float32Array,
  options: { blockSamples?: number; farEnergyFloor?: number } = {},
): { erleDb: number | null; farActiveSamples: number } {
  const block = Math.max(1, Math.floor(options.blockSamples ?? 320));
  const floor = options.farEnergyFloor ?? 1e-7;
  const len = Math.min(nearEnd.length, residual.length, alignedFarEnd.length);
  let nearEnergy = 0;
  let residualEnergy = 0;
  let farActiveSamples = 0;
  for (let start = 0; start < len; start += block) {
    const end = Math.min(len, start + block);
    let farEnergy = 0;
    for (let i = start; i < end; i++) {
      farEnergy += alignedFarEnd[i] * alignedFarEnd[i];
    }
    if (farEnergy / (end - start) < floor) continue;
    farActiveSamples += end - start;
    for (let i = start; i < end; i++) {
      nearEnergy += nearEnd[i] * nearEnd[i];
      residualEnergy += residual[i] * residual[i];
    }
  }
  if (farActiveSamples === 0 || nearEnergy === 0) {
    return { erleDb: null, farActiveSamples };
  }
  if (residualEnergy === 0) {
    return { erleDb: Number.POSITIVE_INFINITY, farActiveSamples };
  }
  return {
    erleDb: 10 * Math.log10(nearEnergy / residualEnergy),
    farActiveSamples,
  };
}
