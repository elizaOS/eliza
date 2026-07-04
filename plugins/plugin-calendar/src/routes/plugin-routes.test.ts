/**
 * Calendar HTTP route adapter tests cover service-resolution failure policy at
 * the runtime boundary.
 */

import type http from "node:http";
import type { ElizaError, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { calendarRouteHandler } from "./plugin-routes.js";

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
}): IAgentRuntime {
  return {
    agentId: "calendar-agent",
    getService: vi.fn(() => null),
    getServiceLoadPromise: vi.fn(() => overrides.serviceLoad ?? null),
    reportError: overrides.reportError ?? vi.fn(),
  } as unknown as IAgentRuntime;
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
});
