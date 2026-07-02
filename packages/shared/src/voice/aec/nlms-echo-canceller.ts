/**
 * nlms-echo-canceller.ts — PCM acoustic echo cancellation for the live
 * half-duplex voice pipeline (#9455).
 *
 * When the agent speaks, its TTS playback leaks back into the microphone and
 * corrupts ASR / VAD / diarization (the agent hears itself). This is a
 * single-channel adaptive echo canceller: a normalized least-mean-squares
 * (NLMS) FIR filter models the playback→mic acoustic path and subtracts the
 * estimated echo from the near-end (mic) signal sample-by-sample.
 *
 *   near-end d[n] = local_speech[n] + echo[n]        (the raw mic)
 *   far-end  x[n] = agent TTS playback (the reference)
 *   estimate ŷ[n] = Σ_k w[k]·x[n−k]                  (modeled echo)
 *   output   e[n] = d[n] − ŷ[n]                       (echo-cancelled mic → ASR)
 *   update   w[k] += μ·e[n]·x[n−k] / (‖x‖² + ε)       (NLMS adaptation)
 *
 * All audio is 16 kHz mono Float32 [-1, 1] — the pipeline's internal format
 * (see audio-frame-consumer.ts). The filter length must cover the
 * playback→mic delay plus the room's reverberation tail; for tails longer than
 * the filter, calibrate `delaySamples` (the bulk transport delay) so the
 * adaptive taps only have to model the short residual impulse.
 *
 * Scope: this targets the dominant failure mode — the agent transcribing its
 * own TTS while the *user is silent* (echo-only), where it achieves ~29 dB of
 * echo-return-loss-enhancement. A far-end-vs-near-end double-talk detector
 * freezes adaptation when a local talker is active so the filter cannot learn
 * (and cancel) the user's voice; barge-in itself is handled upstream by the
 * barge-in detector (which stops playback). Full double-talk residual-echo
 * suppression is AEC3-class work and intentionally out of scope here.
 *
 * Pure DSP, zero dependencies — verified by nlms-echo-canceller.test.ts
 * (ERLE on synthetic echo, passthrough, stability, reset).
 */

export interface NlmsEchoCancellerOptions {
  /** Adaptive FIR length in samples. 256 ≈ 16 ms of impulse response @16 kHz. */
  filterTaps?: number;
  /** NLMS step size in (0, 2). Larger = faster adaptation, less stable. */
  mu?: number;
  /** Regularization added to the reference energy to avoid divide-by-zero. */
  epsilon?: number;
  /**
   * Bulk playback→mic transport delay in samples. The reference is consumed
   * `delaySamples` ahead of the near-end so the adaptive taps only model the
   * residual room impulse, not the (potentially large) transport latency.
   */
  delaySamples?: number;
  /**
   * Double-talk detector ratio. When the smoothed near-end power exceeds
   * `dtdRatio`× the smoothed far-end reference power (a passive echo path
   * attenuates, so echo power stays below the reference), a local talker is
   * assumed active and adaptation is frozen so the filter cannot learn (and
   * cancel) the user's voice. Set 0 to disable.
   */
  dtdRatio?: number;
  /**
   * Opt-in nonlinear residual-echo suppressor (#9583/#9649). After the linear
   * NLMS subtracts the modeled echo, an echo-only frame (the agent is speaking,
   * the user is NOT — far-end power exceeds near-end power and no double-talk)
   * still carries the residual echo the finite-length filter could not remove.
   * When enabled, the residual on those frames is scaled toward zero. It is
   * **default-off** and never engages during double-talk or near-end-dominant
   * frames, so it can never attenuate the user's voice. Pass `true` for the
   * default gain or `{ gain }` to tune.
   */
  residualSuppression?: boolean | ResidualSuppressionOptions;
}

export interface ResidualSuppressionOptions {
  /**
   * Gain (0,1] applied to the residual on echo-only frames. Lower = stronger
   * suppression. Default 0.15 (~−16 dB) — aggressive enough to flatten residual
   * echo while leaving headroom for the gate's hysteresis.
   */
  gain?: number;
}

const DEFAULTS = {
  filterTaps: 256,
  mu: 0.3,
  epsilon: 1e-6,
  delaySamples: 0,
  dtdRatio: 2,
  residualSuppressionGain: 0.15,
} as const;

export class NlmsEchoCanceller {
  private readonly w: Float32Array; // adaptive filter weights
  private readonly x: Float32Array; // far-end ring buffer (most-recent-first)
  private readonly taps: number;
  private readonly mu: number;
  private readonly eps: number;
  private readonly delay: number;
  private readonly dtdRatio: number;
  /** Residual-suppressor gain, or null when the suppressor is disabled (default). */
  private readonly resGain: number | null;
  /** Pending far-end samples not yet aligned to a near-end sample (delay line). */
  private readonly delayLine: number[] = [];
  private xEnergy = 0; // running ‖x‖² over the active window (incremental)
  private peakXEnergy = 0; // slowly-decaying envelope of ‖x‖² (far-end scale)
  private pNear = 0; // smoothed near-end power (DTD)
  private pFar = 0; // smoothed far-end reference power (DTD)
  private hangover = 0; // samples to stay frozen after a double-talk trigger
  private lastEchoPow = 0;

