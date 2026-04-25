import { describe, expect, it } from "vitest";
import { shouldDeferReminderUntilComputerActive } from "../src/lifeops/service-helpers-reminder.js";
import type {
  LifeOpsReminderChannel,
  LifeOpsTaskDefinition,
} from "@elizaos/app-lifeops/contracts";
import type { ReminderActivityProfileSnapshot } from "../src/lifeops/service-types.js";

function buildDefinition(
  overrides: Partial<
    Pick<LifeOpsTaskDefinition, "title" | "originalIntent" | "cadence">
  > = {},
): Pick<LifeOpsTaskDefinition, "title" | "originalIntent" | "cadence"> {
  return {
    title: "Stretch",
    originalIntent: "stretch every 2 hours while I'm working",
    cadence: {
      kind: "interval",
      everyMinutes: 120,
      windows: ["morning", "afternoon", "evening"],
      maxOccurrencesPerDay: 2,
    },
    ...overrides,
  };
}

function buildActivityProfile(
  overrides: Partial<ReminderActivityProfileSnapshot> = {},
): ReminderActivityProfileSnapshot {
  return {
    primaryPlatform: "desktop_app",
    secondaryPlatform: null,
    lastSeenPlatform: "desktop_app",
    isCurrentlyActive: true,
    lastSeenAt: Date.now(),
    isProbablySleeping: false,
    sleepConfidence: 0,
    schedulePhase: "afternoon",
    lastSleepEndedAt: null,
    nextMealLabel: null,
    nextMealWindowStartAt: null,
    nextMealWindowEndAt: null,
    ...overrides,
  };
}

function shouldDefer(
  channel: LifeOpsReminderChannel,
  profile: ReminderActivityProfileSnapshot | null,
  definition: Pick<LifeOpsTaskDefinition, "title" | "originalIntent" | "cadence">,
): boolean {
  return shouldDeferReminderUntilComputerActive({
    channel,
    activityProfile: profile,
    definition,
  });
}

describe("shouldDeferReminderUntilComputerActive", () => {
  it("defers stretch reminders when the owner is inactive", () => {
    expect(
      shouldDefer(
        "in_app",
        buildActivityProfile({ isCurrentlyActive: false }),
        buildDefinition(),
      ),
    ).toBe(true);
  });

  it("defers stretch reminders when the owner is active on mobile instead of desktop", () => {
    expect(
      shouldDefer(
        "in_app",
        buildActivityProfile({
          primaryPlatform: "mobile_app",
          lastSeenPlatform: "mobile_app",
        }),
        buildDefinition(),
      ),
    ).toBe(true);
  });

  it("allows stretch reminders when the owner is actively using a computer", () => {
    expect(
      shouldDefer("in_app", buildActivityProfile(), buildDefinition()),
    ).toBe(false);
  });

  it("does not defer non-stretch reminders", () => {
    expect(
      shouldDefer(
        "in_app",
        buildActivityProfile({ isCurrentlyActive: false }),
        buildDefinition({
          title: "Drink water",
          originalIntent: "drink water during the day",
        }),
      ),
    ).toBe(false);
  });
});
