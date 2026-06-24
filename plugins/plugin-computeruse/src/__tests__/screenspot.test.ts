/**
 * ScreenSpot grounding harness (#9170 M14).
 *
 * Pure point-in-bbox scoring + the harness fold, exercised with synthetic
 * samples and fake grounders (no dataset, no model).
 */

import { describe, expect, it } from "vitest";
import {
  pointInBbox,
  type ScreenSpotSample,
  scoreScreenSpot,
} from "../parity/screenspot.js";

describe("pointInBbox", () => {
  it("is true inside and on the edges, false outside", () => {
    expect(pointInBbox({ x: 50, y: 50 }, [0, 0, 100, 100])).toBe(true);
    expect(pointInBbox({ x: 0, y: 0 }, [0, 0, 100, 100])).toBe(true);
    expect(pointInBbox({ x: 100, y: 100 }, [0, 0, 100, 100])).toBe(true);
    expect(pointInBbox({ x: 101, y: 50 }, [0, 0, 100, 100])).toBe(false);
    expect(pointInBbox({ x: -1, y: 50 }, [0, 0, 100, 100])).toBe(false);
  });
});

const SAMPLES: ScreenSpotSample[] = [
  {
    id: "icon-1",
    instruction: "click settings",
    bbox: [10, 10, 40, 40],
    imageWidth: 800,
    imageHeight: 600,
    group: "icon",
  },
  {
    id: "text-1",
    instruction: "click Save",
    bbox: [200, 100, 80, 24],
    imageWidth: 800,
    imageHeight: 600,
    group: "text",
  },
];

describe("scoreScreenSpot", () => {
  it("scores 100% for a grounder that hits every bbox center", async () => {
    const score = await scoreScreenSpot(SAMPLES, (s) => ({
      x: s.bbox[0] + s.bbox[2] / 2,
      y: s.bbox[1] + s.bbox[3] / 2,
    }));
    expect(score.accuracy).toBe(1);
    expect(score.correct).toBe(2);
    expect(score.byGroup.icon?.accuracy).toBe(1);
    expect(score.byGroup.text?.accuracy).toBe(1);
  });

  it("scores 0% for a grounder that always misses", async () => {
    const score = await scoreScreenSpot(SAMPLES, () => ({ x: 9999, y: 9999 }));
    expect(score.accuracy).toBe(0);
    expect(score.correct).toBe(0);
  });

  it("counts a null (abstain) prediction as wrong", async () => {
    const score = await scoreScreenSpot(SAMPLES, (s) =>
      s.id === "icon-1" ? { x: s.bbox[0] + 1, y: s.bbox[1] + 1 } : null,
    );
    expect(score.correct).toBe(1);
    expect(score.total).toBe(2);
    expect(score.accuracy).toBe(0.5);
    expect(score.results.find((r) => r.id === "text-1")?.predicted).toBeNull();
  });

  it("handles an empty sample set", async () => {
    const score = await scoreScreenSpot([], () => ({ x: 0, y: 0 }));
    expect(score.total).toBe(0);
    expect(score.accuracy).toBe(0);
  });
});
