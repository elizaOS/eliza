/** Verifies the real next-event projection over a supplied multi-event feed;
 * source freshness must never imply that its single result is a full agenda. */

import { AgentRuntime, type Memory } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/shared/contracts/calendar";
import { describe, expect, it, vi } from "vitest";
import { createCalendarActionRunner } from "../actions/calendar-handler.js";
import { CalendarService } from "./CalendarService.js";

describe("next-event read coverage", () => {
  it.each([
    { state: "complete", empty: false },
    { state: "partial", empty: false },
    { state: "complete", empty: true },
  ] as const)(
    "preserves $state source health without claiming exhaustive event coverage (empty=$empty)",
    async ({ state, empty }) => {
      const now = new Date("2026-09-24T10:00:00.000Z");
      const events: LifeOpsCalendarEvent[] = (empty ? [] : [11, 13]).map(
        (hour) => ({
          id: `event-${hour}`,
          externalId: `event-${hour}`,
          agentId: "calendar-owner",
          provider: "eliza",
          side: "owner",
          calendarId: "primary",
          title: `Meeting at ${hour}`,
          description: "",
          location: "",
          status: "confirmed",
          startAt: `2026-09-24T${hour}:00:00.000Z`,
          endAt: `2026-09-24T${hour}:30:00.000Z`,
          isAllDay: false,
          timezone: "UTC",
          htmlLink: null,
          conferenceLink: null,
          organizer: null,
          attendees: [],
          metadata: {},
          syncedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }),
      );
      const feed: LifeOpsCalendarFeed = {
        calendarId: "primary",
        events,
        source: "synced",
        state,
        sources: [],
        timeMin: now.toISOString(),
        timeMax: "2026-10-24T00:00:00.000Z",
        syncedAt: now.toISOString(),
      };
      const original = structuredClone(feed);
      const runtime = new AgentRuntime({
        character: { name: "Calendar coverage", bio: [] },
      });
      const service = new CalendarService(runtime);
      vi.spyOn(service, "getCalendarFeed").mockResolvedValue(feed);

      const result = await service.getNextCalendarEventContext(
        new URL("http://localhost/"),
        { timeZone: "UTC" },
        now,
      );

      expect(result.event).toEqual(events[0] ?? null);
      expect(result.calendarFeedState).toBe(state);
      expect(result.readScope).toEqual({
        selection: "next_event",
        timeMin: feed.timeMin,
        timeMax: feed.timeMax,
        exhaustive: false,
      });
      expect(feed).toEqual(original);

      runtime.services.set(CalendarService.serviceType, [service]);
      const unexpectedModel = async () => {
        throw new Error("Unexpected model call");
      };
      const action = createCalendarActionRunner({
        runTextModel: unexpectedModel,
        runJsonModel: unexpectedModel,
        recentConversationTexts: async () => [],
      });
      const message: Memory = {
        id: "00000000-0000-0000-0000-000000000001",
        entityId: "00000000-0000-0000-0000-000000000002",
        roomId: "00000000-0000-0000-0000-000000000003",
        agentId: runtime.agentId,
        createdAt: now.getTime(),
        content: { text: "What's my next event?" },
      };
      // Freeze the returned projection so the action cannot silently read a
      // different date while this test compares its complete wire evidence.
      vi.spyOn(service, "getNextCalendarEventContext").mockResolvedValue(
        result,
      );
      const outcome = await action.handler(runtime, message, undefined, {
        parameters: { subaction: "next_event", details: { timeZone: "UTC" } },
      });
      if (!outcome || typeof outcome !== "object")
        throw new Error("Expected Calendar result");
      expect(outcome.data).toMatchObject(result);
      expect(outcome.data?.replyContext).toMatchObject({
        scenario: "next_event",
        context: {},
      });
      expect(outcome.effectReceipts?.[0].resource.kind).toBe(
        "calendar.next_event",
      );
      const agenda = await action.handler(
        runtime,
        {
          ...message,
          content: { text: "List my calendar for September 24." },
        },
        undefined,
        {
          parameters: {
            subaction: "feed",
            details: { date: "2026-09-24", timeZone: "UTC" },
          },
        },
      );
      if (!agenda || typeof agenda !== "object")
        throw new Error("Expected agenda result");
      expect(agenda.data).toMatchObject(feed);
      expect(agenda.data?.replyContext).not.toHaveProperty("context.events");
      expect(agenda.effectReceipts?.[0].resource.kind).toBe("calendar.feed");
    },
  );
});
