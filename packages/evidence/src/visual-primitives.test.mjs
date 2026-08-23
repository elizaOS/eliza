/**
 * Tests deterministic CSS color parsing, including long invalid numeric tokens,
 * and the deterministic ordering contract of `quantizePalette` when several
 * quantized bins share the same pixel count.
 */

import { describe, expect, it } from "vitest";
import { parseRgb } from "./visual-color-parser.mjs";
import { quantizePalette } from "./visual-primitives.mjs";

describe("parseRgb", () => {
  it("parses rgb and rgba components", () => {
    expect(parseRgb("rgb(1, 2, 3)")).toEqual([1, 2, 3, 1]);
    expect(parseRgb("rgba(1.5,2,3,0.5)")).toEqual([1.5, 2, 3, 0.5]);
  });

  it("rejects a 100k-character malformed component in linear time", () => {
    expect(parseRgb(`rgb(${"0".repeat(100_000)}x,0,0)`)).toBeNull();
  });
});

describe("quantizePalette", () => {
  it("breaks equal-count ties on r, then g, then b instead of insertion order", () => {
    // Four opaque pixels, each landing in its own bin with count 1. They are
    // written in an order that is the exact reverse of the required rgb order,
    // so insertion-dependent ordering is distinguishable from the tie-break.
    const data = Uint8Array.from([
      200,
      0,
      0,
      255, // bin { r: 200, g: 8, b: 8 }
      0,
      200,
      0,
      255, // bin { r: 8, g: 200, b: 8 }
      0,
      0,
      200,
      255, // bin { r: 8, g: 8, b: 200 }
      0,
      0,
      0,
      255, // bin { r: 8, g: 8, b: 8 }
    ]);

    const { swatches } = quantizePalette(data);

    expect(swatches.map((s) => s.count)).toEqual([1, 1, 1, 1]);
    expect(swatches.map((s) => s.rgb)).toEqual([
      [8, 8, 8],
      [8, 8, 200],
      [8, 200, 8],
      [200, 8, 8],
    ]);
  });

  it("still orders by coverage before applying the rgb tie-break", () => {
    const data = Uint8Array.from([
      0,
      0,
      0,
      255, // { r: 8, g: 8, b: 8 }
      200,
      0,
      0,
      255, // { r: 200, g: 8, b: 8 }
      200,
      0,
      0,
      255,
    ]);

    const { swatches } = quantizePalette(data);

    expect(swatches.map((s) => s.rgb)).toEqual([
      [200, 8, 8],
      [8, 8, 8],
    ]);
  });
});
