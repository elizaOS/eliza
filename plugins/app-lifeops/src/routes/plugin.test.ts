import type http from "node:http";
import type { AgentRuntime, Route } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  lifeopsPlugin,
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
): http.IncomingMessage {
  return {
    method: "GET",
    url,
    headers,
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
  } as unknown as AgentRuntime;
}

function findRoute(
  type: Route["type"],
  path: string,
): Route & { handler: NonNullable<Route["handler"]> } {
  const route = lifeopsPlugin.routes?.find(
    (candidate) => candidate.type === type && candidate.path === path,
  );
  expect(route?.handler).toBeTypeOf("function");
  return route as Route & { handler: NonNullable<Route["handler"]> };
}

describe("LifeOps raw route owner/admin gate", () => {
  it("allows actors with an ADMIN role", async () => {
    const res = createResponse();
    const allowed = await requireLifeOpsRouteOwnerAdminAccess({
      req: createRequest("/api/lifeops/app-state", {
        "x-eliza-entity-id": "admin-1",
      }),
      res,
      runtime: createRuntime({ roles: { "admin-1": "ADMIN" } }),
    });

    expect(allowed).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  it("keeps existing local UI calls mapped to the default owner when no actor header is present", async () => {
    const res = createResponse();
    const allowed = await requireLifeOpsRouteOwnerAdminAccess({
      req: createRequest("/api/lifeops/app-state"),
      res,
      runtime: createRuntime({ ownerId: null }),
    });

    expect(allowed).toBe(true);
    expect(res.writableEnded).toBe(false);
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

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "LifeOps routes require OWNER or ADMIN access",
    });
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
