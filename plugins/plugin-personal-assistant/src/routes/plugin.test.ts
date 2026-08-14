/**
 * Tests the personal-assistant route plugin's auth/authorization gate: token
 * enforcement, session resolution, and OWNER/ADMIN role gating on the raw
 * `/api/lifeops/*` surface. Downstream route handlers are stubbed (deterministic
 * vi.mock), so the assertions isolate the access-control boundary in plugin.ts.
 */

import type http from "node:http";
import { _resetAuthRateLimiter } from "@elizaos/app-core/api/auth";
import type { AgentRuntime, Route } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lifeops/scheduled-task/service.js", () => ({
  getScheduledTaskRunner: () => null,
}));

vi.mock("./entities.js", () => ({
  handleEntityRoutes: async () => false,
}));

vi.mock("./lifeops-routes.js", () => ({
  handleLifeOpsRoutes: async () => undefined,
}));

vi.mock("./relationships.js", () => ({
  handleRelationshipRoutes: async () => false,
}));

vi.mock("./scheduled-tasks.js", () => ({
  DEV_REGISTRIES_ROUTE_PATHS: [],
  makeScheduledTasksRouteHandler: () => async () => false,
}));

vi.mock("./sleep-routes.js", () => ({
  handleSleepRoutes: async () => undefined,
}));

vi.mock("./website-blocker-routes.js", () => ({
  handleWebsiteBlockerRoutes: async () => undefined,
}));

import {
  personalAssistantRoutesPlugin,
  requireLifeOpsRouteOwnerAdminAccess,
} from "./plugin.js";

type CapturedResponse = http.ServerResponse & {
  body: string;
  headers: Record<string, string | number | string[]>;
  writableEnded: boolean;
};

function createRequest(
  url: string,
  headers: http.IncomingHttpHeaders = {},
  options: { method?: string; remoteAddress?: string; host?: string } = {},
): http.IncomingMessage {
  return {
    method: options.method ?? "GET",
    url,
    headers: {
      host: options.host ?? "example.test",
      ...headers,
    },
    socket: {
      remoteAddress: options.remoteAddress ?? "203.0.113.10",
    },
  } as http.IncomingMessage;
}

function createResponse(): CapturedResponse {
  return {
    statusCode: 200,
    body: "",
    headers: {},
    writableEnded: false,
    setHeader(name: string, value: string | number | readonly string[]) {
      this.headers[name.toLowerCase()] = Array.isArray(value)
        ? [...value]
        : value;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk != null) {
        this.body += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
      }
      this.writableEnded = true;
      return this;
    },
  } as CapturedResponse;
}