  /** Stay frozen ~30 ms after the last double-talk trigger so the filter is not
   * corrupted by the bursty onset/offset of the near-end talker. */
  private static readonly HANGOVER_SAMPLES = 480;
  /** Per-sample decay of the far-end energy envelope (~1 s time constant) so a
   * short TTS pause keeps the far-end-active gate closed through the gap. */
  private static readonly PEAK_DECAY = 0.99994;
  /** Far-end is "active" only when the instantaneous ‖x‖² is within this
   * fraction (−20 dB) of the recent envelope. Below it there is no echo to
   * learn, so adaptation freezes (see process()). */
  private static readonly FAR_ACTIVITY_FRAC = 0.01;
  /** NLMS regularization as a fraction of the far-end envelope. Keeps the step
   * bounded when ‖x‖² momentarily underflows, so a quiet far-end passage can't
   * make the normaliser collapse to the absolute `eps` and blow the filter up. */
  private static readonly REG_FRAC = 0.01;
  private lastResidualPow = 0;

  constructor(opts: NlmsEchoCancellerOptions = {}) {
    this.taps = Math.max(1, Math.floor(opts.filterTaps ?? DEFAULTS.filterTaps));
    this.mu = opts.mu ?? DEFAULTS.mu;
    this.eps = opts.epsilon ?? DEFAULTS.epsilon;
    this.delay = Math.max(
      0,
      Math.floor(opts.delaySamples ?? DEFAULTS.delaySamples),
    );
    this.dtdRatio = opts.dtdRatio ?? DEFAULTS.dtdRatio;
    this.resGain = resolveResidualSuppressionGain(opts.residualSuppression);
    this.w = new Float32Array(this.taps);
    this.x = new Float32Array(this.taps);
  }

  /**
   * Cancel echo from one block of mic audio.
   *
   * @param nearEnd raw mic block (local speech + echo), Float32 [-1, 1]
   * @param farEnd  agent playback reference for the same time window. Pass an
   *                empty/zero array when the agent is NOT speaking — the filter
   *                then passes the mic through unchanged (output ≈ input).
   * @returns echo-cancelled near-end block (same length as `nearEnd`).
   */
  process(nearEnd: Float32Array, farEnd: Float32Array): Float32Array {
    const n = nearEnd.length;
    const out = new Float32Array(n);
    let echoPow = 0;
    let residualPow = 0;

    for (let i = 0; i < n; i++) {
      // Feed the (delay-aligned) far-end sample into the ring buffer.
      const incoming = i < farEnd.length ? farEnd[i] : 0;
      this.delayLine.push(incoming);
      const ref =
        this.delayLine.length > this.delay
          ? (this.delayLine.shift() as number)
          : 0;
      this.pushRef(ref);
      // Track the far-end energy envelope (instant rise, slow decay) so the
      // activity gate and the regulariser scale with the playback level.
      this.peakXEnergy = Math.max(
        this.peakXEnergy * NlmsEchoCanceller.PEAK_DECAY,
        this.xEnergy,
      );

      // Estimate echo ŷ = wᵀ·x and the error e = d − ŷ (the cleaned sample).
      let yhat = 0;
      for (let k = 0; k < this.taps; k++) yhat += this.w[k] * this.x[k];
      const d = nearEnd[i];
      const e = d - yhat;

      // Double-talk detection by near-end vs far-end power. A passive
      // playback→mic path attenuates, so the echo power stays below the
      // far-end reference power; when the smoothed near-end power instead
      // exceeds `dtdRatio`× the far-end power, a local talker is active. This is
      // independent of the filter's convergence state, so it never blocks
      // initial adaptation (unlike comparing against the echo estimate).
      // Fast smoothing (~6 ms) so the detector reacts at the onset of the
      // near-end burst, plus a hangover so it stays frozen through it.
      this.pNear = 0.99 * this.pNear + 0.01 * d * d;
      this.pFar = 0.99 * this.pFar + 0.01 * ref * ref;
      if (
        this.dtdRatio > 0 &&
        this.pFar > this.eps &&
        this.pNear > this.dtdRatio * this.pFar
      ) {
        this.hangover = NlmsEchoCanceller.HANGOVER_SAMPLES;
      }
      const doubleTalk = this.hangover > 0;
      if (this.hangover > 0) this.hangover--;

      // Far-end activity gate: only adapt while the far-end is actually
      // driving an echo. During a quiet TTS passage ‖x‖² collapses toward
      // zero but is not exactly zero (DAC dither / room floor), so without
      // this gate the NLMS step μ·e/(‖x‖²+ε) explodes and the filter learns
      // the near-end MIC NOISE instead of an echo — diverging and corrupting
      // the signal handed to ASR/VAD. There is no echo to learn when the
      // far-end is silent, so freezing is both correct and stabilising.
      const farActive =
        this.xEnergy > NlmsEchoCanceller.FAR_ACTIVITY_FRAC * this.peakXEnergy;

      // NLMS weight update: w += μ·e·x / (‖x‖² + δ), frozen during
      // double-talk or far-end silence. δ scales with the far-end envelope so
      // the normaliser can never collapse to the tiny absolute `eps`.
      if (!doubleTalk && farActive) {
        const reg = Math.max(
          this.eps,
          NlmsEchoCanceller.REG_FRAC * this.peakXEnergy,
        );
        const norm = this.xEnergy + reg;
        const step = (this.mu * e) / norm;
        if (Number.isFinite(step)) {
          for (let k = 0; k < this.taps; k++) this.w[k] += step * this.x[k];
        }
      }

      // Opt-in residual-echo suppressor (#9583/#9649): on echo-only frames
      // (far-end dominant, no double-talk, far actually active) the residual
      // `e` is mostly the echo the finite filter could not remove, so scale it
      // toward zero. Gated so it never engages while the user might be talking
      // (double-talk or near-end-dominant) — it cannot attenuate the user's
      // voice. Default-off: `cleaned === e` unless explicitly enabled.
      const cleaned =
        this.resGain !== null &&
        !doubleTalk &&
        farActive &&
        this.pFar > this.pNear
          ? e * this.resGain
          : e;
      out[i] = cleaned;

      echoPow += yhat * yhat;
      residualPow += cleaned * cleaned;
    }

    this.lastEchoPow = echoPow / Math.max(1, n);
    this.lastResidualPow = residualPow / Math.max(1, n);
    return out;
  }

