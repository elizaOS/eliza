// Exercises lifeops-quality benchmark lifeops quality timeliness oracle.test behavior against deterministic harness fixtures.
import { describe, expect, it } from "vitest";
import {
  type ActualFire,
  expectedFiresForCase,
  firstTickAtOrAfter,
  MINUTE_MS,
  scoreCase,
  scoreTimeliness,
  type TimelinessCase,
  type TimelinessWindow,
  tickGrid,
} from "./oracle.ts";

const WINDOW: TimelinessWindow = {
  name: "unit",
  startIso: "2026-01-01T00:00:00.000Z",
  endIso: "2026-01-01T01:00:00.000Z",
  cadenceMinutes: 5,
  tasks: [],
};

const T0 = Date.parse(WINDOW.startIso);

describe("tickGrid / firstTickAtOrAfter", () => {
  it("builds an inclusive grid and rejects inverted windows", () => {
    const ticks = tickGrid(WINDOW);
    expect(ticks).toHaveLength(13); // 00:00..01:00 inclusive, every 5m
    expect(ticks[0]).toBe(T0);
    expect(ticks.at(-1)).toBe(Date.parse(WINDOW.endIso));
    expect(() =>
      tickGrid({ ...WINDOW, endIso: "2025-12-31T00:00:00.000Z" }),
    ).toThrow("ends before it starts");
  });

  it("finds the first tick at/after an instant, or null past the grid", () => {
    const ticks = tickGrid(WINDOW);
    expect(firstTickAtOrAfter(ticks, T0)).toBe(T0);
    expect(firstTickAtOrAfter(ticks, T0 + 1)).toBe(T0 + 5 * MINUTE_MS);
    expect(firstTickAtOrAfter(ticks, T0 + 5 * MINUTE_MS)).toBe(
      T0 + 5 * MINUTE_MS,
    );
    expect(firstTickAtOrAfter(ticks, Date.parse(WINDOW.endIso) + 1)).toBeNull();
  });
});

describe("expectedFiresForCase", () => {
  const ticks = tickGrid(WINDOW);

  it("maps once/cron occurrences to the first tick at/after each ideal", () => {
    const benchCase: TimelinessCase = {
      id: "u-once",
      kind: "reminder",
      trigger: { kind: "once", atIso: "2026-01-01T00:02:00.000Z" },
      expectedOccurrences: ["2026-01-01T00:02:00.000Z"],
    };
    const fires = expectedFiresForCase(benchCase, ticks);
    expect(fires).toEqual([
      {
        idealMs: T0 + 2 * MINUTE_MS,
        expectedTickMs: T0 + 5 * MINUTE_MS,
      },
    ]);
  });

  it("derives interval ideals from the re-anchor-on-fire contract", () => {
    const benchCase: TimelinessCase = {
      id: "u-interval",
      kind: "reminder",
      trigger: {
        kind: "interval",
        everyMinutes: 7,
        from: "2026-01-01T00:02:00.000Z",
      },
    };
    const fires = expectedFiresForCase(benchCase, ticks);
    // ideal 00:02 → tick 00:05; next ideal 00:05+7=00:12 → tick 00:15; …
    expect(fires[0]).toEqual({
      idealMs: T0 + 2 * MINUTE_MS,
      expectedTickMs: T0 + 5 * MINUTE_MS,
    });
    expect(fires[1]).toEqual({
      idealMs: T0 + 12 * MINUTE_MS,
      expectedTickMs: T0 + 15 * MINUTE_MS,
    });
    for (const fire of fires) {
      expect(fire.expectedTickMs - fire.idealMs).toBeLessThan(5 * MINUTE_MS);
      expect(fire.expectedTickMs).toBeGreaterThanOrEqual(fire.idealMs);
    }
  });

  it("rejects malformed corpora instead of scoring them", () => {
    expect(() =>
      expectedFiresForCase(
        {
          id: "u-bad-interval",
          kind: "reminder",
          trigger: { kind: "interval", everyMinutes: 7 },
          expectedOccurrences: ["2026-01-01T00:05:00.000Z"],
        },
        ticks,
      ),
    ).toThrow("must not carry expectedOccurrences");
    expect(() =>
      expectedFiresForCase(
        {
          id: "u-empty",
          kind: "reminder",
          trigger: { kind: "once", atIso: "2026-01-01T00:02:00.000Z" },
        },
        ticks,
      ),
    ).toThrow("no expectedOccurrences");
    expect(() =>
      expectedFiresForCase(
        {
          id: "u-unsorted",
          kind: "reminder",
          trigger: { kind: "cron", expression: "0 0 * * *", tz: "UTC" },
          expectedOccurrences: [
            "2026-01-01T00:10:00.000Z",
            "2026-01-01T00:05:00.000Z",
          ],
        },
        ticks,
      ),
    ).toThrow("not strictly increasing");
    expect(() =>
      expectedFiresForCase(
        {
          id: "u-late",
          kind: "reminder",
          trigger: { kind: "once", atIso: "2026-01-01T02:00:00.000Z" },
          expectedOccurrences: ["2026-01-01T02:00:00.000Z"],
        },
        ticks,
      ),
    ).toThrow("falls after the last tick");
    expect(() =>
      expectedFiresForCase(
        {
          id: "u-collapsed",
          kind: "reminder",
          trigger: { kind: "cron", expression: "* * * * *", tz: "UTC" },
          expectedOccurrences: [
            "2026-01-01T00:06:00.000Z",
            "2026-01-01T00:07:00.000Z",
          ],
        },
        ticks,
      ),
    ).toThrow("two occurrences inside one tick interval");
  });
});

