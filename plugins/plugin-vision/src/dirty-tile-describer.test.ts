/**
 * DirtyTileDescriber — change-gated per-tile description (#9105 M3).
 *
 * Asserts:
 *   - an unchanged frame re-describes nothing (all tiles served from cache);
 *   - the token counters reflect the saving;
 *   - a changed tile IS re-described while its unchanged neighbours are not;
 *   - the composed vlm_scene / vlm_elements carry the described tiles.
 *
 * Host-mockable: the per-tile hash and the per-tile describe call are injected,
 * so there is no model and no native dHash in play.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  APPROX_TOKENS_PER_TILE,
  DirtyTileDescriber,
} from "./dirty-tile-describer";

type Rgb = [number, number, number];
type QuadrantColors = [Rgb, Rgb, Rgb, Rgb];

/** A four-quadrant PNG so a >maxEdge frame tiles into a real grid. */
async function makeQuadrantPng(
  edge: number,
  colors: QuadrantColors,
): Promise<Buffer> {
  const half = Math.floor(edge / 2);
  const [tl, tr, bl, br] = colors;
  const tile = async (c: Rgb): Promise<Buffer> =>
    sharp({
      create: {
        width: half,
        height: half,
        channels: 3,
        background: { r: c[0], g: c[1], b: c[2] },
      },
    })
      .png()
      .toBuffer();
  const top = await sharp({
    create: { width: edge, height: half, channels: 3, background: bgOf(tl) },
  })
    .composite([
      { input: await tile(tl), left: 0, top: 0 },
      { input: await tile(tr), left: half, top: 0 },
    ])
    .png()
    .toBuffer();
  const bottom = await sharp({
    create: { width: edge, height: half, channels: 3, background: bgOf(bl) },
  })
    .composite([
      { input: await tile(bl), left: 0, top: 0 },
      { input: await tile(br), left: half, top: 0 },
    ])
    .png()
    .toBuffer();
  return sharp({
    create: { width: edge, height: edge, channels: 3, background: bgOf(tl) },
  })
    .composite([
      { input: top, left: 0, top: 0 },
      { input: bottom, left: 0, top: half },
    ])
    .png()
    .toBuffer();
}

function bgOf(c: [number, number, number]): {
  r: number;
  g: number;
  b: number;
} {
  return { r: c[0], g: c[1], b: c[2] };
}

/** Deterministic 64-bit FNV-1a over the tile bytes: identical tiles hash equal. */
function contentHash(png: Buffer): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < png.length; i += 1) {
    h = (h ^ BigInt(png[i] ?? 0)) & mask;
    h = (h * prime) & mask;
  }
  return h;
}

const EDGE = 256;
const MAX_EDGE = 128; // forces a 2x2 tile grid

function makeDescriber(): {
  describer: DirtyTileDescriber;
  describeCalls: () => number;
  describedIds: () => string[];
} {
  let calls = 0;
  const ids: string[] = [];
  const describer = new DirtyTileDescriber({
    hashTile: (png) => contentHash(png),
    describeTile: async (tile) => {
      calls += 1;
      ids.push(tile.id);
      return `desc:${tile.id}`;
    },
    maxEdge: MAX_EDGE,
  });
  return {
    describer,
    describeCalls: () => calls,
    describedIds: () => ids,
  };
}

describe("DirtyTileDescriber (M3)", () => {
  it("describes every tile on the first frame", async () => {
    const png = await makeQuadrantPng(EDGE, [
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120],
    ]);
    const { describer, describeCalls } = makeDescriber();
    const out = await describer.describe({
      displayId: 0,
      width: EDGE,
      height: EDGE,
      pngBytes: png,
    });
    expect(out.tiles).toHaveLength(4);
    expect(describeCalls()).toBe(4);
    expect(out.tiles.every((t) => !t.cached)).toBe(true);
    expect(out.vlmScene.split("\n")).toHaveLength(4);
    expect(out.elements).toHaveLength(4);
    expect(describer.getStats().tilesDescribed).toBe(4);
    expect(describer.getStats().tilesSkipped).toBe(0);
  });

  it("skips the describe call for an unchanged frame (cache + counters prove the saving)", async () => {
    const colors: QuadrantColors = [
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120],
    ];
    const png1 = await makeQuadrantPng(EDGE, colors);
    const png2 = await makeQuadrantPng(EDGE, colors); // identical pixels
    const { describer, describeCalls } = makeDescriber();
    await describer.describe({
      displayId: 0,
      width: EDGE,
      height: EDGE,
      pngBytes: png1,
    });
    const second = await describer.describe({
      displayId: 0,
      width: EDGE,
      height: EDGE,
      pngBytes: png2,
    });
    // No new describe calls on the second, identical frame.
    expect(describeCalls()).toBe(4);
    expect(second.tiles.every((t) => t.cached)).toBe(true);
    const stats = describer.getStats();
    expect(stats.tilesDescribed).toBe(4); // only the first frame
    expect(stats.tilesSkipped).toBe(4); // all four reused
    expect(stats.describeCallsSaved).toBe(4);
    expect(stats.approxTokensSaved).toBe(4 * APPROX_TOKENS_PER_TILE);
  });

  it("re-describes only the changed tile, reusing the rest", async () => {
    const base: QuadrantColors = [
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120],
    ];
    // Change only the bottom-right quadrant (tile-1-1) on the second frame.
    const changed: QuadrantColors = [
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [200, 210, 220],
    ];
    const png1 = await makeQuadrantPng(EDGE, base);
    const png2 = await makeQuadrantPng(EDGE, changed);
    const { describer, describeCalls, describedIds } = makeDescriber();
    await describer.describe({
      displayId: 0,
      width: EDGE,
      height: EDGE,
      pngBytes: png1,
    });
    const second = await describer.describe({
      displayId: 0,
      width: EDGE,
      height: EDGE,
      pngBytes: png2,
    });
    // Exactly one extra describe call (the changed tile).
    expect(describeCalls()).toBe(5);
    const reDescribed = describedIds().slice(4);
    expect(reDescribed).toEqual(["tile-1-1"]);
    const changedTile = second.tiles.find((t) => t.id === "tile-1-1");
    expect(changedTile?.cached).toBe(false);
    const unchanged = second.tiles.filter((t) => t.id !== "tile-1-1");
    expect(unchanged.every((t) => t.cached)).toBe(true);
    expect(describer.getStats().tilesSkipped).toBe(3); // 3 reused on frame 2
  });
});
