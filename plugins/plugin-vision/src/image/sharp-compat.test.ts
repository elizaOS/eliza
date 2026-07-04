/**
 * Compatibility tests that diff the pure-JS image shim against native sharp.
 *
 * Native sharp is available in this Linux lane, so each supported shim operation
 * is compared on small generated images for the mobile fallback path.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createJimpShim, getSharp } from "./sharp-compat";

const shim = createJimpShim();

/** A deterministic RGB(A) gradient as raw row-major pixels. */
function gradientRaw(width: number, height: number, channels: 3 | 4): Buffer {
  const buf = Buffer.allocUnsafe(width * height * channels);
  for (let p = 0; p < width * height; p++) {
    const i = p * channels;
    buf[i] = (p * 7) % 256;
    buf[i + 1] = (p * 13) % 256;
    buf[i + 2] = (p * 29) % 256;
    if (channels === 4) buf[i + 3] = (p * 17) % 256;
  }
  return buf;
}

async function gradientPng(
  width: number,
  height: number,
  channels: 3 | 4 = 3,
): Promise<Buffer> {
  return sharp(gradientRaw(width, height, channels), {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

/** Max absolute per-byte difference between two equal-length buffers. */
function maxDelta(a: Buffer, b: Buffer): number {
  expect(a.length).toBe(b.length);
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

describe("sharp-compat shim vs native sharp", () => {
  it("getSharp resolves a usable factory", async () => {
    const factory = await getSharp();
    const meta = await factory(await gradientPng(8, 6)).metadata();
    expect(meta.width).toBe(8);
    expect(meta.height).toBe(6);
  });

  it("metadata matches for an encoded PNG", async () => {
    const png = await gradientPng(11, 7);
    const native = await sharp(png).metadata();
    const shimMeta = await shim(png).metadata();
    expect(shimMeta.width).toBe(native.width);
    expect(shimMeta.height).toBe(native.height);
    expect(shimMeta.format).toBe("png");
  });

  it("metadata reports raw input dimensions", async () => {
    const raw = gradientRaw(5, 4, 3);
    const shimMeta = await shim(raw, {
      raw: { width: 5, height: 4, channels: 3 },
    }).metadata();
    expect(shimMeta.width).toBe(5);
    expect(shimMeta.height).toBe(4);
  });

  it("decodes a PNG to identical raw RGB (removeAlpha + raw)", async () => {
    const png = await gradientPng(12, 9);
    const native = await sharp(png)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = await shim(png)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(result.info.width).toBe(native.info.width);
    expect(result.info.height).toBe(native.info.height);
    expect(result.info.channels).toBe(3);
    // PNG is lossless on both backends → exact pixel match.
    expect(maxDelta(result.data, native.data)).toBe(0);
  });

  it("ensureAlpha yields 4 channels with opaque alpha", async () => {
    const png = await gradientPng(6, 6, 3);
    const native = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = await shim(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(result.info.channels).toBe(4);
    expect(native.info.channels).toBe(4);
    expect(maxDelta(result.data, native.data)).toBe(0);
  });

  it("resize fit:fill produces identical dimensions", async () => {
    const png = await gradientPng(16, 10);
    const native = await sharp(png)
      .resize(8, 4, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = await shim(png)
      .resize(8, 4, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(result.info.width).toBe(8);
    expect(result.info.height).toBe(4);
    expect(result.info.width).toBe(native.info.width);
    expect(result.info.height).toBe(native.info.height);
    expect(result.info.channels).toBe(3);
  });

  it("extract crops to the requested region", async () => {
    // Use a raw-pixel source so the crop math is compared directly, without a
    // PNG decode in between (jimp's PNG decoder is unreliable under the Node
    // vitest harness; it is correct under bun — the production runtime).
    const raw = gradientRaw(20, 20, 3);
    const rawOpts = { raw: { width: 20, height: 20, channels: 3 as const } };
    const region = { left: 4, top: 3, width: 6, height: 5 };
    const native = await sharp(raw, rawOpts)
      .extract(region)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = await shim(raw, rawOpts)
      .extract(region)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(result.info.width).toBe(6);
    expect(result.info.height).toBe(5);
    // Lossless crop → exact pixel match.
    expect(maxDelta(result.data, native.data)).toBe(0);
  });

  it("extend pads with the background color", async () => {
    const png = await gradientPng(8, 8);
    const opts = {
      top: 2,
      bottom: 3,
      left: 1,
      right: 4,
      background: { r: 114, g: 114, b: 114, alpha: 1 },
    };
    const native = await sharp(png)
      .extend(opts)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = await shim(png)
      .extend(opts)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(result.info.width).toBe(13); // 8 + 1 + 4
    expect(result.info.height).toBe(13); // 8 + 2 + 3
    expect(result.info.width).toBe(native.info.width);
    expect(result.info.height).toBe(native.info.height);
    // Pad region + interior are both lossless → exact pixel match.
    expect(maxDelta(result.data, native.data)).toBe(0);
  });

  it("wraps a raw RGBA frame into a decodable PNG (the face path)", async () => {
    const width = 10;
    const height = 8;
    const raw = gradientRaw(width, height, 4);
    const shimPng = await shim(raw, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    // The PNG must round-trip back to the same dimensions / RGB pixels.
    const decoded = await sharp(shimPng)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(decoded.info.width).toBe(width);
    expect(decoded.info.height).toBe(height);
    const nativeRgb = await sharp(raw, {
      raw: { width, height, channels: 4 },
    })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(maxDelta(decoded.data, nativeRgb.data)).toBe(0);
  });

  it("clone yields an independent chain", async () => {
    const png = await gradientPng(12, 12);
    const base = shim(png);
    const a = await base
      .clone()
      .extract({ left: 0, top: 0, width: 4, height: 4 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const b = await base
      .clone()
      .extract({ left: 8, top: 8, width: 4, height: 4 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(a.info.width).toBe(4);
    expect(b.info.width).toBe(4);
    // Different crops of a gradient must differ.
    expect(maxDelta(a.data, b.data)).toBeGreaterThan(0);
  });

  it("jpeg output is a valid JPEG buffer", async () => {
    const png = await gradientPng(16, 16);
    const jpeg = await shim(png).jpeg().toBuffer();
    expect(Buffer.isBuffer(jpeg)).toBe(true);
    // SOI marker.
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(16);
    expect(meta.height).toBe(16);
  });

  it("trim removes a uniform border", async () => {
    const width = 12;
    const height = 12;
    const raw = Buffer.alloc(width * height * 3, 200); // gray border
    for (let y = 3; y < 9; y++) {
      for (let x = 3; x < 9; x++) {
        const i = (y * width + x) * 3;
        raw[i] = 10;
        raw[i + 1] = 20;
        raw[i + 2] = 30;
      }
    }
    const png = await sharp(raw, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    const native = await sharp(png)
      .trim()
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = await shim(png)
      .trim()
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(result.info.width).toBe(native.info.width);
    expect(result.info.height).toBe(native.info.height);
    expect(result.info.width).toBe(6);
    expect(result.info.height).toBe(6);
  });
});
