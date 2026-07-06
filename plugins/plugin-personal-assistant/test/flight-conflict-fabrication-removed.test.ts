/**
 * Regression tests for the deleted fabricated flight-conflict template
 * (#10721 / #10723).
 *
 * A keyword gate (flight/JFK × meeting/board × lands/rebook) used to intercept
 * the CALENDAR umbrella BEFORE subaction resolution — and a near-copy hijacked
 * the LifeOps direct-message path in `plugin.ts` — returning a scripted
 * "Your 8 AM JFK arrival is too tight for the 9 AM board meeting…" success
 * regardless of the actual times or calendar contents. These tests pin the
 * honest behavior: flight-vs-meeting questions flow through normal subaction
 * resolution and answer from real calendar data.
 */

import type {
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { calendarAction } from "../src/actions/calendar.js";

/**
 * Matches only the deleted scripted reply (both variants said "too tight" and
 * named a JFK arrival), not legitimate data-derived conflict answers.
 */
const CANNED_TEMPLATE = /too tight|jfk arrival|rebook to an arrival/i;

/**
 * Trips every group of the old keyword gate (flight/jfk × board ×
 * lands/rebook/make) while avoiding the literal word "meetings", so the
 * bulk_reschedule cohort extraction stays on its default path.
 */
const FLIGHT_CONFLICT_TEXT =
  "My flight lands at JFK at 8 AM — should I rebook, or can I make the 9 AM board sync?";

function makeMessage(text: string): Memory {
  return {
    id: "msg-flight-1" as UUID,
    entityId: "owner-1" as UUID,
    roomId: "room-flight-1" as UUID,
    content: { text, source: "test" },
  } as Memory;
}

function makeLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
}

function collectCallback(sink: string[]): HandlerCallback {
  return (async (content: { text?: string }) => {
    if (typeof content.text === "string") sink.push(content.text);
    return [];
  }) as HandlerCallback;
}

describe("CALENDAR — fabricated flight-conflict template removed", () => {
  it("routes a flight-vs-meeting question into real subaction resolution instead of a canned success", async () => {
    // useModel returns unparseable output on both extraction passes, so the
    // umbrella must ask for clarification — never fabricate a conflict answer.
    const useModel = vi.fn(async () => "");
    const runtime = {
      agentId: "agent-flight-test" as UUID,
      logger: makeLogger(),
      useModel,
      getService: () => null,
    } as unknown as IAgentRuntime;
    const callbackTexts: string[] = [];

    const result = (await calendarAction.handler(
      runtime,
      makeMessage(FLIGHT_CONFLICT_TEXT),
      undefined,
      { parameters: {} } as HandlerOptions,
      collectCallback(callbackTexts),
    )) as ActionResult;

    // The message reached the real extraction pipeline (the old gate returned
    // before resolveActionArgs, so useModel was never called).
    expect(useModel).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "MISSING_SUBACTION" });
    expect(
      (result.data as { subaction?: string } | undefined)?.subaction,
    ).toBeUndefined();
    expect(String(result.text ?? "")).not.toMatch(CANNED_TEMPLATE);
    for (const text of callbackTexts) {
      expect(text).not.toMatch(CANNED_TEMPLATE);
    }
  });

  it("answers explicit planner subactions from the real calendar feed even when the text mentions flights", async () => {
    const getCalendarFeed = vi.fn(async () => ({
      calendarId: "all",
      events: [
        {
          id: "evt-flight",
          title: "Flight SFO → JFK",
          description: "",
          location: "",
          startAt: "2026-07-08T12:00:00.000Z",
          endAt: "2026-07-08T12:30:00.000Z",
          isAllDay: false,
          timezone: "America/New_York",
          attendees: [],
        },
        {
          id: "evt-board",
          title: "Board sync",
          description: "",
          location: "NYC office",
          startAt: "2026-07-08T13:00:00.000Z",
          endAt: "2026-07-08T15:00:00.000Z",
          isAllDay: false,
          timezone: "America/New_York",
          attendees: [],
        },
      ],
      source: "synced",
      timeMin: "2026-07-01T00:00:00.000Z",
      timeMax: "2026-08-15T00:00:00.000Z",
      syncedAt: null,
    }));
    const runtime = {
      agentId: "agent-flight-test" as UUID,
      logger: makeLogger(),
      getService: () => ({ getCalendarFeed }),
    } as unknown as IAgentRuntime;
    const callbackTexts: string[] = [];

    const result = (await calendarAction.handler(
      runtime,
      makeMessage(FLIGHT_CONFLICT_TEXT),
      undefined,
      { parameters: { action: "bulk_reschedule" } } as HandlerOptions,
      collectCallback(callbackTexts),
    )) as ActionResult;

    // The planner-trusted subaction executed against the seeded feed — the
    // old gate hijacked the handler before parameters were even read.
    expect(getCalendarFeed).toHaveBeenCalled();
    expect(result.success).toBe(true);
    const data = result.data as {
      subaction: string;
      matchedEvents: { id: string }[];
    };
    expect(data.subaction).toBe("bulk_reschedule");
    expect(data.matchedEvents.map((event) => event.id)).toContain("evt-board");
    expect(String(result.text ?? "")).not.toMatch(CANNED_TEMPLATE);
    for (const text of callbackTexts) {
      expect(text).not.toMatch(CANNED_TEMPLATE);
    }
  });
});
