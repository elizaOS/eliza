/**
 * Unit tests for the Screenshot Quality app shell contract and coverage
 * guardrail.
 */
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  analyzeScreenshot,
  captureScreenshotWithQualityRetry,
} from "./ui-smoke/helpers/screenshot-quality";

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

async function noisyPng(): Promise<Buffer> {
  const width = 96;
  const height = 96;
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    pixels[offset] = (i * 17) % 256;
    pixels[offset + 1] = (i * 31) % 256;
    pixels[offset + 2] = (i * 47) % 256;
    pixels[offset + 3] = 255;
  }
  return sharp(pixels, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
}

describe("app screenshot quality guard", () => {
  it("fails one-color screenshots with explicit quality diagnostics", async () => {
    const white = await solidPng("#ffffff");
    const page = {
      screenshot: vi.fn(async () => white),
      waitForTimeout: vi.fn(async () => undefined),
    };

    await expect(
      captureScreenshotWithQualityRetry(page as never, "white app capture", {
        fullPage: true,
      }),
    ).rejects.toThrow(/white app capture.*screenshot is one color/);
    expect(page.screenshot).toHaveBeenCalledTimes(3);
  });

  it("accepts nonblank multi-color screenshots", async () => {
    const image = await noisyPng();
    const page = {
      screenshot: vi.fn(async () => image),
      waitForTimeout: vi.fn(async () => undefined),
    };

    const captured = await captureScreenshotWithQualityRetry(
      page as never,
      "noisy app capture",
      { fullPage: true },
    );
    const quality = await analyzeScreenshot(captured);

    expect(captured.length).toBeGreaterThan(1_000);
    expect(quality.colorBuckets).toBeGreaterThan(2);
    expect(page.screenshot).toHaveBeenCalledTimes(1);
  });
});
