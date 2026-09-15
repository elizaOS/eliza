/**
 * Unit tests for the calendar HTTP route dispatcher (`handleCalendarRoutes`).
 *
 * The dispatcher is pure path -> service mapping over an injected deps object;
 * these tests stub the host plumbing and assert each path routes to the right
 * CalendarService method with the parsed request, and that unmatched paths fall
 * through so the host can continue its own dispatch.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type CalendarRouteDeps,
  type CalendarRouteService,
  handleCalendarRoutes,
} from "../src/routes/calendar-routes.js";

function harness(
  overrides: Partial<CalendarRouteDeps> & {
    method: string;
    pathname: string;
    body?: object | null;
  },
) {
  const service: Record<string, ReturnType<typeof vi.fn>> = {
    getCalendarFeed: vi.fn(async () => ({ events: [] })),
    listCalendars: vi.fn(async () => [{ calendarId: "primary" }]),
    setCalendarIncluded: vi.fn(async () => ({ calendarId: "primary" })),
    getNextCalendarEventContext: vi.fn(async () => ({ event: null })),
    createCalendarEvent: vi.fn(async () => ({ id: "evt-1" })),
    updateCalendarEvent: vi.fn(async () => ({ id: "evt-1" })),
    deleteCalendarEvent: vi.fn(async () => undefined),
    respondToCalendarEvent: vi.fn(async () => ({ id: "evt-1" })),
    listIcsCalendarSources: vi.fn(async () => []),
    createIcsCalendarSource: vi.fn(async () => ({ id: "source-1" })),
    updateIcsCalendarSource: vi.fn(async () => ({ id: "source-1" })),
    deleteIcsCalendarSource: vi.fn(async () => undefined),
    syncIcsCalendarSource: vi.fn(async () => ({
      source: { id: "source-1" },
      outcome: "complete",
    })),
    purgeImportedCalendarData: vi.fn(async () => ({
      provider: "google",
      side: "owner",
      grantId: "connector-account:account-a",
      connectorAccountId: "account-a",
      deletedEventCount: 3,
      deletedSyncStateCount: 1,
      providerMutation: false,
      purgedAt: "2026-08-22T09:00:00.000Z",
    })),
    seedImportedCalendarData: vi.fn(async () => ({
      timeMin: "2026-08-15T00:00:00.000Z",
      timeMax: "2026-11-20T00:00:00.000Z",
      feedState: "complete",
      selectedSourceCount: 2,
      eventCount: 5,
      duplicateEventCount: 1,
      seededAt: "2026-08-22T09:00:00.000Z",
    })),
  };
  const jsonCalls: Array<{ data: unknown; status?: number }> = [];
  const mutationGateway = {
    create: vi.fn(async () => ({
      outcome: "event" as const,
      event: { id: "evt-1" },
      writeOnlyReceipt: null,
    })),
    update: vi.fn(async () => ({ id: "evt-1" })),
    cancel: vi.fn(async () => ({
      outcome: "deleted" as const,
      cancellationMode: "organizer_cancel" as const,
      event: null,
    })),
  };
  const deps: CalendarRouteDeps = {
    method: overrides.method,
    pathname: overrides.pathname,
    url: new URL(`http://host${overrides.pathname}`),
    runRoute: async (fn) => {
      await fn(service as unknown as CalendarRouteService);
      return true;
    },
    rateLimit: () => false,
    json: (data, status) => jsonCalls.push({ data, status }),
    readJsonBody: async () =>
      (overrides.body === undefined ? {} : overrides.body) as never,
    decodePathComponent: (raw) => raw,
    parseConnectorMode: () => undefined,
    parseConnectorSide: () => undefined,
    parseBoolean: () => undefined,
    serviceError: (status, message) =>
      Object.assign(new Error(message), { status }),
    mutationGateway: mutationGateway as never,
    ...overrides,
  };
  return { deps, service, mutationGateway, jsonCalls };
}

describe("handleCalendarRoutes", () => {
  it("routes GET /feed to getCalendarFeed", async () => {
    const { deps, service, jsonCalls } = harness({
      method: "GET",
      pathname: "/api/lifeops/calendar/feed",
    });
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(service.getCalendarFeed).toHaveBeenCalledTimes(1);
    expect(jsonCalls).toHaveLength(1);
  });

  it("routes GET /calendars to listCalendars and wraps the result", async () => {
    const { deps, service, jsonCalls } = harness({
      method: "GET",
      pathname: "/api/lifeops/calendar/calendars",
    });
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(service.listCalendars).toHaveBeenCalledTimes(1);
    expect(jsonCalls[0]?.data).toHaveProperty("calendars");
  });

  it("routes exact-identity local projection purge without a provider mutation", async () => {
    const body = {
      provider: "google",
      side: "owner",
      grantId: "connector-account:account-a",
      connectorAccountId: "account-a",
      confirmAction: true,
    };
    const { deps, service, jsonCalls } = harness({
      method: "POST",
      pathname: "/api/lifeops/calendar/imported-data/purge",
      body,
    });

    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(service.purgeImportedCalendarData).toHaveBeenCalledWith(body);
    expect(jsonCalls[0]?.data).toMatchObject({
      deletedEventCount: 3,
      deletedSyncStateCount: 1,
      providerMutation: false,
    });
  });

  it("routes a bounded calendar seed to the server-side receipt use-case", async () => {
    const body = {
      side: "owner",
      timeMin: "2026-08-15T00:00:00.000Z",
      timeMax: "2026-11-20T00:00:00.000Z",
      calendars: [
        {
          provider: "google",
          side: "owner",
          grantId: "connector-account:account-a",
          connectorAccountId: "account-a",
          calendarId: "primary",
        },
      ],
    };
    const { deps, service, jsonCalls } = harness({
      method: "POST",
      pathname: "/api/lifeops/calendar/seed",
      body,
    });

    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(service.seedImportedCalendarData).toHaveBeenCalledWith(
      deps.url,
      body,
    );
    expect(jsonCalls[0]?.data).toMatchObject({
      feedState: "complete",
      eventCount: 5,
      duplicateEventCount: 1,
    });
  });

  it("routes subscription source CRUD and manual sync", async () => {
    const listed = harness({
      method: "GET",
      pathname: "/api/lifeops/calendar/sources",
    });
    expect(await handleCalendarRoutes(listed.deps)).toBe(true);
    expect(listed.service.listIcsCalendarSources).toHaveBeenCalledOnce();
    expect(listed.jsonCalls[0]?.data).toEqual({ sources: [] });

    const created = harness({
      method: "POST",
      pathname: "/api/lifeops/calendar/sources",
      body: {
        name: "School",
        url: "webcal://calendar.example.test/school.ics?token=secret",
      },
    });
    expect(await handleCalendarRoutes(created.deps)).toBe(true);
    expect(created.service.createIcsCalendarSource).toHaveBeenCalledWith({
      name: "School",
      url: "webcal://calendar.example.test/school.ics?token=secret",
    });
    expect(created.jsonCalls[0]?.status).toBe(201);

    const updated = harness({
      method: "PATCH",
      pathname: "/api/lifeops/calendar/sources/source-1",
      body: { enabled: false },
    });
    expect(await handleCalendarRoutes(updated.deps)).toBe(true);
    expect(updated.service.updateIcsCalendarSource).toHaveBeenCalledWith(
      "source-1",
      { enabled: false },
    );

    const synced = harness({
      method: "POST",
      pathname: "/api/lifeops/calendar/sources/source-1/sync",
    });
    expect(await handleCalendarRoutes(synced.deps)).toBe(true);
    expect(synced.service.syncIcsCalendarSource).toHaveBeenCalledWith(
      "source-1",
    );

    const deleted = harness({
      method: "DELETE",
      pathname: "/api/lifeops/calendar/sources/source-1",
    });
    expect(await handleCalendarRoutes(deleted.deps)).toBe(true);
    expect(deleted.service.deleteIcsCalendarSource).toHaveBeenCalledWith(
      "source-1",
    );
    expect(deleted.jsonCalls[0]?.data).toEqual({ deleted: true });
  });

  it("routes PUT /calendars/:id/include to setCalendarIncluded", async () => {
    const { deps, service } = harness({
      method: "PUT",
      pathname: "/api/lifeops/calendar/calendars/primary/include",
      body: {
        provider: "google",
        side: "owner",
        grantId: "connector-account:account-a",
        connectorAccountId: "account-a",
        calendarId: "primary",
        includeInFeed: false,
        expectedVersion: 7,
      },
    });
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(service.setCalendarIncluded).toHaveBeenCalledTimes(1);
    expect(service.setCalendarIncluded.mock.calls[0]?.[1]).toEqual({
      provider: "google",
      side: "owner",
      grantId: "connector-account:account-a",
      connectorAccountId: "account-a",
      calendarId: "primary",
      includeInFeed: false,
      expectedVersion: 7,
    });
  });

  it("rejects a calendarId path/body mismatch on include", async () => {
    const { deps } = harness({
      method: "PUT",
      pathname: "/api/lifeops/calendar/calendars/primary/include",
      body: { calendarId: "other", includeInFeed: true },
    });
    await expect(handleCalendarRoutes(deps)).rejects.toThrow(/must match/);
  });

  it("rejects an unversioned include write before calling the service", async () => {
    const { deps, service } = harness({
      method: "PUT",
      pathname: "/api/lifeops/calendar/calendars/primary/include",
      body: {
        provider: "google",
        side: "owner",
        grantId: "connector-account:account-a",
        connectorAccountId: "account-a",
        calendarId: "primary",
        includeInFeed: false,
      },
    });

    await expect(handleCalendarRoutes(deps)).rejects.toThrow(/expectedVersion/);
    expect(service.setCalendarIncluded).not.toHaveBeenCalled();
  });

  it("routes GET /next-context to getNextCalendarEventContext", async () => {
    const { deps, service } = harness({
      method: "GET",
      pathname: "/api/lifeops/calendar/next-context",
    });
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(service.getNextCalendarEventContext).toHaveBeenCalledTimes(1);
  });

  it("routes POST /events to createCalendarEvent with 201", async () => {
    const { deps, mutationGateway, jsonCalls } = harness({
      method: "POST",
      pathname: "/api/lifeops/calendar/events",
      body: { title: "x", idempotencyKey: "editor-create-1" },
    });
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(mutationGateway.create).toHaveBeenCalledTimes(1);
    expect(jsonCalls[0]?.status).toBe(201);
  });

  it("routes PATCH /events/:id to updateCalendarEvent", async () => {
    const { deps, mutationGateway } = harness({
      method: "PATCH",
      pathname: "/api/lifeops/calendar/events/evt-1",
      body: {
        title: "renamed",
        expectedProviderVersion: '"etag-1"',
        idempotencyKey: "editor-update-1",
      },
    });
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(mutationGateway.update).toHaveBeenCalledTimes(1);
    expect(mutationGateway.update.mock.calls[0][1]).toMatchObject({
      eventId: "evt-1",
    });
  });

  it("routes DELETE /events/:id to deleteCalendarEvent", async () => {
    const { deps, mutationGateway, jsonCalls } = harness({
      method: "DELETE",
      pathname: "/api/lifeops/calendar/events/evt-1",
    });
    deps.url = new URL(
      "http://host/api/lifeops/calendar/events/evt-1?expectedProviderVersion=%22etag-1%22&cancellationMode=organizer_cancel&idempotencyKey=editor-delete-1",
    );
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(mutationGateway.cancel).toHaveBeenCalledTimes(1);
    expect(jsonCalls[0]?.data).toEqual({
      outcome: "deleted",
      cancellationMode: "organizer_cancel",
      event: null,
    });
  });

  it("forwards recurrence + recurrenceScope on PATCH /events/:id", async () => {
    const { deps, mutationGateway } = harness({
      method: "PATCH",
      pathname: "/api/lifeops/calendar/events/standup_1",
      body: {
        title: "renamed",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
        recurrenceScope: "series",
        expectedProviderVersion: '"etag-1"',
        idempotencyKey: "editor-update-series-1",
      },
    });
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(mutationGateway.update.mock.calls[0][1]).toMatchObject({
      eventId: "standup_1",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
      recurrenceScope: "series",
    });
  });

  it("forwards ?recurrenceScope on DELETE /events/:id", async () => {
    const { deps, mutationGateway } = harness({
      method: "DELETE",
      pathname: "/api/lifeops/calendar/events/standup_1",
    });
    deps.url = new URL(
      "http://host/api/lifeops/calendar/events/standup_1?recurrenceScope=series&expectedProviderVersion=%22etag-1%22&cancellationMode=organizer_cancel&idempotencyKey=editor-delete-series-1",
    );
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(mutationGateway.cancel.mock.calls[0][1]).toMatchObject({
      eventId: "standup_1",
      recurrenceScope: "series",
      expectedProviderVersion: '"etag-1"',
    });
  });

  it("routes invitee removal to a conditional decline rather than delete", async () => {
    const { deps, mutationGateway, jsonCalls } = harness({
      method: "DELETE",
      pathname: "/api/lifeops/calendar/events/invite-1",
    });
    const declinedEvent = {
      id: "cached-invite-1",
      externalId: "invite-1",
      attendees: [{ self: true, responseStatus: "declined" }],
    };
    mutationGateway.cancel.mockResolvedValue({
      outcome: "invitation_declined",
      cancellationMode: "decline_invitation",
      event: declinedEvent,
    });
    deps.url = new URL(
      "http://host/api/lifeops/calendar/events/invite-1?expectedProviderVersion=%22etag-2%22&cancellationMode=decline_invitation&notifyAttendees=false&idempotencyKey=editor-decline-1",
    );

    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(mutationGateway.cancel).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        eventId: "invite-1",
        cancellationMode: "decline_invitation",
        expectedProviderVersion: '"etag-2"',
        notifyAttendees: false,
      }),
    );
    expect(jsonCalls[0]?.data).toEqual({
      outcome: "invitation_declined",
      cancellationMode: "decline_invitation",
      event: declinedEvent,
    });
  });

  it("rejects route mutations without idempotency/precondition tokens", async () => {
    const create = harness({
      method: "POST",
      pathname: "/api/lifeops/calendar/events",
      body: { title: "unsafe" },
    });
    await expect(handleCalendarRoutes(create.deps)).rejects.toMatchObject({
      status: 428,
    });
    expect(create.mutationGateway.create).not.toHaveBeenCalled();

    const update = harness({
      method: "PATCH",
      pathname: "/api/lifeops/calendar/events/evt-1",
      body: { title: "unsafe" },
    });
    await expect(handleCalendarRoutes(update.deps)).rejects.toMatchObject({
      status: 428,
    });
    expect(update.mutationGateway.update).not.toHaveBeenCalled();

    const deletion = harness({
      method: "DELETE",
      pathname: "/api/lifeops/calendar/events/evt-1",
    });
    await expect(handleCalendarRoutes(deletion.deps)).rejects.toMatchObject({
      status: 428,
    });
    expect(deletion.mutationGateway.cancel).not.toHaveBeenCalled();
  });

  it("short-circuits when rate-limited without calling the service", async () => {
    const { deps, service } = harness({
      method: "GET",
      pathname: "/api/lifeops/calendar/feed",
      rateLimit: () => true,
    });
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(service.getCalendarFeed).not.toHaveBeenCalled();
  });

  it("returns false for a non-calendar path so the host continues", async () => {
    const { deps } = harness({
      method: "GET",
      pathname: "/api/lifeops/inbox",
    });
    expect(await handleCalendarRoutes(deps)).toBe(false);
  });
});
