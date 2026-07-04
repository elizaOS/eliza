/**
 * Screenshot quality tests pin the pure classifier that guards real-driver
 * screenshot evidence lanes from empty or visually blank PNG captures.
 *
 * Synthetic metrics lock the empty floor, single-color rule, and dominant-color
 * threshold without depending on live display capture.
 */
import { describe, expect, it } from "vitest";
import {
  type ScreenshotQuality,
  screenshotQualityIssues,
} from "./screenshot-quality";

const quality = (o: Partial<ScreenshotQuality>): ScreenshotQuality => ({
  width: 100,
  height: 100,
  sampledPixels: 10_000,
  colorBuckets: 500,
  dominantRatio: 0.2,
  ...o,
});

describe("screenshotQualityIssues", () => {
  it("flags an empty screenshot", () => {
    const issues = screenshotQualityIssues(
      "shot",
      quality({ width: 0, height: 0, sampledPixels: 0, colorBuckets: 0 }),
    );
    expect(issues).toContain("shot: screenshot is empty");
  });

  it("flags a single-color screenshot without also flagging 'effectively one color'", () => {
    const issues = screenshotQualityIssues(
      "shot",
      quality({ colorBuckets: 1, dominantRatio: 1 }),
    );
    expect(issues).toContain("shot: screenshot is one color");
    expect(issues.some((i) => i.includes("effectively one color"))).toBe(false);
  });

  it("flags 'effectively one color' only above the 0.995 dominance boundary", () => {
    const over = screenshotQualityIssues(
      "shot",
      quality({ colorBuckets: 2, dominantRatio: 0.996 }),
    );
    expect(over.some((i) => i.includes("effectively one color"))).toBe(true);

    // 0.99 is below the 0.995 cutoff → not flagged.
    const under = screenshotQualityIssues(
      "shot",
      quality({ colorBuckets: 2, dominantRatio: 0.99 }),
    );
    expect(under).toEqual([]);
  });

  it("returns no issues for a healthy multi-color screenshot", () => {
    expect(
      screenshotQualityIssues(
        "shot",
        quality({ colorBuckets: 500, dominantRatio: 0.2 }),
      ),
    ).toEqual([]);
  });
});
