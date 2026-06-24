/**
 * dHash / block-grid change-detection core (#9105 M3).
 *
 * `dhash.ts` is the cheap "did the screen change?" gate underneath the unified
 * ScreenState store — frame dHash for the whole-frame idle gate, block grids +
 * dirty-block diffing/coalescing for region re-OCR, and a minimal hand-rolled
 * PNG decoder. `screen-state.test.ts` drives the store end-to-end but never
 * exercises the decoder's reject paths or the diff/coalesce geometry directly.
 *
 * This pins:
 *   - `decodePng` accepts the formats every screenshot path ships (8-bit RGB /
 *     RGBA, non-interlaced) and returns `null` — never throws — for the
 *     unsupported variants (truncated, bad signature, interlaced, palette,
 *     16-bit),
 *   - `pngDimensions` reads IHDR without inflating,
 *   - `frameDhash` / `hamming` (popcount correctness + flat-frame invariant),
 *   - `blockGrid` shape + `diffBlocks` / `coalesceDirtyBlocks` geometry.
 *
 * Reuses the crc32 + pngChunk + deflateSync PNG synthesizer from
 * `screen-state.test.ts`, parameterized so the reject-path variants are
 * constructible.
 */

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type BlockGrid,
  blockGrid,
  blockGridFromImage,
  coalesceDirtyBlocks,
  type DirtyBlock,
  decodePng,
  diffBlocks,
  frameDhash,
  hamming,
  pngDimensions,
} from "./dhash.js";

// ── parameterized PNG synthesizer ────────────────────────────────────────────
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

