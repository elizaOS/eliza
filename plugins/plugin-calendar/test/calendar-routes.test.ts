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
  };
  const jsonCalls: Array<{ data: unknown; status?: number }> = [];
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
    ...overrides,
  };
  return { deps, service, jsonCalls };
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

  it("routes PUT /calendars/:id/include to setCalendarIncluded", async () => {
    const { deps, service } = harness({
      method: "PUT",
      pathname: "/api/lifeops/calendar/calendars/primary/include",
      body: { calendarId: "primary", includeInFeed: false },
    });
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(service.setCalendarIncluded).toHaveBeenCalledTimes(1);
  });

  it("rejects a calendarId path/body mismatch on include", async () => {
    const { deps } = harness({
      method: "PUT",
      pathname: "/api/lifeops/calendar/calendars/primary/include",
      body: { calendarId: "other", includeInFeed: true },
    });
    await expect(handleCalendarRoutes(deps)).rejects.toThrow(/must match/);
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
    const { deps, service, jsonCalls } = harness({
      method: "POST",
      pathname: "/api/lifeops/calendar/events",
      body: { title: "x" },
    });
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(service.createCalendarEvent).toHaveBeenCalledTimes(1);
    expect(jsonCalls[0]?.status).toBe(201);
  });

  it("routes PATCH /events/:id to updateCalendarEvent", async () => {
    const { deps, service } = harness({
      method: "PATCH",
      pathname: "/api/lifeops/calendar/events/evt-1",
      body: { title: "renamed" },
    });
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(service.updateCalendarEvent).toHaveBeenCalledTimes(1);
    expect(service.updateCalendarEvent.mock.calls[0][1]).toMatchObject({
      eventId: "evt-1",
    });
  });

  it("routes DELETE /events/:id to deleteCalendarEvent", async () => {
    const { deps, service, jsonCalls } = harness({
      method: "DELETE",
      pathname: "/api/lifeops/calendar/events/evt-1",
    });
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(service.deleteCalendarEvent).toHaveBeenCalledTimes(1);
    expect(jsonCalls[0]?.data).toEqual({ deleted: true });
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
