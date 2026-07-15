/**
 * Proves the chat-sheet frame-glitch detector both ways: it must NOT flag a
 * whole-frame sub-pixel scroll jog (the transcript tracking the open-spring's
 * pixel settle — the ~50%-flaky false positive this metric fixes) yet must
 * still flag a genuine one-frame wrong state. Synthetic RGBA frames + a trivial
 * exact-pixel comparator, so the verdict math is exercised in isolation.
 */

import { describe, expect, it } from "vitest";
import {
  detectFlashes,
  type FlashDetectorOptions,
  type PixelDiff,
  type RgbaFrame,
  shiftTolerantDiff,
} from "./frame-glitch-detect";

const W = 60;
const H = 60;

// Count pixels whose RGB differs at all — the detector is comparator-agnostic,
// so an exact-equality count stands in for the harness's pixelmatch.
const exactDiff: PixelDiff = (a, b, w, h) => {
  let n = 0;
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2]) n += 1;
  }
  return n;
};

// A texture whose colour depends only on the row, so shifting `shiftY` is an
// exact vertical translation: a 1px jog changes every row under a naive diff
// but aligns to zero under a 1px shift — exactly the transcript-scroll jog.
function rowTexture(shiftY: number): RgbaFrame {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    const v = ((y - shiftY) * 37) & 0xff;
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      data[o] = v;
      data[o + 1] = (v * 3) & 0xff;
      data[o + 2] = (v * 7) & 0xff;
      data[o + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

// The row texture with a solid opaque block painted in — a genuine content
// change no small translation can undo (a mispainted morph / "two pills" frame).
function withBlock(base: RgbaFrame): RgbaFrame {
  const data = new Uint8Array(base.data);
  for (let y = 15; y < 45; y += 1) {
    for (let x = 15; x < 45; x += 1) {
      const o = (y * W + x) * 4;
      data[o] = 255;
      data[o + 1] = 0;
      data[o + 2] = 255;
      data[o + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

const OPTS: FlashDetectorOptions = {
  maxShift: 1,
  noise: 50,
  activeFraction: 0.25,
  flashRatio: 0.4,
};

describe("shiftTolerantDiff", () => {
  it("aligns away a whole-frame 1px scroll jog to zero", () => {
    const a = rowTexture(0);
    const b = rowTexture(1);
    // A 1px translation lights up (almost) every pixel under a naive diff...
    expect(exactDiff(a.data, b.data, W, H)).toBeGreaterThan(W * (H - 1));
    // ...but shift-tolerant alignment collapses it to zero.
    expect(shiftTolerantDiff(a, b, exactDiff, 1)).toBe(0);
  });

  it("preserves a genuine localized content change", () => {
    const base = rowTexture(0);
    const blocked = withBlock(base);
    // No 1px translation can hide the 30x30 block.
    expect(shiftTolerantDiff(base, blocked, exactDiff, 1)).toBeGreaterThan(800);
  });
});

describe("detectFlashes", () => {
  it("does NOT flag a one-frame sub-pixel scroll jog (the flaky false positive)", () => {
    const frames = [rowTexture(0), rowTexture(1), rowTexture(0)];
    // The naive detector (maxShift 0) DOES fire on the jog — this is the bug the
    // shift-tolerant metric fixes, asserted so the fix stays load-bearing.
    expect(
      detectFlashes(frames, exactDiff, { ...OPTS, maxShift: 0 }),
    ).toHaveLength(1);
    // Shift-tolerant: the jog aligns away, no flash.
    expect(detectFlashes(frames, exactDiff, OPTS)).toHaveLength(0);
  });

  it("still flags a genuine one-frame wrong state", () => {
    const base = rowTexture(0);
    const frames = [base, withBlock(base), base];
    const flashes = detectFlashes(frames, exactDiff, OPTS);
    expect(flashes).toHaveLength(1);
    expect(flashes[0].frame).toBe(1);
    expect(flashes[0].neighbours).toBeLessThan(flashes[0].in);
  });

  it("does not flag a monotonic multi-frame drift as a one-frame flash", () => {
    // A steady 1px-per-frame scroll is real motion, not an outlier: the two
    // neighbours do NOT agree, so it is never a single-frame flash.
    const frames = [rowTexture(0), rowTexture(1), rowTexture(2), rowTexture(3)];
    expect(
      detectFlashes(frames, exactDiff, { ...OPTS, maxShift: 0 }),
    ).toHaveLength(0);
    expect(detectFlashes(frames, exactDiff, OPTS)).toHaveLength(0);
  });

  it("ignores frames whose motion is below the active-fraction gate", () => {
    // A tiny wobble that never approaches the burst's peak motion is settled-tail
    // noise, not a flash, even if its neighbours agree.
    const big = withBlock(rowTexture(0));
    const frames = [
      rowTexture(0),
      big, // a real, large flash → sets the peak
      rowTexture(0),
      rowTexture(0),
      rowTexture(0),
    ];
    const flashes = detectFlashes(frames, exactDiff, OPTS);
    // Only the large block frame flashes; the flat tail contributes nothing.
    expect(flashes.map((f) => f.frame)).toEqual([1]);
  });
});
