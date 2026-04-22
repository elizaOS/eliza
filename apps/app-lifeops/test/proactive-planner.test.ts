import { describe, expect, it } from "vitest";
import {
  planGm,
  planGn,
  type InboxDigestSlim,
  type ProactiveRelativeTimeSlim,
} from "../src/activity-profile/proactive-planner.js";
import { readFiredLogFromMetadata } from "../src/activity-profile/service.js";
import type {
  ActivityProfile,
  FiredActionsLog,
} from "../src/activity-profile/types.js";
import { emptyBucketCounts } from "../src/activity-profile/types.js";

const ZONE = "America/Los_Angeles";
const PROFILE_NOW = Date.UTC(2026, 3, 19, 16, 0);

function localDateInZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): Date {
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  let candidate = probe;
  for (let i = 0; i < 5; i++) {
    const parts = fmt.formatToParts(candidate);
    const get = (type: string) =>
      Number.parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
    const h = get("hour") % 24;
    const m = get("minute");
    const diffMinutes = (hour - h) * 60 + (minute - m);
    if (diffMinutes === 0) return candidate;
    candidate = new Date(candidate.getTime() + diffMinutes * 60_000);
  }
  return candidate;
}

function buildProfile(
  overrides: Partial<ActivityProfile> = {},
): ActivityProfile {
  const todayKey = "2026-04-19";
  return {
    ownerEntityId: "00000000-0000-0000-0000-000000000001",
    analyzedAt: PROFILE_NOW,
    analysisWindowDays: 14,
    timezone: ZONE,
    totalMessages: 10,
    sustainedInactivityThresholdMinutes: 180,
    platforms: [],
    primaryPlatform: "client_chat",
    secondaryPlatform: null,
    bucketCounts: emptyBucketCounts(),
    hasCalendarData: false,
    typicalFirstEventHour: null,
    typicalLastEventHour: null,
    avgWeekdayMeetings: null,
    typicalFirstActiveHour: 9,
    typicalLastActiveHour: 22,
    typicalWakeHour: null,
    typicalSleepHour: null,
    hasSleepData: false,
    isCurrentlySleeping: false,
    lastSleepSignalAt: null,
    lastWakeSignalAt: null,
    sleepSourcePlatform: null,
    sleepSource: null,
    typicalSleepDurationMinutes: null,
    lastSeenAt: PROFILE_NOW - 60_000,
    lastSeenPlatform: "client_chat",
    isCurrentlyActive: true,
    hasOpenActivityCycle: true,
    currentActivityCycleStartedAt: PROFILE_NOW - 60_000,
    currentActivityCycleLocalDate: todayKey,
    effectiveDayKey: todayKey,
    screenContextFocus: null,
    screenContextSource: null,
    screenContextSampledAt: null,
    screenContextConfidence: null,
    screenContextBusy: false,
    screenContextAvailable: false,
    screenContextStale: false,
    ...overrides,
  };
}

function buildRelativeTime(
  overrides: Partial<ProactiveRelativeTimeSlim> = {},
): ProactiveRelativeTimeSlim {
  return {
    wakeAnchorAt: null,
    bedtimeTargetAt: null,
    minutesSinceWake: null,
    minutesUntilBedtimeTarget: null,
    ...overrides,
  };
}

function buildInboxDigest(
  overrides: Partial<InboxDigestSlim> = {},
): InboxDigestSlim {
  return {
    unreadCount: 3,
    channelCounts: [
      { channel: "gmail", unreadCount: 2 },
      { channel: "telegram", unreadCount: 1 },
    ],
    highlights: [
      {
        channel: "gmail",
        sender: "Finance",
        subject: "Invoice approval",
        snippet: "Need your sign-off before noon.",
        receivedAt: new Date(PROFILE_NOW - 10 * 60_000).toISOString(),
        unread: true,
      },
    ],
    ...overrides,
  };
}

