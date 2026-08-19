/**
 * Screenshot tiling tests for tile dimensions and absolute-coordinate recovery.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  MAX_SCREEN_TILES,
  reconstructAbsoluteCoords,
  type ScreenTile,
  tileScreenshot,
} from "./screen-tiler";

function expectPresent<T>(value: T | undefined, label: string): T {
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error(`Expected ${label} to be present`);
  }
  return value;
}

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
    const t = expectPresent(tiles[0], "single tile");
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
    const first = expectPresent(
      tiles.find((t) => t.id === "tile-0-0"),
      "tile-0-0",
    );
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
    const coversTopLeft = tiles.some((t) => t.sourceX === 0 && t.sourceY === 0);
    const coversBottomRight = tiles.some(
      (t) => t.sourceX + t.sourceW === 5120 && t.sourceY + t.sourceH === 2160,
    );
    expect(coversTopLeft).toBe(true);
    expect(coversBottomRight).toBe(true);
  });
});

describe("tileScreenshot — full source coverage (regression #22125)", () => {
  // A floored inter-tile stride advanced intermediate tiles too slowly while
  // the anchored last tile jumped to `width - tileWidth`, leaving a strip of
  // source columns/rows present in no tile. These sizes each opened such a gap
  // (e.g. width 5119 dropped source column 3838 entirely). Every source
  // column and row must land inside at least one tile's cropped rect.
  const cases: Array<{ width: number; height: number }> = [
    { width: 5119, height: 1440 },
    { width: 6399, height: 1440 },
    { width: 7679, height: 2160 },
    { width: 5120, height: 2160 },
  ];
  for (const { width, height } of cases) {
    it(`covers every source column and row for ${width}x${height}`, async () => {
      const png = await makePng(width, height);
      const tiles = await tileScreenshot(
        { displayId: "cov", width, height, pngBytes: png },
        { maxEdge: 1280, overlapFraction: 0.12 },
      );

      const colCovered = new Uint8Array(width);
      const rowCovered = new Uint8Array(height);
      for (const t of tiles) {
        // No tile may extend past the source bounds.
        expect(t.sourceX).toBeGreaterThanOrEqual(0);
        expect(t.sourceY).toBeGreaterThanOrEqual(0);
        expect(t.sourceX + t.sourceW).toBeLessThanOrEqual(width);
        expect(t.sourceY + t.sourceH).toBeLessThanOrEqual(height);
        for (let x = t.sourceX; x < t.sourceX + t.sourceW; x += 1) {
          colCovered[x] = 1;
        }
        for (let y = t.sourceY; y < t.sourceY + t.sourceH; y += 1) {
          rowCovered[y] = 1;
        }
      }

      const firstGapCol = [...colCovered].indexOf(0);
      const firstGapRow = [...rowCovered].indexOf(0);
      expect(
        firstGapCol,
        `source column ${firstGapCol} covered by no tile for ${width}x${height}`,
      ).toBe(-1);
      expect(
        firstGapRow,
        `source row ${firstGapRow} covered by no tile for ${width}x${height}`,
      ).toBe(-1);
    });
  }

  it("never leaves a gap between horizontally adjacent tiles", async () => {
    // At width 5119 four 1280px-max tiles span 5120px of capacity, so only 1px
    // of total slack is spread across three seams: positive overlap at every
    // seam is impossible without exceeding maxEdge. The guarantee the ceil
    // stride restores is that neighbours are contiguous-or-overlapping
    // (overlap >= 0), which is exactly "no source column falls between tiles".
    const width = 5119;
    const png = await makePng(width, 1440);
    const tiles = await tileScreenshot(
      { displayId: "cov", width, height: 1440, pngBytes: png },
      { maxEdge: 1280, overlapFraction: 0.12 },
    );
    const row0 = tiles
      .filter((t) => t.id.startsWith("tile-0-"))
      .sort((a, b) => a.sourceX - b.sourceX);
    expect(row0.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < row0.length; i += 1) {
      const prev = expectPresent(row0[i - 1], `tile-0-${i - 1}`);
      const cur = expectPresent(row0[i], `tile-0-${i}`);
      const overlap = prev.sourceX + prev.sourceW - cur.sourceX;
      expect(overlap).toBeGreaterThanOrEqual(0);
    }
  });

  it("never leaves a gap between vertically adjacent tiles", async () => {
    // Transpose the formerly failing 5119px axis into the vertical direction.
    // With floor(strideY), the third tile ends at row 3838 while the anchored
    // last tile starts at row 3839, leaving source row 3838 uncovered.
    const height = 5119;
    const png = await makePng(64, height);
    const tiles = await tileScreenshot(
      { displayId: "cov-vertical", width: 64, height, pngBytes: png },
      { maxEdge: 1280, overlapFraction: 0.12 },
    );
    const col0 = tiles.sort((a, b) => a.sourceY - b.sourceY);
    expect(col0).toHaveLength(4);

    const rowCovered = new Uint8Array(height);
    for (const tile of col0) {
      rowCovered.fill(1, tile.sourceY, tile.sourceY + tile.sourceH);
    }
    expect([...rowCovered].indexOf(0), "every source row is covered").toBe(-1);

    for (let i = 1; i < col0.length; i += 1) {
      const prev = expectPresent(col0[i - 1], `tile-${i - 1}-0`);
      const cur = expectPresent(col0[i], `tile-${i}-0`);
      const overlap = prev.sourceY + prev.sourceH - cur.sourceY;
      expect(overlap, `vertical seam before tile ${i}`).toBeGreaterThanOrEqual(
        0,
      );
    }
  });
});

describe("tileScreenshot — degenerate axes and extraction bounds", () => {
  const cases = [
    { width: 1, height: 65, maxEdge: 64, overlapFraction: 0 },
    { width: 1, height: 65, maxEdge: 64, overlapFraction: 0.99 },
    { width: 65, height: 1, maxEdge: 64, overlapFraction: 0 },
    { width: 65, height: 1, maxEdge: 64, overlapFraction: 0.99 },
    { width: 65, height: 65, maxEdge: 64, overlapFraction: 0 },
    { width: 127, height: 193, maxEdge: 64, overlapFraction: 0.37 },
    { width: 130, height: 257, maxEdge: 64, overlapFraction: 0.12 },
  ];

  it.each(cases)(
    "covers and extracts $width x $height at overlap $overlapFraction",
    async ({ width, height, maxEdge, overlapFraction }) => {
      const png = await makePng(width, height);
      const tiles = await tileScreenshot(
        { displayId: "bounds", width, height, pngBytes: png },
        { maxEdge, overlapFraction },
      );
      const expectedCols = Math.ceil(width / maxEdge);
      const expectedRows = Math.ceil(height / maxEdge);
      expect(tiles).toHaveLength(expectedCols * expectedRows);

      const colCovered = new Uint8Array(width);
      const rowCovered = new Uint8Array(height);
      for (const tile of tiles) {
        expect(Number.isInteger(tile.sourceX)).toBe(true);
        expect(Number.isInteger(tile.sourceY)).toBe(true);
        expect(Number.isInteger(tile.sourceW)).toBe(true);
        expect(Number.isInteger(tile.sourceH)).toBe(true);
        expect(tile.sourceX).toBeGreaterThanOrEqual(0);
        expect(tile.sourceY).toBeGreaterThanOrEqual(0);
        expect(tile.sourceW).toBeGreaterThan(0);
        expect(tile.sourceH).toBeGreaterThan(0);
        expect(tile.sourceX + tile.sourceW).toBeLessThanOrEqual(width);
        expect(tile.sourceY + tile.sourceH).toBeLessThanOrEqual(height);
        expect(tile.sourceW).toBeLessThanOrEqual(maxEdge);
        expect(tile.sourceH).toBeLessThanOrEqual(maxEdge);
        await expect(dimsOf(tile.pngBytes)).resolves.toEqual({
          width: tile.sourceW,
          height: tile.sourceH,
        });
        colCovered.fill(1, tile.sourceX, tile.sourceX + tile.sourceW);
        rowCovered.fill(1, tile.sourceY, tile.sourceY + tile.sourceH);
      }

      expect([...colCovered]).not.toContain(0);
      expect([...rowCovered]).not.toContain(0);
    },
  );
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
    const a = expectPresent(
      row0.find((t) => t.id === "tile-0-0"),
      "tile-0-0",
    );
    const b = expectPresent(
      row0.find((t) => t.id === "tile-0-1"),
      "tile-0-1",
    );
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

  it("fails closed on a hostile width/height that would emit tens of thousands of tiles", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const started = performance.now();
    await expect(
      tileScreenshot(
        { displayId: "x", width: 20_000, height: 20_000, pngBytes: png },
        { maxEdge: 64, overlapFraction: 0 },
      ),
    ).rejects.toThrow(new RegExp(`exceeds ${MAX_SCREEN_TILES}`));
    expect(performance.now() - started).toBeLessThan(50);
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
    expect(() => reconstructAbsoluteCoords(t, Number.NaN, 0)).toThrow(/finite/);
    expect(() =>
      reconstructAbsoluteCoords(t, 0, Number.POSITIVE_INFINITY),
    ).toThrow(/finite/);
  });
});
