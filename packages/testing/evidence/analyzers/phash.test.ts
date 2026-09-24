// Perceptual-hash stability on synthetic fixtures: identical frames hash to
// Hamming distance 0, a small crop of the same content stays within the
// same-screen threshold, and two clearly different screens diverge past it.
import { rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  hammingDistance,
  isSameScreen,
  medianOf,
  perceptualHash,
  SAME_SCREEN_THRESHOLD,
} from "./phash.ts";
import { gradientPng, makeTmpDir, solidPng, textPng } from "./test-fixtures.ts";

const dir = makeTmpDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("hammingDistance", () => {
  it("counts differing bits", () => {
    expect(hammingDistance("00", "00")).toBe(0);
    expect(hammingDistance("0f", "00")).toBe(4);
    expect(hammingDistance("ff", "00")).toBe(8);
  });
  it("rejects mismatched lengths", () => {
    expect(() => hammingDistance("00", "0000")).toThrow();
  });
});

describe("perceptualHash", () => {
  it("identical images yield distance 0", async () => {
    const a = await textPng(join(dir, "same-a.png"), "Sign in to Eliza");
    const b = await textPng(join(dir, "same-b.png"), "Sign in to Eliza");
    const ha = await perceptualHash(a);
    const hb = await perceptualHash(b);
    expect(hammingDistance(ha, hb)).toBe(0);
    expect(isSameScreen(ha, hb)).toBe(true);
  });

  it("minor crop of same render stays below same-screen threshold", async () => {
    const full = await textPng(
      join(dir, "full.png"),
      "Ask me anything",
      640,
      200,
    );
    const cropped = join(dir, "cropped.png");
    // Shave 12px off left and 4px off top, keep 95% of area: simulates a
    // realistic "same screen across runs" shift, not a large recompose.
    await sharp(full)
      .extract({ left: 12, top: 4, width: 616, height: 192 })
      .toFile(cropped);
    const distance = hammingDistance(
      await perceptualHash(full),
      await perceptualHash(cropped),
    );
    expect(distance).toBeLessThanOrEqual(SAME_SCREEN_THRESHOLD);
  });

  it("two different screens diverge past the threshold", async () => {
    const gradient = await gradientPng(join(dir, "grad.png"));
    const solid = await solidPng(join(dir, "solid.png"), [20, 20, 20]);
    const distance = hammingDistance(
      await perceptualHash(gradient),
      await perceptualHash(solid),
    );
    expect(distance).toBeGreaterThan(SAME_SCREEN_THRESHOLD);
  });

  it("computes medianOf safely with non-finite values and empty arrays", () => {
    expect(medianOf([NaN, 10, 5, 20])).toBe(10);
    expect(medianOf([NaN, Number.POSITIVE_INFINITY, 10, 20, 30, 40])).toBe(25);
    expect(medianOf([10, 20])).toBe(15);
    expect(medianOf([5])).toBe(5);
    expect(medianOf([])).toBe(0);
    expect(medianOf([NaN, NaN])).toBe(0);
  });
});
