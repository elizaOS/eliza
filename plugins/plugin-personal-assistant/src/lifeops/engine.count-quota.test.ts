/**
 * Pure-transform coverage for the count-per-day quota cadence (#17025): one
 * owner-local active-day occurrence per local date (never per fabricated
 * slot), an `anytime` timing that stays structurally distinct from windows,
 * normalization bounds, and the LLM-param path that must no longer invent
 * wall-clock slot times for a bare count. No runtime graph; deterministic.
 */
import { describe, expect, it } from "vitest";
import type { ExtractedTaskParams } from "../actions/lib/extract-task-plan.ts";
import { buildCadenceFromLlmParams } from "../actions/life.ts";
import type {
  LifeOpsCadence,
  LifeOpsTaskDefinition,
} from "../contracts/index.js";
import { materializeDefinitionOccurrences } from "./engine.ts";
import { normalizeCadence } from "./service-normalize-task.ts";

const quotaCadence: LifeOpsCadence = {
  kind: "count_per_day",
  targetCount: 3,
  unit: "set",
  perOccurrenceWork: "25 pushups",
  timing: { kind: "anytime" },
};

function makeQuotaDefinition(
  cadence: LifeOpsCadence,
  timezone = "America/New_York",
): LifeOpsTaskDefinition {
  return {
    id: "def-quota",
    agentId: "agent-1",
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: "owner-1",
    visibilityScope: "owner_only",
    contextPolicy: "explicit_only",
    kind: "habit",
    title: "pushups",
    description: "",
    originalIntent: "25 pushups 3 times a day, whenever",
    timezone,
    status: "active",
    priority: 3,
    cadence,
    windowPolicy: {
      timezone,
      windows: [
        { name: "morning", label: "Morning", startMinute: 360, endMinute: 720 },
        {
          name: "evening",
          label: "Evening",
          startMinute: 1020,
          endMinute: 1320,
        },
      ],
    },
    progressionRule: { kind: "none" },
    websiteAccess: null,
    reminderPlanId: null,
    goalId: null,
    source: "test",
    metadata: {},
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  } as unknown as LifeOpsTaskDefinition;
}

describe("materializeDefinitionOccurrences — count_per_day", () => {
  const now = new Date("2026-08-15T16:00:00.000Z");

  it("materializes exactly one occurrence per local date, never per slot", () => {
    const occurrences = materializeDefinitionOccurrences(
      makeQuotaDefinition(quotaCadence),
      [],
      { now, lookbackDays: 2, lookaheadDays: 7 },
    );
    expect(occurrences).toHaveLength(10);
    const keys = occurrences.map((occurrence) => occurrence.occurrenceKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^quota:\d{4}-\d{2}-\d{2}:day$/);
    }
  });

  it("spans the whole owner-local day for anytime timing", () => {
    const occurrences = materializeDefinitionOccurrences(
      makeQuotaDefinition(quotaCadence),
      [],
      { now, lookbackDays: 0, lookaheadDays: 0 },
    );
    expect(occurrences).toHaveLength(1);
    const [occurrence] = occurrences;
    // 2026-08-15 America/New_York is UTC-4: local midnight is 04:00Z.
    expect(occurrence.scheduledAt).toBe("2026-08-15T04:00:00.000Z");
    expect(occurrence.dueAt).toBe("2026-08-16T03:59:59.000Z");
    expect(occurrence.windowName).toBeNull();
    expect(occurrence.state).toBe("visible");
    expect(occurrence.derivedTarget).toEqual({
      kind: "count_per_day",
      targetCount: 3,
      unit: "set",
      perOccurrenceWork: "25 pushups",
    });
  });

  it("narrows the day span to the named windows for windows timing", () => {
    const occurrences = materializeDefinitionOccurrences(
      makeQuotaDefinition({
        ...quotaCadence,
        timing: { kind: "windows", windows: ["morning", "evening"] },
      }),
      [],
      { now, lookbackDays: 0, lookaheadDays: 0 },
    );
    expect(occurrences).toHaveLength(1);
    const [occurrence] = occurrences;
    // Local 06:00 → 10:00Z, local 22:00 → 02:00Z next day.
    expect(occurrence.scheduledAt).toBe("2026-08-15T10:00:00.000Z");
    expect(occurrence.dueAt).toBe("2026-08-16T02:00:59.000Z");
    expect(occurrence.windowName).toBe("morning+evening");
  });

  it("keeps a terminal existing occurrence sticky and reuses its identity", () => {
    const definition = makeQuotaDefinition(quotaCadence);
    const [fresh] = materializeDefinitionOccurrences(definition, [], {
      now,
      lookbackDays: 0,
      lookaheadDays: 0,
    });
    const completed = { ...fresh, state: "completed" as const };
    const [rematerialized] = materializeDefinitionOccurrences(
      definition,
      [completed],
      { now, lookbackDays: 0, lookaheadDays: 0 },
    );
    expect(rematerialized.id).toBe(fresh.id);
    expect(rematerialized.state).toBe("completed");
  });

  it("resets on the next local day through a distinct occurrence key", () => {
    const definition = makeQuotaDefinition(quotaCadence);
    const [today] = materializeDefinitionOccurrences(definition, [], {
      now,
      lookbackDays: 0,
      lookaheadDays: 0,
    });
    const [tomorrow] = materializeDefinitionOccurrences(
      definition,
      [{ ...today, state: "completed" as const }],
      {
        now: new Date("2026-08-16T16:00:00.000Z"),
        lookbackDays: 0,
        lookaheadDays: 0,
      },
    );
    expect(tomorrow.occurrenceKey).not.toBe(today.occurrenceKey);
    expect(tomorrow.state).toBe("visible");
    expect(tomorrow.id).not.toBe(today.id);
  });
});

