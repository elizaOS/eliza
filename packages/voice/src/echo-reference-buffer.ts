/**
 * Echo-reference alignment buffer (#9583, follow-up to #9455/#9586).
 *
 * The NLMS echo canceller's `process(nearEnd, farEnd)` needs the far-end
 * (the agent's TTS playback) **time-aligned** to the current mic frame: the
 * echo in `nearEnd[t]` is the room-filtered playback from `t − delay`, where
 * `delay` is the bulk playback→mic transport delay (estimated by
 * {@link estimateEchoDelaySamples} in `echo-delay.ts`).
 *
 * The caller renders playback PCM in real time and `push()`es it here as it goes;
 * per mic frame it then asks for the aligned far-end slice. This is the
 * "caller must supply the reference" primitive the consumer seam was missing —
 * a fixed-capacity delay line, pure logic (no FFI, no device, no audio I/O).
 * Samples not yet rendered, or already evicted past capacity, are zero-filled
 * (no echo reference ⇒ the adaptive filter simply has nothing to cancel there).
 */

export interface EchoReferenceBufferOptions {
  /**
   * Ring-buffer capacity in samples. Must comfortably exceed
   * `maxDelaySamples + frameLength`. Default 24000 (1.5 s @ 16 kHz).
   */
  capacitySamples?: number;
  /** Sample rate for timestamp-based push/read helpers. Default 16000. */
  sampleRateHz?: number;
}

export class EchoReferenceBuffer {
  private readonly buffer: Float32Array;
  private readonly valid: Uint8Array;
  private readonly capacity: number;
  private readonly sampleRateHz: number;
  /** Total samples ever pushed (monotonic); the logical "now" cursor. */
  private pushed = 0;
  /** Timestamp mapped to absolute sample 0 for timestamp-aware playback. */
  private originMs: number | null = null;

  constructor(options: EchoReferenceBufferOptions = {}) {
    this.capacity = Math.max(1, Math.floor(options.capacitySamples ?? 24000));
    this.sampleRateHz = Math.max(1, Math.floor(options.sampleRateHz ?? 16_000));
    this.buffer = new Float32Array(this.capacity);
    this.valid = new Uint8Array(this.capacity);
  }

  /** Append rendered playback (far-end) PCM as it is produced. */
  push(playback: Float32Array): void {
    this.writeAt(this.pushed, playback);
    this.pushed += playback.length;
  }

  /**
   * Store rendered playback at its capture/render timestamp. This preserves
   * real gaps between playback bursts instead of treating chunks as contiguous.
   */
  pushAt(timestampMs: number, playback: Float32Array): void {
    if (!Number.isFinite(timestampMs)) {
      this.push(playback);
      return;
    }
    if (this.originMs === null) this.originMs = timestampMs;
    let start = this.sampleIndexFor(timestampMs);
    if (start < 0) {
      this.reset();
      this.originMs = timestampMs;
      start = 0;
    }
    this.writeAt(start, playback);
    this.pushed = Math.max(this.pushed, start + playback.length);
  }

  /**
   * The far-end reference frame aligned to a mic frame of `length` samples
   * captured `delaySamples` after the corresponding playback. Returns the
   * playback window `[pushed − delaySamples − length, pushed − delaySamples)`.
   * Indices before the retained window (not yet pushed, or evicted past
   * capacity) are zero-filled.
   */
  referenceFor(length: number, delaySamples: number): Float32Array {
    const out = new Float32Array(Math.max(0, Math.floor(length)));
    const delay = Math.max(0, Math.floor(delaySamples));
    // Absolute index (in the monotonic stream) of the first output sample.
    const start = this.pushed - delay - out.length;
    return this.readWindow(start, out.length);
  }

  /**
   * Reference aligned to a mic frame starting at `timestampMs`.
   * Returns playback `[timestampMs - delay, timestampMs - delay + length)`.
   */
  referenceAt(
    timestampMs: number,
    length: number,
    delaySamples: number,
  ): Float32Array {
    const outLength = Math.max(0, Math.floor(length));
    if (this.originMs === null || !Number.isFinite(timestampMs)) {
      return new Float32Array(outLength);
    }
    const delay = Math.max(0, Math.floor(delaySamples));
    const start = this.sampleIndexFor(timestampMs) - delay;
    return this.readWindow(start, outLength);
  }

  /** Samples pushed so far (the monotonic stream position). */
  get position(): number {
    return this.pushed;
  }

  /** Drop all buffered playback (e.g. on a new turn / barge-in flush). */
  reset(): void {
    this.buffer.fill(0);
    this.valid.fill(0);
    this.pushed = 0;
    this.originMs = null;
  }

  private sampleIndexFor(timestampMs: number): number {
    if (this.originMs === null) return 0;
    return Math.round(
      ((timestampMs - this.originMs) / 1000) * this.sampleRateHz,
    );
  }

  private writeAt(start: number, playback: Float32Array): void {
    const safeStart = Math.max(0, Math.floor(start));
    const end = safeStart + playback.length;
    if (safeStart > this.pushed) this.clearRange(this.pushed, safeStart);
    const oldest = Math.max(0, this.pushed - this.capacity);
    if (end <= oldest) return;
    for (let i = 0; i < playback.length; i++) {
      const abs = safeStart + i;
      if (abs < oldest) continue;
      const slot = abs % this.capacity;
      this.buffer[slot] = playback[i] ?? 0;
      this.valid[slot] = 1;
    }
  }

  private clearRange(from: number, to: number): void {
    if (to <= from) return;
    if (to - from >= this.capacity) {
      this.buffer.fill(0);
      this.valid.fill(0);
      return;
    }
    for (let abs = Math.max(0, Math.floor(from)); abs < to; abs++) {
      const slot = abs % this.capacity;
      this.buffer[slot] = 0;
      this.valid[slot] = 0;
    }
  }

  private readWindow(start: number, length: number): Float32Array {
    const out = new Float32Array(length);
    const oldest = Math.max(0, this.pushed - this.capacity);
    for (let i = 0; i < out.length; i++) {
      const abs = start + i;
      if (abs >= oldest && abs >= 0 && abs < this.pushed) {
        const slot = abs % this.capacity;
        if (this.valid[slot] === 1) out[i] = this.buffer[slot];
      }
    }
    return out;
  }
}
