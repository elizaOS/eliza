/**
 * Deterministic coverage for adaptive LifeOps window boundaries and their
 * consumption by the real occurrence materializer.
 */
import { describe, expect, it } from "vitest";
import type {
  LifeOpsTaskDefinition,
  LifeOpsWindowPolicy,
} from "../contracts/index.js";
import { computeAdaptiveWindowPolicy } from "./defaults.js";
import { materializeDefinitionOccurrences } from "./engine.js";

function createDailyMorningDefinition(
  windowPolicy: LifeOpsWindowPolicy,
): LifeOpsTaskDefinition {
  return {
    id: "late-wake-morning-routine",
    agentId: "agent-1",
    domain: "personal",
    subjectType: "owner",
    subjectId: "owner-1",
    visibilityScope: "private",
    contextPolicy: { allowAmbient: false },
    kind: "routine",
    title: "Morning routine",
    description: "",
    originalIntent: "Do my morning routine every day",
    timezone: "UTC",
    status: "active",
    priority: 3,
    cadence: { kind: "daily", windows: ["morning"] },
    windowPolicy,
    progressionRule: { kind: "none" },
    websiteAccess: null,
    reminderPlanId: null,
    goalId: null,
    source: "test",
    metadata: {},
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}

describe("computeAdaptiveWindowPolicy", () => {
  it("retains the standard five-hour morning span for an ordinary wake rhythm", () => {
    const policy = computeAdaptiveWindowPolicy(
      {
        typicalWakeHour: 7,
        typicalFirstActiveHour: null,
        typicalLastActiveHour: null,
        typicalSleepHour: null,
      },
      "UTC",
    );

    expect(policy.windows[0]).toMatchObject({
      name: "morning",
      startMinute: 390,
      endMinute: 690,
    });
  });

  it.each([
    {
      wakeTime: "14:30",
      typicalWakeHour: 14.5,
      startMinute: 840,
      endMinute: 900,
    },
    {
      wakeTime: "15:00",
      typicalWakeHour: 15,
      startMinute: 870,
      endMinute: 930,
    },
  ])(
    "keeps the morning window wake-relative for a $wakeTime wake rhythm",
    ({ typicalWakeHour, startMinute, endMinute }) => {
      const policy = computeAdaptiveWindowPolicy(
        {
          typicalWakeHour,
          typicalFirstActiveHour: null,
          typicalLastActiveHour: null,
          typicalSleepHour: null,
        },
        "UTC",
      );

      expect(policy.windows[0]).toMatchObject({
        name: "morning",
        startMinute,
        endMinute,
      });
      const wakeMinute = typicalWakeHour * 60;
      expect(startMinute).toBeLessThanOrEqual(wakeMinute);
      expect(endMinute).toBeGreaterThan(wakeMinute);
      expect(policy.windows[1]?.startMinute).toBe(endMinute);
    },
  );

  it("keeps downstream dayparts positive when a very late wake crosses both caps", () => {
    const policy = computeAdaptiveWindowPolicy(
      {
        typicalWakeHour: 21,
        typicalFirstActiveHour: null,
        typicalLastActiveHour: null,
        typicalSleepHour: null,
      },
      "UTC",
    );

    expect(policy.windows.slice(0, 3)).toMatchObject([
      { name: "morning", startMinute: 1230, endMinute: 1290 },
      { name: "afternoon", startMinute: 1290, endMinute: 1350 },
      { name: "evening", startMinute: 1350, endMinute: 1410 },
    ]);
  });

  it("keeps every adaptive daypart contiguous and non-empty across wake rhythms", () => {
    for (
      let typicalWakeHour = 0;
      typicalWakeHour < 24;
      typicalWakeHour += 0.5
    ) {
      const policy = computeAdaptiveWindowPolicy(
        {
          typicalWakeHour,
          typicalFirstActiveHour: null,
          typicalLastActiveHour: null,
          typicalSleepHour: null,
        },
        "UTC",
      );

      for (const [index, window] of policy.windows.entries()) {
        expect(window.endMinute).toBeGreaterThan(window.startMinute);
        if (index > 0) {
          expect(window.startMinute).toBe(policy.windows[index - 1]?.endMinute);
        }
      }
    }
  });

  it("materializes daily morning occurrences under a late-wake policy", () => {
    const policy = computeAdaptiveWindowPolicy(
      {
        typicalWakeHour: 15,
        typicalFirstActiveHour: null,
        typicalLastActiveHour: null,
        typicalSleepHour: null,
      },
      "UTC",
    );
    const occurrences = materializeDefinitionOccurrences(
      createDailyMorningDefinition(policy),
      [],
      {
        now: new Date("2026-08-15T12:00:00.000Z"),
        lookbackDays: 2,
        lookaheadDays: 7,
      },
    );

    expect(occurrences).toHaveLength(10);
    expect(
      occurrences.every(({ windowName }) => windowName === "morning"),
    ).toBe(true);
    expect(
      occurrences.every(
        ({ scheduledAt }) => scheduledAt?.slice(11, 16) === "14:30",
      ),
    ).toBe(true);
  });
});
