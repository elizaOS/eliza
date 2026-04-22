import { describe, expect, it } from "vitest";
import { computeSleepRegularity } from "../src/lifeops/sleep-regularity.js";

describe("sleep regularity", () => {
  it("classifies a stable schedule as regular", () => {
    const episodes = Array.from({ length: 10 }, (_, index) => ({
      startAt: new Date(Date.parse("2026-04-01T23:00:00.000Z") + index * 24 * 60 * 60 * 1_000).toISOString(),
      endAt: new Date(Date.parse("2026-04-02T07:00:00.000Z") + index * 24 * 60 * 60 * 1_000).toISOString(),
      cycleType: "overnight" as const,
    }));
    const regularity = computeSleepRegularity({
      episodes,
      timezone: "UTC",
      nowMs: Date.parse("2026-04-20T12:00:00.000Z"),
    });

    expect(regularity.sampleCount).toBeGreaterThanOrEqual(5);
    expect(regularity.regularityClass).toMatch(/regular/);
    expect(regularity.sri).toBeGreaterThan(70);
  });

  it("classifies sparse history as insufficient_data", () => {
    const regularity = computeSleepRegularity({
      episodes: [
        {
          startAt: "2026-04-18T23:00:00.000Z",
          endAt: "2026-04-19T07:00:00.000Z",
          cycleType: "overnight",
        },
      ],
      timezone: "UTC",
      nowMs: Date.parse("2026-04-20T12:00:00.000Z"),
    });

    expect(regularity.regularityClass).toBe("insufficient_data");
  });
});
