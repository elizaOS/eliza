/**
 * Verifies generateThumbnailBytes (api/media-thumbnail.ts) downscales oversized
 * images to a ≤512px JPEG, returns null for in-bounds or non-thumbnailable
 * inputs, and rejects declared bomb dimensions from the container header before
 * any decode runs — including the codec-specific escapes: Adam7-interlaced
 * PNGs (pngjs inflates those without its dimension-derived output cap) and
 * multi-SOF JPEGs (jpeg-js allocates every frame's blocks before throwing on
 * multi-frame input). Uses real PNG/JPEG encode + decode (pngjs / jpeg-js).
 */
import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
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

/** One SOF0 segment (1-component) declaring `width`×`height`. */
function makeSof0Segment(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf[0] = 0xff;
  buf[1] = 0xc0; // SOF0
  buf.writeUInt16BE(11, 2); // segment length (self-inclusive)
  buf[4] = 8; // sample precision
  buf.writeUInt16BE(height, 5);
  buf.writeUInt16BE(width, 7);
  buf[9] = 1; // one component: id / sampling / qtable
  buf[10] = 1;
  buf[11] = 0x11;
  buf[12] = 0;
  return buf;
}

/**
 * The wave-5 PoC shape: a small first SOF passes the dimension pre-check, a
 * second SOF declares bomb geometry — jpeg-js allocates every frame's MCU
 * blocks at SOF parse and only afterwards throws on multi-frame input.
 */
function makeMultiSofJpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    makeSof0Segment(64, 64),
    makeSof0Segment(9999, 9999),
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

// ── Minimal valid-PNG construction (signature + CRC'd chunks) ────────────────

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(buf: Buffer): number {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(
    crc32(Buffer.concat([Buffer.from(type, "ascii"), data])),
    8 + data.length,
  );
  return out;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Adam7 pass origins/strides: [x0, y0, dx, dy] for the 7 interlace passes. */
const ADAM7_PASSES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

/**
 * A structurally valid Adam7-interlaced RGBA PNG (filter-0 zeroed scanlines,
 * correct chunk CRCs) — decodable by pngjs, so a header check that ignores the
 * interlace byte would proceed to decode it.
 */
function makeInterlacedPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 1; // interlace: Adam7
  const scanlines: Buffer[] = [];
  for (const [x0, y0, dx, dy] of ADAM7_PASSES) {
    const passWidth = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const passHeight = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    for (let row = 0; row < passHeight; row++) {
      scanlines.push(Buffer.alloc(1 + passWidth * 4));
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(scanlines))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The wave-5 bomb shape, scaled down: a 64×64 IHDR passes the dimension cap,
 * interlace=1 routes pngjs to its uncapped inflate branch, and the IDAT
 * carries 4 MiB of deflated zeros — far more than the declared geometry needs.
 */
function makeInterlacedBombPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[12] = 1;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.alloc(4 * 1024 * 1024))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
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

  it("rejects a multi-SOF JPEG whose later frame declares bomb geometry", async () => {
    // The first SOF (64×64) passes the dimension pre-check; the second SOF
    // (9999×9999) would make jpeg-js allocate ~1 GB of MCU blocks before it
    // throws on multi-frame input. The header walk must fail closed on the
    // second SOFn instead of returning after the first.
    expect(
      await generateThumbnailBytes(makeMultiSofJpeg(), "image/jpeg"),
    ).toBeNull();
  });

  it("returns null for an Adam7-interlaced PNG without attempting decode", async () => {
    // A valid, decodable interlaced PNG above the thumbnail size: pre-fix this
    // produced a thumbnail; the interlace byte must now fail closed because
    // pngjs inflates interlaced IDAT with no dimension-derived output cap.
    const png = makeInterlacedPng(640, 640);
    expect(png[28]).toBe(1); // sanity: the IHDR interlace byte is set
    expect(await generateThumbnailBytes(png, "image/png")).toBeNull();
  });

  it("rejects an interlaced small-IHDR PNG bomb before any inflate runs", async () => {
    expect(
      await generateThumbnailBytes(makeInterlacedBombPng(), "image/png"),
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
