// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  classifyTimeBucket,
  resolveCurrentBucket,
} from "../src/activity-profile/analyzer.js";

/**
 * Time-bucket classification drives the owner activity profile (#8795) — which
 * part of the day a signal falls in. The boundaries are half-open ranges; an
 * off-by-one here mislabels every signal near a boundary.
 */

describe("classifyTimeBucket", () => {
  it("maps each hour to its half-open bucket", () => {
    expect(classifyTimeBucket(0)).toBe("LATE_NIGHT");
    expect(classifyTimeBucket(4)).toBe("LATE_NIGHT");
    expect(classifyTimeBucket(5)).toBe("EARLY_MORNING");
    expect(classifyTimeBucket(6)).toBe("EARLY_MORNING");
    expect(classifyTimeBucket(7)).toBe("MORNING");
    expect(classifyTimeBucket(9)).toBe("MORNING");
    expect(classifyTimeBucket(10)).toBe("MIDDAY");
    expect(classifyTimeBucket(13)).toBe("MIDDAY");
    expect(classifyTimeBucket(14)).toBe("AFTERNOON");
    expect(classifyTimeBucket(16)).toBe("AFTERNOON");
    expect(classifyTimeBucket(17)).toBe("EVENING");
    expect(classifyTimeBucket(20)).toBe("EVENING");
    expect(classifyTimeBucket(21)).toBe("NIGHT");
    expect(classifyTimeBucket(23)).toBe("NIGHT");
    // out-of-range guard
    expect(classifyTimeBucket(24)).toBe("LATE_NIGHT");
  });
});

describe("resolveCurrentBucket", () => {
  it("classifies the current hour in the owner timezone", () => {
    // 18:00 UTC → EVENING in UTC.
    expect(resolveCurrentBucket("UTC", new Date("2026-06-23T18:00:00Z"))).toBe(
      "EVENING",
    );
    // 18:00 UTC → 14:00 EDT → AFTERNOON in New York.
    expect(
      resolveCurrentBucket(
        "America/New_York",
        new Date("2026-06-23T18:00:00Z"),
      ),
    ).toBe("AFTERNOON");
    // 02:00 UTC → LATE_NIGHT.
    expect(resolveCurrentBucket("UTC", new Date("2026-06-23T02:00:00Z"))).toBe(
      "LATE_NIGHT",
    );
  });
});
