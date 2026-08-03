/**
 * Calendar HTTP route adapter tests cover service-resolution failure policy at
 * the runtime boundary.
 */

import type http from "node:http";
import type { ElizaError, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  __calendarRouteRateLimitBucketCountForTests,
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

const webhookEnabledSettings = {
  GOOGLE_CALENDAR_WEBHOOK_ENABLED: "true",
  GOOGLE_CALENDAR_WEBHOOK_URL:
    "https://calendar.example.test/api/lifeops/calendar/google/webhook",
  GOOGLE_CALENDAR_WEBHOOK_HMAC_KEYS:
    "cur:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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
      settings: webhookEnabledSettings,
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

  it("rate-limits a same-source public flood before resolving the service", async () => {
    const notification = vi.fn(async () => ({
      status: 204,
      outcome: "processed",
    }));
    const runtime = createRuntime({
      settings: webhookEnabledSettings,
      service: { handleGoogleCalendarNotification: notification },
    });
    const handler = calendarRouteHandler();
    const responses = [];
    for (let index = 0; index < 61; index += 1) {
      const response = createResponse();
      responses.push(response);
      await handler(createWebhookRequest(), response, runtime);
    }

    expect(responses.slice(0, 60).every((res) => res.statusCode === 404)).toBe(
      true,
    );
    expect(responses[60]?.statusCode).toBe(429);
    expect(notification).not.toHaveBeenCalled();
    expect(runtime.getService).not.toHaveBeenCalled();
  });

  it("bounds distributed source buckets with oldest-entry eviction", async () => {
    const notification = vi.fn(async () => ({
      status: 204,
      outcome: "processed",
    }));
    const runtime = createRuntime({
      settings: webhookEnabledSettings,
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
      expect(response.statusCode).toBe(404);
    }

    expect(__calendarRouteRateLimitBucketCountForTests(runtime)).toBe(256);
    expect(notification).not.toHaveBeenCalled();
    expect(runtime.getService).not.toHaveBeenCalled();
  });
});
