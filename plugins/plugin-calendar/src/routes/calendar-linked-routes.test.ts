/**
 * Owner linked-calendar route tests exercise the real route dispatcher with
 * deterministic host plumbing and prove consequential writes cross the shared
 * mutation gateway instead of calling CalendarService directly.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type CalendarRouteDeps,
  handleCalendarRoutes,
} from "./calendar-routes.js";

function route(
  method: string,
  pathname: string,
  body: Record<string, unknown> | null,
) {
  const json = vi.fn();
  const service = {
    listLinkedCalendarEvents: vi.fn(async () => []),
    getLinkedCalendarEvent: vi.fn(async () => ({ id: "link-1" })),
  };
  const mutationGateway = {
    create: vi.fn(),
    update: vi.fn(),
    cancel: vi.fn(),
    linkCalendar: vi.fn(async () => ({ outcome: "pushed" })),
    reconcileLinkedCalendar: vi.fn(async () => ({ outcome: "clean" })),
    resolveLinkedCalendarConflict: vi.fn(async () => ({ outcome: "pulled" })),
    disconnectLinkedCalendar: vi.fn(async () => ({ outcome: "paused" })),
    reconcileLinkedCalendarProviderChanges: vi.fn(),
  };
  const deps: CalendarRouteDeps = {
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    async runRoute(fn) {
      await fn(service as never);
      return true;
    },
    rateLimit: vi.fn(() => false),
    json,
    readJsonBody: vi.fn(async () => body),
    decodePathComponent: (raw) => decodeURIComponent(raw),
    parseConnectorMode: () => undefined,
    parseConnectorSide: () => undefined,
    parseBoolean: () => undefined,
    serviceError: (_status, message) => new Error(message),
    mutationGateway,
  };
  return { deps, json, mutationGateway, service };
}

describe("linked calendar owner routes", () => {
  it("routes link creation through the existing owner mutation gateway", async () => {
    const request = {
      localEventId: "local-1",
      connectorAccountId: "google-1",
      providerCalendarId: "primary",
      idempotencyKey: "request-1",
    };
    const test = route("POST", "/api/lifeops/calendar/links", request);

    await expect(handleCalendarRoutes(test.deps)).resolves.toBe(true);
    expect(test.mutationGateway.linkCalendar).toHaveBeenCalledWith(
      test.deps.url,
      request,
    );
    expect(test.service.listLinkedCalendarEvents).not.toHaveBeenCalled();
    expect(test.json).toHaveBeenCalledWith({ outcome: "pushed" }, 201);
  });

  it("preserves the explicit retention contract when disconnecting", async () => {
    const request = { retainEvents: true, idempotencyKey: "disconnect-1" };
    const test = route(
      "POST",
      "/api/lifeops/calendar/links/link-1/disconnect",
      request,
    );

    await expect(handleCalendarRoutes(test.deps)).resolves.toBe(true);
    expect(test.mutationGateway.disconnectLinkedCalendar).toHaveBeenCalledWith(
      test.deps.url,
      "link-1",
      request,
    );
    expect(test.json).toHaveBeenCalledWith({ outcome: "paused" });
  });
});
