import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_EDGE,
  DEFAULT_OVERLAP_FRACTION,
  reconstructAbsoluteCoords,
  type ScreenTile,
  tileScreenshot,
} from "./screen-tiler";

/**
 * Render a solid-color PNG of the requested dimensions. We don't care about
 * the pixels — only that sharp can decode/extract from the buffer — so a flat
 * color is fastest.
 */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 32, g: 64, b: 128 },
    },
  })
    .png()
    .toBuffer();
}

async function dimsOf(buf: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("sharp metadata missing dims");
  }
  return { width: meta.width, height: meta.height };
}

describe("tileScreenshot — single-tile fast path", () => {
  it("returns the input unchanged when both dims fit in maxEdge", async () => {
    const png = await makePng(800, 600);
    const tiles = await tileScreenshot(
      { displayId: "d-0", width: 800, height: 600, pngBytes: png },
      { maxEdge: 1024, overlapFraction: 0.12 },
    );
    expect(tiles).toHaveLength(1);
    const t = tiles[0]!;
    expect(t.id).toBe("tile-0-0");
    expect(t.displayId).toBe("d-0");
    expect(t.sourceX).toBe(0);
    expect(t.sourceY).toBe(0);
    expect(t.sourceW).toBe(800);
    expect(t.sourceH).toBe(600);
    expect(t.tileW).toBe(800);
    expect(t.tileH).toBe(600);
    expect(t.pngBytes).toBe(png);
  });

  it("returns one tile when width and height equal maxEdge exactly", async () => {
    const png = await makePng(1024, 1024);
    const tiles = await tileScreenshot(
      { displayId: "d-1", width: 1024, height: 1024, pngBytes: png },
      { maxEdge: 1024, overlapFraction: 0.12 },
    );
    expect(tiles).toHaveLength(1);
  });
});

describe("tileScreenshot — 2x2 grid", () => {
  it("produces a 2x2 grid for an image just over 2× maxEdge", async () => {
    const png = await makePng(2000, 1500);
    const tiles = await tileScreenshot(
      { displayId: "d-2", width: 2000, height: 1500, pngBytes: png },
      { maxEdge: 1024, overlapFraction: 0.12 },
    );
    expect(tiles).toHaveLength(4);
    // Last tile in each axis must anchor to the source's far edge.
    const lastCol = tiles.filter((t) => t.id.endsWith("-1"));
    for (const t of lastCol) {
      expect(t.sourceX + t.sourceW).toBe(2000);
    }
    const lastRow = tiles.filter((t) => t.id.startsWith("tile-1-"));
    for (const t of lastRow) {
      expect(t.sourceY + t.sourceH).toBe(1500);
    }
    // First-tile origin is (0, 0).
    const first = tiles.find((t) => t.id === "tile-0-0")!;
    expect(first.sourceX).toBe(0);
    expect(first.sourceY).toBe(0);
    // No tile exceeds maxEdge in either axis.
    for (const t of tiles) {
      expect(t.tileW).toBeLessThanOrEqual(1024);
      expect(t.tileH).toBeLessThanOrEqual(1024);
    }
    // Each tile's PNG must decode at exactly the reported tile dims.
    for (const t of tiles) {
      const dims = await dimsOf(t.pngBytes);
      expect(dims).toEqual({ width: t.tileW, height: t.tileH });
    }
  });
});

describe("tileScreenshot — ultra-wide 5K case", () => {
  it("tiles a 5120x2160 ultra-wide into >=5 tiles, none over maxEdge", async () => {
    const png = await makePng(5120, 2160);
    const tiles = await tileScreenshot(
      { displayId: "ultrawide", width: 5120, height: 2160, pngBytes: png },
      { maxEdge: 1280, overlapFraction: 0.12 },
    );
    // ceil(5120/1280)=4 cols, ceil(2160/1280)=2 rows → 8 tiles.
    expect(tiles.length).toBe(8);
    for (const t of tiles) {
      expect(t.tileW).toBeLessThanOrEqual(1280);
      expect(t.tileH).toBeLessThanOrEqual(1280);
      expect(t.sourceX).toBeGreaterThanOrEqual(0);
      expect(t.sourceY).toBeGreaterThanOrEqual(0);
      expect(t.sourceX + t.sourceW).toBeLessThanOrEqual(5120);
      expect(t.sourceY + t.sourceH).toBeLessThanOrEqual(2160);
    }
    // Coverage: union of every tile's cropped rect must hit (0,0) and the
    // bottom-right corner of the source image.
    const coversTopLeft = tiles.some(
      (t) => t.sourceX === 0 && t.sourceY === 0,
    );
    const coversBottomRight = tiles.some(
      (t) => t.sourceX + t.sourceW === 5120 && t.sourceY + t.sourceH === 2160,
    );
    expect(coversTopLeft).toBe(true);
    expect(coversBottomRight).toBe(true);
  });
});

