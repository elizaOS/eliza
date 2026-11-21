/**
 * The owner RSVP route: the calendar client's request reaches the host
 * approval gateway with the reviewed provider version and operation key.
 */

import type { LifeOpsCalendarEvent } from "@elizaos/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCalendarApi } from "../api/calendar-api.js";
import {
  type CalendarRouteDeps,
  handleCalendarRoutes,
} from "./calendar-routes.js";
import type { CalendarOwnerMutationGateway } from "./mutation-gateway.js";

class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function serve(gateway: Partial<CalendarOwnerMutationGateway>) {
  return async (path: string, init?: RequestInit) => {
    const url = new URL(path, "http://agent.local");
    let response: { data: unknown; status: number } | null = null;
    const deps: CalendarRouteDeps = {
      method: init?.method ?? "GET",
      pathname: url.pathname,
      url,
      runRoute: async (fn) => {
        try {
          await fn({} as never);
        } catch (error) {
          if (!(error instanceof RouteError)) throw error;
          response = { data: { error: error.message }, status: error.status };
        }
        return true;
      },
      rateLimit: () => false,
      json: (data, status = 200) => {
        response = { data, status };
      },
      readJsonBody: async <T extends object>() =>
        JSON.parse(String(init?.body)) as T,
      decodePathComponent: (raw) => decodeURIComponent(raw),
      parseConnectorMode: () => undefined,
      parseConnectorSide: (value) => (value as "owner" | null) ?? undefined,
      parseBoolean: () => undefined,
      serviceError: (status, message) => new RouteError(status, message),
      mutationGateway: gateway as CalendarOwnerMutationGateway,
    };
    expect(await handleCalendarRoutes(deps)).toBe(true);
    return response;
  };
}

const updated = {
  id: "row-1",
  externalId: "evt@1",
  attendees: [{ self: true, responseStatus: "tentative" }],
} as unknown as LifeOpsCalendarEvent;

describe("POST /api/lifeops/calendar/events/:eventId/response", () => {
  it("sends the client's reviewed RSVP to the approval gateway", async () => {
    const respond = vi.fn(async () => updated);
    const fetch = serve({ respond });
    const api = createCalendarApi(
      async <T>(path: string, init?: RequestInit) =>
        ((await fetch(path, init)) as { data: T }).data,
    );

    await expect(
      api.respondToLifeOpsCalendarEvent("evt@1", {
        side: "owner",
        grantId: "grant-1",
        calendarId: "primary",
        responseStatus: "tentative",
        recurrenceScope: "instance",
        expectedProviderVersion: '"v1"',
        idempotencyKey: "rsvp-1",
      }),
    ).resolves.toEqual({ event: updated });
    expect(respond).toHaveBeenCalledTimes(1);
    const [url, request] = respond.mock.calls[0] as unknown as [URL, unknown];
    expect(url.pathname).toBe("/api/lifeops/calendar/events/evt%401/response");
    expect(request).toEqual({
      eventId: "evt@1",
      side: "owner",
      grantId: "grant-1",
      calendarId: "primary",
      responseStatus: "tentative",
      recurrenceScope: "instance",
      notifyAttendees: false,
      expectedProviderVersion: '"v1"',
      idempotencyKey: "rsvp-1",
    });
  });

  it.each([
    [{ responseStatus: "maybe" }, 400],
    [{ expectedProviderVersion: " " }, 428],
    [{ idempotencyKey: "" }, 428],
  ])("refuses %j with %i before the gateway", async (override, status) => {
    const respond = vi.fn(async () => updated);
    const response = await serve({ respond })(
      "/api/lifeops/calendar/events/evt-1/response",
      {
        method: "POST",
        body: JSON.stringify({
          responseStatus: "accepted",
          expectedProviderVersion: '"v1"',
          idempotencyKey: "rsvp-1",
          ...override,
        }),
      },
    );
    expect(response?.status).toBe(status);
    expect(respond).not.toHaveBeenCalled();
  });

  it("answers 501 when the host gateway has no RSVP support", async () => {
    const response = await serve({})(
      "/api/lifeops/calendar/events/evt-1/response",
      {
        method: "POST",
        body: JSON.stringify({
          responseStatus: "accepted",
          expectedProviderVersion: '"v1"',
          idempotencyKey: "rsvp-1",
        }),
      },
    );
    expect(response?.status).toBe(501);
  });
});
