/** Tests the `definitionCount` final check (final-checks/index.ts) with LifeOpsService mocked to return a fixed definition list, asserting the min/max count comparison. */
import type { ScenarioFinalCheck } from "@elizaos/scenario-runner/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  definitions: [] as unknown[],
}));

vi.mock("@elizaos/plugin-personal-assistant/lifeops/service", () => ({
  LifeOpsService: class {
    async listDefinitions(): Promise<unknown[]> {
      return mockState.definitions;
    }
  },
}));

const { runFinalCheck } = await import("./index.ts");

function definitionRecord(
  definition: Record<string, unknown>,
  reminderPlan: unknown = null,
): unknown {
  return {
    definition: {
      id: "definition-1",
      title: "Brush teeth",
      timezone: "UTC",
      cadence: { kind: "daily", windows: ["morning"] },
      reminderPlanId: reminderPlan ? "plan-1" : null,
      websiteAccess: null,
      ...definition,
    },
    reminderPlan,
  };
}

async function run(check: ScenarioFinalCheck) {
  return runFinalCheck(check, {
    runtime: {} as never,
    ctx: { actionsCalled: [] },
  });
}

describe("definitionCountDelta final check", () => {
  beforeEach(() => {
    mockState.definitions = [];
  });

  it("passes when a matching definition has the required cadence slots, timezone, and reminder plan", async () => {
    mockState.definitions = [
      definitionRecord(
        {
          title: "Brush teeth 8 am & 9 pm",
          timezone: "America/Denver",
          cadence: {
            kind: "times_per_day",
            slots: [
              { label: "Morning", minuteOfDay: 480, durationMinutes: 15 },
              { label: "Night", minuteOfDay: 1260, durationMinutes: 15 },
            ],
          },
        },
        { id: "plan-1", steps: [{ channel: "in_app", offsetMinutes: 0 }] },
      ),
    ];

    const result = await run({
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: ["Brush teeth 8 am & 9 pm"],
      delta: 1,
      cadenceKind: "times_per_day",
      requiredSlots: [{ minuteOfDay: 480 }, { minuteOfDay: 1260 }],
      expectedTimeZone: "America/Denver",
      requireReminderPlan: true,
    });

    expect(result.status).toBe("passed");
  });

  it("passes interval cadence and required windows/max occurrence fields", async () => {
    mockState.definitions = [
      definitionRecord(
        {
          title: "Drink water",
          cadence: {
            kind: "interval",
            everyMinutes: 180,
            maxOccurrencesPerDay: 4,
            windows: ["morning", "afternoon", "evening"],
          },
        },
        { id: "plan-1" },
      ),
    ];

    const result = await run({
      type: "definitionCountDelta",
      title: "Drink water",
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 180,
      requiredMaxOccurrencesPerDay: 4,
      requiredWindows: ["morning", "afternoon", "evening"],
      requireReminderPlan: true,
    });

    expect(result.status).toBe("passed");
  });

  it("fails when a matching definition is missing a required slot", async () => {
    mockState.definitions = [
      definitionRecord({
        title: "Brush teeth",
        cadence: {
          kind: "times_per_day",
          slots: [{ label: "Morning", minuteOfDay: 480 }],
        },
      }),
    ];

    const result = await run({
      type: "definitionCountDelta",
      title: "Brush teeth",
      delta: 1,
      cadenceKind: "times_per_day",
      requiredSlots: [{ minuteOfDay: 480 }, { minuteOfDay: 1260 }],
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("1260");
  });

  it("fails when a once definition lands on a forbidden local due time", async () => {
    mockState.definitions = [
      definitionRecord({
        title: "Drink water",
        timezone: "America/New_York",
        cadence: {
          kind: "once",
          dueAt: "2026-07-04T13:00:00.000Z",
        },
      }),
    ];

    const result = await run({
      type: "definitionCountDelta",
      title: "Drink water",
      delta: 1,
      cadenceKind: "once",
      forbiddenDueLocalTimes: [{ hour: 9, minute: 0 }],
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("09:00");
    expect(result.detail).toContain("forbidden");
  });

  it("lists the stored definition titles when no title matches (misroute diagnostic)", async () => {
    // The live gemma-4-31b brush-teeth misroute saved the habit under the
    // goals store / a different title; the "saw none" branch must name what
    // WAS stored so the misroute is diagnosable from the report alone.
    mockState.definitions = [
      definitionRecord({ title: "Evening wind-down" }),
      definitionRecord({ title: "Morning stretch" }),
    ];

    const result = await run({
      type: "definitionCountDelta",
      title: "Brush teeth",
      delta: 1,
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("saw none among 2 definition(s)");
    expect(result.detail).toContain(
      "Stored definition titles: Evening wind-down, Morning stretch",
    );
  });

  it("reports '(none)' stored titles when the definition store is empty", async () => {
    const result = await run({
      type: "definitionCountDelta",
      title: "Brush teeth",
      delta: 1,
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("Stored definition titles: (none)");
  });

  it("fails when website access fields do not match", async () => {
    mockState.definitions = [
      definitionRecord({
        title: "Workout",
        cadence: { kind: "daily", windows: ["afternoon"] },
        websiteAccess: {
          groupKey: "workout",
          websites: ["youtube.com"],
          unlockMode: "fixed_duration",
          unlockDurationMinutes: 30,
        },
      }),
    ];

    const result = await run({
      type: "definitionCountDelta",
      title: "Workout",
      delta: 1,
      websiteAccess: {
        unlockMode: "fixed_duration",
        unlockDurationMinutes: 60,
      },
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("websiteAccess");
  });
});
