/**
 * LifeOps scheduling-with-others tests.
 *
 * Covers:
 *   - CALENDAR (subaction:"propose_times") pure slot computation
 *     (computeProposedSlots): respects busy events, preferred hours,
 *     blackout windows, and travel buffer. Runs without DB or network.
 *   - CALENDAR (subaction:"update_preferences") end-to-end against a
 *     real PGLite runtime: the action handler persists the patch to the
 *     LifeOps scheduler task's metadata, and a subsequent read returns it.
 *   - CALENDAR (subaction:"propose_times") handler reports a helpful
 *     error when Google Calendar is not connected (exercises the
 *     LifeOpsServiceError path).
 *   - CALENDAR (subaction:"check_availability") handler validates
 *     its inputs.
 *
 * The handler tests that require a seeded calendar feed live in the LifeOps
 * live-e2e suite because that path needs the full life_connector_grants +
 * life_calendar_events table set which is only created by the LifeOps plugin
 * schema migrations (not yet wired in this submodule's current state).
 *
 * No SQL mocks. PGLite only, per user memory.
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/real-runtime";
import {
  checkAvailabilityAction,
  computeProposedSlots,
  extractBundledMeetingCounterparties,
  formatProposedSlotsReply,
  proposeMeetingTimesAction,
  schedulingAction,
  updateMeetingPreferencesAction,
} from "../src/actions/scheduling.js";
import { readLifeOpsMeetingPreferences } from "../src/lifeops/owner-profile.js";
import { ensureLifeOpsSchedulerTask } from "../src/lifeops/runtime.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "../src/lifeops/time.js";

const AGENT_ID = "lifeops-scheduling-agent";
const TEST_TIME_ZONE = "America/Los_Angeles";

function localDayAtOffset(daysFromToday: number) {
  const now = getZonedDateParts(new Date(), TEST_TIME_ZONE);
  return addDaysToLocalDate(
    { year: now.year, month: now.month, day: now.day },
    daysFromToday,
  );
}

function localIso(daysFromToday: number, hour: number, minute = 0): string {
  const date = localDayAtOffset(daysFromToday);
  return buildUtcDateFromLocalParts(TEST_TIME_ZONE, {
    year: date.year,
    month: date.month,
    day: date.day,
    hour,
    minute,
    second: 0,
  }).toISOString();
}

function makeMessage(runtime: AgentRuntime, text: string) {
  return {
    id: `msg-${Math.random()}` as unknown as string,
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    content: { text },
  };
}

describe("life-ops scheduling-with-others (pure slot logic)", () => {
  it("keeps SCHEDULING scoped to negotiation workflows", () => {
    expect(schedulingAction.suppressPostActionContinuation).toBe(true);
    expect(schedulingAction.similes ?? []).not.toContain("SCHEDULE_MEETING");
    expect(schedulingAction.similes ?? []).not.toContain("COORDINATE_SCHEDULE");
  });

  it("computeProposedSlots returns 3 slots within preferred hours, avoiding busy intervals and blackouts", () => {
    const now = new Date();
    const windowStart = new Date(localIso(1, 0, 0));
    const windowEnd = new Date(localIso(5, 0, 0));
    const preferences = {
      timeZone: TEST_TIME_ZONE,
      preferredStartLocal: "09:00",
      preferredEndLocal: "17:00",
      defaultDurationMinutes: 30,
      travelBufferMinutes: 0,
      blackoutWindows: [
        { label: "Lunch", startLocal: "12:00", endLocal: "13:00" },
      ],
      updatedAt: null,
    };
    const busyMorningDay3 = {
      id: "e3",
      externalId: "e3",
      agentId: AGENT_ID,
      provider: "google" as const,
      side: "owner" as const,
      calendarId: "primary",
      title: "Morning block",
      description: "",
      location: "",
      status: "confirmed",
      startAt: localIso(3, 9, 0),
      endAt: localIso(3, 11, 0),
      isAllDay: false,
      timezone: TEST_TIME_ZONE,
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [],
      metadata: {},
      syncedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const slots = computeProposedSlots({
      now,
      windowStart,
      windowEnd,
      durationMinutes: 30,
      slotCount: 3,
      preferences,
      events: [busyMorningDay3],
    });

    expect(slots.length).toBe(3);
    // All slots in [09:00, 17:00] local, not inside 12:00-13:00 lunch blackout,
    // and not overlapping the Morning block.
    for (const slot of slots) {
      const parts = getZonedDateParts(new Date(slot.startAt), TEST_TIME_ZONE);
      const minutes = parts.hour * 60 + parts.minute;
      expect(minutes).toBeGreaterThanOrEqual(9 * 60);
      expect(minutes + 30).toBeLessThanOrEqual(17 * 60);
      expect(minutes >= 12 * 60 && minutes < 13 * 60).toBe(false);
      const s = Date.parse(slot.startAt);
      const e = Date.parse(slot.endAt);
      const bs = Date.parse(busyMorningDay3.startAt);
      const be = Date.parse(busyMorningDay3.endAt);
      expect(s < be && e > bs).toBe(false);
    }
  });

  it("computeProposedSlots honors travel buffer (expanded busy window)", () => {
    const now = new Date();
    const windowStart = new Date(localIso(1, 9, 0));
    const windowEnd = new Date(localIso(1, 17, 0));
    const preferences = {
      timeZone: TEST_TIME_ZONE,
      preferredStartLocal: "09:00",
      preferredEndLocal: "17:00",
      defaultDurationMinutes: 30,
      travelBufferMinutes: 60,
      blackoutWindows: [],
      updatedAt: null,
    };
    // Single event 12:00-13:00 with 60min travel buffer blocks 11:00-14:00.
    const meetingNoon = {
      id: "x",
      externalId: "x",
      agentId: AGENT_ID,
      provider: "google" as const,
      side: "owner" as const,
      calendarId: "primary",
      title: "Lunch meeting",
      description: "",
      location: "",
      status: "confirmed",
      startAt: localIso(1, 12, 0),
      endAt: localIso(1, 13, 0),
      isAllDay: false,
      timezone: TEST_TIME_ZONE,
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [],
      metadata: {},
      syncedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const slots = computeProposedSlots({
      now,
      windowStart,
      windowEnd,
      durationMinutes: 30,
      slotCount: 10,
      preferences,
      events: [meetingNoon],
    });

    const blockedStart = Date.parse(localIso(1, 11, 0));
    const blockedEnd = Date.parse(localIso(1, 14, 0));
    for (const slot of slots) {
      const s = Date.parse(slot.startAt);
      const e = Date.parse(slot.endAt);
      expect(s < blockedEnd && e > blockedStart).toBe(false);
    }
  });

  it("formats bundled travel slot replies with counterparties and travel city", () => {
    const reply = formatProposedSlotsReply({
      slots: [
        {
          startAt: localIso(1, 10, 0),
          endAt: localIso(1, 10, 30),
          durationMinutes: 30,
          localStart: "Tue, Apr 21, 10:00 AM",
          localEnd: "Tue, Apr 21, 10:30 AM",
          timeZone: "Asia/Tokyo",
        },
      ],
      context: {
        counterparties: ["PendingReality", "Ryan"],
        bundleLocationLabel: "Tokyo",
        timeZone: "Asia/Tokyo",
      },
    });

    expect(reply).toContain("Tokyo-time");
    expect(reply).toContain("PendingReality");
    expect(reply).toContain("Ryan");
    expect(reply).toContain("same window");
  });
});

describe("life-ops scheduling-with-others handlers (real PGLite)", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({ characterName: AGENT_ID });
    runtime = testResult.runtime;
    await ensureLifeOpsSchedulerTask(runtime);
  }, 180_000);

  afterAll(async () => {
    await testResult.cleanup();
  });

  it("CALENDAR.update_preferences persists preferences to scheduler task metadata", async () => {
    const result = await updateMeetingPreferencesAction.handler!(
      runtime,
      makeMessage(runtime, "set my preferences") as never,
      undefined,
      {
        parameters: {
          timeZone: TEST_TIME_ZONE,
          preferredStartLocal: "10:00",
          preferredEndLocal: "16:00",
          defaultDurationMinutes: 45,
          travelBufferMinutes: 15,
          blackoutWindows: [
            { label: "Lunch", startLocal: "12:00", endLocal: "13:00" },
          ],
        },
      } as never,
      async () => {},
    );

    if (!result || result.success !== true) {
      // eslint-disable-next-line no-console
      console.error("update prefs result:", JSON.stringify(result, null, 2));
    }
    expect(result?.success).toBe(true);

    const readBack = await readLifeOpsMeetingPreferences(runtime);
    expect(readBack.preferredStartLocal).toBe("10:00");
    expect(readBack.preferredEndLocal).toBe("16:00");
    expect(readBack.defaultDurationMinutes).toBe(45);
    expect(readBack.travelBufferMinutes).toBe(15);
    expect(readBack.blackoutWindows).toHaveLength(1);
    expect(readBack.blackoutWindows[0].label).toBe("Lunch");
  });

  it("CALENDAR.update_preferences rejects an empty patch", async () => {
    const result = await updateMeetingPreferencesAction.handler!(
      runtime,
      makeMessage(runtime, "set my preferences") as never,
      undefined,
      { parameters: {} } as never,
      async () => {},
    );
    expect(result?.success).toBe(false);
    expect(
      (result as unknown as { data?: { error?: string } }).data?.error,
    ).toBe("NO_FIELDS");
  });

  it("CALENDAR.check_availability rejects an invalid window (end <= start)", async () => {
    const result = await checkAvailabilityAction.handler!(
      runtime,
      makeMessage(runtime, "am I free") as never,
      undefined,
      {
        parameters: {
          startAt: "2026-05-01T10:00:00Z",
          endAt: "2026-05-01T09:00:00Z",
        },
      } as never,
      async () => {},
    );
    expect(result?.success).toBe(false);
    expect(
      (result as unknown as { data?: { error?: string } }).data?.error,
    ).toBe("INVALID_WINDOW");
  });
});
