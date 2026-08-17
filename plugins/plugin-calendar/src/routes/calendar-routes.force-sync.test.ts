/**
 * GET /api/lifeops/calendar/feed `forceSync` is refresh-now identity,
 * leftover tax after LifeOps inbox flags (#20930). Stock develop accepted
 * `1` / `TRUE` as force-sync via case-folded boolean identities, so a
 * non-exact token changed the live connector pull instead of a 400.
 * includeHiddenCalendars stays untouched.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type CalendarRouteDeps,
  type CalendarRouteService,
  handleCalendarRoutes,
} from "./calendar-routes.js";

function harness(path: string) {
  const getCalendarFeed = vi.fn(async () => ({ events: [] }));
  const jsonCalls: Array<{ data: unknown; status?: number }> = [];
  const deps: CalendarRouteDeps = {
    method: "GET",
    pathname: "/api/lifeops/calendar/feed",
    url: new URL(`http://host${path}`),
    runRoute: async (fn) => {
      await fn({ getCalendarFeed } as unknown as CalendarRouteService);
      return true;
    },
    rateLimit: () => false,
    json: (data, status) => jsonCalls.push({ data, status }),
    readJsonBody: async () => ({}) as never,
    decodePathComponent: (raw) => raw,
    parseConnectorMode: () => undefined,
    parseConnectorSide: () => undefined,
    parseBoolean: () => undefined,
    serviceError: (status, message) =>
      Object.assign(new Error(message), { status }),
    mutationGateway: {} as CalendarRouteDeps["mutationGateway"],
  };
  return { deps, getCalendarFeed, jsonCalls };
}

describe("GET /api/lifeops/calendar/feed forceSync identity", () => {
  it.each([
    "/api/lifeops/calendar/feed",
    "/api/lifeops/calendar/feed?forceSync=",
  ])("accepts %s as no force-sync", async (path) => {
    const { deps, getCalendarFeed, jsonCalls } = harness(path);
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(getCalendarFeed).toHaveBeenCalledTimes(1);
    const request = getCalendarFeed.mock.calls[0]?.[1] as { forceSync?: boolean };
    expect(request.forceSync).toBeUndefined();
    expect(jsonCalls[0]?.status).toBeUndefined();
  });

  it("accepts forceSync=true as a forced connector pull", async () => {
    const { deps, getCalendarFeed } = harness(
      "/api/lifeops/calendar/feed?forceSync=true",
    );
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(getCalendarFeed).toHaveBeenCalledTimes(1);
    const request = getCalendarFeed.mock.calls[0]?.[1] as { forceSync?: boolean };
    expect(request.forceSync).toBe(true);
  });

  it("accepts forceSync=false as no force-sync", async () => {
    const { deps, getCalendarFeed } = harness(
      "/api/lifeops/calendar/feed?forceSync=false",
    );
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(getCalendarFeed).toHaveBeenCalledTimes(1);
    const request = getCalendarFeed.mock.calls[0]?.[1] as { forceSync?: boolean };
    expect(request.forceSync).toBe(false);
  });

  it.each(["TRUE", "FALSE", "1", "0", "yes", "no", "foo", "1e2"])(
    "rejects forceSync=%s before getCalendarFeed",
    async (token) => {
      const { deps, getCalendarFeed, jsonCalls } = harness(
        `/api/lifeops/calendar/feed?forceSync=${encodeURIComponent(token)}`,
      );
      expect(await handleCalendarRoutes(deps)).toBe(true);
      expect(getCalendarFeed).not.toHaveBeenCalled();
      expect(jsonCalls).toEqual([{ data: { error: "Invalid forceSync" }, status: 400 }]);
    },
  );

  it.each([
    "/api/lifeops/calendar/feed?forceSync=true&forceSync=true",
    "/api/lifeops/calendar/feed?forceSync=true&forceSync=false",
    "/api/lifeops/calendar/feed?forceSync=&forceSync=true",
    "/api/lifeops/calendar/feed?forceSync=foo&forceSync=true",
  ])("rejects duplicate forceSync values in %s before getCalendarFeed", async (path) => {
    const { deps, getCalendarFeed, jsonCalls } = harness(path);
    expect(await handleCalendarRoutes(deps)).toBe(true);
    expect(getCalendarFeed).not.toHaveBeenCalled();
    expect(jsonCalls).toEqual([{ data: { error: "Invalid forceSync" }, status: 400 }]);
  });
});
