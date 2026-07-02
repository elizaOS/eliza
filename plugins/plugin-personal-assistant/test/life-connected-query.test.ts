/**
 * Availability gating for the LIFE action's connected-account queries
 * (query_calendar_today / query_calendar_next / query_email).
 *
 * These operations used to return canned "not connected" refusals
 * unconditionally, even for owners with a live Google grant. The handler now
 * routes through `runLifeConnectedQuery`, which decides availability with the
 * real capability snapshot (`lifeops/access.ts` — getGoogleCapabilityStatus)
 * plus `listCalendars` for Apple-native calendars:
 *
 *   - capability granted            → the query is served from the service
 *   - capability missing            → honest refusal (connected-but-limited vs
 *                                     not-connected wording from access.ts)
 *   - backing service unavailable   → LifeOpsServiceError is translated, not
 *                                     thrown
 *
 * The LifeOpsService is stubbed per test; the agent-module stub makes
 * renderGroundedActionReply deterministic, so success-path assertions target
 * the returned `data` DTO and the service-call spies.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runLifeConnectedQuery } from "../src/actions/life.js";
import type { LifeOpsService } from "../src/lifeops/service.js";
import { LifeOpsServiceError } from "../src/lifeops/service.js";

const runtime = {
  agentId: "agent-life-query-test",
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
} as unknown as IAgentRuntime;

const message = {
  id: "00000000-0000-0000-0000-000000000201",
  entityId: "00000000-0000-0000-0000-000000000202",
  roomId: "00000000-0000-0000-0000-000000000203",
  content: { text: "what's on my calendar today" },
} as unknown as Memory;

function connectorStatus(args: {
  connected: boolean;
  grantedCapabilities: string[];
}) {
  return {
    connected: args.connected,
    grantedCapabilities: args.grantedCapabilities,
    grant: null,
    accounts: [],
  };
}

function calendarEvent(args: { externalId: string; title: string }) {
  return {
    id: `agent-life-query-test:google:owner:calendar:primary:${args.externalId}`,
    externalId: args.externalId,
    agentId: "agent-life-query-test",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: args.title,
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-07-01T17:00:00.000Z",
    endAt: "2026-07-01T18:00:00.000Z",
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    grantId: "connector-account:acct-a",
  };
}

function stubService(args: {
  status?: ReturnType<typeof connectorStatus>;
  statusError?: Error;
  calendars?: unknown[];
  calendarsError?: Error;
  feedEvents?: ReturnType<typeof calendarEvent>[];
  nextEvent?: ReturnType<typeof calendarEvent> | null;
  triageMessages?: Array<Record<string, unknown>>;
}) {
  const service = {
    getGoogleConnectorStatus: vi.fn(async () => {
      if (args.statusError) {
        throw args.statusError;
      }
      return (
        args.status ??
        connectorStatus({ connected: false, grantedCapabilities: [] })
      );
    }),
    listCalendars: vi.fn(async () => {
      if (args.calendarsError) {
        throw args.calendarsError;
      }
      return args.calendars ?? [];
    }),
    getCalendarFeed: vi.fn(async () => ({
      calendarId: "all",
      events: args.feedEvents ?? [],
      source: "synced" as const,
      timeMin: "2026-07-01T00:00:00.000Z",
      timeMax: "2026-07-02T00:00:00.000Z",
      syncedAt: "2026-07-01T12:00:00.000Z",
    })),
    getNextCalendarEventContext: vi.fn(async () => ({
      event: args.nextEvent ?? null,
      startsAt: args.nextEvent?.startAt ?? null,
      startsInMinutes: args.nextEvent ? 45 : null,
      attendeeCount: 0,
      attendeeNames: [],
      location: null,
      conferenceLink: null,
      preparationChecklist: [],
      linkedMailState: "unavailable" as const,
      linkedMailError: null,
      linkedMail: [],
    })),
    getGmailTriage: vi.fn(async () => ({
      messages: args.triageMessages ?? [],
      source: "synced" as const,
      syncedAt: "2026-07-01T12:00:00.000Z",
      summary: {
        unreadCount: args.triageMessages?.length ?? 0,
        importantNewCount: 0,
        likelyReplyNeededCount: 0,
      },
    })),
  };
  return service;
}

type StubService = ReturnType<typeof stubService>;

function run(
  service: StubService,
  queryOperation:
    | "query_calendar_today"
    | "query_calendar_next"
    | "query_email",
) {
  return runLifeConnectedQuery({
    runtime,
    message,
    state: undefined as State | undefined,
    intent: "connected query test",
    service: service as unknown as LifeOpsService,
    queryOperation,
    actionName: "LIFE",
  });
}

describe("query_email availability", () => {
  it("refuses honestly when Google is not connected, without calling triage", async () => {
    const service = stubService({
      status: connectorStatus({ connected: false, grantedCapabilities: [] }),
    });
    const result = await run(service, "query_email");
    expect(result.success).toBe(false);
    expect(result.text).toBe(
      "Gmail is not connected. Connect Google in LifeOps settings to use Gmail actions.",
    );
    expect(service.getGmailTriage).not.toHaveBeenCalled();
  });

  it("refuses with the limited-access wording when connected without triage capability", async () => {
    const service = stubService({
      status: connectorStatus({
        connected: true,
        grantedCapabilities: ["google.calendar.read"],
      }),
    });
    const result = await run(service, "query_email");
    expect(result.success).toBe(false);
    expect(result.text).toBe(
      "Gmail access is limited. Reconnect Google in LifeOps settings to grant Gmail triage and search access.",
    );
    expect(service.getGmailTriage).not.toHaveBeenCalled();
  });

  it("serves the triage feed when the triage capability is granted", async () => {
    const service = stubService({
      status: connectorStatus({
        connected: true,
        grantedCapabilities: ["google.gmail.triage"],
      }),
      triageMessages: [
        {
          id: "msg-1",
          subject: "Quarterly report",
          from: "Dana",
          fromEmail: "dana@example.com",
          receivedAt: "2026-07-01T10:00:00.000Z",
          snippet: "Numbers attached.",
          isImportant: true,
          likelyReplyNeeded: false,
        },
      ],
    });
    const result = await run(service, "query_email");
    expect(result.success).toBe(true);
    expect(service.getGmailTriage).toHaveBeenCalledTimes(1);
    const data = result.data as {
      messages: Array<{ subject: string }>;
      summary: { unreadCount: number };
    };
    expect(data.messages[0]?.subject).toBe("Quarterly report");
    expect(data.summary.unreadCount).toBe(1);
  });

  it("treats a failing status probe as disconnected instead of crashing", async () => {
    const service = stubService({
      statusError: new Error("google connector backend offline"),
    });
    const result = await run(service, "query_email");
    expect(result.success).toBe(false);
    expect(result.text).toBe(
      "Gmail is not connected. Connect Google in LifeOps settings to use Gmail actions.",
    );
  });
});

describe("query_calendar_today availability", () => {
  it("refuses honestly when neither Google read nor any calendar is available", async () => {
    const service = stubService({
      status: connectorStatus({ connected: false, grantedCapabilities: [] }),
      calendars: [],
    });
    const result = await run(service, "query_calendar_today");
    expect(result.success).toBe(false);
    expect(result.text).toBe(
      "Google Calendar is not connected. Connect Google in LifeOps settings to use calendar actions.",
    );
    expect(service.getCalendarFeed).not.toHaveBeenCalled();
  });

  it("serves today's feed when Google calendar read is granted", async () => {
    const service = stubService({
      status: connectorStatus({
        connected: true,
        grantedCapabilities: ["google.calendar.read"],
      }),
      feedEvents: [calendarEvent({ externalId: "evt-1", title: "Standup" })],
    });
    const result = await run(service, "query_calendar_today");
    expect(result.success).toBe(true);
    expect(service.getCalendarFeed).toHaveBeenCalledTimes(1);
    // Google read short-circuits the Apple probe.
    expect(service.listCalendars).not.toHaveBeenCalled();
    const data = result.data as { events: Array<{ title: string }> };
    expect(data.events.map((event) => event.title)).toEqual(["Standup"]);
  });

  it("serves the feed for Apple-only owners (no Google, calendars listed)", async () => {
    const service = stubService({
      status: connectorStatus({ connected: false, grantedCapabilities: [] }),
      calendars: [{ provider: "apple_calendar", calendarId: "home" }],
      feedEvents: [calendarEvent({ externalId: "evt-2", title: "Dentist" })],
    });
    const result = await run(service, "query_calendar_today");
    expect(result.success).toBe(true);
    expect(service.getCalendarFeed).toHaveBeenCalledTimes(1);
  });

  it("translates a LifeOpsServiceError from the availability probe instead of throwing", async () => {
    const service = stubService({
      status: connectorStatus({ connected: false, grantedCapabilities: [] }),
      calendarsError: new LifeOpsServiceError(
        503,
        "Calendar service is unavailable. Ensure @elizaos/plugin-calendar is registered.",
      ),
    });
    const result = await run(service, "query_calendar_today");
    expect(result.success).toBe(false);
    expect(service.getCalendarFeed).not.toHaveBeenCalled();
  });
});

describe("query_calendar_next availability", () => {
  it("serves the next-event context when calendar read is granted", async () => {
    const nextEvent = calendarEvent({
      externalId: "evt-3",
      title: "Design review",
    });
    const service = stubService({
      status: connectorStatus({
        connected: true,
        grantedCapabilities: ["google.calendar.read"],
      }),
      nextEvent,
    });
    const result = await run(service, "query_calendar_next");
    expect(result.success).toBe(true);
    expect(service.getNextCalendarEventContext).toHaveBeenCalledTimes(1);
    const data = result.data as { event: { title: string } | null };
    expect(data.event?.title).toBe("Design review");
  });

  it("reports an empty calendar as success, not as a refusal", async () => {
    const service = stubService({
      status: connectorStatus({
        connected: true,
        grantedCapabilities: ["google.calendar.read"],
      }),
      nextEvent: null,
    });
    const result = await run(service, "query_calendar_next");
    expect(result.success).toBe(true);
    const data = result.data as { event: unknown };
    expect(data.event).toBeNull();
  });

  it("refuses with the limited-access wording when connected without calendar read", async () => {
    const service = stubService({
      status: connectorStatus({
        connected: true,
        grantedCapabilities: ["google.gmail.triage"],
      }),
      calendars: [],
    });
    const result = await run(service, "query_calendar_next");
    expect(result.success).toBe(false);
    expect(result.text).toBe(
      "Google Calendar access is limited. Reconnect Google in LifeOps settings to grant calendar access.",
    );
    expect(service.getNextCalendarEventContext).not.toHaveBeenCalled();
  });
});
