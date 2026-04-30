import type {
  LifeOpsReminderChannel,
  LifeOpsReminderUrgency,
  LifeOpsTaskDefinition,
} from "@elizaos/app-lifeops";
import { describe, expect, it } from "vitest";
import {
  REMINDER_ACTIVITY_GATE_METADATA_KEY,
  REMINDER_URGENCY_METADATA_KEY,
} from "../src/lifeops/service-constants.js";
import {
  isWithinQuietHours,
  priorityToUrgency,
} from "../src/lifeops/service-helpers-misc.js";
import {
  classifyReminderOwnerResponseText,
  rankReminderEscalationChannels,
  resolveReminderDeliveryUrgency,
  shouldDeferReminderUntilComputerActive,
} from "../src/lifeops/service-helpers-reminder.js";
import type { ReminderActivityProfileSnapshot } from "../src/lifeops/service-types.js";

function buildDefinition(
  overrides: Partial<
    Pick<
      LifeOpsTaskDefinition,
      "title" | "originalIntent" | "cadence" | "metadata"
    >
  > = {},
): Pick<
  LifeOpsTaskDefinition,
  "title" | "originalIntent" | "cadence" | "metadata"
> {
  return {
    title: "Stretch",
    originalIntent: "stretch every 2 hours while I'm working",
    cadence: {
      kind: "interval",
      everyMinutes: 120,
      windows: ["morning", "afternoon", "evening"],
      maxOccurrencesPerDay: 2,
    },
    metadata: {
      [REMINDER_ACTIVITY_GATE_METADATA_KEY]: "active_on_computer",
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
    circadianState: "awake",
    stateConfidence: 0.8,
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
  definition: Pick<
    LifeOpsTaskDefinition,
    "title" | "originalIntent" | "cadence" | "metadata"
  >,
  urgency?: LifeOpsReminderUrgency,
): boolean {
  return shouldDeferReminderUntilComputerActive({
    channel,
    activityProfile: profile,
    definition,
    urgency,
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

  it("does not defer high-priority stretch reminders", () => {
    expect(
      shouldDefer(
        "in_app",
        buildActivityProfile({ isCurrentlyActive: false }),
        buildDefinition(),
        "high",
      ),
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
          metadata: {},
        }),
      ),
    ).toBe(false);
  });

  it("uses explicit activity-gate metadata rather than routine text", () => {
    expect(
      shouldDefer(
        "in_app",
        buildActivityProfile({ isCurrentlyActive: false }),
        buildDefinition({ metadata: {} }),
      ),
    ).toBe(false);
  });
});

describe("rankReminderEscalationChannels", () => {
  it("starts in app and uses observed or configured channels only", () => {
    const channels = rankReminderEscalationChannels({
      activityProfile: buildActivityProfile({
        primaryPlatform: "telegram",
        secondaryPlatform: "discord",
        lastSeenPlatform: "telegram",
      }),
      ownerContactHints: {},
      ownerContactSources: [],
      policyChannels: ["sms"],
    });

    expect(channels.slice(0, 4)).toEqual([
      "in_app",
      "telegram",
      "discord",
      "sms",
    ]);
  });

  it("does not invent escalation channels when usage is unknown", () => {
    const channels = rankReminderEscalationChannels({
      activityProfile: null,
      ownerContactHints: {},
      ownerContactSources: [],
      policyChannels: [],
    });

    expect(channels).toEqual(["in_app"]);
  });
});

describe("classifyReminderOwnerResponseText", () => {
  it("treats explicit completion as a reminder resolution", () => {
    expect(classifyReminderOwnerResponseText("done")).toMatchObject({
      decision: "explicit_resolution",
      resolution: "completed",
    });
  });

  it("does not treat unrelated chat as acknowledgement", () => {
    expect(classifyReminderOwnerResponseText("what time is it?")).toMatchObject(
      {
        decision: "unrelated",
        resolution: null,
      },
    );
  });
});

describe("resolveReminderDeliveryUrgency", () => {
  it("keeps task priority separate from delivery urgency metadata", () => {
    expect(
      resolveReminderDeliveryUrgency({
        priority: 4,
        metadata: { [REMINDER_URGENCY_METADATA_KEY]: "high" },
      }),
    ).toBe("high");
    expect(
      resolveReminderDeliveryUrgency({
        priority: 4,
        metadata: {},
      }),
    ).toBe("low");
  });
});

describe("priorityToUrgency", () => {
  it("uses the stored LifeOps 1-5 priority scale", () => {
    expect(priorityToUrgency(1)).toBe("critical");
    expect(priorityToUrgency(2)).toBe("high");
    expect(priorityToUrgency(3)).toBe("medium");
    expect(priorityToUrgency(4)).toBe("low");
    expect(priorityToUrgency(5)).toBe("low");
  });
});

describe("isWithinQuietHours", () => {
  it("uses the normalized minute-based quiet-hours contract", () => {
    const quietHours = {
      timezone: "America/Los_Angeles",
      startMinute: 6 * 60,
      endMinute: 8 * 60,
      channels: ["push"],
    };

    expect(
      isWithinQuietHours({
        now: new Date("2026-04-28T13:30:00.000Z"),
        quietHours,
        channel: "push",
      }),
    ).toBe(true);
    expect(
      isWithinQuietHours({
        now: new Date("2026-04-28T13:30:00.000Z"),
        quietHours,
        channel: "sms",
      }),
    ).toBe(false);
  });
});
