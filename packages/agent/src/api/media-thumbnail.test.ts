/**
 * Verifies generateThumbnailBytes (api/media-thumbnail.ts) downscales oversized
 * images to a ≤512px JPEG and returns null for in-bounds or non-thumbnailable
 * inputs, using real PNG encode + JPEG decode (pngjs / jpeg-js).
 */
import type { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { generateThumbnailBytes } from "./media-thumbnail.ts";

const jpegMod = await import("jpeg-js");
const jpeg = (jpegMod as { default?: unknown }).default ?? jpegMod;

function makePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0x33;
    png.data[i + 1] = 0x66;
    png.data[i + 2] = 0xcc;
    png.data[i + 3] = 0xff;
  }
  return PNG.sync.write(png);
}

describe("generateThumbnailBytes", () => {
  it("downscales a large PNG to a ≤512px JPEG", async () => {
    const png = makePng(1280, 960);
    const thumb = await generateThumbnailBytes(png, "image/png");
    expect(thumb).not.toBeNull();
    expect(thumb?.mimeType).toBe("image/jpeg");
    // Decode the JPEG result and confirm it was actually downscaled.
    const decoded = (
      jpeg as {
        decode: (b: Buffer) => { width: number; height: number };
      }
    ).decode(thumb?.buffer as Buffer);
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(512);
    // 1280×960 → longest 1280 scaled to 512 → width 512.
    expect(decoded.width).toBe(512);
    expect((thumb?.buffer.length ?? 0) > 0).toBe(true);
  });

  it("returns null for an image already within bounds", async () => {
    expect(
      await generateThumbnailBytes(makePng(200, 150), "image/png"),
    ).toBeNull();
  });

  it("returns null for non-thumbnailable mime types", async () => {
    const png = makePng(1280, 960);
    expect(await generateThumbnailBytes(png, "image/webp")).toBeNull();
    expect(await generateThumbnailBytes(png, "application/pdf")).toBeNull();
  });
});
