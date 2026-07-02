/**
 * Owner-timezone decision paths (refs #10721 #10723).
 *
 * Two decision surfaces previously classified time in the SERVER's zone:
 *
 * 1. `enrichWithCalendar` derived each event's weekday via `Date#getDay()`
 *    (server zone) while deriving its hours via `getZonedDateParts`
 *    (owner zone) — an owner-Monday 03:00 meeting could be counted as a
 *    weekend event whenever the server sat west of the owner.
 * 2. `evaluateProactiveBlockOnBrowserFocus` resolved its enforcement-window
 *    zone from `resolveDefaultTimeZone()` (the server's `Intl` zone) even
 *    when the owner's timezone fact was on file — "don't let me use X in
 *    the morning" fired on the server's morning, not the owner's.
 *
 * Both suites pick instants whose owner-zone classification differs from
 * the classification in UTC and in every US zone, so they fail loudly on
 * the old code regardless of which of those zones CI runs in.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  type CalendarEventRecord,
  enrichWithCalendar,
} from "../src/activity-profile/analyzer.ts";
import { emptyBucketCounts } from "../src/activity-profile/types.ts";
import { resolveOwnerFactStore } from "../src/lifeops/owner/fact-store.ts";
import type { BlockRule } from "../src/website-blocker/chat-integration/block-rule-schema.ts";
import { evaluateProactiveBlockOnBrowserFocus } from "../src/website-blocker/proactive-block-bridge.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

// ── enrichWithCalendar: weekday classification in the OWNER zone ──────────

type CalendarProfileInput = Parameters<typeof enrichWithCalendar>[0];

function baseProfile(timezone: string): CalendarProfileInput {
  return {
    ownerEntityId: "owner-1",
    analyzedAt: Date.parse("2026-05-11T06:00:00.000Z"),
    analysisWindowDays: 14,
    timezone,
    totalMessages: 0,
    sustainedInactivityThresholdMinutes: 180,
    platforms: [],
    primaryPlatform: null,
    secondaryPlatform: null,
    bucketCounts: emptyBucketCounts(),
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
    lastSeenAt: Date.parse("2026-05-11T05:00:00.000Z"),
    lastSeenPlatform: null,
    isCurrentlyActive: false,
    hasOpenActivityCycle: false,
    currentActivityCycleStartedAt: null,
    currentActivityCycleLocalDate: null,
    effectiveDayKey: "2026-05-11",
    screenContextFocus: null,
    screenContextSource: null,
    screenContextSampledAt: null,
    screenContextConfidence: null,
    screenContextBusy: false,
    screenContextAvailable: false,
    screenContextStale: false,
  };
}

describe("enrichWithCalendar weekday classification (owner zone)", () => {
  it("counts an owner-Monday-morning meeting as a weekday meeting even when the server's calendar still says Sunday", () => {
    // 2026-05-10T18:00Z is Sunday in UTC and every US zone, but already
    // Monday 03:00 in Asia/Tokyo (UTC+9).
    const events: CalendarEventRecord[] = [
      {
        startAt: "2026-05-10T18:00:00.000Z",
        endAt: "2026-05-10T19:00:00.000Z",
        isAllDay: false,
      },
    ];
    const profile = enrichWithCalendar(
      baseProfile("Asia/Tokyo"),
      events,
      "Asia/Tokyo",
    );
    expect(profile.hasCalendarData).toBe(true);
    expect(profile.typicalFirstEventHour).toBe(3); // 03:00 Tokyo
    expect(profile.typicalLastEventHour).toBe(4); // 04:00 Tokyo
    expect(profile.avgWeekdayMeetings).toBe(1);
  });

  it("excludes an owner-Sunday-evening event that lands on the server's Monday", () => {
    // 2026-05-10T23:00Z (Sunday 16:00 in America/Los_Angeles) is already
    // Monday 08:00 in Asia/Tokyo — for an LA owner it must stay a weekend
    // event even when the server runs in UTC+.
    const events: CalendarEventRecord[] = [
      {
        startAt: "2026-05-10T23:00:00.000Z",
        endAt: "2026-05-11T00:00:00.000Z",
        isAllDay: false,
      },
    ];
    const profile = enrichWithCalendar(
      baseProfile("America/Los_Angeles"),
      events,
      "America/Los_Angeles",
    );
    expect(profile.hasCalendarData).toBe(true);
    expect(profile.typicalFirstEventHour).toBeNull();
    expect(profile.avgWeekdayMeetings).toBeNull();
  });
});

// ── proactive block bridge: enforcement windows in the OWNER zone ─────────

function activeRule(websites: string[]): BlockRule {
  return {
    id: "rule-1",
    agentId: "agent-1",
    profile: "focus",
    websites,
    gateType: "manual",
    gateTodoId: null,
    gateUntilMs: null,
    fixedDurationMs: null,
    unlockDurationMs: null,
    active: true,
    createdAt: Date.parse("2026-05-01T00:00:00.000Z"),
    releasedAt: null,
    releasedReason: null,
  };
}

async function seedOwnerTimezone(
  runtime: IAgentRuntime,
  timezone: string,
): Promise<void> {
  await resolveOwnerFactStore(runtime).update(
    { timezone },
    { source: "profile_save", recordedAt: new Date().toISOString() },
  );
}

describe("evaluateProactiveBlockOnBrowserFocus enforcement-window zone", () => {
  // 2026-05-11T00:30Z: Tokyo 09:30 (inside the default 06:00-10:00 morning
  // window). UTC 00:30 and every US zone (16:30-20:30 the prior evening)
  // sit OUTSIDE both default windows, so a server-zone evaluation cannot
  // pass this test by accident.
  const NOW = new Date("2026-05-11T00:30:00.000Z");

  it("enforces during the OWNER's morning window (timezone fact on file)", async () => {
    const runtime = createMinimalRuntimeStub();
    await seedOwnerTimezone(runtime, "Asia/Tokyo");
    const outcome = await evaluateProactiveBlockOnBrowserFocus(
      runtime,
      { domain: "example.com" },
      {
        now: () => NOW,
        loadActiveRules: async () => [activeRule(["example.com"])],
        startBlock: async () => ({ success: true }),
        sendAlert: async () => {},
      },
    );
    expect(outcome.reason).toBe("blocked");
    expect(outcome.blocked).toBe(true);
    expect(outcome.enforcementWindowKind).toBe("morning");
  });

  it("stays outside the window for an owner whose local time is evening (explicit zone override)", async () => {
    const runtime = createMinimalRuntimeStub();
    await seedOwnerTimezone(runtime, "Asia/Tokyo");
    const outcome = await evaluateProactiveBlockOnBrowserFocus(
      runtime,
      { domain: "example.com" },
      {
        now: () => NOW,
        timezone: "America/Los_Angeles", // deps override wins over the fact
        loadActiveRules: async () => [activeRule(["example.com"])],
        startBlock: async () => ({ success: true }),
        sendAlert: async () => {},
      },
    );
    expect(outcome.blocked).toBe(false);
    expect(outcome.reason).toBe("outside_enforcement_window");
  });
});
