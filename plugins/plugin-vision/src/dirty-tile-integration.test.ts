/**
 * Dirty-tile scene-describe integration (#9105 efficiency).
 *
 * Proves the wiring `VisionService` uses end-to-end: a `DirtyTileDescriber`
 * built from `createTileDescribeFn` — the real per-tile describe factory the
 * service injects — driving a stub IMAGE_DESCRIPTION model. Two frames that
 * differ in exactly ONE quadrant must re-describe only the changed tile; the
 * unchanged tiles reuse their cached description.
 *
 * This drives the production seam — the same `createTileDescribeFn` +
 * `tilePngToImageUrl` + `DirtyTileDescriber` composition the service builds —
 * not a re-implementation of it, so a regression in the factory, the data-URL
 * encoder, or the describer surfaces here. The injected tile hash is a
 * deterministic content hash (identical pixels hash equal); the production hash
 * (`frameDhash`) is exercised by plugin-computeruse's own dHash tests.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DirtyTileDescriber } from "./dirty-tile-describer";
import { createTileDescribeFn, tilePngToImageUrl } from "./dirty-tile-scene";

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
const MAX_EDGE = 128; // forces a 2x2 tile grid like the screen tiler at scale

/** Solid-color PNG used to compose quadrants. */
async function solid(
  w: number,
  h: number,
  c: [number, number, number],
): Promise<Buffer> {
  return sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: c[0], g: c[1], b: c[2] },
    },
  })
    .png()
    .toBuffer();
}

/** A four-quadrant PNG so a >maxEdge frame tiles into a real 2x2 grid. */
async function makeQuadrantPng(
  edge: number,
  colors: [number, number, number][],
): Promise<Buffer> {
  const half = Math.floor(edge / 2);
  const top = await sharp({
    create: {
      width: edge,
      height: half,
      channels: 3,
      background: bg(colors[0]),
    },
  })
    .composite([
      { input: await solid(half, half, colors[0]), left: 0, top: 0 },
      { input: await solid(half, half, colors[1]), left: half, top: 0 },
    ])
    .png()
    .toBuffer();
  const bottom = await sharp({
    create: {
      width: edge,
      height: half,
      channels: 3,
      background: bg(colors[2]),
    },
  })
    .composite([
      { input: await solid(half, half, colors[2]), left: 0, top: 0 },
      { input: await solid(half, half, colors[3]), left: half, top: 0 },
    ])
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: edge,
      height: edge,
      channels: 3,
      background: bg(colors[0]),
    },
  })
    .composite([
      { input: top, left: 0, top: 0 },
      { input: bottom, left: 0, top: half },
    ])
    .png()
    .toBuffer();
}

function bg(c: [number, number, number]): { r: number; g: number; b: number } {
  return { r: c[0], g: c[1], b: c[2] };
}

interface WiredDescriber {
  describer: DirtyTileDescriber;
  describeCalls: () => number;
  describedIds: () => string[];
  imageUrls: () => string[];
  prompts: () => string[];
}

/**
 * Build a describer wired the way `VisionService.ensureDirtyTileDescriber`
 * does: the real `createTileDescribeFn` factory for the per-tile describe, plus
 * a deterministic content hash standing in for the production `frameDhash`. The
 * model call is a stub that records what it was asked to describe.
 */
function wireDescriber(): WiredDescriber {
  let calls = 0;
  const ids: string[] = [];
  const urls: string[] = [];
  const prompts: string[] = [];
  const describeTile = createTileDescribeFn({
    buildTileImageUrl: tilePngToImageUrl,
    buildTilePrompt: async (tile) => `describe ${tile.id}`,
    invokeModel: async (imageUrl, prompt) => {
      calls += 1;
      urls.push(imageUrl);
      prompts.push(prompt);
      // The factory tags the call by id via the prompt; echo a stable text.
      return { description: prompt.replace("describe ", "desc:") };
    },
    extractDescription: (result) => {
      if (
        typeof result === "object" &&
        result !== null &&
        "description" in result
      ) {
        const d = (result as { description?: unknown }).description;
        if (typeof d === "string") return d;
      }
      return null;
    },
  });
  const describer = new DirtyTileDescriber({
    hashTile: (png) => contentHash(png),
    describeTile: async (tile) => {
      ids.push(tile.id);
      return describeTile(tile);
    },
    maxEdge: MAX_EDGE,
  });
  return {
    describer,
    describeCalls: () => calls,
    describedIds: () => ids,
    imageUrls: () => urls,
    prompts: () => prompts,
  };
}