function createRuntime(options?: {
  ownerId?: string | null;
  roles?: Record<string, "OWNER" | "ADMIN" | "USER" | "GUEST">;
}): AgentRuntime {
  const ownerId = options?.ownerId === undefined ? "owner-1" : options.ownerId;
  return {
    agentId: "agent-1",
    getSetting: vi.fn((key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? (ownerId ?? undefined) : undefined,
    ),
    getAllWorlds: vi.fn(async () => [
      {
        id: "world-1",
        metadata: {
          roles: options?.roles ?? {},
        },
      },
    ]),
    getEntityById: vi.fn(async () => null),
    getRelationships: vi.fn(async () => []),
    getService: vi.fn(() => null),
  } as AgentRuntime;
}

function findRoute(
  type: Route["type"],
  path: string,
): Route & { handler: NonNullable<Route["handler"]> } {
  const route = personalAssistantRoutesPlugin.routes?.find(
    (candidate) => candidate.type === type && candidate.path === path,
  );
  expect(route?.handler).toBeTypeOf("function");
  return route as Route & { handler: NonNullable<Route["handler"]> };
}

describe("LifeOps raw route owner/admin gate", () => {
  beforeEach(() => {
    _resetAuthRateLimiter();
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  });

  afterEach(() => {
    _resetAuthRateLimiter();
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  });

  it("allows configured owner bearer tokens without trusting actor headers", async () => {
    process.env.ELIZA_API_TOKEN = "owner-token";
    const res = createResponse();
    const allowed = await requireLifeOpsRouteOwnerAdminAccess({
      req: createRequest("/api/lifeops/app-state", {
        authorization: "Bearer owner-token",
        "x-eliza-entity-id": "spoofed-admin",
      }),
      res,
      runtime: createRuntime({ roles: { "spoofed-admin": "GUEST" } }),
    });

    expect(allowed).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  it("allows trusted local UI calls without an actor header", async () => {
    const res = createResponse();
    const allowed = await requireLifeOpsRouteOwnerAdminAccess({
      req: createRequest(
        "/api/lifeops/app-state",
        {},
        { remoteAddress: "127.0.0.1", host: "localhost:3000" },
      ),
      res,
      runtime: createRuntime({ ownerId: null }),
    });

    expect(allowed).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  it("denies remote headerless raw routes instead of defaulting to owner", async () => {
    const res = createResponse();
    const runtime = createRuntime({ ownerId: null });
    const allowed = await requireLifeOpsRouteOwnerAdminAccess({
      req: createRequest("/api/lifeops/app-state"),
      res,
      runtime,
    });

    expect(allowed).toBe(false);
    expect(runtime.getAllWorlds).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
  });

  it("denies spoofed actor headers even when they name the canonical owner", async () => {
    const res = createResponse();
    const runtime = createRuntime();
    const allowed = await requireLifeOpsRouteOwnerAdminAccess({
      req: createRequest("/api/lifeops/app-state", {
        "x-eliza-entity-id": "owner-1",
        "x-eliza-actor-entity-id": "owner-1",
      }),
      res,
      runtime,
    });

    expect(allowed).toBe(false);
    expect(runtime.getAllWorlds).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
  });

  it("denies private raw routes for explicit non-admin actors before the route handler runs", async () => {
    const route = findRoute("GET", "/api/lifeops/app-state");
    const res = createResponse();

    await route.handler(
      createRequest("/api/lifeops/app-state", {
        "x-eliza-entity-id": "user-1",
      }) as never,
      res as never,
      createRuntime({ roles: { "user-1": "USER" } }) as never,
    );

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: "Unauthorized",
    });
  });

  it("mounts every owner calendar surface behind the same private gate", () => {
    const calendarRoutes = [
      ["GET", "/api/lifeops/calendar/feed"],
      ["GET", "/api/lifeops/calendar/sources"],
      ["POST", "/api/lifeops/calendar/sources"],
      ["PATCH", "/api/lifeops/calendar/sources/:sourceId"],
      ["DELETE", "/api/lifeops/calendar/sources/:sourceId"],
      ["POST", "/api/lifeops/calendar/sources/:sourceId/sync"],
      ["GET", "/api/lifeops/calendar/meeting-auto-join"],
      ["PUT", "/api/lifeops/calendar/meeting-auto-join"],
      ["GET", "/api/lifeops/calendar/calendars"],
      ["PUT", "/api/lifeops/calendar/calendars/:id/include"],
      ["GET", "/api/lifeops/calendar/next-context"],
      ["POST", "/api/lifeops/calendar/events"],
      ["PATCH", "/api/lifeops/calendar/events/:eventId"],
      ["DELETE", "/api/lifeops/calendar/events/:eventId"],
    ] as const;

    for (const [type, path] of calendarRoutes) {
      expect(findRoute(type, path).public).not.toBe(true);
    }
  });

  it("mounts the commitment regret audit behind the owner/admin gate", async () => {
    const route = findRoute("GET", "/api/lifeops/commitments/regret-audit");
    const denied = createResponse();

    expect(route.public).not.toBe(true);
    await route.handler(
      createRequest("/api/lifeops/commitments/regret-audit") as never,
      denied as never,
      createRuntime() as never,
    );
    expect(denied.statusCode).toBe(401);
    expect(JSON.parse(denied.body)).toEqual({ error: "Unauthorized" });

    process.env.ELIZA_API_TOKEN = "owner-token";
    const allowed = createResponse();
    await route.handler(
      createRequest("/api/lifeops/commitments/regret-audit", {
        authorization: "Bearer owner-token",
      }) as never,
      allowed as never,
      createRuntime() as never,
    );
    expect(allowed.statusCode).toBe(200);
    expect(allowed.writableEnded).toBe(false);
  });

  it("does not wrap public OAuth callback routes with the owner/admin gate", async () => {
    const route = findRoute("GET", "/api/connectors/google/oauth/callback");
    const res = createResponse();

    await route.handler(
      createRequest("/api/connectors/google/oauth/callback", {
        "x-eliza-entity-id": "user-1",
      }) as never,
      res as never,
      createRuntime({ roles: { "user-1": "USER" } }) as never,
    );

    expect(route.public).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Missing OAuth state",
    });
  });
});
