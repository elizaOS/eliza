/**
 * Verifies generateThumbnailBytes (api/media-thumbnail.ts) downscales oversized
 * images to a ≤512px JPEG, returns null for in-bounds or non-thumbnailable
 * inputs, and rejects declared bomb dimensions from the container header before
 * any decode runs. Uses real PNG/JPEG encode + decode (pngjs / jpeg-js).
 */
import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { generateThumbnailBytes } from "./media-thumbnail.ts";

const jpegMod = await import("jpeg-js");
const jpeg = (jpegMod as { default?: unknown }).default ?? jpegMod;

interface JpegCodec {
  decode: (b: Buffer) => { width: number; height: number };
  encode: (
    img: { width: number; height: number; data: Uint8Array },
    quality?: number,
  ) => { data: Buffer };
}

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

function makeJpeg(width: number, height: number): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0x33;
    data[i + 1] = 0x66;
    data[i + 2] = 0xcc;
    data[i + 3] = 0xff;
  }
  return (jpeg as JpegCodec).encode({ width, height, data }, 80).data;
}

/** SOI + bare SOF0 segment declaring `width`×`height` — no real scan data. */
function makeJpegHeaderOnly(width: number, height: number): Buffer {
  const buf = Buffer.alloc(15);
  buf[0] = 0xff;
  buf[1] = 0xd8; // SOI
  buf[2] = 0xff;
  buf[3] = 0xc0; // SOF0
  buf.writeUInt16BE(11, 4); // segment length (self-inclusive)
  buf[6] = 8; // sample precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

describe("generateThumbnailBytes", () => {
  it("downscales a large PNG to a ≤512px JPEG", async () => {
    const png = makePng(1280, 960);
    const thumb = await generateThumbnailBytes(png, "image/png");
    expect(thumb).not.toBeNull();
    expect(thumb?.mimeType).toBe("image/jpeg");
    // Decode the JPEG result and confirm it was actually downscaled.
    const decoded = (jpeg as JpegCodec).decode(thumb?.buffer as Buffer);
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

describe("generateThumbnailBytes decode-dimension bounds", () => {
  it("rejects a PNG whose IHDR declares bomb dimensions before decoding", async () => {
    // Forge the IHDR of a real small PNG: the compressed bytes stay tiny, but
    // decoding the declared 25000×25000 would allocate ~2.5 GB of RGBA.
    const png = makePng(64, 64);
    png.writeUInt32BE(25000, 16);
    png.writeUInt32BE(25000, 20);
    expect(await generateThumbnailBytes(png, "image/png")).toBeNull();
  });

  it("rejects a PNG over the total-pixel bound with each edge under the cap", async () => {
    // 5000×5000 = 25 M px > 16 Mi px, yet both edges are ≤ 8192.
    const png = makePng(64, 64);
    png.writeUInt32BE(5000, 16);
    png.writeUInt32BE(5000, 20);
    expect(await generateThumbnailBytes(png, "image/png")).toBeNull();
  });

  it("rejects a JPEG whose SOF declares bomb dimensions", async () => {
    expect(
      await generateThumbnailBytes(
        makeJpegHeaderOnly(25000, 25000),
        "image/jpeg",
      ),
    ).toBeNull();
  });

  it("fails closed when the container header can't be parsed", async () => {
    expect(
      await generateThumbnailBytes(Buffer.from("not an image"), "image/png"),
    ).toBeNull();
  });

  it("still thumbnails a valid in-bounds JPEG", async () => {
    const thumb = await generateThumbnailBytes(
      makeJpeg(1280, 960),
      "image/jpeg",
    );
    expect(thumb?.mimeType).toBe("image/jpeg");
    const decoded = (jpeg as JpegCodec).decode(thumb?.buffer as Buffer);
    expect(decoded.width).toBe(512);
  });
});
