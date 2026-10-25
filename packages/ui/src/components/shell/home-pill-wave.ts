/**
 * Pure audio-metering math for the home pill's listening chip (#20483): maps
 * one time-domain sample frame from the capture `AnalyserNode` onto per-bar
 * scale factors for the chip's waveform.
 *
 * The contract is honesty: bar motion must come from real microphone energy.
 * In silence every bar sits at {@link FLATLINE_SCALE} — a flat line is the
 * dead-mic signal, never a decorative shimmer. Kept free of DOM/React so the
 * mapping is unit-testable; HomePill applies the returned scales imperatively
 * per animation frame without rerendering.
 */

/** Resting scale for a silent (or dead) mic — the visible flatline. */
export const FLATLINE_SCALE = 0.14;

/** Gain applied to per-segment RMS before clamping. Chosen so conversational
 *  speech (~0.05–0.2 RMS on byte time-domain data) spans most of the bar. */
const RMS_GAIN = 5.5;

/** How much each step away from the center bar attenuates the scale, keeping
 *  the chip's center-weighted silhouette under live drive. */
const CENTER_FALLOFF = 0.035;

/**
 * Computes a scaleY factor per waveform bar from one analyser time-domain
 * frame (`getByteTimeDomainData` output, 128 = silence). Each bar meters its
 * own contiguous sample segment so the row reads as a waveform rather than a
 * single VU needle. An empty frame (mic not producing data) flatlines.
 */
export function computeWaveBarScales(
  samples: Uint8Array,
  barCount: number,
): number[] {
  const scales: number[] = [];
  if (barCount <= 0) return scales;
  const center = (barCount - 1) / 2;
  for (let index = 0; index < barCount; index += 1) {
    if (samples.length === 0) {
      scales.push(FLATLINE_SCALE);
      continue;
    }
    const segmentStart = Math.floor((index * samples.length) / barCount);
    const segmentEnd = Math.max(
      segmentStart + 1,
      Math.floor(((index + 1) * samples.length) / barCount),
    );
    let energy = 0;
    for (let sample = segmentStart; sample < segmentEnd; sample += 1) {
      const normalized = ((samples[sample] ?? 128) - 128) / 128;
      energy += normalized * normalized;
    }
    const rms = Math.sqrt(energy / (segmentEnd - segmentStart));
    const activity = Math.min(1, rms * RMS_GAIN);
    const centerWeight = 1 - Math.abs(index - center) * CENTER_FALLOFF;
    scales.push(Math.max(FLATLINE_SCALE, activity * centerWeight));
  }
  return scales;
}
