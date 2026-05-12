/**
 * Audio routing for the two-agents-talking-endlessly harness (`voice-duet.mjs`).
 *
 * Both agents are local processes, so the duet NEVER goes through speakers /
 * mic — agent A's TTS PCM is resampled and pushed straight into agent B's
 * `PushMicSource` via an in-memory ring, and symmetrically B → A.
 *
 *   A.scheduler.sink ── DuetSink(aToB) ──→ PcmRingBuffer ──→ B.micSource.push
 *   B.scheduler.sink ── DuetSink(bToA) ──→ PcmRingBuffer ──→ A.micSource.push
 *
 * The TTS emits 24 kHz mono; the VAD + Qwen3-ASR want 16 kHz mono — one
 * linear-interpolation resample in the `DuetSink`, zero file writes.
 *
 * `DuetSink` also reports the **`peer-utterance-end`** instant: when the
 * producing agent's TTS has settled (its turn is done AND no PCM has arrived
 * for `quietGapMs`), the consuming agent's tracer should mark
 * `peer-utterance-end` — that is the headline `t0` for the duet round-trip.
 * The harness drives that explicitly off `bridge.settle()`; `DuetSink` exposes
 * `lastWriteAt()` / `totalWritten()` so the harness can detect "drained".
 *
 * Pure JS, no FFI, no native deps — used both by the live harness and by
 * `voice-duet.e2e.test.ts`'s stub-backend wiring path.
 */

const TTS_SAMPLE_RATE = 24_000;
const ASR_SAMPLE_RATE = 16_000;

/**
 * Linear-interpolation resample of mono `Float32Array` PCM. Cheap and good
 * enough for a benchmark / VAD-feed (the ASR/VAD are robust to it). Returns the
 * input unchanged when the rates already match.
 *
 * @param {Float32Array} pcm
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resampleLinear(pcm, fromRate, toRate) {
  if (!(pcm instanceof Float32Array)) {
    throw new TypeError("resampleLinear: pcm must be a Float32Array");
  }
  if (fromRate <= 0 || toRate <= 0) {
    throw new RangeError("resampleLinear: rates must be positive");
  }
  if (fromRate === toRate || pcm.length === 0) return pcm;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(pcm.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(pcm.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = pcm[i0] * (1 - frac) + pcm[i1] * frac;
  }
  return out;
}

/**
 * An `AudioSink` (the shape `VoiceScheduler` writes PCM into) that resamples
 * each chunk to `targetRate` and forwards it to a callback (the harness pushes
 * it into the peer's ring / `PushMicSource`). Tracks last-write time and total
 * samples so the harness can detect "the producer has drained".
 */
export class DuetSink {
  /**
   * @param {(pcm: Float32Array, sampleRate: number) => void} onResampled
   *   called once per chunk with PCM at `targetRate`.
   * @param {object} [opts]
   * @param {number} [opts.targetRate] default 16 kHz (the ASR/VAD rate).
   * @param {number} [opts.sourceRate] default 24 kHz (the TTS rate). Each
   *   `write` may carry its own rate; this is only the assumed default when a
   *   write doesn't say.
   */
  constructor(onResampled, opts = {}) {
    if (typeof onResampled !== "function") {
      throw new TypeError("DuetSink: onResampled must be a function");
    }
    this.onResampled = onResampled;
    this.targetRate = opts.targetRate ?? ASR_SAMPLE_RATE;
    this.sourceRate = opts.sourceRate ?? TTS_SAMPLE_RATE;
    this._totalWritten = 0;
    this._totalOut = 0;
    this._lastWriteAt = 0;
    this._buffered = 0;
  }

  /** @param {Float32Array} pcm @param {number} sampleRate */
  write(pcm, sampleRate) {
    if (!(pcm instanceof Float32Array) || pcm.length === 0) return;
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : this.sourceRate;
    this._totalWritten += pcm.length;
    this._buffered += pcm.length;
    this._lastWriteAt = Date.now();
    const resampled = resampleLinear(pcm, sr, this.targetRate);
    this._totalOut += resampled.length;
    this.onResampled(resampled, this.targetRate);
  }

  drain() {
    this._buffered = 0;
  }

  bufferedSamples() {
    return this._buffered;
  }

  /** Total INPUT samples written to this sink (at the source rate). */
  totalWritten() {
    return this._totalWritten;
  }

  /** Total OUTPUT samples forwarded (at `targetRate`). */
  totalForwarded() {
    return this._totalOut;
  }

  /** `Date.now()` of the most recent `write()`, or 0 if none. */
  lastWriteAt() {
    return this._lastWriteAt;
  }

  /** Seconds of audio (at the source rate) forwarded so far. */
  forwardedSeconds() {
    return this._totalOut / this.targetRate;
  }
}

/**
 * The duet's two cross-rings: `aToB` carries agent A's speech into agent B's
 * ear; `bToA` carries B's reply back to A. Each direction is one `DuetSink`
 * plus the peer's `PushMicSource` it feeds. The harness wires the engines'
 * scheduler sinks to these and pumps `PushMicSource` frames into the VADs.
 *
 * `ringMs` sizes the implicit buffering (the `PushMicSource` re-frames; the
 * "ring" here is just the sink + push pair — bounded by the producer pacing).
 * It's a sweep knob (`--ring-ms`); a too-small value would underrun a real
 * streaming TTS, a too-big one adds latency. Recorded in the report.
 */
export class DuetAudioBridge {
  /**
   * @param {object} args
   * @param {object} args.micSourceA  agent A's `PushMicSource`.
   * @param {object} args.micSourceB  agent B's `PushMicSource`.
   * @param {object} [args.opts]
   * @param {number} [args.opts.ringMs] target cross-ring size in ms (sweep knob).
   * @param {number} [args.opts.targetRate] ASR/VAD rate (default 16 kHz).
   * @param {(dir: "aToB"|"bToA", pcm: Float32Array) => void} [args.opts.onForward]
   *   observability hook (the harness uses it to count PCM crossing each way).
   */
  constructor({ micSourceA, micSourceB, opts = {} }) {
    this.ringMs = opts.ringMs ?? 200;
    const targetRate = opts.targetRate ?? ASR_SAMPLE_RATE;
    const onForward = opts.onForward;
    // A speaks → resample → push into B's mic source.
    this.aToB = new DuetSink(
      (pcm) => {
        onForward?.("aToB", pcm);
        try {
          micSourceB.push(pcm);
        } catch {
          /* a stopped mic source ignores pushes — fine */
        }
      },
      { targetRate },
    );
    // B replies → resample → push into A's mic source.
    this.bToA = new DuetSink(
      (pcm) => {
        onForward?.("bToA", pcm);
        try {
          micSourceA.push(pcm);
        } catch {
          /* ignore */
        }
      },
      { targetRate },
    );
  }

  /** The sink the harness assigns to engine A's scheduler. */
  sinkForA() {
    return this.aToB;
  }

  /** The sink the harness assigns to engine B's scheduler. */
  sinkForB() {
    return this.bToA;
  }
}
