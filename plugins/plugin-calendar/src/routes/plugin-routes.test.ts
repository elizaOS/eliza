/**
 * Calendar HTTP route adapter tests cover service-resolution failure policy at
 * the runtime boundary and the owner gate on the calendar read routes.
 */

import type http from "node:http";
import type { AccessContext, ElizaError, IAgentRuntime } from "@elizaos/core";
import type { RouteHandlerContext } from "@elizaos/host/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  __calendarRouteRateLimitBucketCountForTests,
  calendarHttpRoutes,
  calendarRouteHandler,
} from "./plugin-routes.js";

function createRequest(path = "/api/lifeops/calendar/feed") {
  return {
    method: "GET",
    url: path,
    headers: { host: "localhost" },
  } as http.IncomingMessage;
}

function createResponse() {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    headersSent: false,
    setHeader(name: string, value: number | string | readonly string[]) {
      response.headers[name.toLowerCase()] = Array.isArray(value)
        ? value.join(", ")
        : String(value);
    },
    writeHead(
      statusCode: number,
      headers?: Record<string, number | string | readonly string[]>,
    ) {
      response.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers ?? {})) {
        response.setHeader(name, value);
      }
      return response;
    },
    end(chunk?: unknown) {
      response.headersSent = true;
      response.body = chunk === undefined ? "" : String(chunk);
      return response;
    },
  };
  return response as unknown as http.ServerResponse & typeof response;
}

function createRuntime(overrides: {
  serviceLoad?: Promise<unknown>;
  reportError?: ReturnType<typeof vi.fn>;
  service?: unknown;
  settings?: Record<string, string>;
}): IAgentRuntime {
  return {
    agentId: "calendar-agent",
    getSetting: vi.fn((key: string) => overrides.settings?.[key] ?? null),
    getService: vi.fn(() => overrides.service ?? null),
    getServiceLoadPromise: vi.fn(() => overrides.serviceLoad ?? null),
    reportError: overrides.reportError ?? vi.fn(),
  } as unknown as IAgentRuntime;
}

const webhookHeaders = {
  host: "localhost",
  "x-goog-channel-id": "channel-1",
  "x-goog-channel-token": "opaque-token",
  "x-goog-resource-id": "resource-1",
  "x-goog-resource-uri":
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
  "x-goog-resource-state": "exists",
  "x-goog-message-number": "2",
};

function createWebhookRequest(
  overrides: Partial<http.IncomingMessage> & {
    headers?: http.IncomingHttpHeaders;
  } = {},
): http.IncomingMessage {
  return {
    method: "POST",
    url: "/api/lifeops/calendar/google/webhook",
    ...overrides,
    headers: { ...webhookHeaders, ...overrides.headers },
    socket:
      overrides.socket ??
      ({ remoteAddress: "203.0.113.10" } as http.IncomingMessage["socket"]),
  } as unknown as http.IncomingMessage;
}