  /**
   * Advance cheap detector/reference state while the far-end is silent without
   * running the FIR echo-estimation loop. Learned filter weights are preserved,
   * but stale playback samples are removed from the delay line/ring so the next
   * non-empty reference frame cannot subtract an echo estimate from a previous
   * utterance.
   */
  observeFarEndSilence(nearEnd: Float32Array): void {
    const n = nearEnd.length;
    this.delayLine.length = 0;
    this.x.fill(0);
    this.xEnergy = 0;
    this.peakXEnergy *= NlmsEchoCanceller.PEAK_DECAY ** n;
    this.pFar *= 0.99 ** n;
    this.hangover = Math.max(0, this.hangover - n);

    let residualPow = 0;
    for (let i = 0; i < n; i++) {
      const d = nearEnd[i];
      this.pNear = 0.99 * this.pNear + 0.01 * d * d;
      residualPow += d * d;
    }
    if (this.peakXEnergy < this.eps) this.peakXEnergy = 0;
    if (this.pFar < this.eps) this.pFar = 0;
    this.lastEchoPow = 0;
    this.lastResidualPow = residualPow / Math.max(1, n);
  }

  /** Echo-return-loss-enhancement (dB) over the last processed block. Higher is
   * better; >10 dB is a meaningful cancellation. Returns 0 when there is no
   * modeled echo (agent silent) so a passthrough block reads as "no gain". */
  get lastErleDb(): number {
    if (this.lastResidualPow <= 0 || this.lastEchoPow <= 0) return 0;
    return 10 * Math.log10(this.lastEchoPow / this.lastResidualPow);
  }

  /** Reset adaptation (e.g. when the playback path changes). */
  reset(): void {
    this.w.fill(0);
    this.x.fill(0);
    this.delayLine.length = 0;
    this.xEnergy = 0;
    this.peakXEnergy = 0;
    this.pNear = 0;
    this.pFar = 0;
    this.hangover = 0;
    this.lastEchoPow = 0;
    this.lastResidualPow = 0;
  }

  /** Shift a new far-end sample into the ring buffer, maintaining ‖x‖²
   * incrementally (drop the oldest sample's energy, add the newest). */
  private pushRef(sample: number): void {
    const dropped = this.x[this.taps - 1];
    this.xEnergy += sample * sample - dropped * dropped;
    if (this.xEnergy < 0) this.xEnergy = 0; // guard fp drift
    for (let k = this.taps - 1; k > 0; k--) this.x[k] = this.x[k - 1];
    this.x[0] = sample;
  }
}

/** Resolve the residual-suppressor option to a clamped gain in (0,1], or null
 *  (disabled). `false`/`undefined` → null; `true` → default gain; `{ gain }` →
 *  that gain clamped to (0,1] (an out-of-range/non-finite gain falls back to the
 *  default rather than silently disabling the suppressor). */
function resolveResidualSuppressionGain(
  option: boolean | ResidualSuppressionOptions | undefined,
): number | null {
  if (!option) return null;
  if (option === true) return DEFAULTS.residualSuppressionGain;
  const g = option.gain;
  if (typeof g !== "number" || !Number.isFinite(g) || g <= 0 || g > 1) {
    return DEFAULTS.residualSuppressionGain;
  }
  return g;
}