describe("dirty-tile scene-describe integration (#9105)", () => {
  it("describes every tile on the first frame, then nothing on an identical frame", async () => {
    const colors: [number, number, number][] = [
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120],
    ];
    const png1 = await makeQuadrantPng(EDGE, colors);
    const png2 = await makeQuadrantPng(EDGE, colors); // identical pixels
    const { describer, describeCalls } = wireDescriber();

    const first = await describer.describe({
      displayId: 0,
      width: EDGE,
      height: EDGE,
      pngBytes: png1,
    });
    expect(first.tiles).toHaveLength(4);
    expect(describeCalls()).toBe(4);
    expect(first.tiles.every((t) => !t.cached)).toBe(true);

    const second = await describer.describe({
      displayId: 0,
      width: EDGE,
      height: EDGE,
      pngBytes: png2,
    });
    // No new model calls on the identical frame — every tile reused from cache.
    expect(describeCalls()).toBe(4);
    expect(second.tiles.every((t) => t.cached)).toBe(true);
    const stats = describer.getStats();
    expect(stats.tilesDescribed).toBe(4);
    expect(stats.tilesSkipped).toBe(4);
    expect(stats.describeCallsSaved).toBe(4);
    expect(stats.approxTokensSaved).toBeGreaterThan(0);
  });

  it("re-describes ONLY the changed tile and reuses the cache for the rest", async () => {
    const base: [number, number, number][] = [
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120],
    ];
    // Flip only the bottom-right quadrant (tile-1-1) on the second frame.
    const changed: [number, number, number][] = [
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [220, 30, 240],
    ];
    const png1 = await makeQuadrantPng(EDGE, base);
    const png2 = await makeQuadrantPng(EDGE, changed);
    const { describer, describeCalls, describedIds, imageUrls, prompts } =
      wireDescriber();

    const first = await describer.describe({
      displayId: 0,
      width: EDGE,
      height: EDGE,
      pngBytes: png1,
    });
    const tileCount = first.tiles.length;
    expect(tileCount).toBe(4);
    expect(describeCalls()).toBe(tileCount); // full describe on frame 1

    const second = await describer.describe({
      displayId: 0,
      width: EDGE,
      height: EDGE,
      pngBytes: png2,
    });

    const stats = describer.getStats();
    // The efficiency win: far fewer describe calls than tiles across both
    // frames, and most tiles served from cache on the incremental update.
    expect(describeCalls()).toBeLessThan(tileCount * 2);
    expect(stats.tilesSkipped).toBeGreaterThan(0);

    // Exactly one extra describe call on the incremental frame: the dirty tile.
    expect(describeCalls()).toBe(tileCount + 1);
    const reDescribed = describedIds().slice(tileCount);
    expect(reDescribed).toEqual(["tile-1-1"]);

    const changedTile = second.tiles.find((t) => t.id === "tile-1-1");
    expect(changedTile?.cached).toBe(false);
    const unchanged = second.tiles.filter((t) => t.id !== "tile-1-1");
    expect(unchanged.every((t) => t.cached)).toBe(true);
    expect(stats.tilesSkipped).toBe(tileCount - 1); // 3 reused on frame 2

    // The re-describe went through the real factory: a per-tile PNG data URL
    // and a per-tile prompt for the changed tile.
    const lastUrl = imageUrls()[imageUrls().length - 1] ?? "";
    expect(lastUrl.startsWith("data:image/png;base64,")).toBe(true);
    const lastPrompt = prompts()[prompts().length - 1] ?? "";
    expect(lastPrompt).toBe("describe tile-1-1");

    // The composed scene reflects the re-described tile's fresh text.
    expect(second.vlmScene).toContain("desc:tile-1-1");
  });
});
