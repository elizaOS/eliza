// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  computeSnoozedUntil,
  isRecord,
  normalizedStringSet,
  sameNormalizedStringSet,
} from "../src/lifeops/service-helpers-misc.js";

/**
 * Snooze-time computation and the string-set utilities underpin reminder
 * rescheduling and grant-set comparison (#8795). Snooze presets/minutes must
 * land on an exact future instant and reject non-positive durations.
 */

// biome-ignore lint/suspicious/noExplicitAny: minimal stand-ins for the domain types.
const def: any = { timezone: "UTC" };
const NOW = new Date("2026-06-23T10:00:00.000Z");
const plus = (mins: number) =>
  new Date(NOW.getTime() + mins * 60_000).getTime();
// biome-ignore lint/suspicious/noExplicitAny: loose request input.
const req = (o: Record<string, unknown>): any => o;

describe("computeSnoozedUntil", () => {
  it("resolves fixed presets to now + delta", () => {
    expect(
      computeSnoozedUntil(def, req({ preset: "15m" }), NOW).getTime(),
    ).toBe(plus(15));
    expect(
      computeSnoozedUntil(def, req({ preset: "30m" }), NOW).getTime(),
    ).toBe(plus(30));
    expect(computeSnoozedUntil(def, req({ preset: "1h" }), NOW).getTime()).toBe(
      plus(60),
    );
  });

  it("uses minutes (default 30) and rejects non-positive durations", () => {
    expect(computeSnoozedUntil(def, req({ minutes: 45 }), NOW).getTime()).toBe(
      plus(45),
    );
    expect(computeSnoozedUntil(def, req({}), NOW).getTime()).toBe(plus(30));
    expect(() => computeSnoozedUntil(def, req({ minutes: 0 }), NOW)).toThrow();
    expect(() => computeSnoozedUntil(def, req({ minutes: -5 }), NOW)).toThrow();
  });
});

describe("normalizedStringSet / sameNormalizedStringSet", () => {
  it("trims, drops empties, de-duplicates, and sorts", () => {
    expect(normalizedStringSet(["b", "a", "a", " c ", ""])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("compares sets independent of order and whitespace", () => {
    expect(sameNormalizedStringSet(["a", "b"], ["b", " a "])).toBe(true);
    expect(sameNormalizedStringSet(["a"], ["a", "b"])).toBe(false);
  });
});

describe("isRecord", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});
