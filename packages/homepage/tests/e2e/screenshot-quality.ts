/**
 * Screenshot capture gate for the homepage visual suites: rejects blank or
 * effectively single-color frames, then requires two consecutive
 * byte-identical captures before returning a buffer.
 *
 * The stability requirement replaces the settling loop Playwright's
 * toHaveScreenshot used to provide. toMatchSnapshot diffs one frozen frame,
 * so without this gate a colorful mid-composite WebGL frame would pass the
 * blank check yet fail the pixel diff outright. Failures throw
 * ScreenshotQualityError / ScreenshotUnstableError with the measured
 * diagnostics so CI logs name the actual defect instead of a pixel-ratio
 * number.
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
   * Require two consecutive byte-identical captures (default true). Artifact
   * suites that photograph deliberately live pages — where frames are
   * human-reviewed, never pixel-diffed — opt out and keep the quality gate
   * only.
   */
  requireStable?: boolean;
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

/** Captures passed the quality gate but never produced two identical frames. */
export class ScreenshotUnstableError extends Error {
  readonly lastDiffBytes: number;

  constructor(label: string, attempts: number, lastDiffBytes: number) {
    super(
      `${label}: screenshot never stabilized after ${attempts} attempts — ` +
        `last two captures differ by ${lastDiffBytes} bytes. The page is ` +
        `still compositing (animation, WebGL, or late layout).`,
    );
    this.name = "ScreenshotUnstableError";
    this.lastDiffBytes = lastDiffBytes;
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

function countDifferingBytes(a: Buffer, b: Buffer): number {
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

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_SETTLE_DELAY_MS = 150;

/**
 * Captures until a frame both passes the quality gate and is byte-identical
 * to the immediately preceding quality-passing capture, then returns that
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

  let previousUsable: Buffer | undefined;
  let lastBuffer: Buffer | undefined;
  let lastQuality: ScreenshotQuality | undefined;
  let lastDiffBytes = 0;
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
      if (!requireStable || previousUsable?.equals(lastBuffer)) {
        return lastBuffer;
      }
      if (previousUsable) {
        lastDiffBytes = countDifferingBytes(previousUsable, lastBuffer);
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
    throw new ScreenshotUnstableError(label, maxAttempts, lastDiffBytes);
  }
  throw new ScreenshotQualityError(
    label,
    lastQuality ?? { sampledPixels: 0, colorBuckets: 0, dominantRatio: 1 },
    lastBuffer?.length ?? 0,
  );
}
