import { describe, expect, it } from "vitest";
import { classifyColor, colorFractionsFromRaw, round4 } from "../color-math.ts";

describe("classifyColor", () => {
  it("classifies blue when blue dominates", () => {
    expect(classifyColor(10, 20, 200)).toBe("blue");
    expect(classifyColor(50, 60, 120)).toBe("blue");
  });

  it("classifies orange for warm high-red colours", () => {
    expect(classifyColor(220, 120, 40)).toBe("orange");
    expect(classifyColor(180, 100, 60)).toBe("orange");
  });

  it("classifies neutral for low channel spread", () => {
    expect(classifyColor(120, 122, 121)).toBe("neutral");
    expect(classifyColor(30, 30, 30)).toBe("neutral");
  });

  it("classifies everything else as other", () => {
    expect(classifyColor(100, 200, 80)).toBe("other");
    expect(classifyColor(0, 150, 0)).toBe("other");
  });
});

describe("colorFractionsFromRaw", () => {
  it("computes fractions over an RGB buffer", () => {
    const buf = new Uint8Array([
      10,
      20,
      200, // blue
      220,
      120,
      40, // orange
      120,
      122,
      121, // neutral
      100,
      200,
      80, // other
    ]);
    const f = colorFractionsFromRaw(buf, 3);
    expect(f.blue_fraction).toBe(0.25);
    expect(f.orange_fraction).toBe(0.25);
    expect(f.neutral_fraction).toBe(0.25);
  });

  it("handles RGBA buffers ignoring alpha", () => {
    const buf = new Uint8Array([
      10,
      20,
      200,
      255, // blue
      220,
      120,
      40,
      0, // orange
    ]);
    const f = colorFractionsFromRaw(buf, 4);
    expect(f.blue_fraction).toBe(0.5);
    expect(f.orange_fraction).toBe(0.5);
  });

  it("handles an empty buffer", () => {
    const f = colorFractionsFromRaw(new Uint8Array(0), 3);
    expect(f).toEqual({
      blue_fraction: 0,
      orange_fraction: 0,
      neutral_fraction: 0,
    });
  });
});

describe("round4", () => {
  it("rounds to four decimals", () => {
    expect(round4(0.123456)).toBe(0.1235);
    expect(round4(0.5)).toBe(0.5);
  });
});
