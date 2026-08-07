/**
 * Screenshot capture gate for the homepage visual suites: rejects blank or
 * effectively single-color frames, then requires two consecutive captures to
 * be visually stable — byte-identical, or within the same pixel-diff ratio
 * the snapshot comparison itself allows — before returning a buffer.
 *
 * The stability requirement replaces the settling loop Playwright's
 * toHaveScreenshot used to provide, and mirrors its semantics: that loop
 * re-captured until two consecutive frames matched under the configured
 * pixel tolerance, never under byte equality (PNG compression cascades, so
 * a handful of changed pixels rewrites most of the byte stream).
 * toMatchSnapshot diffs one frozen frame, so without this gate a colorful
 * mid-composite WebGL frame would pass the blank check yet fail the pixel
 * diff outright. Failures throw ScreenshotQualityError /
 * ScreenshotUnstableError with the measured diagnostics so CI logs name the
 * actual defect instead of a bare pixel-ratio number.
 */

import type { Page } from "playwright/test";
import sharp from "sharp";

type ScreenshotOptions = NonNullable<Parameters<Page["screenshot"]>[0]>;

/** The subset of Page the capture loop touches; tests substitute a fake. */
export type ScreenshotTarget = Pick<Page, "screenshot" | "waitForTimeout">;

export interface CaptureRetryOptions {
  /** Total capture attempts before giving up. Stability needs at least 2. */
  maxAttempts?: number;
  /** Delay between attempts while waiting for the page to settle. */
  settleDelayMs?: number;
  /**
   * Require two consecutive visually-stable captures (default true).
   * Artifact suites that photograph deliberately live pages — where frames
   * are human-reviewed, never pixel-diffed — opt out and keep the quality
   * gate only.
   */
  requireStable?: boolean;
  /**
   * Fraction of pixels allowed to differ between two consecutive captures
   * that still count as stable. Defaults to the 0.02 ratio the snapshot
   * comparison uses, so a returned buffer is settled to at least the
   * precision the diff will judge it by.
   */
  stabilityMaxDiffRatio?: number;
}

interface ScreenshotQuality {
  sampledPixels: number;
  colorBuckets: number;
  dominantRatio: number;
}

/** Capture repeatedly failed the blank / single-color quality gate. */
export class ScreenshotQualityError extends Error {
  constructor(label: string, quality: ScreenshotQuality, byteLength: number) {
    super(
      `${label}: screenshot failed quality gate after retries ` +
        `(${byteLength} bytes, ${quality.colorBuckets} color buckets, ${
          Math.round(quality.dominantRatio * 1000) / 10
        }% dominant color)`,
    );
    this.name = "ScreenshotQualityError";
  }
}

/** Captures passed the quality gate but never produced two stable frames. */
export class ScreenshotUnstableError extends Error {
  readonly lastDiffBytes: number;
  readonly lastDiffRatio: number;

  constructor(label: string, attempts: number, lastDelta: FrameDelta) {
    super(
      `${label}: screenshot never stabilized after ${attempts} attempts — ` +
        `last two captures differ by ${lastDelta.differingPixels} pixels ` +
        `(${Math.round(lastDelta.diffRatio * 1000) / 10}% of the frame, ` +
        `${lastDelta.byteDelta} bytes). The page is still compositing ` +
        `(animation, WebGL, or late layout).`,
    );
    this.name = "ScreenshotUnstableError";
    this.lastDiffBytes = lastDelta.byteDelta;
    this.lastDiffRatio = lastDelta.diffRatio;
  }
}

