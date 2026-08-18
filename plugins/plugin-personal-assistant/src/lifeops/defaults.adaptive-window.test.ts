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
      expectedEndMinute: 900,
      expectedStartMinute: 840,
      typicalWakeHour: 14.5,
    },
    {
      expectedEndMinute: 930,
      expectedStartMinute: 870,
      typicalWakeHour: 15,
    },
    {
      expectedEndMinute: 1410,
      expectedStartMinute: 1350,
      typicalWakeHour: 23,
    },
    {
      expectedEndMinute: 1650,
      expectedStartMinute: 1590,
      typicalWakeHour: 27,
    },
  ])(
    "keeps a $typicalWakeHour wake inside its wake-relative morning window",
    ({ expectedEndMinute, expectedStartMinute, typicalWakeHour }) => {
      const policy = computeAdaptiveWindowPolicy(
        {
          typicalWakeHour,
          typicalFirstActiveHour: null,
          typicalLastActiveHour: null,
          typicalSleepHour: 28,
        },
        "UTC",
      );

      expect(policy.windows[0]).toMatchObject({
        name: "morning",
        startMinute: expectedStartMinute,
        endMinute: expectedEndMinute,
      });
      const wakeMinute = typicalWakeHour * 60;
      expect(policy.windows[0]?.startMinute).toBeLessThanOrEqual(wakeMinute);
      expect(policy.windows[0]?.endMinute).toBeGreaterThan(wakeMinute);
      expect(policy.windows[1]?.startMinute).toBe(expectedEndMinute);
    },
  );

  it("keeps every adaptive daypart contiguous and non-empty across wake rhythms", () => {
    for (
      let typicalWakeHour = 4;
      typicalWakeHour <= 27;
      typicalWakeHour += 0.25
    ) {
      const policy = computeAdaptiveWindowPolicy(
        {
          typicalWakeHour,
          typicalFirstActiveHour: null,
          typicalLastActiveHour: null,
          typicalSleepHour: 28,
        },
        "UTC",
      );

      for (const [index, window] of policy.windows.entries()) {
        expect(window.endMinute - window.startMinute).toBeGreaterThanOrEqual(
          60,
        );
        if (index > 0) {
          expect(window.startMinute).toBe(policy.windows[index - 1]?.endMinute);
        }
      }
      const morning = policy.windows[0];
      expect(morning?.startMinute).toBe(
        Math.max(Math.round((typicalWakeHour - 0.5) * 60), 4 * 60),
      );
      expect(morning?.startMinute).toBeLessThanOrEqual(typicalWakeHour * 60);
      expect(morning?.endMinute).toBeGreaterThan(typicalWakeHour * 60);
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
