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

  it("requires blue strictly above brightness 90", () => {
    expect(classifyColor(0, 0, 91)).toBe("blue");
    expect(classifyColor(0, 0, 90)).toBe("other");
  });

  it("requires blue to dominate red and green by more than 30", () => {
    expect(classifyColor(60, 0, 95)).toBe("blue");
    expect(classifyColor(61, 0, 91)).toBe("other");
  });

  it("requires red strictly above 150 for orange", () => {
    expect(classifyColor(151, 100, 41)).toBe("orange");
    expect(classifyColor(150, 100, 40)).toBe("other");
  });

  it("requires green to beat blue by more than 15 for orange", () => {
    expect(classifyColor(220, 131, 115)).toBe("orange");
    expect(classifyColor(220, 130, 115)).toBe("other");
  });

  it("rejects orange when blue reaches 140", () => {
    expect(classifyColor(200, 160, 139)).toBe("orange");
    expect(classifyColor(200, 160, 140)).toBe("other");
  });

  it("keeps mildly tinted greys neutral below a spread of 20", () => {
    expect(classifyColor(135, 125, 130)).toBe("neutral");
    expect(classifyColor(109, 109, 129)).toBe("other");
  });

  it("never reads saturated brand colours as neutral", () => {
    expect(classifyColor(244, 81, 30)).toBe("orange");
    expect(classifyColor(0, 0, 255)).toBe("blue");
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

  it("rounds fractions to four decimals over a single pixel", () => {
    const buf = new Uint8Array([
      10,
      20,
      200, // blue
      120,
      122,
      121, // neutral
      120,
      122,
      121, // neutral
    ]);
    const f = colorFractionsFromRaw(buf, 3);
    expect(f.blue_fraction).toBe(0.3333);
    expect(f.neutral_fraction).toBe(0.6667);
  });

  it("counts other-classified pixels in the denominator only", () => {
    const buf = new Uint8Array([
      10,
      20,
      200, // blue
      100,
      200,
      80, // other
    ]);
    const f = colorFractionsFromRaw(buf, 3);
    expect(f).toEqual({
      blue_fraction: 0.5,
      orange_fraction: 0,
      neutral_fraction: 0,
    });
  });

  it("reads Node Buffer input the same as Uint8Array", () => {
    const buf = Buffer.from([10, 20, 200, 10, 20, 200]);
    const f = colorFractionsFromRaw(buf, 3);
    expect(f.blue_fraction).toBe(1);
    expect(f.orange_fraction).toBe(0);
    expect(f.neutral_fraction).toBe(0);
  });

  it("classifies a single solid pixel fully into its bucket", () => {
    const f = colorFractionsFromRaw(new Uint8Array([120, 122, 121]), 3);
    expect(f.neutral_fraction).toBe(1);
  });
});

describe("round4", () => {
  it("rounds to four decimals", () => {
    expect(round4(0.123456)).toBe(0.1235);
    expect(round4(0.5)).toBe(0.5);
  });

  it("collapses trailing zeros and underflows sub-half ten-thousandths", () => {
    expect(round4(1)).toBe(1);
    expect(round4(0.30001)).toBe(0.3);
    expect(round4(0.00004)).toBe(0);
  });
});
