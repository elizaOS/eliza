/**
 * Deterministic route-boundary coverage verifies malformed entity and
 * relationship IDs fail with a structured 400 before knowledge-graph or body
 * work, while valid encoded IDs still reach the real handler contract.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { decodePathComponent } from "@elizaos/agent/api/server-helpers";
import type { AgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleEntityRoutes } from "./entities.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";
import { handleRelationshipRoutes } from "./relationships.js";

const graph = vi.hoisted(() => {
  const entityStore = {
    get: vi.fn(),
    list: vi.fn(),
    merge: vi.fn(),
    observeIdentity: vi.fn(),
    resolve: vi.fn(),
    upsert: vi.fn(),
  };
  const relationshipStore = {
    get: vi.fn(),
    list: vi.fn(),
    observe: vi.fn(),
    retire: vi.fn(),
    upsert: vi.fn(),
  };
  const service = {
    getEntityStore: vi.fn(() => entityStore),
    getRelationshipStore: vi.fn(() => relationshipStore),
  };
  return {
    entityStore,
    relationshipStore,
    resolve: vi.fn(() => service),
    service,
  };
});

vi.mock("@elizaos/agent", () => ({
  resolveKnowledgeGraphService: graph.resolve,
}));

interface CapturedResponse {
  body: string;
  ended: boolean;
  statusCode: number;
}

function buildContext(options: {
  body?: object;
  method: string;
  pathname: string;
}): {
  ctx: LifeOpsRouteContext;
  readJsonBody: ReturnType<typeof vi.fn>;
  response: CapturedResponse;
} {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    configurable: true,
    value: "127.0.0.1",
  });
  const req = new IncomingMessage(socket);
  req.method = options.method;
  req.url = options.pathname;

  const captured: CapturedResponse = {
    body: "",
    ended: false,
    statusCode: 200,
  };
  const res = new ServerResponse(req);
  res.end = function end(
    this: ServerResponse,
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): ServerResponse {
    captured.body =
      chunk === undefined
        ? ""
        : Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
    captured.ended = true;
    captured.statusCode = this.statusCode;
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return this;
  };

  const readJsonBody = vi.fn(async () => options.body ?? {});
  const ctx: LifeOpsRouteContext = {
    req,
    res,
    method: options.method,
    pathname: options.pathname,
    url: new URL(options.pathname, "http://localhost"),
    state: {
      adminEntityId: null,
      runtime: { agentId: "agent-1" } as unknown as AgentRuntime,
    },
    json(response, data, status = 200) {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(data));
    },
    error(response, message, status = 400) {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: message }));
    },
    readJsonBody:
      readJsonBody as unknown as LifeOpsRouteContext["readJsonBody"],
    decodePathComponent,
  };
  return { ctx, readJsonBody, response: captured };
}

const routeCases = [
  {
    domain: "entity",
    handle: handleEntityRoutes,
    label: "entity id",
    method: "POST",
    path: (segment: string) => `/api/lifeops/entities/${segment}/identities`,
  },
  {
    domain: "entity",
    handle: handleEntityRoutes,
    label: "entity id",
    method: "PATCH",
    path: (segment: string) => `/api/lifeops/entities/${segment}`,
  },
  {
    domain: "entity",
    handle: handleEntityRoutes,
    label: "entity id",
    method: "GET",
    path: (segment: string) => `/api/lifeops/entities/${segment}`,
  },
  {
    domain: "relationship",
    handle: handleRelationshipRoutes,
    label: "relationship id",
    method: "POST",
    path: (segment: string) => `/api/lifeops/relationships/${segment}/retire`,
  },
  {
    domain: "relationship",
    handle: handleRelationshipRoutes,
    label: "relationship id",
    method: "PATCH",
    path: (segment: string) => `/api/lifeops/relationships/${segment}`,
  },
  {
    domain: "relationship",
    handle: handleRelationshipRoutes,
    label: "relationship id",
    method: "GET",
    path: (segment: string) => `/api/lifeops/relationships/${segment}`,
  },
] as const;

describe("entity and relationship item-route encoding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const routeCase of routeCases) {
    it.each(["%", "%E0%A4"])(
      `rejects ${routeCase.method} ${routeCase.domain} segment %s before downstream work`,
      async (segment) => {
        const { ctx, readJsonBody, response } = buildContext({
          method: routeCase.method,
          pathname: routeCase.path(segment),
        });

        await expect(routeCase.handle(ctx)).resolves.toBe(true);

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body)).toEqual({
          error: `Invalid ${routeCase.label}: malformed URL encoding`,
        });
        expect(graph.resolve).not.toHaveBeenCalled();
        expect(graph.service.getEntityStore).not.toHaveBeenCalled();
        expect(graph.service.getRelationshipStore).not.toHaveBeenCalled();
        expect(readJsonBody).not.toHaveBeenCalled();
      },
    );
  }

  it("decodes a valid entity ID before entity lookup", async () => {
    graph.entityStore.get.mockResolvedValueOnce({ entityId: "entity one" });
    const { ctx, response } = buildContext({
      method: "GET",
      pathname: "/api/lifeops/entities/entity%20one",
    });

    await expect(handleEntityRoutes(ctx)).resolves.toBe(true);

    expect(graph.entityStore.get).toHaveBeenCalledWith("entity one");
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      entity: { entityId: "entity one" },
    });
  });

  it("decodes a valid relationship ID before relationship lookup", async () => {
    graph.relationshipStore.get.mockResolvedValueOnce({
      relationshipId: "relationship one",
    });
    const { ctx, response } = buildContext({
      method: "GET",
      pathname: "/api/lifeops/relationships/relationship%20one",
    });

    await expect(handleRelationshipRoutes(ctx)).resolves.toBe(true);

    expect(graph.relationshipStore.get).toHaveBeenCalledWith(
      "relationship one",
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      relationship: { relationshipId: "relationship one" },
    });
  });
});