describe("scoreCase / scoreTimeliness", () => {
  const benchCase: TimelinessCase = {
    id: "u-score",
    kind: "reminder",
    trigger: { kind: "once", atIso: "2026-01-01T00:02:00.000Z" },
    expectedOccurrences: ["2026-01-01T00:02:00.000Z"],
  };
  const ticks = tickGrid(WINDOW);
  const expected = expectedFiresForCase(benchCase, ticks);
  const idealIso = "2026-01-01T00:02:00.000Z";

  function fire(tickMs: number, occurrenceAtIso?: string): ActualFire {
    return { taskId: "u-score", tickMs, status: "fired", occurrenceAtIso };
  }

  it("scores an on-contract fire with its deviation and no defects", () => {
    const score = scoreCase(benchCase, expected, [
      fire(T0 + 5 * MINUTE_MS, idealIso),
    ]);
    expect(score).toMatchObject({
      missedFireCount: 0,
      duplicateFireCount: 0,
      earlyFireCount: 0,
      occurrenceMismatchCount: 0,
      deviationsMs: [3 * MINUTE_MS],
    });
  });

  it("counts missed, duplicate, early, and occurrence-mismatched fires", () => {
    expect(scoreCase(benchCase, expected, []).missedFireCount).toBe(1);
    expect(
      scoreCase(benchCase, expected, [
        fire(T0 + 5 * MINUTE_MS, idealIso),
        fire(T0 + 10 * MINUTE_MS, idealIso),
      ]).duplicateFireCount,
    ).toBe(1);
    expect(
      scoreCase(benchCase, expected, [fire(T0, idealIso)]).earlyFireCount,
    ).toBe(1);
    expect(
      scoreCase(benchCase, expected, [
        fire(T0 + 5 * MINUTE_MS, "2026-01-01T00:04:00.000Z"),
      ]).occurrenceMismatchCount,
    ).toBe(1);
    // A fire whose tick claims NO occurrence instant is a mismatch too.
    expect(
      scoreCase(benchCase, expected, [fire(T0 + 5 * MINUTE_MS)])
        .occurrenceMismatchCount,
    ).toBe(1);
  });

  it("aggregates across cases with max/mean deviation", () => {
    const window: TimelinessWindow = { ...WINDOW, tasks: [benchCase] };
    const score = scoreTimeliness(
      window,
      ticks,
      new Map([["u-score", [fire(T0 + 5 * MINUTE_MS, idealIso)]]]),
    );
    expect(score.totalExpectedFires).toBe(1);
    expect(score.totalActualFires).toBe(1);
    expect(score.maxDeviationMs).toBe(3 * MINUTE_MS);
    expect(score.meanDeviationMs).toBe(3 * MINUTE_MS);
  });
});
