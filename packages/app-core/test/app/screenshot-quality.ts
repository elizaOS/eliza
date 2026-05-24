import sharp from "sharp";

type ScreenshotOptions = {
  path?: string;
  fullPage?: boolean;
  timeout?: number;
};

type ScreenshotPage = {
  screenshot(options: ScreenshotOptions): Promise<Buffer | Uint8Array | string>;
  waitForTimeout?: (ms: number) => Promise<void>;
};

export async function analyzeScreenshot(buffer: Buffer) {
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

export async function assertScreenshotNotBlank(
  buffer: Buffer,
  label: string,
): Promise<void> {
  const quality = await analyzeScreenshot(buffer);
  const issues: string[] = [];
  if (buffer.length <= 1_000) {
    issues.push(`${label}: screenshot byte length ${buffer.length} <= 1000`);
  }
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
  if (issues.length > 0) {
    throw new Error(
      `${label}: screenshot quality failed: ${issues.join("; ")}; metrics=${JSON.stringify({
        byteLength: buffer.length,
        ...quality,
      })}`,
    );
  }
}

function screenshotResultToBuffer(result: Buffer | Uint8Array | string): Buffer {
  if (typeof result === "string") {
    return Buffer.from(result, "base64");
  }
  return Buffer.from(result);
}

export async function captureScreenshotWithQualityRetry(
  page: ScreenshotPage,
  label: string,
  options: ScreenshotOptions,
): Promise<Buffer> {
  let lastBuffer: Buffer | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await page.screenshot(options);
    lastBuffer = screenshotResultToBuffer(result);
    const quality = await analyzeScreenshot(lastBuffer);
    const usable =
      quality.colorBuckets > 1 &&
      !(quality.colorBuckets <= 2 && quality.dominantRatio > 0.995);
    if (usable) {
      return lastBuffer;
    }
    await page.waitForTimeout?.(150);
  }
  await assertScreenshotNotBlank(
    lastBuffer ?? Buffer.alloc(0),
    `${label}: screenshot after retries`,
  );
  return lastBuffer ?? Buffer.alloc(0);
}
