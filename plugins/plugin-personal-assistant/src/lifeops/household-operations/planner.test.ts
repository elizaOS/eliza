/**
 * Unit coverage for annual almanac window resolution: an open window is kept
 * for its whole span, otherwise the next window to open is chosen.
 */

import { describe, expect, it } from "vitest";
import {
  expandAlmanacWindowForPreparation,
  resolveAlmanacWindow,
} from "./planner.js";
import type { AlmanacEntryDefinition } from "./types.js";

function annualEntry(
  opens: { month: number; day: number },
  closes: { month: number; day: number },
): AlmanacEntryDefinition {
  return {
    kind: "almanac_entry",
    recordId: "almanac-heating-season",
    householdId: "household-planner-unit",
    active: true,
    visibility: { kind: "household" },
    title: "Heating season furnace filter checks",
    subjectKey: "home:furnace-filter",
    category: "maintenance",
    trigger: {
      kind: "annual_window",
      opens,
      closes,
      timezone: "America/New_York",
    },
    vendorProfileRecordId: null,
    responsibilityAssignmentId: null,
    preparationLeadDays: 14,
    sourceObservationIds: [],
  };
}

function resolveAt(entry: AlmanacEntryDefinition, asOf: string) {
  return resolveAlmanacWindow({
    entry,
    serviceEvents: [],
    asOf: new Date(asOf),
  });
}

describe("resolveAlmanacWindow annual windows", () => {
  // October 1 through April 30 (America/New_York), about seven months long.
  const heatingSeason = annualEntry(
    { month: 10, day: 1 },
    { month: 4, day: 30 },
  );

  it("keeps a long window that is open late in its span", () => {
    // 201 days after the October opening, 164 days before next October.
    const resolved = resolveAt(heatingSeason, "2027-04-20T15:00:00.000Z");
    expect(resolved).toMatchObject({
      state: "known",
      startsAt: "2026-10-01T04:00:00.000Z",
      endsAt: "2027-04-30T04:00:00.000Z",
    });
  });

  it("keeps a long window that is open early in its span", () => {
    const resolved = resolveAt(heatingSeason, "2026-11-01T15:00:00.000Z");
    expect(resolved).toMatchObject({
      state: "known",
      startsAt: "2026-10-01T04:00:00.000Z",
      endsAt: "2027-04-30T04:00:00.000Z",
    });
  });

  it("picks the next window when none is open yet", () => {
    const springCleanup = annualEntry(
      { month: 3, day: 15 },
      { month: 5, day: 1 },
    );
    const resolved = resolveAt(springCleanup, "2027-02-01T15:00:00.000Z");
    expect(resolved).toMatchObject({
      state: "known",
      startsAt: "2027-03-15T04:00:00.000Z",
      endsAt: "2027-05-01T04:00:00.000Z",
    });
  });

  it("moves to next year's window once this year's has just ended", () => {
    const resolved = resolveAt(heatingSeason, "2027-04-30T05:00:00.000Z");
    expect(resolved).toMatchObject({
      state: "known",
      startsAt: "2027-10-01T04:00:00.000Z",
      endsAt: "2028-04-30T04:00:00.000Z",
    });
  });

  it("keeps an open long window inside the weekly brief's preparation window", () => {
    const resolved = resolveAt(heatingSeason, "2027-04-20T15:00:00.000Z");
    if (!resolved.startsAt || !resolved.endsAt) {
      throw new Error("Expected a known annual window");
    }
    const preparation = expandAlmanacWindowForPreparation(heatingSeason, {
      startsAt: resolved.startsAt,
      endsAt: resolved.endsAt,
    });
    const briefWeek = {
      startsAt: "2027-04-19T04:00:00.000Z",
      endsAt: "2027-04-26T04:00:00.000Z",
    };
    expect(Date.parse(preparation.startsAt)).toBeLessThan(
      Date.parse(briefWeek.endsAt),
    );
    expect(Date.parse(briefWeek.startsAt)).toBeLessThan(
      Date.parse(preparation.endsAt),
    );
  });
});