async function analyzeScreenshot(buffer: Buffer): Promise<ScreenshotQuality> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .resize({ width: 96, height: 96, fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map<string, number>();
  for (let i = 0; i < data.length; i += 4) {
    const key = [
      Math.round(data[i] / 16),
      Math.round(data[i + 1] / 16),
      Math.round(data[i + 2] / 16),
      Math.round(data[i + 3] / 16),
    ].join(",");
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  const sampledPixels = info.width * info.height;
  const dominantCount = Math.max(0, ...buckets.values());
  return {
    sampledPixels,
    colorBuckets: buckets.size,
    dominantRatio: sampledPixels === 0 ? 1 : dominantCount / sampledPixels,
  };
}

function passesQualityGate(
  buffer: Buffer,
  quality: ScreenshotQuality,
): boolean {
  return (
    buffer.length > 1_000 &&
    quality.sampledPixels > 0 &&
    quality.colorBuckets > 1 &&
    !(quality.colorBuckets <= 2 && quality.dominantRatio > 0.995)
  );
}

interface FrameDelta {
  differingPixels: number;
  diffRatio: number;
  byteDelta: number;
}

/** Per-channel delta below this is anti-aliasing noise, not real change. */
const CHANNEL_NOISE_THRESHOLD = 3;

/**
 * Pixel-level delta between two consecutive PNG captures. Byte-identical
 * buffers short-circuit; mismatched dimensions count as fully different
 * (the layout itself is still moving).
 */
async function compareFrames(a: Buffer, b: Buffer): Promise<FrameDelta> {
  const byteDelta = countDifferingBytes(a, b);
  if (byteDelta === 0) {
    return { differingPixels: 0, diffRatio: 0, byteDelta: 0 };
  }
  const [rawA, rawB] = await Promise.all(
    [a, b].map((buffer) =>
      sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ),
  );
  if (
    rawA.info.width !== rawB.info.width ||
    rawA.info.height !== rawB.info.height
  ) {
    const pixels = Math.max(
      rawA.info.width * rawA.info.height,
      rawB.info.width * rawB.info.height,
    );
    return { differingPixels: pixels, diffRatio: 1, byteDelta };
  }
  let differingPixels = 0;
  for (let i = 0; i < rawA.data.length; i += 4) {
    if (
      Math.abs(rawA.data[i] - rawB.data[i]) > CHANNEL_NOISE_THRESHOLD ||
      Math.abs(rawA.data[i + 1] - rawB.data[i + 1]) > CHANNEL_NOISE_THRESHOLD ||
      Math.abs(rawA.data[i + 2] - rawB.data[i + 2]) > CHANNEL_NOISE_THRESHOLD ||
      Math.abs(rawA.data[i + 3] - rawB.data[i + 3]) > CHANNEL_NOISE_THRESHOLD
    ) {
      differingPixels += 1;
    }
  }
  const totalPixels = rawA.info.width * rawA.info.height;
  return {
    differingPixels,
    diffRatio: totalPixels === 0 ? 1 : differingPixels / totalPixels,
    byteDelta,
  };
}

function countDifferingBytes(a: Buffer, b: Buffer): number {
  if (a.equals(b)) {
    return 0;
  }
  const shared = Math.min(a.length, b.length);
  let diff = Math.abs(a.length - b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) diff += 1;
  }
  return diff;
}

// Parallel fullPage captures of WebGL-heavy pages (THREE.js on /connected,
// /login) transiently fail with CDP "Unable to capture screenshot" when
// several workers composite at once. It is load-dependent (solo runs never
// hit it), so it belongs in this retry loop; the final attempt rethrows.
const TRANSIENT_CAPTURE_ERROR = /Unable to capture screenshot/;

// Ten attempts at ~1-2s per fullPage capture plus the settle delay tracks the
// 20s expect.timeout budget the removed toHaveScreenshot loop retried within.
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_SETTLE_DELAY_MS = 250;
const DEFAULT_STABILITY_MAX_DIFF_RATIO = 0.02;

/**
 * Captures until a frame both passes the quality gate and is visually stable
 * against the immediately preceding quality-passing capture — byte-identical
 * or within stabilityMaxDiffRatio of differing pixels — then returns that
 * settled buffer. A capture that fails the quality gate resets the stability
 * comparison — a blank frame proves the page is still painting. Throws
 * ScreenshotUnstableError when the budget runs out on a moving page and
 * ScreenshotQualityError when every capture stayed blank.
 */
export async function captureScreenshotWithQualityRetry(
  page: ScreenshotTarget,
  label: string,
  options: ScreenshotOptions = {},
  retry: CaptureRetryOptions = {},
): Promise<Buffer> {
  const maxAttempts = retry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const settleDelayMs = retry.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
  const requireStable = retry.requireStable ?? true;
  const stabilityMaxDiffRatio =
    retry.stabilityMaxDiffRatio ?? DEFAULT_STABILITY_MAX_DIFF_RATIO;

  let previousUsable: Buffer | undefined;
  let lastBuffer: Buffer | undefined;
  let lastQuality: ScreenshotQuality | undefined;
  let lastDelta: FrameDelta | undefined;
  let sawUsable = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      lastBuffer = await page.screenshot(options);
    } catch (error) {
      if (
        attempt === maxAttempts - 1 ||
        !TRANSIENT_CAPTURE_ERROR.test(String(error))
      ) {
        throw error;
      }
      await page.waitForTimeout(500 * (attempt + 1));
      continue;
    }
    lastQuality = await analyzeScreenshot(lastBuffer);
    if (passesQualityGate(lastBuffer, lastQuality)) {
      sawUsable = true;
      if (!requireStable) {
        return lastBuffer;
      }
      if (previousUsable) {
        lastDelta = await compareFrames(previousUsable, lastBuffer);
        if (lastDelta.diffRatio <= stabilityMaxDiffRatio) {
          return lastBuffer;
        }
      }
      previousUsable = lastBuffer;
    } else {
      previousUsable = undefined;
    }
    if (attempt < maxAttempts - 1) {
      await page.waitForTimeout(settleDelayMs);
    }
  }

  if (sawUsable) {
    throw new ScreenshotUnstableError(
      label,
      maxAttempts,
      lastDelta ?? { differingPixels: 0, diffRatio: 1, byteDelta: 0 },
    );
  }
  throw new ScreenshotQualityError(
    label,
    lastQuality ?? { sampledPixels: 0, colorBuckets: 0, dominantRatio: 1 },
    lastBuffer?.length ?? 0,
  );
}
