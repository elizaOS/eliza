/**
 * Behavior tests for the visual-suite capture gate in
 * tests/e2e/screenshot-quality.ts, run against a fake page whose
 * screenshot() yields scripted PNG sequences. Real sharp decoding, no
 * browser: proves the loop returns only after two consecutive visually
 * stable quality-passing captures (byte-identical or within the pixel
 * tolerance), resets stability on blank frames, and throws the distinct
 * unstable/quality errors when the attempt budget runs out.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  captureScreenshotWithQualityRetry,
  ScreenshotQualityError,
  ScreenshotUnstableError,
} from "./e2e/screenshot-quality.ts";

const SIZE = 32;

/** Multi-color PNG whose pixels derive from `seed`, so seeds differ bytewise. */
async function colorfulPng(seed) {
  const raw = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const i = (y * SIZE + x) * 3;
      raw[i] = (x * 8 + seed * 37) % 256;
      raw[i + 1] = (y * 8 + seed * 53) % 256;
      raw[i + 2] = (x * y + seed) % 256;
    }
  }
  return sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .png()
    .toBuffer();
}

/** Variant of colorfulPng(seed) with `pixels` pixels visibly changed. */
async function perturbedPng(seed, pixels) {
  const raw = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const i = (y * SIZE + x) * 3;
      raw[i] = (x * 8 + seed * 37) % 256;
      raw[i + 1] = (y * 8 + seed * 53) % 256;
      raw[i + 2] = (x * y + seed) % 256;
    }
  }
  for (let p = 0; p < pixels; p += 1) {
    raw[p * 3] = (raw[p * 3] + 128) % 256;
  }
  return sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .png()
    .toBuffer();
}

/** Single-color PNG that must fail the blank/quality gate. */
async function blankPng() {
  return sharp({
    create: {
      width: SIZE,
      height: SIZE,
      channels: 3,
      background: { r: 12, g: 12, b: 12 },
    },
  })
    .png()
    .toBuffer();
}

/** ScreenshotTarget whose screenshot() replays `frames` in order. */
function fakePage(frames) {
  let calls = 0;
  return {
    page: {
      screenshot: async () => {
        assert.ok(calls < frames.length, "screenshot() called past script");
        const frame = frames[calls];
        calls += 1;
        return frame;
      },
      waitForTimeout: async () => {},
    },
    callCount: () => calls,
  };
}

const retry = { settleDelayMs: 0 };

test("returns after two consecutive byte-identical captures", async () => {
  const a = await colorfulPng(1);
  const { page, callCount } = fakePage([a, Buffer.from(a)]);
  const result = await captureScreenshotWithQualityRetry(
    page,
    "stable",
    {},
    retry,
  );
  assert.ok(result.equals(a));
  assert.equal(callCount(), 2);
});

test("consecutive frames within the pixel tolerance count as stable", async () => {
  // 32x32 = 1024 pixels; 10 changed pixels ≈ 0.98% < the 2% default ratio,
  // while PNG compression makes the two buffers differ in far more bytes.
  const a = await colorfulPng(6);
  const nearA = await perturbedPng(6, 10);
  const { page, callCount } = fakePage([a, nearA]);
  const result = await captureScreenshotWithQualityRetry(
    page,
    "tolerant",
    {},
    retry,
  );
  assert.ok(result.equals(nearA));
  assert.equal(callCount(), 2);
});

test("keeps capturing while frames change, then returns the settled frame", async () => {
  const a = await colorfulPng(1);
  const b = await colorfulPng(2);
  const { page, callCount } = fakePage([a, b, Buffer.from(b)]);
  const result = await captureScreenshotWithQualityRetry(
    page,
    "settles",
    {},
    retry,
  );
  assert.ok(result.equals(b));
  assert.equal(callCount(), 3);
});

test("a blank frame resets stability instead of pairing with a real frame", async () => {
  const a = await colorfulPng(3);
  const { page, callCount } = fakePage([await blankPng(), a, Buffer.from(a)]);
  const result = await captureScreenshotWithQualityRetry(
    page,
    "blank-reset",
    {},
    retry,
  );
  assert.ok(result.equals(a));
  assert.equal(callCount(), 3);
});

test("throws ScreenshotUnstableError naming the byte diff when frames never settle", async () => {
  const a = await colorfulPng(1);
  const b = await colorfulPng(2);
  const { page } = fakePage([a, b, a, b, a]);
  await assert.rejects(
    captureScreenshotWithQualityRetry(
      page,
      "never-stable",
      {},
      {
        ...retry,
        maxAttempts: 5,
      },
    ),
    (error) => {
      assert.ok(error instanceof ScreenshotUnstableError);
      assert.ok(error.lastDiffBytes > 0);
      assert.ok(error.lastDiffRatio > 0.02);
      assert.match(error.message, /differ by \d+ pixels/);
      assert.match(error.message, /\d+ bytes/);
      assert.match(error.message, /never-stable/);
      return true;
    },
  );
});

test("throws ScreenshotQualityError when every capture stays blank", async () => {
  const blank = await blankPng();
  const { page } = fakePage([blank, blank, blank, blank, blank]);
  await assert.rejects(
    captureScreenshotWithQualityRetry(
      page,
      "all-blank",
      {},
      {
        ...retry,
        maxAttempts: 5,
      },
    ),
    (error) => {
      assert.ok(error instanceof ScreenshotQualityError);
      assert.match(error.message, /quality gate/);
      return true;
    },
  );
});

test("requireStable: false returns the first quality-passing capture", async () => {
  const a = await colorfulPng(4);
  const b = await colorfulPng(5);
  const { page, callCount } = fakePage([a, b]);
  const result = await captureScreenshotWithQualityRetry(
    page,
    "opt-out",
    {},
    {
      ...retry,
      requireStable: false,
    },
  );
  assert.ok(result.equals(a));
  assert.equal(callCount(), 1);
});
