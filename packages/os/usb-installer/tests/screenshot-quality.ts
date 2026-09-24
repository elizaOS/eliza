// Exercises USB installer browser flows and screenshot quality gates.
import { expect, type Page } from "@playwright/test";
import sharp from "sharp";

type ScreenshotOptions = NonNullable<Parameters<Page["screenshot"]>[0]>;

async function assertScreenshotNotBlank(
  buffer: Buffer,
  label: string,
): Promise<void> {
  expect(buffer.length, `${label}: screenshot byte length`).toBeGreaterThan(
    1_000,
  );
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
  const dominantRatio =
    sampledPixels === 0 ? 1 : Math.max(0, ...buckets.values()) / sampledPixels;
  const issues: string[] = [];
  if (sampledPixels === 0) issues.push(`${label}: screenshot is empty`);
  if (buckets.size <= 1) issues.push(`${label}: screenshot is one color`);
  if (buckets.size <= 2 && dominantRatio > 0.995) {
    issues.push(`${label}: screenshot is effectively one color`);
  }
  expect(issues, `${label}: screenshot quality`).toEqual([]);
}

export async function captureScreenshotWithQualityRetry(
  page: Page,
  label: string,
  options: ScreenshotOptions = {},
): Promise<void> {
  let lastBuffer: Buffer | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    lastBuffer = await page.screenshot(options);
    try {
      await assertScreenshotNotBlank(lastBuffer, label);
      return;
    } catch {
      await page.waitForTimeout(150);
    }
  }
  await assertScreenshotNotBlank(lastBuffer ?? Buffer.alloc(0), label);
}
