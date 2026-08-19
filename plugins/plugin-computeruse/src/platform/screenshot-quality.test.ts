/**
 * Screenshot quality tests pin the pure classifier that guards real-driver
 * screenshot evidence lanes from empty or visually blank PNG captures.
 *
 * Synthetic metrics lock the empty floor, single-color rule, and dominant-color
 * threshold without depending on live display capture. Additional cases pin the
 * bounded PNG decompression guards that prevent a 69-byte IHDR bomb from driving
 * an unbounded inflateSync allocation — pixel budget, stride overflow, and
 * maxOutputLength + length-mismatch checks mirror scene/dhash.ts.
 */

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  analyzePngScreenshot,
  type ScreenshotQuality,
  screenshotQualityIssues,
} from "./screenshot-quality";

// ── PNG synthesizer (crc32 + chunk + minimal IHDR/IDAT/IEND) ─────────────
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i] ?? 0;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function makePng(
  opts: {
    width?: number;
    height?: number;
    colorType?: number;
    pixel?: (x: number, y: number) => number;
  } = {},
): Buffer {
  const w = opts.width ?? 32;
  const h = opts.height ?? 32;
  const colorType = opts.colorType ?? 2;
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const pixel = opts.pixel ?? ((x: number) => (x * 8) % 255);
  const rows: number[] = [];
  for (let y = 0; y < h; y += 1) {
    rows.push(0);
    for (let x = 0; x < w; x += 1) {
      const v = pixel(x, y) & 0xff;
      for (let ch = 0; ch < channels; ch += 1) rows.push(ch === 3 ? 255 : v);
    }
  }
  const idat = deflateSync(Buffer.from(rows));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const quality = (o: Partial<ScreenshotQuality>): ScreenshotQuality => ({
  width: 100,
  height: 100,
  sampledPixels: 10_000,
  colorBuckets: 500,
  dominantRatio: 0.2,
  ...o,
});
describe("screenshotQualityIssues", () => {
  it("flags an empty screenshot", () => {
    const issues = screenshotQualityIssues(
      "shot",
      quality({ width: 0, height: 0, sampledPixels: 0, colorBuckets: 0 }),
    );
    expect(issues).toContain("shot: screenshot is empty");
  });

  it("flags a single-color screenshot without also flagging 'effectively one color'", () => {
    const issues = screenshotQualityIssues(
      "shot",
      quality({ colorBuckets: 1, dominantRatio: 1 }),
    );
    expect(issues).toContain("shot: screenshot is one color");
    expect(issues.some((i) => i.includes("effectively one color"))).toBe(false);
  });

  it("flags 'effectively one color' only above the 0.995 dominance boundary", () => {
    const over = screenshotQualityIssues(
      "shot",
      quality({ colorBuckets: 2, dominantRatio: 0.996 }),
    );
    expect(over.some((i) => i.includes("effectively one color"))).toBe(true);

    // 0.99 is below the 0.995 cutoff → not flagged.
    const under = screenshotQualityIssues(
      "shot",
      quality({ colorBuckets: 2, dominantRatio: 0.99 }),
    );
    expect(under).toEqual([]);
  });

  it("returns no issues for a healthy multi-color screenshot", () => {
    expect(
      screenshotQualityIssues(
        "shot",
        quality({ colorBuckets: 500, dominantRatio: 0.2 }),
      ),
    ).toEqual([]);
  });
});

describe("analyzePngScreenshot: bounded decompression", () => {
  it("decodes a valid 1x1 PNG without throwing", () => {
    const buf = makePng({ width: 1, height: 1 });
    const q = analyzePngScreenshot(buf);
    expect(q.width).toBe(1);
    expect(q.height).toBe(1);
    expect(q.sampledPixels).toBe(1);
  });

  it("decodes a synthesized multi-color PNG and reports sane metrics", () => {
    const buf = makePng({ width: 4, height: 4 });
    const q = analyzePngScreenshot(buf);
    expect(q.width).toBe(4);
    expect(q.height).toBe(4);
    expect(q.sampledPixels).toBe(16);
    expect(q.colorBuckets).toBeGreaterThan(1);
  });

  it("throws for a pixel-budget-exceeding IHDR (bomb header)", () => {
    const budget = 7_680 * 4_320;
    // 65535x65535 >> budget, bomb is <128 bytes.
    const w = 65535;
    const h = 65535;
    expect(w * h).toBeGreaterThan(budget);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const bomb = Buffer.concat([
      PNG_SIG,
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3]))),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    expect(bomb.length).toBeLessThan(128);
    expect(() => analyzePngScreenshot(bomb)).toThrow(/exceed.*pixel budget/);
  });

  it("throws on decompression length mismatch", () => {
    // Valid IHDR 2x2 but IDAT only inflates to 2 rows instead of 2*(stride+1).
    const w = 2;
    const h = 2;
    // Build a truncated IDAT (only 1 row).
    const rows = [0, 10, 20, 30, 40, 50, 60];
    const idat = deflateSync(Buffer.from(rows));
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const truncated = Buffer.concat([
      PNG_SIG,
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", idat),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    expect(() => analyzePngScreenshot(truncated)).toThrow(
      /PNG decompression length mismatch/,
    );
  });

  it("caps inflateSync via maxOutputLength (bomb with claimed large dims but tiny body)", () => {
    const w = 100;
    const h = 100;
    // IHDR claims 100x100 RGB (stride 300, expected 30100) but IDAT inflates to far larger.
    // Craft an IDAT that would inflate to >expected if unbounded — repetition compresses well.
    const huge = Buffer.alloc(50_000, 0xaa);
    const idat = deflateSync(huge);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const bomb = Buffer.concat([
      PNG_SIG,
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", idat),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    // This distinguishes the allocation cap from the later length check: if
    // maxOutputLength is removed, inflate succeeds and reports a mismatch.
    expect(() => analyzePngScreenshot(bomb)).toThrow(
      /PNG decompression failed/,
    );
  });
});