interface PngOpts {
  width?: number;
  height?: number;
  /** 2 = RGB, 6 = RGBA, 3 = palette (an unsupported variant). */
  colorType?: number;
  bitDepth?: number;
  interlace?: number;
  /** Per-pixel luminance; defaults to a horizontal gradient. */
  pixel?: (x: number, y: number) => number;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makePng(opts: PngOpts = {}): Buffer {
  const w = opts.width ?? 32;
  const h = opts.height ?? 32;
  const colorType = opts.colorType ?? 2;
  const bitDepth = opts.bitDepth ?? 8;
  const interlace = opts.interlace ?? 0;
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const pixel = opts.pixel ?? ((x: number) => (x * 8) % 255);
  const rows: number[] = [];
  for (let y = 0; y < h; y += 1) {
    rows.push(0); // filter byte: none
    for (let x = 0; x < w; x += 1) {
      const v = pixel(x, y) & 0xff;
      for (let ch = 0; ch < channels; ch += 1) {
        rows.push(ch === 3 ? 255 : v); // opaque alpha for RGBA
      }
    }
  }
  const idat = deflateSync(Buffer.from(rows));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  return Buffer.concat([
    SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("decodePng", () => {
  it("decodes an 8-bit RGB PNG to width·height·4 RGBA bytes", () => {
    const decoded = decodePng(makePng({ width: 32, height: 32 }));
    expect(decoded).not.toBeNull();
    expect(decoded?.width).toBe(32);
    expect(decoded?.height).toBe(32);
    expect(decoded?.rgba.length).toBe(32 * 32 * 4);
    // RGB source → every alpha byte forced opaque.
    expect(decoded?.rgba[3]).toBe(255);
  });

  it("decodes an 8-bit RGBA PNG and preserves the alpha channel", () => {
    const decoded = decodePng(makePng({ colorType: 6 }));
    expect(decoded).not.toBeNull();
    expect(decoded?.rgba.length).toBe(32 * 32 * 4);
    expect(decoded?.rgba[3]).toBe(255);
  });

  it("returns null (never throws) for every unsupported / malformed variant", () => {
    const cases: Array<[string, Buffer]> = [
      ["empty", Buffer.alloc(0)],
      ["shorter-than-signature", Buffer.from([0x89, 0x50, 0x4e])],
      [
        "bad-signature",
        Buffer.concat([Buffer.alloc(8, 0), makePng().subarray(8)]),
      ],
      ["truncated-mid-chunk", makePng().subarray(0, 20)],
      ["interlaced", makePng({ interlace: 1 })],
      ["palette-indexed", makePng({ colorType: 3 })],
      ["16-bit-depth", makePng({ bitDepth: 16 })],
    ];
    for (const [label, buf] of cases) {
      let result: ReturnType<typeof decodePng> | "threw";
      try {
        result = decodePng(buf);
      } catch {
        result = "threw";
      }
      expect(
        result,
        `${label} must decode to null without throwing`,
      ).toBeNull();
    }
  });
});

describe("pngDimensions", () => {
  it("reads dimensions from IHDR without inflating IDAT", () => {
    expect(pngDimensions(makePng({ width: 64, height: 48 }))).toEqual({
      width: 64,
      height: 48,
    });
  });

  it("returns null for a non-PNG or too-short buffer", () => {
    expect(pngDimensions(Buffer.alloc(4))).toBeNull();
    expect(pngDimensions(Buffer.alloc(40, 0))).toBeNull(); // valid length, bad signature
  });
});

describe("frameDhash + hamming", () => {
  it("is deterministic and null for an undecodable frame", () => {
    const a = frameDhash(makePng({ pixel: (x) => x * 8 }));
    const b = frameDhash(makePng({ pixel: (x) => x * 8 }));
    expect(typeof a).toBe("bigint");
    expect(a).toBe(b);
    expect(frameDhash(Buffer.from("not a png"))).toBeNull();
  });

  it("is 0 for a perfectly flat frame and nonzero where a vertical edge exists", () => {
    const flat = frameDhash(makePng({ pixel: () => 128 }));
    const edge = frameDhash(
      makePng({ pixel: (x) => (x < 16 ? 255 : 0) }), // bright-left / dark-right
    );
    expect(flat).toBe(0n);
    expect(edge).not.toBe(0n);
    // The flat frame and the edged frame must differ.
    expect(hamming(flat as bigint, edge as bigint)).toBeGreaterThan(0);
  });

  it("counts differing bits (popcount of the XOR)", () => {
    expect(hamming(0n, 0n)).toBe(0);
    expect(hamming(0b101n, 0b010n)).toBe(3); // all three low bits differ
    expect(hamming(0b1011n, 0b1110n)).toBe(2);
    expect(hamming(0n, 0xffffffffffffffffn)).toBe(64);
  });
});

describe("blockGrid", () => {
  it("produces a cols·rows hash matrix and matches blockGridFromImage", () => {
    const png = makePng();
    const grid = blockGrid(png, 4, 4);
    expect(grid).not.toBeNull();
    expect(grid?.cols).toBe(4);
    expect(grid?.rows).toBe(4);
    expect(grid?.hashes.length).toBe(16);

    const decoded = decodePng(png);
    expect(decoded).not.toBeNull();
    if (decoded) {
      const direct = blockGridFromImage(decoded, 4, 4);
      expect(Array.from(direct.hashes)).toEqual(Array.from(grid?.hashes ?? []));
    }
  });

  it("defaults to a 16×16 grid and returns null for an undecodable PNG", () => {
    const grid = blockGrid(makePng());
    expect(grid?.cols).toBe(16);
    expect(grid?.hashes.length).toBe(256);
    expect(blockGrid(Buffer.from("nope"))).toBeNull();
  });
});

// Hand-built grids keep the diff/coalesce geometry deterministic and decoupled
// from the resampling math.
const gridOf = (cols: number, rows: number, hashes: number[]): BlockGrid => ({
  cols,
  rows,
  hashes: Uint32Array.from(hashes),
});

describe("diffBlocks", () => {
  it("treats every block as dirty on the first frame (prev = null)", () => {
    const current = gridOf(2, 2, [0, 0, 0, 0]);
    expect(diffBlocks(null, current)).toHaveLength(4);
  });

  it("reports no dirty blocks between identical grids", () => {
    const g = gridOf(2, 2, [1, 2, 3, 4]);
    expect(diffBlocks(gridOf(2, 2, [1, 2, 3, 4]), g)).toEqual([]);
  });

  it("flags exactly the changed block, with a pixel-space bbox when dims are given", () => {
    const prev = gridOf(2, 2, [1, 1, 1, 1]);
    const current = gridOf(2, 2, [1, 9, 1, 1]); // block (col 1, row 0) changed
    const plain = diffBlocks(prev, current);
    expect(plain).toEqual([{ col: 1, row: 0, bbox: [1, 0, 1, 1] }]);

    const withBbox = diffBlocks(prev, current, 40, 40);
    expect(withBbox).toEqual([{ col: 1, row: 0, bbox: [20, 0, 20, 20] }]);
  });

  it("treats a grid-size change as all-dirty (no stale comparison)", () => {
    const prev = gridOf(2, 2, [0, 0, 0, 0]);
    const current = gridOf(3, 3, new Array(9).fill(0));
    expect(diffBlocks(prev, current)).toHaveLength(9);
  });
});

describe("coalesceDirtyBlocks", () => {
  const grid = gridOf(4, 4, new Array(16).fill(0));
  const db = (col: number, row: number): DirtyBlock => ({
    col,
    row,
    bbox: [col, row, 1, 1],
  });

  it("returns nothing for an empty dirty set", () => {
    expect(coalesceDirtyBlocks([], grid)).toEqual([]);
  });

  it("merges a horizontal run into a single strip", () => {
    const merged = coalesceDirtyBlocks([db(0, 0), db(1, 0)], grid);
    expect(merged).toEqual([{ bbox: [0, 0, 2, 1] }]); // col,row,colspan,rowspan
  });

  it("merges equal-width strips across successive rows into one rectangle", () => {
    const merged = coalesceDirtyBlocks(
      [db(0, 0), db(1, 0), db(0, 1), db(1, 1)],
      grid,
    );
    expect(merged).toEqual([{ bbox: [0, 0, 2, 2] }]);
  });

  it("projects the merged rectangle into pixel space when image dims are given", () => {
    const merged = coalesceDirtyBlocks(
      [db(0, 0), db(1, 0), db(0, 1), db(1, 1)],
      grid,
      64,
      64,
    );
    // cols=rows=4 over a 64px frame → 16px/block; a 2×2 block region → 32×32 px.
    expect(merged).toEqual([{ bbox: [0, 0, 32, 32] }]);
  });
});
