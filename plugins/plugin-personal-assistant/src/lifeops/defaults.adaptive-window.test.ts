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
    { wakeTime: "14:30", typicalWakeHour: 14.5 },
    { wakeTime: "15:00", typicalWakeHour: 15 },
  ])(
    "keeps the morning window non-empty for a $wakeTime wake rhythm",
    ({ typicalWakeHour }) => {
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
        startMinute: 780,
        endMinute: 840,
      });
      expect(policy.windows[1]?.startMinute).toBe(840);
    },
  );

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
        ({ scheduledAt }) => scheduledAt?.slice(11, 16) === "13:00",
      ),
    ).toBe(true);
  });
});
