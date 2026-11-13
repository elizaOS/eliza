import { initializeTestRuntime } from "@elizaos/testing/runtime";
/**
 * Proves the owner-gated LifeOps calendar adapter dispatches to the registered
 * CalendarService, including source administration and typed domain failures.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  _resetDeferredBootStatusForTest,
  markDeferredBootPhase,
} from "@elizaos/agent/runtime/deferred-boot-status";
import {
  AgentRuntime,
  createCharacter,
  EventType,
  type IAgentRuntime,
  stringToUuid,
} from "@elizaos/core";
import {
  CalendarService,
  CalendarServiceError,
} from "@elizaos/plugin-calendar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function routeContext(args: {
  runtime: AgentRuntime;
  pathname: string;
  method?: string;
}): {
  context: LifeOpsRouteContext;
  response: CapturedResponse;
} {
  const method = args.method ?? "GET";
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const request = new IncomingMessage(socket);
  request.method = method;
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
    method,
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

describe("LifeOps calendar reads during deferred boot", () => {
  // The calendar plugin registers in the deferred wave after these routes mount.
  const calendarPlugin = {
    name: "calendar",
    description: "Deferred calendar plugin",
    services: [RouteCalendarService],
  };
  let runtime: AgentRuntime;

  beforeEach(async () => {
    runtime = new AgentRuntime({
      agentId: stringToUuid(`calendar-deferred-${crypto.randomUUID()}`),
      character: createCharacter({ name: "Calendar deferred boot" }),
      enableAutonomy: false,
      logLevel: "fatal",
    });
    await initializeTestRuntime(runtime, { skipMigrations: true });
    _resetDeferredBootStatusForTest();
    markDeferredBootPhase("agent-deferred-boot", "pending");
  });

  afterEach(async () => {
    vi.useRealTimers();
    _resetDeferredBootStatusForTest();
    await runtime.stop();
  });

  function track(promise: Promise<boolean>): { settled: () => boolean } {
    let settled = false;
    void promise.finally(() => {
      settled = true;
    });
    return { settled: () => settled };
  }

  it("serves a read that arrives before the calendar plugin registers", async () => {
    const startedHandlers = runtime.getEvent(EventType.SERVICE_STARTED) ?? [];
    const { context, response } = routeContext({
      runtime,
      pathname: "/api/lifeops/calendar/sources",
    });

    const handled = handleLifeOpsRoutes(context);
    const request = track(handled);
    await new Promise((resolve) => setImmediate(resolve));
    expect(request.settled()).toBe(false);

    await runtime.registerPlugin(calendarPlugin);

    await expect(handled).resolves.toBe(true);
    expect(response).toEqual({ statusCode: 200, body: '{"sources":[]}' });
    expect(runtime.getEvent(EventType.SERVICE_STARTED) ?? []).toEqual(
      startedHandlers,
    );
  });

  it("keeps the 503 for a calendar service that never registers, after the bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const startedHandlers = runtime.getEvent(EventType.SERVICE_STARTED) ?? [];
    const { context, response } = routeContext({
      runtime,
      pathname: "/api/lifeops/calendar/sources",
    });

    const handled = handleLifeOpsRoutes(context);
    const request = track(handled);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(request.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(handled).resolves.toBe(true);
    expect(response).toEqual({
      statusCode: 503,
      body: '{"error":"Calendar service failed to load."}',
    });
    expect(runtime.getEvent(EventType.SERVICE_STARTED) ?? []).toEqual(
      startedHandlers,
    );
  });

  it("fails an absent calendar service at once after deferred boot settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    markDeferredBootPhase("agent-deferred-boot", "complete");
    const { context, response } = routeContext({
      runtime,
      pathname: "/api/lifeops/calendar/sources",
    });

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(response).toEqual({
      statusCode: 503,
      body: '{"error":"Calendar service failed to load."}',
    });
  });

  it("does not hold a calendar mutation across deferred registration", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { context, response } = routeContext({
      runtime,
      method: "POST",
      pathname: "/api/lifeops/calendar/sources/source-1/sync",
    });

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(response).toEqual({
      statusCode: 503,
      body: '{"error":"Calendar service failed to load."}',
    });
  });

  it("serves an already-started calendar service without waiting", async () => {
    await runtime.registerPlugin(calendarPlugin);
    await runtime.getServiceLoadPromise(RouteCalendarService.serviceType);
    const registerEvent = vi.spyOn(runtime, "registerEvent");
    const { context, response } = routeContext({
      runtime,
      pathname: "/api/lifeops/calendar/sources",
    });

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(response).toEqual({ statusCode: 200, body: '{"sources":[]}' });
    expect(registerEvent).not.toHaveBeenCalled();
  });
});
