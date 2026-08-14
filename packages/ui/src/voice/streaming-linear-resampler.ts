/**
 * Stateful linear PCM resampling for realtime browser audio.
 *
 * One source sample is retained between pushes so interpolation is continuous
 * across transport-frame boundaries. The final sample is intentionally held
 * until a successor arrives; live streams therefore pay one source-sample of
 * latency without inventing or duplicating a boundary sample.
 */

export class StreamingLinearResampler {
  private readonly sourceSamplesPerOutputSample: number;
  private pending = new Float32Array(0);
  private nextSourcePosition = 0;

  constructor(
    readonly sourceSampleRateHz: number,
    readonly targetSampleRateHz: number,
  ) {
    if (
      !Number.isFinite(sourceSampleRateHz) ||
      sourceSampleRateHz <= 0 ||
      !Number.isFinite(targetSampleRateHz) ||
      targetSampleRateHz <= 0
    ) {
      throw new RangeError("sample rates must be finite positive numbers");
    }
    this.sourceSamplesPerOutputSample = sourceSampleRateHz / targetSampleRateHz;
  }

  push(block: Float32Array): Float32Array {
    if (block.length === 0) return block;
    if (this.sourceSampleRateHz === this.targetSampleRateHz) return block;

    const input = new Float32Array(this.pending.length + block.length);
    input.set(this.pending);
    input.set(block, this.pending.length);

    const output: number[] = [];
    while (this.nextSourcePosition + 1 < input.length) {
      const leftIndex = Math.floor(this.nextSourcePosition);
      const fraction = this.nextSourcePosition - leftIndex;
      const left = input[leftIndex];
      const right = input[leftIndex + 1];
      output.push(left + (right - left) * fraction);
      this.nextSourcePosition += this.sourceSamplesPerOutputSample;
    }

    // Downsampling can advance past the newest available sample. Retain that
    // final sample and carry the overshoot so the next block resumes at the
    // same global source position as an unsplit input stream.
    const consumed = Math.min(
      Math.floor(this.nextSourcePosition),
      input.length - 1,
    );
    this.pending = input.slice(consumed);
    this.nextSourcePosition -= consumed;
    return Float32Array.from(output);
  }

  /** Discard every held sample and fractional position (for flush/epoch cuts). */
  reset(): void {
    this.pending = new Float32Array(0);
    this.nextSourcePosition = 0;
  }
}