describe("planGn", () => {
  it("schedules GN in the evening for an evening-active user", () => {
    const now = localDateInZone(2026, 4, 19, 17, 20, ZONE);
    const profile = buildProfile({ typicalLastActiveHour: 22 });
    const result = planGn(profile, null, null, null, ZONE, now);
    expect(result).not.toBeNull();
    expect(result?.scheduledFor).toBeGreaterThan(now.getTime());
  });

  it("never schedules GN before the evening floor — even when the user's typical last-active hour is in the early morning (LATE_NIGHT bucket)", () => {
    const now = localDateInZone(2026, 4, 19, 17, 20, ZONE);
    // Simulates the bug: a user whose typicalLastActiveHour was set to 3
    // (LATE_NIGHT bucket midpoint). Pre-fix this produced a GN scheduled
    // for 4 AM today, which the dispatcher fired immediately and re-fired
    // every 60s tick.
    const profile = buildProfile({ typicalLastActiveHour: 3 });
    const result = planGn(profile, null, null, null, ZONE, now);
    expect(result).not.toBeNull();
    // GN must be scheduled for the future, not the past.
    expect(result?.scheduledFor).toBeGreaterThan(now.getTime());
  });

  it("does not re-fire GN when one was sent within the last 12 hours, even when the day key flips", () => {
    const now = localDateInZone(2026, 4, 19, 22, 5, ZONE);
    const profile = buildProfile({ typicalLastActiveHour: 22 });
    // Imagine the planner fired GN 2 minutes ago. firedToday's `date`
    // could have been written under a different effective day key, but
    // we still want the timestamp-based gate to suppress the re-fire.
    const firedLog: FiredActionsLog = {
      date: "2026-04-18",
      gnFiredAt: now.getTime() - 2 * 60_000,
      nudgedOccurrenceIds: [],
      nudgedCalendarEventIds: [],
      checkedGoalIds: [],
    };
    const result = planGn(profile, null, null, firedLog, ZONE, now);
    expect(result).toBeNull();
  });

  it("allows GN again 12+ hours after the last fire (next calendar day)", () => {
    const now = localDateInZone(2026, 4, 19, 22, 5, ZONE);
    const profile = buildProfile({ typicalLastActiveHour: 22 });
    const firedLog: FiredActionsLog = {
      date: "2026-04-18",
      // Yesterday's GN fired 24 hours ago — should not block today's.
      gnFiredAt: now.getTime() - 24 * 60 * 60 * 1000,
      nudgedOccurrenceIds: [],
      nudgedCalendarEventIds: [],
      checkedGoalIds: [],
    };
    const result = planGn(profile, null, null, firedLog, ZONE, now);
    expect(result).not.toBeNull();
  });

  it("targets two hours before the computed bedtime when relative time is available", () => {
    const now = localDateInZone(2026, 4, 19, 20, 55, ZONE);
    const bedtime = localDateInZone(2026, 4, 19, 23, 0, ZONE).toISOString();
    const profile = buildProfile({ typicalLastActiveHour: 22 });
    const result = planGn(
      profile,
      buildRelativeTime({
        bedtimeTargetAt: bedtime,
        minutesUntilBedtimeTarget: 125,
      }),
      buildInboxDigest(),
      null,
      ZONE,
      now,
    );
    expect(result).not.toBeNull();
    expect(result?.scheduledFor).toBe(
      new Date(bedtime).getTime() - 2 * 60 * 60 * 1000,
    );
    expect(result?.messageText).toContain("Night summary.");
    expect(result?.messageText).toContain("Finance on gmail");
  });
});

describe("planGm", () => {
  it("does not re-fire GM when one was sent within the last 12 hours", () => {
    const now = localDateInZone(2026, 4, 19, 8, 30, ZONE);
    const profile = buildProfile({ typicalFirstActiveHour: 8 });
    const firedLog: FiredActionsLog = {
      date: "2026-04-18",
      gmFiredAt: now.getTime() - 2 * 60_000,
      nudgedOccurrenceIds: [],
      nudgedCalendarEventIds: [],
      checkedGoalIds: [],
    };
    const result = planGm(profile, [], [], null, null, firedLog, ZONE, now);
    expect(result).toBeNull();
  });

  it("targets the wake anchor and includes inbox digest context", () => {
    const now = localDateInZone(2026, 4, 19, 7, 8, ZONE);
    const wakeAnchor = localDateInZone(2026, 4, 19, 7, 2, ZONE).toISOString();
    const profile = buildProfile({
      typicalFirstActiveHour: 8,
      currentActivityCycleLocalDate: "2026-04-19",
      effectiveDayKey: "2026-04-19",
    });
    const result = planGm(
      profile,
      [],
      [],
      buildRelativeTime({
        wakeAnchorAt: wakeAnchor,
        minutesSinceWake: 6,
      }),
      buildInboxDigest(),
      null,
      ZONE,
      now,
    );
    expect(result).not.toBeNull();
    expect(result?.scheduledFor).toBe(new Date(wakeAnchor).getTime());
    expect(result?.messageText).toContain("Good morning.");
    expect(result?.messageText).toContain("3 unread");
    expect(result?.messageText).toContain("Finance on gmail");
  });
});

describe("readFiredLogFromMetadata", () => {
  it("returns null when no log exists", () => {
    expect(readFiredLogFromMetadata({}, "2026-04-19")).toBeNull();
    expect(readFiredLogFromMetadata(null, "2026-04-19")).toBeNull();
  });

  it("returns the log as-is when the date matches today", () => {
    const stored: FiredActionsLog = {
      date: "2026-04-19",
      gnFiredAt: 1000,
      nudgedOccurrenceIds: ["a"],
      nudgedCalendarEventIds: [],
      checkedGoalIds: ["g1"],
    };
    const result = readFiredLogFromMetadata(
      { firedActionsLog: stored },
      "2026-04-19",
    );
    expect(result).toEqual(stored);
  });

  it("preserves GM/GN timestamps across day boundaries while resetting per-day arrays", () => {
    // The previous tick's log is from yesterday. We must keep the
    // gmFiredAt/gnFiredAt timestamps so the planner's once-per-12h gate
    // can still suppress repeated fires across an effective-day-key flip,
    // but per-day nudge IDs must reset so today's nudges aren't blocked.
    const yesterdayLog: FiredActionsLog = {
      date: "2026-04-18",
      gmFiredAt: 1111,
      gnFiredAt: 2222,
      nudgedOccurrenceIds: ["o1", "o2"],
      nudgedCalendarEventIds: ["e1"],
      checkedGoalIds: ["g1"],
      seedingOfferedAt: 3333,
    };
    const result = readFiredLogFromMetadata(
      { firedActionsLog: yesterdayLog },
      "2026-04-19",
    );
    expect(result).not.toBeNull();
    expect(result?.date).toBe("2026-04-19");
    expect(result?.gmFiredAt).toBe(1111);
    expect(result?.gnFiredAt).toBe(2222);
    expect(result?.seedingOfferedAt).toBe(3333);
    expect(result?.nudgedOccurrenceIds).toEqual([]);
    expect(result?.nudgedCalendarEventIds).toEqual([]);
    expect(result?.checkedGoalIds).toEqual([]);
  });
});