describe("normalizeCadence — count_per_day", () => {
  const windowPolicy = {
    timezone: "UTC",
    windows: [
      {
        name: "morning" as const,
        label: "Morning",
        startMinute: 360,
        endMinute: 720,
      },
    ],
  };

  it("round-trips a valid anytime quota without inventing slots", () => {
    const normalized = normalizeCadence(quotaCadence, windowPolicy);
    expect(normalized).toEqual(quotaCadence);
    expect("slots" in normalized).toBe(false);
  });

  it("rejects a non-positive target", () => {
    expect(() =>
      normalizeCadence({ ...quotaCadence, targetCount: 0 }, windowPolicy),
    ).toThrowError(/targetCount/);
  });

  it("rejects an empty unit", () => {
    expect(() =>
      normalizeCadence({ ...quotaCadence, unit: " " }, windowPolicy),
    ).toThrowError(/unit/);
  });

  it("rejects an unknown timing kind", () => {
    expect(() =>
      normalizeCadence(
        {
          ...quotaCadence,
          timing: { kind: "slots" },
        } as unknown as LifeOpsCadence,
        windowPolicy,
      ),
    ).toThrowError(/timing/);
  });

  it("validates windows timing against the window policy", () => {
    const normalized = normalizeCadence(
      { ...quotaCadence, timing: { kind: "windows", windows: ["morning"] } },
      windowPolicy,
    );
    expect(normalized).toMatchObject({
      timing: { kind: "windows", windows: ["morning"] },
    });
  });
});

describe("buildCadenceFromLlmParams — bare count is a quota, not slots", () => {
  const baseParams = {
    requestKind: null,
    title: "pushups",
    description: null,
    cadenceKind: "times_per_day",
    windows: null,
    weekdays: null,
    timeOfDay: null,
    timeZone: null,
    everyMinutes: null,
    timesPerDay: 3,
    priority: null,
    durationMinutes: null,
    dueDate: null,
    dueInDays: null,
    dueWeekday: null,
    dueInMinutes: null,
    multiStep: false,
  } as unknown as ExtractedTaskParams;

  it("emits count_per_day anytime for a count with no clock times", () => {
    const built = buildCadenceFromLlmParams(baseParams, {
      intent: "25 pushups 3 times a day, doesn't matter when",
    });
    expect(built?.cadence).toEqual({
      kind: "count_per_day",
      targetCount: 3,
      unit: "time",
      perOccurrenceWork: null,
      timing: { kind: "anytime" },
    });
  });

  it("constrains the quota to named windows without fabricating slot times", () => {
    const built = buildCadenceFromLlmParams(
      { ...baseParams, windows: ["morning", "evening"] },
      { intent: "stretch twice in the morning and evening" },
    );
    expect(built?.cadence).toMatchObject({
      kind: "count_per_day",
      timing: { kind: "windows", windows: ["morning", "evening"] },
    });
  });

  it("still honors an explicitly named time with a fixed slot", () => {
    const built = buildCadenceFromLlmParams(
      { ...baseParams, timeOfDay: "08:00" },
      { intent: "pushups at 8am every day" },
    );
    expect(built?.cadence.kind).toBe("times_per_day");
  });
});
