/**
 * Independent cross-checks of the committed timeliness corpus (#10723).
 *
 * The gate's oracle trusts the hand-authored occurrence instants in
 * corpus.ts; these tests re-derive each instant's LOCAL wall clock through
 * Intl (the same IANA tzdata the production cron path walks) and assert it
 * matches the cron expression — so a mis-transcribed UTC instant fails the
 * cheap unit lane instead of silently teaching the gate a wrong ideal.
 * Also pins the corpus shape and checks baseline.json's timeliness block
 * against budgets.json.
 */

import { describe, expect, it } from "vitest";
import baseline from "../baseline.json";
import budgets from "../budgets.json";
import { TIMELINESS_WINDOWS } from "./corpus.ts";
import { parseIsoStrict } from "./oracle.ts";

interface CronFields {
  minute: number;
  hour: number;
  dayOfWeek: number | null;
}

/** The corpus only uses `m h * * *` and `m h * * <dow>` expressions. */
function parseCorpusCron(expression: string): CronFields {
  const match = /^(\d+) (\d+) \* \* (\*|\d)$/.exec(expression);
  if (!match) throw new Error(`unsupported corpus cron: ${expression}`);
  return {
    minute: Number(match[1]),
    hour: Number(match[2]),
    dayOfWeek: match[3] === "*" ? null : Number(match[3]),
  };
}

function localParts(
  iso: string,
  tz: string,
): { hour: number; minute: number; dayOfWeek: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  let hour = -1;
  let minute = -1;
  let dayOfWeek = -1;
  for (const part of formatter.formatToParts(new Date(iso))) {
    if (part.type === "hour") hour = Number(part.value) % 24;
    else if (part.type === "minute") minute = Number(part.value);
    else if (part.type === "weekday") dayOfWeek = dayMap[part.value] ?? -1;
  }
  if (hour < 0 || minute < 0 || dayOfWeek < 0) {
    throw new Error(`could not derive local parts for ${iso} in ${tz}`);
  }
  return { hour, minute, dayOfWeek };
}

describe("timeliness corpus invariants", () => {
  it("covers both 2026 US DST windows with the documented shape", () => {
    expect(TIMELINESS_WINDOWS.map((w) => w.name)).toEqual([
      "spring-forward",
      "fall-back",
    ]);
    for (const window of TIMELINESS_WINDOWS) {
      expect(window.cadenceMinutes).toBe(5);
      expect(window.tasks.length).toBeGreaterThanOrEqual(11);
      const ids = new Set(window.tasks.map((task) => task.id));
      expect(ids.size).toBe(window.tasks.length);
      const kinds = new Set(window.tasks.map((task) => task.trigger.kind));
      expect(kinds).toEqual(new Set(["cron", "once", "interval"]));
    }
  });

  it("keeps every committed occurrence inside its window, strictly increasing", () => {
    for (const window of TIMELINESS_WINDOWS) {
      const start = parseIsoStrict(window.startIso);
      const end = parseIsoStrict(window.endIso);
      for (const task of window.tasks) {
        if (task.trigger.kind === "interval") {
          expect(
            task.expectedOccurrences,
            `${task.id} must derive interval ideals`,
          ).toBeUndefined();
          continue;
        }
        const occurrences = task.expectedOccurrences ?? [];
        expect(occurrences.length, task.id).toBeGreaterThan(0);
        let previous = Number.NEGATIVE_INFINITY;
        for (const iso of occurrences) {
          const ms = parseIsoStrict(iso);
          expect(ms, `${task.id} ${iso} before window`).toBeGreaterThanOrEqual(
            start,
          );
          expect(ms, `${task.id} ${iso} after window`).toBeLessThanOrEqual(end);
          expect(ms, `${task.id} not increasing at ${iso}`).toBeGreaterThan(
            previous,
          );
          previous = ms;
        }
      }
    }
  });

  it("re-derives every cron occurrence's local wall clock through Intl tzdata", () => {
    for (const window of TIMELINESS_WINDOWS) {
      for (const task of window.tasks) {
        if (task.trigger.kind !== "cron") continue;
        const fields = parseCorpusCron(task.trigger.expression);
        for (const iso of task.expectedOccurrences ?? []) {
          const local = localParts(iso, task.trigger.tz);
          expect(
            local.hour,
            `${task.id} ${iso} local hour in ${task.trigger.tz}`,
          ).toBe(fields.hour);
          expect(
            local.minute,
            `${task.id} ${iso} local minute in ${task.trigger.tz}`,
          ).toBe(fields.minute);
          if (fields.dayOfWeek !== null) {
            expect(
              local.dayOfWeek,
              `${task.id} ${iso} local weekday in ${task.trigger.tz}`,
            ).toBe(fields.dayOfWeek);
          }
        }
      }
    }
  });

  it("pins the vanished-hour skip: NY 02:30 has 3 spring occurrences, 4 fall", () => {
    const spring = TIMELINESS_WINDOWS[0]?.tasks.find(
      (task) => task.id === "s-cron-ny-0230",
    );
    const fall = TIMELINESS_WINDOWS[1]?.tasks.find(
      (task) => task.id === "f-cron-ny-0230",
    );
    expect(spring?.expectedOccurrences).toHaveLength(3);
    const springDays = (spring?.expectedOccurrences ?? []).map((iso) =>
      iso.slice(0, 10),
    );
    expect(springDays).not.toContain("2026-03-08");
    expect(fall?.expectedOccurrences).toHaveLength(4);
  });

  it("matches once-trigger occurrences to their atIso exactly", () => {
    for (const window of TIMELINESS_WINDOWS) {
      for (const task of window.tasks) {
        if (task.trigger.kind !== "once") continue;
        expect(task.expectedOccurrences, task.id).toEqual([task.trigger.atIso]);
      }
    }
  });
});

describe("committed baseline + budgets consistency (timeliness)", () => {
  it("the recorded baseline satisfies every committed budget", () => {
    const floors = budgets.timeliness;
    for (const [name, window] of Object.entries(baseline.timeliness.windows)) {
      expect(window.missedFireCount, `${name} missed`).toBe(
        floors.missedFireCount,
      );
      expect(window.duplicateFireCount, `${name} duplicate`).toBe(
        floors.duplicateFireCount,
      );
      expect(window.earlyFireCount, `${name} early`).toBe(
        floors.earlyFireCount,
      );
      expect(window.occurrenceMismatchCount, `${name} mismatch`).toBe(
        floors.occurrenceMismatchCount,
      );
      expect(window.maxDeviationMs, `${name} maxDev`).toBeLessThanOrEqual(
        floors.maxDeviationMs,
      );
      expect(window.meanDeviationMs, `${name} meanDev`).toBeLessThanOrEqual(
        floors.meanDeviationMs,
      );
      expect(window.expectedFires, `${name} fires`).toBeGreaterThan(0);
      expect(window.actualFires, `${name} actual`).toBe(window.expectedFires);
    }
  });

  it("the deviation ceiling is the honest tick-cadence bound", () => {
    // 5-minute cadence → any on-contract fire lands within 300000ms of its
    // ideal. A larger ceiling would tolerate a real lateness bug.
    expect(budgets.timeliness.maxDeviationMs).toBe(5 * 60_000);
  });
});
