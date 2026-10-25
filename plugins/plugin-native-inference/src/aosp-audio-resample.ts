/**
 * Bounds the AOSP batch-ASR linear resampler before it allocates output from
 * untrusted WAV sample-rate metadata.
 */

export const MIN_AOSP_RESAMPLE_RATE_HZ = 1_000;
export const MAX_AOSP_RESAMPLE_RATE_HZ = 192_000;
export const MAX_AOSP_RESAMPLE_OUTPUT_SAMPLES = 16_000 * 120;

function requireAospResampleRate(rate: number, label: string): void {
  if (
    !Number.isSafeInteger(rate) ||
    rate < MIN_AOSP_RESAMPLE_RATE_HZ ||
    rate > MAX_AOSP_RESAMPLE_RATE_HZ
  ) {
    throw new Error(
      `[aosp-local-inference] resample rejected ${label} rate ${rate}`,
    );
  }
}

export function resampleAospLinear(
  samples: Float32Array,
  fromHz: number,
  toHz: number,
): Float32Array {
  requireAospResampleRate(fromHz, "source");
  requireAospResampleRate(toHz, "target");
  if (fromHz === toHz || samples.length === 0) return samples;

  const ratio = toHz / fromHz;
  const outLen = Math.max(1, Math.round(samples.length * ratio));
  if (outLen > MAX_AOSP_RESAMPLE_OUTPUT_SAMPLES) {
    throw new Error(
      `[aosp-local-inference] resample output ${outLen} exceeds ${MAX_AOSP_RESAMPLE_OUTPUT_SAMPLES}`,
    );
  }

  const out = new Float32Array(outLen);
  for (let i = 0; i < out.length; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const fraction = src - i0;
    out[i] =
      (samples[i0] ?? 0) * (1 - fraction) + (samples[i1] ?? 0) * fraction;
  }
  return out;
}
