/**
 * Tests for `dirty-tile-scene` — the wiring seam that turns a changed tile
 * into one IMAGE_DESCRIPTION model call.
 *
 * Core contract: `tilePngToImageUrl` must produce a data URL the VLM can
 * fetch (base64 PNG prefix, round-trippable bytes), and `createTileDescribeFn`
 * must funnel every changed tile through URL → prompt → model → extractor,
 * degrading a null extractor result to an empty description instead of
 * propagating it.
 */

import { describe, expect, it } from "vitest";
import {
  createTileDescribeFn,
  type TileDescribeDeps,
  tilePngToImageUrl,
} from "./dirty-tile-scene";
import type { ScreenTile } from "./screen-tiler";

function makeTile(png: Buffer): ScreenTile {
  return {
    id: "tile-0-0",
    displayId: "display-1",
    sourceX: 0,
    sourceY: 0,
    sourceW: 100,
    sourceH: 100,
    tileW: 100,
    tileH: 100,
    pngBytes: png,
  };
}

function makeDeps(
  overrides: Partial<TileDescribeDeps> = {},
): TileDescribeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    buildTileImageUrl: (tile) => {
      calls.push(`url:${tile.id}`);
      return "data:image/png;base64,AAAA";
    },
    buildTilePrompt: async (tile) => {
      calls.push(`prompt:${tile.id}`);
      return `describe ${tile.id}`;
    },
    invokeModel: async (imageUrl, prompt) => {
      calls.push(`model:${imageUrl}:${prompt}`);
      return "raw-result";
    },
    extractDescription: (result) => {
      calls.push(`extract:${String(result)}`);
      return "the screen shows a button";
    },
    ...overrides,
  };
}

describe("tilePngToImageUrl", () => {
  it("encodes tile bytes as a base64 PNG data URL", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const url = tilePngToImageUrl(makeTile(png));

    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    // The encoded payload decodes back to the exact source bytes.
    const payload = url.slice("data:image/png;base64,".length);
    expect(Buffer.from(payload, "base64")).toEqual(png);
  });

  it("handles empty PNG bytes", () => {
    const url = tilePngToImageUrl(makeTile(Buffer.alloc(0)));
    expect(url).toBe("data:image/png;base64,");
  });
});

describe("createTileDescribeFn", () => {
  it("routes a tile through url, prompt, model, then extractor", async () => {
    const deps = makeDeps();
    const describe = createTileDescribeFn(deps);
    const tile = makeTile(Buffer.from("png"));

    const result = await describe(tile);

    expect(result).toBe("the screen shows a button");
    expect(deps.calls).toEqual([
      "url:tile-0-0",
      "prompt:tile-0-0",
      "model:data:image/png;base64,AAAA:describe tile-0-0",
      "extract:raw-result",
    ]);
  });

  it("returns the description produced by the extractor", async () => {
    const deps = makeDeps({
      extractDescription: () => "a login form",
    });
    const describe = createTileDescribeFn(deps);

    expect(await describe(makeTile(Buffer.from("png")))).toBe("a login form");
  });

  it("degrades a null extractor result to an empty description", async () => {
    const deps = makeDeps({
      extractDescription: () => null,
    });
    const describe = createTileDescribeFn(deps);

    expect(await describe(makeTile(Buffer.from("png")))).toBe("");
  });

  it("uses the caller-supplied image URL builder", async () => {
    const deps = makeDeps({
      buildTileImageUrl: (tile) => `custom://${tile.id}`,
      extractDescription: () => null,
    });
    const describe = createTileDescribeFn(deps);

    const result = await describe(makeTile(Buffer.from("png")));
    expect(result).toBe("");
    expect(
      deps.calls.some((c) => c.startsWith("model:custom://tile-0-0:")),
    ).toBe(true);
  });

  it("awaits an async prompt builder before invoking the model", async () => {
    let resolved = false;
    const deps = makeDeps({
      buildTilePrompt: async () => {
        await new Promise((r) => setTimeout(r, 5));
        resolved = true;
        return "late-prompt";
      },
      extractDescription: () => null,
    });
    const describe = createTileDescribeFn(deps);

    await describe(makeTile(Buffer.from("png")));
    expect(resolved).toBe(true);
    expect(deps.calls.some((c) => c.includes("late-prompt"))).toBe(true);
  });
});
