import { initializeTestRuntime } from "@elizaos/testing/runtime";
/**
 * Proves the owner-gated LifeOps calendar adapter dispatches to the registered
 * CalendarService, including source administration and typed domain failures.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  AgentRuntime,
  createCharacter,
  type IAgentRuntime,
  stringToUuid,
} from "@elizaos/core";
import {
  CalendarService,
  CalendarServiceError,
} from "@elizaos/plugin-calendar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalendarLocalTimeError } from "../../../plugin-calendar/src/internal/time.js";
import {
  handleLifeOpsRoutes,
  type LifeOpsRouteContext,
} from "./lifeops-routes.js";

interface CapturedResponse {
  statusCode: number;
  body: string;
}

class RouteCalendarService extends CalendarService {
  static override serviceType = "calendar";

  sourceReads = 0;
  nextContextError: Error = new CalendarServiceError(
    503,
    "Calendar sources are unavailable.",
    "CALENDAR_SOURCES_UNAVAILABLE",
  );

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<RouteCalendarService> {
    return new RouteCalendarService(runtime);
  }

  override async listIcsCalendarSources(): Promise<[]> {
    this.sourceReads += 1;
    return [];
  }

  override async getNextCalendarEventContext(): Promise<never> {
    throw this.nextContextError;
  }
}

function routeContext(args: { runtime: AgentRuntime; pathname: string }): {
  context: LifeOpsRouteContext;
  response: CapturedResponse;
} {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const request = new IncomingMessage(socket);
  request.method = "GET";
  const response = new ServerResponse(request);
  const captured: CapturedResponse = { statusCode: 0, body: "" };
  response.statusCode = 0;
  response.end = function end(
    this: ServerResponse,
    chunk?: unknown,
  ): ServerResponse {
    captured.statusCode = this.statusCode;
    captured.body = typeof chunk === "string" ? chunk : "";
    return this;
  };

  const context: LifeOpsRouteContext = {
    req: request,
    res: response,
    method: "GET",
    pathname: args.pathname,
    url: new URL(`http://localhost${args.pathname}`),
    state: { runtime: args.runtime, adminEntityId: null },
    json(res, data, status = 200) {
      res.statusCode = status;
      res.end(JSON.stringify(data));
    },
    error(res, message, status = 400) {
      res.statusCode = status;
      res.end(JSON.stringify({ error: message }));
    },
    async readJsonBody() {
      return null;
    },
    decodePathComponent(raw) {
      return decodeURIComponent(raw);
    },
  };
  return { context, response: captured };
}

describe("LifeOps calendar route ownership", () => {
  let runtime: AgentRuntime;
  let calendar: RouteCalendarService;

  beforeEach(async () => {
    runtime = new AgentRuntime({
      agentId: stringToUuid(`calendar-route-${crypto.randomUUID()}`),
      character: createCharacter({ name: "Calendar route ownership" }),
      enableAutonomy: false,
      logLevel: "fatal",
    });
    await initializeTestRuntime(runtime, { skipMigrations: true });
    await runtime.registerService(RouteCalendarService);
    const loaded = await runtime.getServiceLoadPromise(
      RouteCalendarService.serviceType,
    );
    if (!(loaded instanceof RouteCalendarService)) {
      throw new Error("RouteCalendarService did not start.");
    }
    calendar = loaded;
  });

  afterEach(async () => {
    await runtime.stop();
  });

  it("routes ICS source reads to CalendarService instead of LifeOpsService", async () => {
    const { context, response } = routeContext({
      runtime,
      pathname: "/api/lifeops/calendar/sources",
    });

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(response).toEqual({ statusCode: 200, body: '{"sources":[]}' });
    expect(calendar.sourceReads).toBe(1);
  });

  it("translates CalendarServiceError at the owner HTTP boundary", async () => {
    const { context, response } = routeContext({
      runtime,
      pathname: "/api/lifeops/calendar/next-context",
    });

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(response).toEqual({
      statusCode: 503,
      body: '{"error":"Calendar sources are unavailable."}',
    });
  });

  it("answers a repeated local time with a 409 clarification instead of a crash", async () => {
    const possibleInstants = [
      new Date("2026-11-01T05:30:00.000Z"),
      new Date("2026-11-01T06:30:00.000Z"),
    ];
    calendar.nextContextError = new CalendarLocalTimeError(
      "America/New_York",
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
      possibleInstants,
    );
    const { context, response } = routeContext({
      runtime,
      pathname: "/api/lifeops/calendar/next-context",
    });

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      code: "CALENDAR_LOCAL_TIME_AMBIGUOUS",
      requiresInput: true,
      timeClarification: {
        timeZone: "America/New_York",
        possibleInstants: possibleInstants.map((d) => d.toISOString()),
      },
    });
  });
});
