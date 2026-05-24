import type { Page } from "@playwright/test";
import sharp from "sharp";

export interface ScreenshotQuality {
  width: number;
  height: number;
  sampledPixels: number;
  colorBuckets: number;
  dominantRatio: number;
}

export async function analyzeScreenshot(
  buffer: Buffer,
): Promise<ScreenshotQuality> {
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
    width: info.width,
    height: info.height,
    sampledPixels,
    colorBuckets: buckets.size,
    dominantRatio: sampledPixels === 0 ? 1 : dominantCount / sampledPixels,
  };
}

export function screenshotQualityIssues(
  label: string,
  quality: ScreenshotQuality,
): string[] {
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
  return issues;
}

export async function assertScreenshotNotBlank(
  buffer: Buffer,
  label: string,
  minBytes = 1_000,
): Promise<void> {
  const quality = await analyzeScreenshot(buffer);
  const issues = screenshotQualityIssues(label, quality);
  if (buffer.length <= minBytes) {
    issues.unshift(
      `${label}: screenshot byte length ${buffer.length} <= ${minBytes}`,
    );
  }
  if (issues.length > 0) {
    throw new Error(
      `${label}: screenshot quality failed: ${issues.join("; ")}; metrics=${JSON.stringify({
        byteLength: buffer.length,
        ...quality,
      })}`,
    );
  }
}

export async function captureScreenshotWithQualityRetry(
  page: Page,
  label: string,
  options: {
    fullPage?: boolean;
    attempts?: number;
    minBytes?: number;
    path?: string;
    type?: "png" | "jpeg";
  } = {},
): Promise<Buffer> {
  const attempts = options.attempts ?? 3;
  let lastBuffer: Buffer | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const buffer = await page.screenshot({
        fullPage: options.fullPage,
        path: options.path,
        type: options.type,
      });
      lastBuffer = buffer;
      const quality = await analyzeScreenshot(buffer);
      const issues = screenshotQualityIssues(label, quality);
      if (buffer.length > (options.minBytes ?? 1_000) && issues.length === 0) {
        return buffer;
      }
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(150);
  }

  if (lastBuffer) {
    await assertScreenshotNotBlank(lastBuffer, label, options.minBytes);
    return lastBuffer;
  }

  throw lastError ?? new Error(`${label}: screenshot capture failed`);
}
