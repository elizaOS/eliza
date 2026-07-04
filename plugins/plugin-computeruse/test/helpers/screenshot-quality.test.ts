/**
 * Screenshot-quality helper: analyzePngScreenshot + assertScreenshotBase64NotBlank
 * over deflate-built PNGs. Deterministic unit test.
 */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  analyzePngScreenshot,
  assertScreenshotBase64NotBlank,
  screenshotQualityIssues,
} from "../../src/platform/screenshot-quality.ts";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([
    length,
    Buffer.from(type, "ascii"),
    data,
    Buffer.alloc(4),
  ]);
}

function pngFromRows(
  width: number,
  height: number,
  pixelAt: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelAt(x, y);
      const offset = 1 + x * 4;
      row[offset] = r;
      row[offset + 1] = g;
      row[offset + 2] = b;
      row[offset + 3] = a;
    }
    rows.push(row);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("computer-use screenshot quality helper", () => {
  it("reports exact quality stats for one-color screenshots", () => {
    const whitePng = pngFromRows(4, 4, () => [255, 255, 255, 255]);
    const quality = analyzePngScreenshot(whitePng);

    expect(quality).toMatchObject({
      width: 4,
      height: 4,
      sampledPixels: 16,
      colorBuckets: 1,
      dominantRatio: 1,
    });
    expect(screenshotQualityIssues("white screen", quality)).toEqual([
      "white screen: screenshot is one color",
    ]);
    expect(() =>
      assertScreenshotBase64NotBlank(
        whitePng.toString("base64"),
        "white screen",
      ),
    ).toThrowError(/white screen: screenshot quality failed:/);
    expect(() =>
      assertScreenshotBase64NotBlank(
        whitePng.toString("base64"),
        "white screen",
      ),
    ).toThrowError(/white screen: screenshot is one color/);
  });

  it("passes screenshots with multiple visible color buckets", () => {
    const quality = analyzePngScreenshot(
      pngFromRows(4, 4, (x, y) =>
        (x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255],
      ),
    );

    expect(quality.colorBuckets).toBeGreaterThan(1);
    expect(screenshotQualityIssues("checkerboard", quality)).toEqual([]);
  });
});
