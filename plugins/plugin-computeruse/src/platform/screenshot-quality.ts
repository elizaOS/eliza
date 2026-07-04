/**
 * Pure PNG screenshot-quality classifier: decodes width/height and samples pixel
 * color distribution to detect blank or single-color captures. Gates the
 * real-driver screenshot lanes without needing a live display.
 */
import { inflateSync } from "node:zlib";

type PngColorType = 0 | 2 | 6;

export interface ScreenshotQuality {
  width: number;
  height: number;
  sampledPixels: number;
  colorBuckets: number;
  dominantRatio: number;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function bytesPerPixel(colorType: PngColorType): number {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  return 4;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }
  return upDistance <= upLeftDistance ? up : upLeft;
}

function unfilterScanline(
  filter: number,
  current: Buffer,
  previous: Buffer,
  bpp: number,
): Buffer<ArrayBufferLike> {
  const output = Buffer.alloc(current.length);
  for (let index = 0; index < current.length; index += 1) {
    const left = index >= bpp ? output[index - bpp] : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= bpp ? previous[index - bpp] : 0;
    const raw = current[index];
    if (filter === 0) {
      output[index] = raw;
    } else if (filter === 1) {
      output[index] = (raw + left) & 0xff;
    } else if (filter === 2) {
      output[index] = (raw + up) & 0xff;
    } else if (filter === 3) {
      output[index] = (raw + Math.floor((left + up) / 2)) & 0xff;
    } else if (filter === 4) {
      output[index] = (raw + paeth(left, up, upLeft)) & 0xff;
    } else {
      throw new Error(`unsupported PNG filter ${filter}`);
    }
  }
  return output;
}

export function analyzePngScreenshot(buffer: Buffer): ScreenshotQuality {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("screenshot is not a PNG");
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType: PngColorType | null = null;
  const idatChunks: Buffer[] = [];

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      const rawColorType = data[9];
      if (rawColorType === 0 || rawColorType === 2 || rawColorType === 6) {
        colorType = rawColorType;
      }
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!width || !height || colorType === null || bitDepth !== 8) {
    throw new Error(
      `unsupported PNG format: width=${width}, height=${height}, bitDepth=${bitDepth}, colorType=${colorType}`,
    );
  }

  const bpp = bytesPerPixel(colorType);
  const stride = width * bpp;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const buckets = new Map<string, number>();
  let previous: Buffer<ArrayBufferLike> = Buffer.alloc(stride);
  let cursor = 0;

  for (let row = 0; row < height; row += 1) {
    const filter = inflated[cursor];
    const scanline = inflated.subarray(cursor + 1, cursor + 1 + stride);
    const unfiltered = unfilterScanline(filter, scanline, previous, bpp);
    cursor += stride + 1;
    previous = unfiltered;

    for (let column = 0; column < width; column += 1) {
      const pixel = column * bpp;
      const r = unfiltered[pixel];
      const g = colorType === 0 ? r : unfiltered[pixel + 1];
      const b = colorType === 0 ? r : unfiltered[pixel + 2];
      const a = colorType === 6 ? unfiltered[pixel + 3] : 255;
      const key = [
        Math.round(r / 16),
        Math.round(g / 16),
        Math.round(b / 16),
        Math.round(a / 16),
      ].join(",");
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
  }

  const sampledPixels = width * height;
  const dominantCount = Math.max(0, ...buckets.values());
  return {
    width,
    height,
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

export function assertScreenshotBase64NotBlank(
  screenshot: string | undefined,
  label: string,
  minBytes = 100,
): void {
  if (!screenshot) {
    throw new Error(`${label}: screenshot base64 should exist`);
  }
  const buffer = Buffer.from(screenshot, "base64");
  const quality = analyzePngScreenshot(buffer);
  const issues = screenshotQualityIssues(label, quality);
  if (buffer.length <= minBytes) {
    issues.unshift(
      `${label}: decoded PNG byte length ${buffer.length} <= ${minBytes}`,
    );
  }
  if (issues.length > 0) {
    throw new Error(
      `${label}: screenshot quality failed: ${issues.join("; ")}; metrics=${JSON.stringify(
        {
          byteLength: buffer.length,
          ...quality,
        },
      )}`,
    );
  }
}