describe("calendarRouteHandler", () => {
  it("returns unavailable when the calendar service is absent", async () => {
    const handler = calendarRouteHandler();
    const req = createRequest();
    const res = createResponse();
    const runtime = createRuntime({});

    await handler(req, res, runtime);

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: "Calendar service is not available.",
    });
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("reports and throws when the calendar service load fails", async () => {
    const handler = calendarRouteHandler();
    const req = createRequest();
    const res = createResponse();
    const loadError = new Error("migration failed");
    const reportError = vi.fn();
    const runtime = createRuntime({
      serviceLoad: Promise.reject(loadError),
      reportError,
    });

    await expect(handler(req, res, runtime)).rejects.toMatchObject({
      code: "CALENDAR_SERVICE_LOAD_FAILED",
    } satisfies Partial<ElizaError>);
    expect(reportError).toHaveBeenCalledWith(
      "CalendarRoutes.serviceLoad",
      loadError,
      { serviceType: "calendar" },
    );
    expect(res.headersSent).toBe(false);
  });

  it("hides the public webhook unless it is explicitly enabled", async () => {
    const notification = vi.fn();
    const runtime = createRuntime({
      settings: {
        GOOGLE_CALENDAR_WEBHOOK_URL:
          "https://calendar.example.test/api/lifeops/calendar/google/webhook",
      },
      service: { handleGoogleCalendarNotification: notification },
    });
    const res = createResponse();

    await calendarRouteHandler()(createWebhookRequest(), res, runtime);

    expect(res.statusCode).toBe(404);
    expect(runtime.getService).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
  });

  it("rejects bounded and streaming bodies without resolving the service", async () => {
    const notification = vi.fn();
    const runtime = createRuntime({
      settings: { GOOGLE_CALENDAR_WEBHOOK_ENABLED: "true" },
      service: { handleGoogleCalendarNotification: notification },
    });
    const oversized = createResponse();
    await calendarRouteHandler()(
      createWebhookRequest({
        rawBody: Buffer.alloc(1_025),
        headers: { "content-length": "1025" },
      } as Partial<http.IncomingMessage>),
      oversized,
      runtime,
    );

    const iterator = vi.fn(() => {
      throw new Error("The webhook must not consume a request stream.");
    });
    const streamed = createResponse();
    await calendarRouteHandler()(
      createWebhookRequest({
        headers: { "transfer-encoding": "chunked" },
        [Symbol.asyncIterator]: iterator,
      } as Partial<http.IncomingMessage>),
      streamed,
      runtime,
    );

    expect(oversized.statusCode).toBe(413);
    expect(streamed.statusCode).toBe(400);
    expect(iterator).not.toHaveBeenCalled();
    expect(runtime.getService).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
  });

  it("rate-limits a public flood before resolving the service", async () => {
    const notification = vi.fn(async () => ({
      status: 204,
      outcome: "processed",
    }));
    const runtime = createRuntime({
      settings: { GOOGLE_CALENDAR_WEBHOOK_ENABLED: "true" },
      service: { handleGoogleCalendarNotification: notification },
    });
    const handler = calendarRouteHandler();
    const responses = [];
    for (let index = 0; index < 61; index += 1) {
      const response = createResponse();
      responses.push(response);
      await handler(createWebhookRequest(), response, runtime);
    }

    expect(responses.slice(0, 60).every((res) => res.statusCode === 204)).toBe(
      true,
    );
    expect(responses[60]?.statusCode).toBe(429);
    expect(notification).toHaveBeenCalledTimes(60);
    expect(runtime.getService).toHaveBeenCalledTimes(60);
  });

  it("bounds distributed source buckets with oldest-entry eviction", async () => {
    const notification = vi.fn(async () => ({
      status: 204,
      outcome: "processed",
    }));
    const runtime = createRuntime({
      settings: { GOOGLE_CALENDAR_WEBHOOK_ENABLED: "true" },
      service: { handleGoogleCalendarNotification: notification },
    });
    const handler = calendarRouteHandler();
    for (let index = 0; index < 300; index += 1) {
      const response = createResponse();
      await handler(
        createWebhookRequest({
          socket: {
            remoteAddress: `2001:db8::${index.toString(16)}`,
          } as http.IncomingMessage["socket"],
        }),
        response,
        runtime,
      );
      expect(response.statusCode).toBe(204);
    }

    expect(__calendarRouteRateLimitBucketCountForTests(runtime)).toBe(256);
    expect(notification).toHaveBeenCalledTimes(300);
  });
});

