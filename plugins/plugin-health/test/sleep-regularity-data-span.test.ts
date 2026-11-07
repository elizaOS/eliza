import { describe, expect, it } from "vitest";
import {
  computePersonalBaseline,
  computeSleepRegularity,
} from "../src/sleep/sleep-regularity.js";

const nowMs = Date.parse("2026-10-10T12:00:00Z");

function nights(bedOffsetsMin: number[]) {
  return bedOffsetsMin.map((offset, i) => {
    const bed =
      Date.parse("2026-10-09T23:00:00Z") - i * 86_400_000 + offset * 60_000;
    return {
      startAt: new Date(bed).toISOString(),
      endAt: new Date(bed + 7 * 3_600_000).toISOString(),
      cycleType: "overnight" as const,
    };
  });
}

describe("computeSleepRegularity data span", () => {
  it("scores a short history the same whatever the window length", () => {
    // Six nights, bedtime alternating 21:35 and 00:25.
    const episodes = nights([-85, 85, -85, 85, -85, 85]);
    const short = computeSleepRegularity({
      episodes,
      timezone: "UTC",
      nowMs,
      windowDays: 6,
    });
    const long = computeSleepRegularity({
      episodes,
      timezone: "UTC",
      nowMs,
      windowDays: 28,
    });
    expect(long.sri).toBe(short.sri);
    expect(long.regularityClass).toBe("irregular");
  });

  it("keeps a steady short history very regular", () => {
    const result = computeSleepRegularity({
      episodes: nights([0, 0, 0, 0, 0, 0]),
      timezone: "UTC",
      nowMs,
    });
    expect(result.regularityClass).toBe("very_regular");
  });

  it("leaves out nights older than the window", () => {
    // The last 28 nights start at 23:00; the 32 nights before them at 03:00.
    const recent = nights(Array(28).fill(0));
    const history = [...recent, ...nights(Array(60).fill(240)).slice(28)];
    const args = { timezone: "UTC", nowMs, windowDays: 28 };
    expect(computeSleepRegularity({ ...args, episodes: history })).toEqual(
      computeSleepRegularity({ ...args, episodes: recent }),
    );
    expect(computePersonalBaseline({ ...args, episodes: history })).toEqual(
      computePersonalBaseline({ ...args, episodes: recent }),
    );
  });
});
