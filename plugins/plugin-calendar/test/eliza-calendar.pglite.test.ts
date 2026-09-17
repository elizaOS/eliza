/**
 * Exercises the built-in Eliza calendar through CalendarService against the
 * production PGlite schema. External providers stay disconnected so default
 * discovery, exact-once creation, feed truth, and versioned writes are proven
 * without a connector or a second event store.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql/runtime-migrator";
import type {
  LifeOpsCalendarEvent,
  LifeOpsReminderPlan,
} from "@elizaos/shared";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createCalendarActionRunner } from "../src/actions/calendar-handler.js";
import { __testing } from "../src/apple-calendar.js";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "../src/internal/eliza-calendar.js";
import {
  type CalendarHostGate,
  CalendarService,
  calendarSchema,
} from "../src/service/index.js";

const AGENT_ID = "eliza-calendar-pglite-agent";
const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const WINDOW = {
  timeMin: "2026-08-01T00:00:00.000Z",
  timeMax: "2026-09-01T00:00:00.000Z",
};

let pg: PGlite;
let service: CalendarService;
let runtime: IAgentRuntime;
const reminderPlans: LifeOpsReminderPlan[] = [];

function gate(): CalendarHostGate {
  return {
    getGoogleConnectorAccounts: async () => [],
    resolveGuestAvailabilityGrants: async () => {
      throw new Error("Guest availability is outside this test.");
    },
    requireGoogleCalendarGrant: async () => {
      throw new Error("Google is outside this test.");
    },
    requireGoogleCalendarWriteGrant: async () => {
      throw new Error("Google is outside this test.");
    },
    createReminderPlan: async (plan) => {
      reminderPlans.push(plan);
    },
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  };
}

function connectedGoogleGate(): CalendarHostGate {
  const timestamp = "2026-08-30T12:00:00.000Z";
  const grant = {
    id: "connector-account:shawgotbags",
    agentId: AGENT_ID,
    provider: "google",
    connectorAccountId: "shawgotbags",
    side: "owner",
    identity: { email: "shawgotbags@gmail.com" },
    identityEmail: "shawgotbags@gmail.com",
    grantedScopes: ["https://www.googleapis.com/auth/calendar"],
    capabilities: ["google.calendar.read", "google.calendar.write"],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: true,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  return {
    ...gate(),
    getGoogleConnectorAccounts: async () => [
      {
        provider: "google",
        side: "owner",
        mode: "local",
        defaultMode: "local",
        availableModes: ["local"],
        executionTarget: "local",
        sourceOfTruth: "connector_account",
        configured: true,
        connected: true,
        reason: "connected",
        preferredByAgent: true,
        cloudConnectionId: null,
        identity: grant.identity,
        grantedCapabilities: [...grant.capabilities],
        grantedScopes: [...grant.grantedScopes],
        expiresAt: null,
        hasRefreshToken: true,
        grant,
      },
    ],
  } as CalendarHostGate;
}

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await new RuntimeMigrator(db).migrate(
    "@elizaos/plugin-calendar",
    calendarSchema,
  );
  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    db,
    initPromise: Promise.resolve(),
    getCache: async () => undefined,
    setCache: async () => undefined,
    getService: (serviceType: string) =>
      serviceType === CalendarService.serviceType ? service : null,
    reportError: async () => {},
  } as unknown as IAgentRuntime;
  service = new CalendarService(runtime);
  service.setGate(gate());
  __testing.setNativeCalendarBridgeForTest(null);
}, 30_000);

beforeEach(async () => {
  await pg.query("DELETE FROM app_calendar.linked_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
  await pg.query("DELETE FROM app_calendar.life_calendar_feed_preferences");
  reminderPlans.length = 0;
  service.setGate(gate());
});

afterAll(async () => {
  __testing.setNativeCalendarBridgeForTest(undefined as never);
  await pg.close();
});

describe("built-in Eliza calendar (real PGlite)", { timeout: 30_000 }, () => {
  async function runUpdate(
    text: string,
    details: Record<string, unknown>,
    extractedUpdate: Record<string, unknown>,
    expectedSuccess = true,
  ) {
    const action = createCalendarActionRunner({
      runTextModel: vi.fn(async () => null),
      runJsonModel: vi.fn(async ({ actionType }) =>
        actionType === "lifeops.calendar.extract_update_event"
          ? {
              rawResponse: JSON.stringify(extractedUpdate),
              parsed: extractedUpdate,
            }
          : null,
      ),
      recentConversationTexts: vi.fn(async () => []),
    });
    const result = await action.handler(
      runtime,
      {
        id: "00000000-0000-0000-0000-000000000101",
        entityId: "00000000-0000-0000-0000-000000000102",
        roomId: "00000000-0000-0000-0000-000000000103",
        content: { text },
      } as Memory,
      undefined,
      {
        parameters: {
          subaction: "update_event",
          query: "Willow Harbor QA",
          details: {
            grantId: ELIZA_CALENDAR_GRANT_ID,
            calendarId: ELIZA_CALENDAR_ID,
            timeZone: "UTC",
            ...WINDOW,
            ...details,
          },
        },
      },
    );
    expect(result?.success).toBe(expectedSuccess);
    const feed = await service.getCalendarFeed(INTERNAL_URL, WINDOW);
    expect(feed.state).toBe("complete");
    expect(feed.events).toHaveLength(1);
    return feed.events[0];
  }

  const originalEvent = {
    title: "Willow Harbor QA",
    description: "Bring the revised agenda and preserve these notes.",
    location: "Meeting room 3",
    startAt: "2026-08-09T10:00:00.000Z",
    endAt: "2026-08-09T10:15:00.000Z",
    timeZone: "UTC",
    idempotencyKey: "calendar-update-field-preservation",
  };

  it.each([
    ["omitted", {}],
    [
      "blank",
      {
        title: "",
        description: "",
        location: "",
        recurrence: "",
        timeZone: "",
      },
    ],
    [
      "null",
      {
        title: null,
        description: null,
        location: null,
        recurrence: null,
        timeZone: null,
      },
    ],
  ])(
    "preserves saved metadata when a move extractor returns %s unchanged fields",
    async (_label, extracted) => {
      const created = await service.createCalendarEventMutation(
        INTERNAL_URL,
        originalEvent,
      );
      const moved = await runUpdate(
        "Move Willow Harbor QA to 11 AM and keep its 15-minute duration and notes.",
        {
          startAt: "2026-08-09T11:00:00.000Z",
          endAt: "2026-08-09T11:15:00.000Z",
        },
        extracted,
      );
      expect(moved).toMatchObject({
        id: created.event?.id,
        title: originalEvent.title,
        description: originalEvent.description,
        location: originalEvent.location,
        startAt: "2026-08-09T11:00:00.000Z",
        endAt: "2026-08-09T11:15:00.000Z",
        recurrence: null,
        timezone: "UTC",
      });
    },
  );

  it.each(["description", "location"] as const)(
    "clears only an explicitly selected %s field and preserves timing",
    async (field) => {
      await service.createCalendarEventMutation(INTERNAL_URL, originalEvent);
      const updated = await runUpdate(
        `Clear the ${field} from Willow Harbor QA and keep everything else.`,
        { clearFields: [field] },
        {
          title: "",
          description: "",
          location: "",
          startAt: "",
          endAt: "",
          timeZone: "",
          recurrence: "",
          clearFields: [field],
        },
      );
      expect(updated).toMatchObject({
        title: originalEvent.title,
        description: field === "description" ? "" : originalEvent.description,
        location: field === "location" ? "" : originalEvent.location,
        startAt: originalEvent.startAt,
        endAt: originalEvent.endAt,
        timezone: "UTC",
      });
    },
  );

  it("applies an explicit clear extracted from the request without clearing other fields", async () => {
    await service.createCalendarEventMutation(INTERNAL_URL, originalEvent);
    const updated = await runUpdate(
      "Remove the notes from Willow Harbor QA.",
      {},
      { clearFields: ["description"] },
    );
    expect(updated).toMatchObject({
      title: originalEvent.title,
      description: "",
      location: originalEvent.location,
      startAt: originalEvent.startAt,
      endAt: originalEvent.endAt,
    });
  });

  it("does not write when extraction and planner disagree about clearing a field", async () => {
    await service.createCalendarEventMutation(INTERNAL_URL, originalEvent);
    const updated = await runUpdate(
      "Set Willow Harbor QA's notes to Bring the slides and move it to Meeting room 4.",
      { description: "Bring the slides", location: "Meeting room 4" },
      { clearFields: ["description", "location"] },
      false,
    );
    expect(updated).toMatchObject({
      title: originalEvent.title,
      description: originalEvent.description,
      location: originalEvent.location,
      startAt: originalEvent.startAt,
      endAt: originalEvent.endAt,
    });
  });

  it("creates without a guest the user never named and keeps the receipt self-verified (live 2026-09-16)", async () => {
    const action = createCalendarActionRunner({
      runTextModel: vi.fn(async () => null),
      runJsonModel: vi.fn(async ({ actionType }) =>
        actionType === "lifeops.calendar.extract_create_event"
          ? {
              rawResponse: "{}",
              parsed: {
                startAt: "2026-09-18T15:00:00-04:00",
                endAt: "2026-09-18T16:00:00-04:00",
                timeZone: "America/New_York",
              },
            }
          : null,
      ),
      recentConversationTexts: vi.fn(async () => []),
    });
    const result = await action.handler(
      runtime,
      {
        id: "00000000-0000-0000-0000-000000000301",
        entityId: "00000000-0000-0000-0000-000000000102",
        roomId: "00000000-0000-0000-0000-000000000103",
        createdAt: Date.parse("2026-09-15T22:00:00.000Z"),
        content: {
          text: "add a barber appointment friday at 3pm to my calendar",
        },
      } as Memory,
      undefined,
      {
        parameters: {
          subaction: "create_event",
          title: "Barber appointment",
          details: {
            grantId: ELIZA_CALENDAR_GRANT_ID,
            calendarId: ELIZA_CALENDAR_ID,
            timeZone: "America/New_York",
            start: "2026-09-18T15:00:00",
            end: "2026-09-18T16:00:00",
            durationMinutes: 60,
            attendees: [{ email: "shawmakesmagic@example.invalid" }],
          },
        },
      },
    );
    expect(result?.success, JSON.stringify(result)).toBe(true);
    const created = (
      result?.data as
        | { event?: { attendees: unknown[]; startAt: string; endAt: string } }
        | undefined
    )?.event;
    expect(created?.attendees).toEqual([]);
    expect(created).toMatchObject({
      startAt: "2026-09-18T19:00:00.000Z",
      endAt: "2026-09-18T20:00:00.000Z",
    });
    expect(result?.modelReplyRequired, JSON.stringify(result)).toBe(true);
    expect((result?.data?.replyContext as { facts: string })?.facts).toBe(
      "Created “Barber appointment” for Friday, Sep 18 at 3pm EDT.",
    );
  });

  it("keeps the create self-verified when the planner's description only repeats the title (live 2026-09-16)", async () => {
    const action = createCalendarActionRunner({
      runTextModel: vi.fn(async () => null),
      runJsonModel: vi.fn(async ({ actionType }) =>
        actionType === "lifeops.calendar.extract_create_event"
          ? {
              rawResponse: "{}",
              parsed: {
                startAt: "2026-09-18T15:00:00-04:00",
                endAt: "2026-09-18T16:00:00-04:00",
                timeZone: "America/New_York",
              },
            }
          : null,
      ),
      recentConversationTexts: vi.fn(async () => []),
    });
    const run = async (id: string, description: string) =>
      action.handler(
        runtime,
        {
          id: `00000000-0000-0000-0000-0000000004${id}`,
          entityId: "00000000-0000-0000-0000-000000000102",
          roomId: "00000000-0000-0000-0000-000000000103",
          createdAt: Date.parse("2026-09-15T22:00:00.000Z"),
          content: {
            text: "add a optometrist appointment friday at 3pm to my calendar",
          },
        } as Memory,
        undefined,
        {
          parameters: {
            subaction: "create_event",
            title: "Optometrist appointment",
            details: {
              grantId: ELIZA_CALENDAR_GRANT_ID,
              calendarId: ELIZA_CALENDAR_ID,
              timeZone: "America/New_York",
              start: "2026-09-18T15:00:00",
              end: "2026-09-18T16:00:00",
              description,
            },
          },
        },
      );
    const echoed = await run("01", "Optometrist appointment");
    expect(echoed?.success, JSON.stringify(echoed)).toBe(true);
    expect(echoed?.modelReplyRequired, JSON.stringify(echoed)).toBe(true);
    expect((echoed?.data?.replyContext as { facts: string })?.facts).toBe(
      "Created “Optometrist appointment” for Friday, Sep 18 at 3pm EDT.",
    );
    // Keep the independent content case free of a deliberate scheduling conflict.
    const echoedEvent = echoed?.data?.event as LifeOpsCalendarEvent;
    await service.deleteCalendarEvent(INTERNAL_URL, {
      eventId: echoedEvent.externalId,
      expectedProviderVersion: echoedEvent.metadata.etag,
      calendarId: echoedEvent.calendarId,
      grantId: echoedEvent.grantId,
    });
    const noted = await run("02", "Bring the insurance card");
    expect(noted?.success, JSON.stringify(noted)).toBe(true);
    expect(noted?.verifiedUserFacing).toBeUndefined();
  });

  it("stamps a plain move as verified even when the planner fills every optional key", async () => {
    // With the complete planner surface a small planner sends end, date,
    // durationMinutes, notifyAttendees, allowPast, includeHiddenCalendars and
    // recurrence "none" on a plain move (live 2026-09-15); none of them is an
    // unshown detail, so the receipt sentence stays self-verified.
    // The target is a 30-minute event; the planner's end (17:00) beside its
    // start (16:00) is not the user's range, so the move keeps 30 minutes.
    await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "Notary appointment",
      startAt: "2026-09-18T19:00:00.000Z",
      endAt: "2026-09-18T19:30:00.000Z",
      timeZone: "America/New_York",
      idempotencyKey: "notary-gate-180",
    });
    const action = createCalendarActionRunner({
      runTextModel: vi.fn(async () => null),
      // The re-extraction answers with empty strings for the fields the user
      // never mentioned; an empty string is an omission, not a clear.
      runJsonModel: vi.fn(async ({ actionType }) =>
        actionType === "lifeops.calendar.extract_update_event"
          ? {
              rawResponse: JSON.stringify({ location: "", description: "" }),
              parsed: { location: "", description: "", recurrenceScope: null },
            }
          : null,
      ),
      recentConversationTexts: vi.fn(async () => []),
    });
    const result = await action.handler(
      runtime,
      {
        id: "00000000-0000-0000-0000-000000000201",
        entityId: "00000000-0000-0000-0000-000000000102",
        roomId: "00000000-0000-0000-0000-000000000103",
        createdAt: Date.parse("2026-09-15T22:00:00.000Z"),
        content: { text: "move my notary appointment to friday at 4pm" },
      } as Memory,
      undefined,
      {
        parameters: {
          subaction: "update_event",
          query: "notary appointment",
          details: {
            grantId: ELIZA_CALENDAR_GRANT_ID,
            calendarId: ELIZA_CALENDAR_ID,
            timeZone: "America/New_York",
            start: "2026-09-18T16:00:00",
            end: "2026-09-18T17:00:00",
            date: "2026-09-18",
            durationMinutes: 60,
            notifyAttendees: true,
            allowPast: true,
            includeHiddenCalendars: true,
            recurrence: "none",
          },
        },
      },
    );
    expect(result?.success, JSON.stringify(result)).toBe(true);
    expect(result?.modelReplyRequired, JSON.stringify(result)).toBe(true);
    expect((result?.data?.replyContext as { facts: string })?.facts).toBe(
      "Moved “Notary appointment” to Friday, Sep 18 at 4pm EDT.",
    );
    const moved = (
      result?.data as { event?: { startAt: string; endAt: string } }
    )?.event;
    expect(moved).toMatchObject({
      startAt: "2026-09-18T20:00:00.000Z",
      endAt: "2026-09-18T20:30:00.000Z",
    });
  });

  it("does not write or report success for an empty extracted update", async () => {
    const created = await service.createCalendarEventMutation(
      INTERNAL_URL,
      originalEvent,
    );
    const unchanged = await runUpdate(
      "Check whether 11 AM is free and move Willow Harbor QA there if it is.",
      {},
      {},
      false,
    );
    expect(unchanged).toMatchObject({
      title: originalEvent.title,
      startAt: originalEvent.startAt,
      endAt: originalEvent.endAt,
      description: originalEvent.description,
      location: originalEvent.location,
      metadata: { etag: created.event?.metadata.etag },
    });
  });

  it("does not mutate an event when the same update both replaces and clears a field", async () => {
    const created = await service.createCalendarEventMutation(
      INTERNAL_URL,
      originalEvent,
    );
    const unchanged = await runUpdate(
      "Update Willow Harbor QA's notes.",
      { description: "Bring the slides", clearFields: ["description"] },
      { description: "Bring the slides", clearFields: ["description"] },
      false,
    );
    expect(unchanged).toMatchObject({
      title: originalEvent.title,
      description: originalEvent.description,
      location: originalEvent.location,
      metadata: { etag: created.event?.metadata.etag },
    });
  });

  it("is the fresh writable default when no external account is connected", async () => {
    const calendars = await service.listCalendars(INTERNAL_URL);
    expect(calendars[0]).toMatchObject({
      provider: "eliza",
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      primary: true,
      accessRole: "owner",
    });

    const feed = await service.getCalendarFeed(INTERNAL_URL, WINDOW);
    expect(feed.events).toHaveLength(0);
    expect(Number.isFinite(Date.parse(feed.syncedAt ?? ""))).toBe(true);
    expect(
      feed.sources.every((source) => source.syncedAt === feed.syncedAt),
    ).toBe(true);
    expect(feed).toMatchObject({
      state: "complete",
      events: [],
      sources: [
        {
          key: {
            provider: "eliza",
            grantId: ELIZA_CALENDAR_GRANT_ID,
            calendarId: ELIZA_CALENDAR_ID,
          },
          status: "fresh",
        },
      ],
    });
  });

  it("creates once, replays idempotently, and returns the event through the canonical feed", async () => {
    const request = {
      title: "Demo with Shaw",
      startAt: "2026-08-06T23:00:00.000Z",
      endAt: "2026-08-07T00:00:00.000Z",
      timeZone: "America/Los_Angeles",
      idempotencyKey: "demo-with-shaw-2026-08-06",
    };
    const first = await service.createCalendarEventMutation(
      INTERNAL_URL,
      request,
    );
    expect(first.event).toMatchObject({
      provider: "eliza",
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      title: "Demo with Shaw",
      metadata: { version: 1, etag: '"eliza-1"' },
    });
    const reminderCount = reminderPlans.length;
    expect(reminderCount).toBeGreaterThan(0);

    const replay = await service.createCalendarEventMutation(
      INTERNAL_URL,
      request,
    );
    expect(replay.event?.id).toBe(first.event?.id);
    expect(reminderPlans).toHaveLength(reminderCount);
    const rows = await pg.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM app_calendar.life_calendar_events",
    );
    expect(rows.rows[0]?.count).toBe("1");

    const feed = await service.getCalendarFeed(INTERNAL_URL, WINDOW);
    expect(feed.state).toBe("complete");
    expect(feed.events.map((event) => event.title)).toEqual(["Demo with Shaw"]);
  });

  it("uses event ETags for atomic update and delete", async () => {
    const created = await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "Calendar rehearsal",
      startAt: "2026-08-09T18:00:00.000Z",
      endAt: "2026-08-09T19:00:00.000Z",
      timeZone: "America/Los_Angeles",
      idempotencyKey: "calendar-rehearsal",
    });
    const event = created.event;
    if (!event) throw new Error("Built-in calendar create returned no event.");

    const updated = await service.updateCalendarEvent(INTERNAL_URL, {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: event.externalId,
      title: "Calendar rehearsal moved",
      expectedProviderVersion: '"eliza-1"',
    });
    expect(updated).toMatchObject({
      title: "Calendar rehearsal moved",
      metadata: { version: 2, etag: '"eliza-2"' },
    });

    await expect(
      service.updateCalendarEvent(INTERNAL_URL, {
        grantId: ELIZA_CALENDAR_GRANT_ID,
        calendarId: ELIZA_CALENDAR_ID,
        eventId: event.externalId,
        title: "Stale update",
        expectedProviderVersion: '"eliza-1"',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_PRECONDITION_FAILED",
    });

    await expect(
      service.deleteCalendarEvent(INTERNAL_URL, {
        grantId: ELIZA_CALENDAR_GRANT_ID,
        calendarId: ELIZA_CALENDAR_ID,
        eventId: event.externalId,
        expectedProviderVersion: '"eliza-1"',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_PRECONDITION_FAILED",
    });

    await service.deleteCalendarEvent(INTERNAL_URL, {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: event.externalId,
      expectedProviderVersion: '"eliza-2"',
    });
    expect(await service.getCalendarEventById(event.id)).toBeNull();
  });

  it("durably queues built-in create, update, and delete for the preferred Google primary calendar", async () => {
    service.setGate(connectedGoogleGate());
    const created = await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "School pickup",
      startAt: "2026-08-12T19:00:00.000Z",
      endAt: "2026-08-12T20:00:00.000Z",
      timeZone: "America/New_York",
      idempotencyKey: "school-pickup-linked",
    });
    const event = created.event;
    if (!event) throw new Error("Built-in calendar create returned no event.");
    await expect
      .poll(async () => {
        const row = await pg.query<{
          connector_account_id: string;
          provider_calendar_id: string;
          pending_operation: string;
        }>(
          "SELECT connector_account_id, provider_calendar_id, pending_operation FROM app_calendar.linked_calendar_events",
        );
        return row.rows[0];
      })
      .toMatchObject({
        connector_account_id: "shawgotbags",
        provider_calendar_id: "primary",
        pending_operation: "create",
      });

    await service.updateCalendarEvent(INTERNAL_URL, {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: event.externalId,
      title: "School pickup moved",
      expectedProviderVersion: '"eliza-1"',
    });
    await expect
      .poll(async () => {
        const row = await pg.query<{ local_revision: number }>(
          "SELECT local_revision FROM app_calendar.linked_calendar_events",
        );
        return row.rows[0]?.local_revision;
      })
      .toBe(2);

    await service.deleteCalendarEvent(INTERNAL_URL, {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: event.externalId,
      expectedProviderVersion: '"eliza-2"',
    });
    await expect
      .poll(async () => {
        const row = await pg.query<{ pending_operation: string }>(
          "SELECT pending_operation FROM app_calendar.linked_calendar_events",
        );
        return row.rows[0]?.pending_operation;
      })
      .toBe("delete");
  });

  it("bootstraps existing local events as soon as a writable Google gate connects", async () => {
    const created = await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "Created before Google",
      startAt: "2026-08-14T19:00:00.000Z",
      endAt: "2026-08-14T20:00:00.000Z",
      timeZone: "America/New_York",
      idempotencyKey: "created-before-google",
    });
    const event = created.event;
    if (!event) throw new Error("Built-in calendar create returned no event.");
    expect(
      (await pg.query("SELECT id FROM app_calendar.linked_calendar_events"))
        .rows,
    ).toHaveLength(0);

    service.setGate(connectedGoogleGate());

    await expect
      .poll(async () => {
        const row = await pg.query<{
          local_event_id: string;
          connector_account_id: string;
          provider_calendar_id: string;
          pending_operation: string;
        }>(
          "SELECT local_event_id, connector_account_id, provider_calendar_id, pending_operation FROM app_calendar.linked_calendar_events",
        );
        return row.rows[0];
      })
      .toMatchObject({
        local_event_id: event.id,
        connector_account_id: "shawgotbags",
        provider_calendar_id: "primary",
        pending_operation: "create",
      });
  });

  it("resolves an unscoped mutation target to the built-in event without hijacking external grants", async () => {
    const created = await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "Unscoped lookup",
      startAt: "2026-08-11T18:00:00.000Z",
      endAt: "2026-08-11T19:00:00.000Z",
      timeZone: "America/Los_Angeles",
      idempotencyKey: "unscoped-lookup",
    });
    const event = created.event;
    if (!event) throw new Error("Built-in calendar create returned no event.");

    // A planner that omits grantId still binds to the built-in event.
    await expect(
      service.getConditionalCalendarMutationTarget(INTERNAL_URL, {
        eventId: event.externalId,
      }),
    ).resolves.toMatchObject({
      id: event.id,
      provider: "eliza",
      grantId: ELIZA_CALENDAR_GRANT_ID,
    });

    // An unknown external id must NOT be claimed by the built-in calendar;
    // it falls through to external-provider resolution (disconnected here).
    await expect(
      service.getConditionalCalendarMutationTarget(INTERNAL_URL, {
        eventId: "google-event-id-that-is-not-built-in",
      }),
    ).rejects.toThrow();
  });

  it("rejects unsupported or invalid built-in mutations without changing the event", async () => {
    const created = await service.createCalendarEventMutation(INTERNAL_URL, {
      title: "Keep this event",
      startAt: "2026-08-09T18:00:00.000Z",
      endAt: "2026-08-09T19:00:00.000Z",
      timeZone: "America/Los_Angeles",
      idempotencyKey: "built-in-mutation-guards",
    });
    const event = created.event;
    if (!event) throw new Error("Built-in calendar create returned no event.");
    const base = {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: event.externalId,
      expectedProviderVersion: '"eliza-1"',
    };

    await expect(
      service.updateCalendarEvent(INTERNAL_URL, { ...base, title: "   " }),
    ).rejects.toMatchObject({
      status: 400,
      code: "CALENDAR_EVENT_TITLE_REQUIRED",
    });
    await expect(
      service.updateCalendarEvent(INTERNAL_URL, {
        ...base,
        recurrence: ["RRULE:FREQ=DAILY"],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED",
    });
    await expect(
      service.deleteCalendarEvent(INTERNAL_URL, {
        ...base,
        notifyAttendees: true,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "ELIZA_CALENDAR_ATTENDEE_NOTIFICATIONS_UNSUPPORTED",
    });

    await expect(service.getCalendarEventById(event.id)).resolves.toMatchObject(
      {
        title: "Keep this event",
        metadata: { version: 1, etag: '"eliza-1"' },
      },
    );
  });
});
