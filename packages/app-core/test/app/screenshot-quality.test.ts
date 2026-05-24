import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  analyzeScreenshot,
  captureScreenshotWithQualityRetry,
} from "./screenshot-quality.ts";

async function pngBuffer(color: string): Promise<Buffer> {
  return sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: color,
    },
  })
    .png()
    .toBuffer();
}

async function splitColorPng(): Promise<Buffer> {
  const left = await sharp({
    create: {
      width: 16,
      height: 32,
      channels: 4,
      background: "#ffffff",
    },
  })
    .png()
    .toBuffer();
  const right = await sharp({
    create: {
      width: 16,
      height: 32,
      channels: 4,
      background: "#111111",
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: "#ffffff",
    },
  })
    .composite([{ input: right, left: 16, top: 0 }])
    .png()
    .toBuffer();
}

describe("app live screenshot quality guard", () => {
  it("fails one-color screenshots with a clear diagnostic after retries", async () => {
    const white = await pngBuffer("#ffffff");
    const page = {
      screenshot: vi.fn(async () => white),
      waitForTimeout: vi.fn(async () => undefined),
    };

    await expect(
      captureScreenshotWithQualityRetry(page, "white capture", {
        fullPage: true,
      }),
    ).rejects.toThrow(/white capture.*screenshot is one color/);
    expect(page.screenshot).toHaveBeenCalledTimes(3);
  });

  it("accepts screenshots with more than one color bucket", async () => {
    const image = await splitColorPng();
    const page = {
      screenshot: vi.fn(async () => image),
      waitForTimeout: vi.fn(async () => undefined),
    };

    const captured = await captureScreenshotWithQualityRetry(
      page,
      "split capture",
      { fullPage: true },
    );
    const quality = await analyzeScreenshot(captured);

    expect(quality.colorBuckets).toBeGreaterThan(1);
    expect(page.screenshot).toHaveBeenCalledTimes(1);
  });
});