describe("tileScreenshot — overlap math", () => {
  it("adjacent tiles in the same row overlap by ~overlapFraction*tileW", async () => {
    const png = await makePng(2400, 1000);
    const tiles = await tileScreenshot(
      { displayId: "wide", width: 2400, height: 1000, pngBytes: png },
      { maxEdge: 1280, overlapFraction: 0.12 },
    );
    // 2400 / 1280 → 2 cols, 1 row.
    const row0 = tiles.filter((t) => t.id.startsWith("tile-0-"));
    expect(row0).toHaveLength(2);
    const a = row0.find((t) => t.id === "tile-0-0")!;
    const b = row0.find((t) => t.id === "tile-0-1")!;
    const overlap = a.sourceX + a.sourceW - b.sourceX;
    expect(overlap).toBeGreaterThan(0);
    // Overlap should be in the ballpark of overlapFraction*maxEdge but not
    // exceed maxEdge. Allow a generous lower bound — the exact value depends
    // on the rounded stride.
    const expectedMin = Math.floor(0.05 * a.tileW);
    expect(overlap).toBeGreaterThanOrEqual(expectedMin);
    expect(overlap).toBeLessThan(a.tileW);
  });

  it("rejects an overlapFraction outside [0, 1)", async () => {
    const png = await makePng(100, 100);
    await expect(
      tileScreenshot(
        { displayId: "x", width: 100, height: 100, pngBytes: png },
        { maxEdge: 64, overlapFraction: 1 },
      ),
    ).rejects.toThrow(/overlapFraction/);
    await expect(
      tileScreenshot(
        { displayId: "x", width: 100, height: 100, pngBytes: png },
        { maxEdge: 64, overlapFraction: -0.1 },
      ),
    ).rejects.toThrow(/overlapFraction/);
  });

  it("rejects a maxEdge below the minimum (64)", async () => {
    const png = await makePng(100, 100);
    await expect(
      tileScreenshot(
        { displayId: "x", width: 100, height: 100, pngBytes: png },
        { maxEdge: 16, overlapFraction: 0.1 },
      ),
    ).rejects.toThrow(/maxEdge/);
  });
});

describe("reconstructAbsoluteCoords", () => {
  function tile(opts: Partial<ScreenTile> = {}): ScreenTile {
    return {
      id: opts.id ?? "tile-1-2",
      displayId: opts.displayId ?? "primary",
      sourceX: opts.sourceX ?? 1280,
      sourceY: opts.sourceY ?? 720,
      sourceW: opts.sourceW ?? 1024,
      sourceH: opts.sourceH ?? 768,
      tileW: opts.tileW ?? 1024,
      tileH: opts.tileH ?? 768,
      pngBytes: opts.pngBytes ?? Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    };
  }

  it("adds tile origin to local coords", () => {
    const t = tile();
    expect(reconstructAbsoluteCoords(t, 0, 0)).toEqual({
      displayId: "primary",
      absoluteX: 1280,
      absoluteY: 720,
    });
    expect(reconstructAbsoluteCoords(t, 50, 100)).toEqual({
      displayId: "primary",
      absoluteX: 1330,
      absoluteY: 820,
    });
    expect(reconstructAbsoluteCoords(t, 1024, 768)).toEqual({
      displayId: "primary",
      absoluteX: 2304,
      absoluteY: 1488,
    });
  });

  it("rejects local coords outside the tile", () => {
    const t = tile({ tileW: 100, tileH: 100 });
    expect(() => reconstructAbsoluteCoords(t, -1, 0)).toThrow(/out of tile/);
    expect(() => reconstructAbsoluteCoords(t, 0, -1)).toThrow(/out of tile/);
    expect(() => reconstructAbsoluteCoords(t, 101, 0)).toThrow(/out of tile/);
    expect(() => reconstructAbsoluteCoords(t, 0, 101)).toThrow(/out of tile/);
  });

  it("rejects non-finite local coords", () => {
    const t = tile();
    expect(() =>
      reconstructAbsoluteCoords(t, Number.NaN, 0),
    ).toThrow(/finite/);
    expect(() =>
      reconstructAbsoluteCoords(t, 0, Number.POSITIVE_INFINITY),
    ).toThrow(/finite/);
  });
});

describe("tileScreenshot — defaults", () => {
  it("exports DEFAULT_MAX_EDGE in the Qwen3.5-VL sweet spot", () => {
    expect(DEFAULT_MAX_EDGE).toBeGreaterThanOrEqual(1024);
    expect(DEFAULT_MAX_EDGE).toBeLessThanOrEqual(1568);
  });
  it("exports a 12% default overlap", () => {
    expect(DEFAULT_OVERLAP_FRACTION).toBeCloseTo(0.12, 5);
  });
});
