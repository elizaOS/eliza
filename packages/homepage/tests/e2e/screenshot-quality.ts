/**
 * Screenshot quality helpers for rejecting blank or effectively single-color homepage captures.
 */

import { expect, type Page } from "playwright/test";
import sharp from "sharp";

type ScreenshotOptions = NonNullable<Parameters<Page["screenshot"]>[0]>;

interface ScreenshotQuality {
  sampledPixels: number;
  colorBuckets: number;
  dominantRatio: number;
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

async function assertScreenshotNotBlank(
  buffer: Buffer,
  label: string,
): Promise<void> {
  expect(buffer.length, `${label}: screenshot byte length`).toBeGreaterThan(
    1_000,
  );
  const quality = await analyzeScreenshot(buffer);
  const issues: string[] = [];
  if (quality.sampledPixels === 0) {
    issues.push(`${label}: screenshot is empty`);
  }
  if (quality.colorBuckets <= 1) {
    issues.push(`${label}: screenshot is one color`);
  } else if (quality.colorBuckets <= 2 && quality.dominantRatio > 0.995) {
    issues.push(
      `${label}: screenshot is effectively one color (${quality.colorBuckets} color buckets, ${
        Math.round(quality.dominantRatio * 1000) / 10
      }% dominant)`,
    );
  }
  expect(
    issues,
    `${label}: screenshot quality ${JSON.stringify(quality)}`,
  ).toEqual([]);
}

// Parallel fullPage captures of WebGL-heavy pages (THREE.js on /connected,
// /login) transiently fail with CDP "Unable to capture screenshot" when
// several workers composite at once. It is load-dependent (solo runs never
// hit it), so it belongs in this retry loop; the final attempt rethrows.
const TRANSIENT_CAPTURE_ERROR = /Unable to capture screenshot/;

export async function captureScreenshotWithQualityRetry(
  page: Page,
  label: string,
  options: ScreenshotOptions = {},
): Promise<Buffer> {
  let lastBuffer: Buffer | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      lastBuffer = await page.screenshot(options);
    } catch (error) {
      if (attempt === 2 || !TRANSIENT_CAPTURE_ERROR.test(String(error))) {
        throw error;
      }
      await page.waitForTimeout(500 * (attempt + 1));
      continue;
    }
    const quality = await analyzeScreenshot(lastBuffer);
    const usable =
      lastBuffer.length > 1_000 &&
      quality.colorBuckets > 1 &&
      !(quality.colorBuckets <= 2 && quality.dominantRatio > 0.995);
    if (usable) {
      return lastBuffer;
    }
    await page.waitForTimeout(150);
  }
  await assertScreenshotNotBlank(
    lastBuffer ?? Buffer.alloc(0),
    `${label}: screenshot after retries`,
  );
  return lastBuffer ?? Buffer.alloc(0);
}