describe("calendar owner read routes", () => {
  const readService = {
    ...Object.fromEntries(
      [
        "setCalendarIncluded",
        "getNextCalendarEventContext",
        "createCalendarEvent",
        "updateCalendarEvent",
        "deleteCalendarEvent",
        "respondToCalendarEvent",
        "listIcsCalendarSources",
        "createIcsCalendarSource",
        "updateIcsCalendarSource",
        "deleteIcsCalendarSource",
        "syncIcsCalendarSource",
        "purgeImportedCalendarData",
        "seedImportedCalendarData",
        "listLinkedCalendarEvents",
        "listLinkedCalendarEventViews",
        "getLinkedCalendarEvent",
      ].map((name) => [name, vi.fn()]),
    ),
    getCalendarFeed: vi.fn(async (_url: URL, _request: unknown) => ({
      state: "partial",
      events: [],
    })),
    listCalendars: vi.fn(async (_url: URL, _request: unknown) => [
      { calendarId: "eliza" },
    ]),
  };

  function readRoute(path: string) {
    const route = calendarHttpRoutes.find(
      (candidate) => candidate.type === "GET" && candidate.path === path,
    );
    if (!route?.routeHandler) throw new Error(`${path} is not mounted`);
    return route.routeHandler;
  }

  function readContext(
    overrides: Partial<RouteHandlerContext>,
  ): RouteHandlerContext {
    return {
      signal: new AbortController().signal,
      body: undefined,
      params: {},
      query: {},
      headers: { host: "agent.local" },
      method: "GET",
      path: "/api/lifeops/calendar/feed",
      runtime: createRuntime({ service: readService }),
      inProcess: false,
      isTrustedLocal: false,
      ...overrides,
    };
  }

  it("mounts private feed and calendars reads beside the public webhook", () => {
    expect(
      calendarHttpRoutes.map((route) => [route.type, route.path, route.public]),
    ).toEqual([
      ["GET", "/api/lifeops/calendar/feed", undefined],
      ["GET", "/api/lifeops/calendar/calendars", undefined],
      ["POST", "/api/lifeops/calendar/google/webhook", true],
    ]);
  });

  it("passes the feed query to CalendarService for the trusted local owner", async () => {
    const result = await readRoute("/api/lifeops/calendar/feed")(
      readContext({
        isTrustedLocal: true,
        query: {
          side: "owner",
          timeMin: "2026-10-01T00:00:00.000Z",
          timeMax: "2026-11-01T00:00:00.000Z",
          timeZone: "America/Argentina/Buenos_Aires",
        },
      }),
    );

    expect(result).toEqual({
      status: 200,
      body: { state: "partial", events: [] },
    });
    const [url, request] = readService.getCalendarFeed.mock.lastCall ?? [];
    expect(String(url)).toBe(
      "http://agent.local/api/lifeops/calendar/feed?side=owner&timeMin=2026-10-01T00%3A00%3A00.000Z&timeMax=2026-11-01T00%3A00%3A00.000Z&timeZone=America%2FArgentina%2FBuenos_Aires",
    );
    expect(request).toMatchObject({
      side: "owner",
      timeMin: "2026-10-01T00:00:00.000Z",
      timeMax: "2026-11-01T00:00:00.000Z",
      timeZone: "America/Argentina/Buenos_Aires",
    });
  });

  it("lists calendars for an OWNER session", async () => {
    const result = await readRoute("/api/lifeops/calendar/calendars")(
      readContext({
        path: "/api/lifeops/calendar/calendars",
        query: { side: "owner" },
        accessContext: { role: "OWNER" } as AccessContext,
      }),
    );

    expect(result).toEqual({
      status: 200,
      body: { calendars: [{ calendarId: "eliza" }] },
    });
    expect(readService.listCalendars.mock.lastCall?.[1]).toEqual({
      mode: undefined,
      side: "owner",
      grantId: undefined,
    });
  });

  it.each([
    ["a USER session", { accessContext: { role: "USER" } as AccessContext }],
    [
      "a USER session over loopback",
      {
        isTrustedLocal: true,
        accessContext: { role: "USER" } as AccessContext,
      },
    ],
    ["a gateway token with no owner principal", {}],
  ])("refuses %s before reading the calendar", async (_label, overrides) => {
    readService.getCalendarFeed.mockClear();
    const result = await readRoute("/api/lifeops/calendar/feed")(
      readContext(overrides),
    );

    expect(result.status).toBe(403);
    expect(readService.getCalendarFeed).not.toHaveBeenCalled();
  });
});
