/**
 * Transient single-frame-flash detector for the chat-sheet frame-burst e2e —
 * the shift-tolerant diff metric plus the one-frame outlier rule, split out of
 * the Playwright harness (`run-chat-sheet-frame-glitch-e2e.mjs`) so the
 * detection math is provable in isolation (`frame-glitch-detect.test.ts`),
 * mirroring the `scroll-cert` split: a pure verdict function the harness feeds
 * real captured frames into.
 *
 * WHY shift-tolerant. The chat sheet opens on a spring; the transcript is
 * bottom-anchored, so as the panel height settles by whole pixels the entire
 * thread tracks it and jogs ≤1px per captured frame. A naive per-pixel diff
 * counts that whole-frame 1px jog as ~17k changed pixels — every glyph edge —
 * even though the frames are perceptually identical. When the jog reverses
 * within one captured frame (the spring's sub-pixel overshoot, or a dropped
 * screencast frame), that frame differs hard from BOTH neighbours while the
 * neighbours agree, so the outlier rule fired a false "single-frame flash" on
 * ~50% of runs at a wandering frame index — on byte-identical code, before and
 * after any given merge. Aligning away a small integer translation before
 * counting collapses that jog to ~0 while leaving genuine content change (a
 * mispainted morph frame, the "two pills" bar, an injected wrong state) fully
 * visible, so the detector keeps its teeth (the harness `--canary` still fires)
 * without flaking on sub-pixel scroll.
 */

/** A decoded RGBA frame: `data` is row-major RGBA, `width * height * 4` bytes. */
export interface RgbaFrame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * Counts "changed" pixels between two equal-dimension RGBA buffers. The harness
 * injects a `pixelmatch`-backed comparator; tests inject a trivial one — the
 * detector logic is comparator-agnostic.
 */
export type PixelDiff = (
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
) => number;

export interface Flash {
  readonly frame: number;
  /** Shift-tolerant change into frame k (diff of k-1 → k). */
  readonly in: number;
  /** Shift-tolerant change out of frame k (diff of k → k+1). */
  readonly out: number;
  /** Shift-tolerant change across frame k (diff of k-1 → k+1). */
  readonly neighbours: number;
}

export interface FlashDetectorOptions {
  /** Per-axis integer translation aligned away before counting (px). */
  readonly maxShift: number;
  /** Per-pair floor below which a change is sub-pixel/caret noise, not motion. */
  readonly noise: number;
  /**
   * A frame is a flash candidate only while its in/out change is at least this
   * fraction of the burst's peak motion — the settled tail cannot flash.
   */
  readonly activeFraction: number;
  /**
   * Flag frame k when its neighbours agree at least this much closer with each
   * other than either does with k (`diff(k-1,k+1) < flashRatio * min(in,out)`).
   */
  readonly flashRatio: number;
}

/** Copies a `w`×`h` RGBA sub-rectangle out of `frame` at (`x0`,`y0`). */
function cropRgba(
  frame: RgbaFrame,
  x0: number,
  y0: number,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const rowBytes = w * 4;
  const srcStride = frame.width * 4;
  for (let y = 0; y < h; y += 1) {
    const srcStart = (y0 + y) * srcStride + x0 * 4;
    out.set(frame.data.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
  }
  return out;
}

/**
 * Minimum `diff` over integer translations of one frame relative to the other
 * within ±`maxShift` on each axis. A whole-frame scroll jog of ≤maxShift px
 * aligns to ~0; a genuine wrong-state frame — not a translation — does not.
 *
 * The unshifted overlap is tried first and short-circuits on a zero count, so
 * the settled tail (identical consecutive frames) costs one comparison and only
 * the handful of genuinely-moving frames pay for the full search.
 */
export function shiftTolerantDiff(
  a: RgbaFrame,
  b: RgbaFrame,
  diff: PixelDiff,
  maxShift: number,
): number {
  const commonW = Math.min(a.width, b.width);
  const commonH = Math.min(a.height, b.height);
  let best = Number.POSITIVE_INFINITY;
  // (0,0) first so aligned frames early-out before the ring is searched.
  for (let radius = 0; radius <= maxShift; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const w = commonW - Math.abs(dx);
        const h = commonH - Math.abs(dy);
        const aCrop = cropRgba(a, dx > 0 ? dx : 0, dy > 0 ? dy : 0, w, h);
        const bCrop = cropRgba(b, dx < 0 ? -dx : 0, dy < 0 ? -dy : 0, w, h);
        const n = diff(aCrop, bCrop, w, h);
        if (n < best) best = n;
        if (best === 0) return 0;
      }
    }
  }
  return best;
}

/**
 * Flags frames that show a wrong state for exactly one frame mid-animation: a
 * large shift-tolerant change into AND out of frame k while its two neighbours
 * agree closely with each other. Uses shift-tolerant change throughout so a
 * whole-frame sub-pixel scroll jog is not mistaken for a flash.
 */
export function detectFlashes(
  frames: readonly RgbaFrame[],
  diff: PixelDiff,
  options: FlashDetectorOptions,
): Flash[] {
  const { maxShift, noise, activeFraction, flashRatio } = options;
  const step: number[] = [];
  for (let i = 0; i < frames.length - 1; i += 1) {
    step.push(shiftTolerantDiff(frames[i], frames[i + 1], diff, maxShift));
  }
  const peak = Math.max(...step, 1);
  const hits: Flash[] = [];
  for (let k = 1; k < frames.length - 1; k += 1) {
    const into = step[k - 1];
    const outOf = step[k];
    if (into < noise || outOf < noise) continue;
    if (Math.max(into, outOf) < activeFraction * peak) continue;
    const across = shiftTolerantDiff(
      frames[k - 1],
      frames[k + 1],
      diff,
      maxShift,
    );
    if (across < flashRatio * Math.min(into, outOf)) {
      hits.push({ frame: k, in: into, out: outOf, neighbours: across });
    }
  }
  return hits;
}
