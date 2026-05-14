/**
 * Pure-function tests for the dHash + block-grid implementation.
 *
 * We synthesize tiny PNGs via `node:zlib` and the PNG chunk format so we
 * don't need any decoder dependency to exercise both code paths.
 */

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  blockGrid,
  decodePng,
  diffBlocks,
  frameDhash,
  hamming,
} from "../scene/dhash.js";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc ^ bytes[i]!) >>> 0;
    for (let j = 0; j < 8; j += 1) {
      const lsb = crc & 1;
      crc = (crc >>> 1) ^ (lsb ? 0xedb88320 : 0);
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

/**
 * Build a 16×16 8-bit RGB PNG painted in a horizontal gradient unless
 * `solid` is true (in which case every pixel is the same color).
 */
function makeTinyPng(seed = 0, solid = false): Buffer {
  const w = 16;
  const h = 16;
  const stride = w * 3;
  const rows: number[] = [];
  for (let y = 0; y < h; y += 1) {
    rows.push(0); // filter = None
    for (let x = 0; x < w; x += 1) {
      const v = solid ? (seed * 7) % 255 : ((x + seed) * 16) % 255;
      rows.push(v, v, v);
    }
  }
  const raw = Buffer.from(rows);
  const idat = deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("dhash — pure functions", () => {
  it("decodes a minimal RGB PNG", () => {
    const png = makeTinyPng();
    const decoded = decodePng(png);
    expect(decoded).not.toBeNull();
    expect(decoded?.width).toBe(16);
    expect(decoded?.height).toBe(16);
    expect(decoded?.rgba.length).toBe(16 * 16 * 4);
  });

  it("returns null for non-PNG input", () => {
    expect(decodePng(Buffer.from("not a png"))).toBeNull();
  });

  it("frameDhash is stable for identical frames", () => {
    const a = frameDhash(makeTinyPng(7));
    const b = frameDhash(makeTinyPng(7));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).toBe(b);
  });

  it("frameDhash differs for visually different frames", () => {
    const a = frameDhash(makeTinyPng(0));
    const b = frameDhash(makeTinyPng(50));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(hamming(a!, b!)).toBeGreaterThan(0);
  });

  it("hamming(x, x) == 0", () => {
    expect(hamming(0xdeadbeefcafe0001n, 0xdeadbeefcafe0001n)).toBe(0);
  });

  it("hamming(a, b) counts changed bits", () => {
    expect(hamming(0n, 0xffffffffffffffffn)).toBe(64);
  });
});

describe("dhash — block grid", () => {
  it("produces a cols*rows grid", () => {
    const grid = blockGrid(makeTinyPng(0), 4, 4);
    expect(grid).not.toBeNull();
    expect(grid!.cols).toBe(4);
    expect(grid!.rows).toBe(4);
    expect(grid!.hashes.length).toBe(16);
  });

  it("identical frames produce identical block grids and zero dirty blocks", () => {
    const a = blockGrid(makeTinyPng(11), 4, 4)!;
    const b = blockGrid(makeTinyPng(11), 4, 4)!;
    const dirty = diffBlocks(a, b);
    expect(dirty.length).toBe(0);
  });

  it("first frame (prev=null) marks every block dirty", () => {
    const grid = blockGrid(makeTinyPng(0), 4, 4)!;
    const dirty = diffBlocks(null, grid);
    expect(dirty.length).toBe(grid.cols * grid.rows);
  });

  it("changed frames produce a non-zero dirty list", () => {
    const a = blockGrid(makeTinyPng(0), 4, 4)!;
    const b = blockGrid(makeTinyPng(120), 4, 4)!;
    const dirty = diffBlocks(a, b);
    expect(dirty.length).toBeGreaterThan(0);
  });

  it("dirty-block bboxes are translated to image pixel space when dims are known", () => {
    const a = blockGrid(makeTinyPng(0), 4, 4)!;
    const b = blockGrid(makeTinyPng(120), 4, 4)!;
    const dirty = diffBlocks(a, b, 16, 16);
    for (const d of dirty) {
      expect(d.bbox[2]).toBeGreaterThan(0);
      expect(d.bbox[3]).toBeGreaterThan(0);
      expect(d.bbox[0]).toBeGreaterThanOrEqual(0);
      expect(d.bbox[1]).toBeGreaterThanOrEqual(0);
      expect(d.bbox[0] + d.bbox[2]).toBeLessThanOrEqual(16);
      expect(d.bbox[1] + d.bbox[3]).toBeLessThanOrEqual(16);
    }
  });
});
