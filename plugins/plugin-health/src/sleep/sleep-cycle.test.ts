/**
 * Sleep-cycle classification tests verify overnight, nap, and unknown labels
 * used by day-boundary anchoring and wake inference.
 */
import { describe, expect, it } from "vitest";
import { classifyLifeOpsSleepCycleType } from "./sleep-cycle.js";

const H = 3_600_000;
// UTC keeps local-hour thresholds deterministic.
const at = (hour: number, day = 1): number => Date.UTC(2024, 0, day, hour);
const UTC = "UTC";

describe("classifyLifeOpsSleepCycleType", () => {
  it("classifies a ≥4h evening-start sleep as overnight", () => {
    const start = at(23);
    expect(
      classifyLifeOpsSleepCycleType({
        startMs: start,
        endMs: start + 7 * H,
        nowMs: start + 8 * H,
        timezone: UTC,
      }),
    ).toBe("overnight");
  });

  it("classifies a ≥4h early-morning-start sleep as overnight", () => {
    const start = at(2); // startHour < 6
    expect(
      classifyLifeOpsSleepCycleType({
        startMs: start,
        endMs: start + 5 * H,
        nowMs: start + 6 * H,
        timezone: UTC,
      }),
    ).toBe("overnight");
  });

  it("classifies a ≥4h sleep that ends by 11:00 as overnight (end-hour branch)", () => {
    // startHour 7 is neither ≥18 nor <6, so only endHour ≤ 11 can qualify it.
    expect(
      classifyLifeOpsSleepCycleType({
        startMs: at(7),
        endMs: at(11), // exactly 4h, ends at 11:00
        nowMs: at(12),
        timezone: UTC,
      }),
    ).toBe("overnight");
  });

  it("classifies a short daytime sleep as a nap", () => {
    const start = at(14);
    expect(
      classifyLifeOpsSleepCycleType({
        startMs: start,
        endMs: start + 1.5 * H,
        nowMs: start + 2 * H,
        timezone: UTC,
      }),
    ).toBe("nap");
  });

  it("classifies a long midday sleep that fits no rule as unknown", () => {
    expect(
      classifyLifeOpsSleepCycleType({
        startMs: at(12), // 12:00 → not ≥18, not <6
        endMs: at(17), // 17:00 → not ≤11; 5h duration
        nowMs: at(18),
        timezone: UTC,
      }),
    ).toBe("unknown");
  });

  it("treats a zero-duration interval as unknown", () => {
    const t = at(10);
    expect(
      classifyLifeOpsSleepCycleType({
        startMs: t,
        endMs: t,
        nowMs: t,
        timezone: UTC,
      }),
    ).toBe("unknown");
  });

  it("uses nowMs as the end when endMs is null (in-progress sleep)", () => {
    const start = at(22); // 22:00 → ≥18
    expect(
      classifyLifeOpsSleepCycleType({
        startMs: start,
        endMs: null,
        nowMs: start + 4 * H, // 4h so far
        timezone: UTC,
      }),
    ).toBe("overnight");
  });
});
