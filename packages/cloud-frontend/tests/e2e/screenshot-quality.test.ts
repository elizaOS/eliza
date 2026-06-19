import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  analyzeScreenshot,
  captureScreenshotWithQualityRetry,
} from "./_helpers/screenshot-quality";

async function solidPng(color: string): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: color,
    },
  })
    .png()
    .toBuffer();
}

async function variedPng(): Promise<Buffer> {
  const width = 96;
  const height = 96;
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    pixels[offset] = (i * 13) % 256;
    pixels[offset + 1] = (i * 29) % 256;
    pixels[offset + 2] = (i * 43) % 256;
    pixels[offset + 3] = 255;
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

describe("cloud screenshot quality guard", () => {
  it("fails one-color screenshots with explicit diagnostics", async () => {
    const white = await solidPng("#ffffff");
    const page = {
      screenshot: vi.fn(async () => white),
      waitForTimeout: vi.fn(async () => undefined),
    };

    await expect(
      captureScreenshotWithQualityRetry(page as never, "white cloud capture", {
        fullPage: true,
      }),
    ).rejects.toThrow(/white cloud capture.*screenshot is one color/);
    expect(page.screenshot).toHaveBeenCalledTimes(3);
  });

  it("accepts nonblank multi-color screenshots", async () => {
    const image = await variedPng();
    const page = {
      screenshot: vi.fn(async () => image),
      waitForTimeout: vi.fn(async () => undefined),
    };

    const captured = await captureScreenshotWithQualityRetry(
      page as never,
      "varied cloud capture",
      { fullPage: true },
    );
    const quality = await analyzeScreenshot(captured);

    expect(captured.length).toBeGreaterThan(1_000);
    expect(quality.colorBuckets).toBeGreaterThan(2);
    expect(page.screenshot).toHaveBeenCalledTimes(1);
  });
});
