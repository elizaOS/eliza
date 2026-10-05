import { describe, expect, it } from "vitest";
import { describeCronSchedule } from "./humanize.ts";
import { computeNextCronRunAtMs } from "./scheduling.ts";

function gapMinutes(expression: string, fires: number): number[] {
  let cursor = Date.parse("2026-01-01T23:00:00Z");
  const gaps: number[] = [];
  for (let i = 0; i < fires; i++) {
    const next = computeNextCronRunAtMs(expression, cursor, "UTC");
    if (next === null) throw new Error(`no next run for ${expression}`);
    gaps.push((next - cursor) / 60_000);
    cursor = next;
  }
  return gaps;
}

describe("describeCronSchedule", () => {
  it("claims an every-N-minutes cadence only when the scheduler fires uniformly", () => {
    for (const n of [1, 5, 15, 30, 7, 25, 45, 59, 90]) {
      const expression = `*/${n} * * * *`;
      const uniform = gapMinutes(expression, 12).every((gap) => gap === n);
      expect(describeCronSchedule(expression)).toBe(
        uniform ? (n === 1 ? "every minute" : `every ${n} minutes`) : null,
      );
    }
    expect(describeCronSchedule("*/45 * * * *")).toBeNull();
  });
});
