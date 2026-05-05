import { describe, expect, it } from "vitest";
import {
  planSocialOveruseCheck,
  SOCIAL_OVERUSE_COOLDOWN_MS,
  SOCIAL_OVERUSE_THRESHOLD_MINUTES,
  type SocialHabitSummarySlim,
} from "./proactive-planner.js";
import type { ActivityProfile, FiredActionsLog } from "./types.js";

const NOW = new Date("2026-05-03T16:00:00.000Z");
const TZ = "America/Los_Angeles";

function makeProfile(overrides: Partial<ActivityProfile> = {}): ActivityProfile {
  return {
    ownerEntityId: "00000000-0000-0000-0000-000000000001",
    analyzedAt: NOW.getTime() - 60_000,
    analysisWindowDays: 7,
    timezone: TZ,
    totalMessages: 0,
    sustainedInactivityThresholdMinutes: 60,
    platforms: [],
    primaryPlatform: "client_chat",
    secondaryPlatform: null,
    bucketCounts: {
      EARLY_MORNING: 0,
      MORNING: 0,
      MIDDAY: 0,
      AFTERNOON: 0,
      EVENING: 0,
      NIGHT: 0,
      LATE_NIGHT: 0,
    },
    hasCalendarData: false,
    typicalFirstEventHour: null,
    typicalLastEventHour: null,
    avgWeekdayMeetings: null,
    typicalFirstActiveHour: null,
    typicalLastActiveHour: null,
    typicalWakeHour: null,
    typicalSleepHour: null,
    hasSleepData: false,
    isCurrentlySleeping: false,
    lastSleepSignalAt: null,
    lastWakeSignalAt: null,
    sleepSourcePlatform: null,
    sleepSource: null,
    typicalSleepDurationMinutes: null,
    lastSeenAt: NOW.getTime() - 30_000,
    lastSeenPlatform: "client_chat",
    isCurrentlyActive: true,
    hasOpenActivityCycle: true,
    currentActivityCycleStartedAt: NOW.getTime() - 6 * 60 * 60_000,
    currentActivityCycleLocalDate: "2026-05-03",
    effectiveDayKey: "2026-05-03",
    screenContextFocus: "leisure",
    screenContextSource: "vision",
    screenContextSampledAt: NOW.getTime() - 60_000,
    screenContextConfidence: 0.9,
    screenContextBusy: false,
    screenContextAvailable: true,
    screenContextStale: false,
    ...overrides,
  };
}

function makeSummary(
  totalMinutes: number,
  topServiceLabel: string = "X",
): SocialHabitSummarySlim {
  return {
    totalSeconds: totalMinutes * 60,
    services: [
      { key: "x", label: topServiceLabel, totalSeconds: totalMinutes * 60 },
    ],
  };
}

function makeFiredLog(
  overrides: Partial<FiredActionsLog> = {},
): FiredActionsLog {
  return {
    date: "2026-05-03",
    nudgedOccurrenceIds: [],
    nudgedCalendarEventIds: [],
    checkedGoalIds: [],
    ...overrides,
  };
}

describe("planSocialOveruseCheck", () => {
  it("fires when total social minutes exceed the threshold and no prior fire is logged", () => {
    const action = planSocialOveruseCheck(
      makeProfile(),
      makeSummary(SOCIAL_OVERUSE_THRESHOLD_MINUTES + 30),
      null,
      TZ,
      NOW,
    );

    expect(action).not.toBeNull();
    expect(action?.kind).toBe("social_overuse_check");
    expect(action?.status).toBe("pending");
    expect(action?.scheduledFor).toBe(NOW.getTime());
  });

  it("includes the top service label and rounded minute count in the message text", () => {
    const action = planSocialOveruseCheck(
      makeProfile(),
      makeSummary(82, "X"),
      null,
      TZ,
      NOW,
    );

    expect(action).not.toBeNull();
    expect(action?.messageText).toContain("X");
    expect(action?.messageText).toContain("82m");
    expect(action?.messageText).toContain("90 min");
    expect(action?.contextSummary).toContain("X");
    expect(action?.contextSummary).toContain("82m");
  });

  it("does not fire when social total is at or below the threshold", () => {
    expect(
      planSocialOveruseCheck(
        makeProfile(),
        makeSummary(SOCIAL_OVERUSE_THRESHOLD_MINUTES),
        null,
        TZ,
        NOW,
      ),
    ).toBeNull();

    expect(
      planSocialOveruseCheck(
        makeProfile(),
        makeSummary(45),
        null,
        TZ,
        NOW,
      ),
    ).toBeNull();
  });

  it("does not fire when the cooldown has not elapsed since the last fire", () => {
    const lastFiredAt = NOW.getTime() - (SOCIAL_OVERUSE_COOLDOWN_MS - 60_000);
    const action = planSocialOveruseCheck(
      makeProfile(),
      makeSummary(SOCIAL_OVERUSE_THRESHOLD_MINUTES + 20),
      makeFiredLog({ socialOveruseCheckedAt: lastFiredAt }),
      TZ,
      NOW,
    );
    expect(action).toBeNull();
  });

  it("fires again once the cooldown has fully elapsed", () => {
    const lastFiredAt = NOW.getTime() - (SOCIAL_OVERUSE_COOLDOWN_MS + 60_000);
    const action = planSocialOveruseCheck(
      makeProfile(),
      makeSummary(SOCIAL_OVERUSE_THRESHOLD_MINUTES + 20),
      makeFiredLog({ socialOveruseCheckedAt: lastFiredAt }),
      TZ,
      NOW,
    );
    expect(action).not.toBeNull();
    expect(action?.kind).toBe("social_overuse_check");
  });

  it("does not fire while the user is sleeping", () => {
    const action = planSocialOveruseCheck(
      makeProfile({ isCurrentlySleeping: true }),
      makeSummary(SOCIAL_OVERUSE_THRESHOLD_MINUTES + 20),
      null,
      TZ,
      NOW,
    );
    expect(action).toBeNull();
  });

  it("falls back to a generic label when no service buckets are present", () => {
    const action = planSocialOveruseCheck(
      makeProfile(),
      { totalSeconds: (SOCIAL_OVERUSE_THRESHOLD_MINUTES + 5) * 60, services: [] },
      null,
      TZ,
      NOW,
    );
    expect(action).not.toBeNull();
    expect(action?.messageText).toContain("social media");
  });
});
