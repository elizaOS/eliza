/** Exercises relationship identifier decoding through the shared LifeOps route context. */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

const { get, retire, upsert, list, observe } = vi.hoisted(() => ({
  get: vi.fn(async (id: string) => ({
    relationshipId: id,
    fromEntityId: "from-1",
    toEntityId: "to-1",
    type: "friend",
  })),
  retire: vi.fn(async () => undefined),
  upsert: vi.fn(async (row: unknown) => row),
  list: vi.fn(async () => []),
  observe: vi.fn(async (row: unknown) => row),
}));

vi.mock("@elizaos/agent", () => ({
  resolveKnowledgeGraphService: () => ({
    getRelationshipStore: () => ({ get, retire, upsert, list, observe }),
  }),
}));

const { handleRelationshipRoutes } = await import("./relationships.js");

interface CapturedResponse {
  statusCode?: number;
  body?: string;
  ended: boolean;
}

function buildCtx(
  method: string,
  pathname: string,
): {
  ctx: LifeOpsRouteContext;
  res: CapturedResponse;
} {
  const res: CapturedResponse = { ended: false };
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const httpReq = new IncomingMessage(socket);
  httpReq.method = method;
  const httpRes = new ServerResponse(httpReq);
  httpRes.statusCode = 0;
  httpRes.end = function end(
    this: ServerResponse,
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): ServerResponse {
    res.ended = true;
    res.body = typeof chunk === "string" ? chunk : "";
    res.statusCode = this.statusCode;
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return this;
  };

  const ctx: LifeOpsRouteContext = {
    req: httpReq,
    res: httpRes,
    method,
    pathname,
    url: new URL("http://localhost/api/lifeops/relationships"),
    state: {
      runtime: { agentId: "agent-1" } as unknown as AgentRuntime,
      adminEntityId: null,
    },
    json(r, data, status = 200) {
      r.statusCode = status;
      r.setHeader?.("content-type", "application/json");
      r.end?.(JSON.stringify(data));
    },
    error(r, message, status = 400) {
      r.statusCode = status;
      r.setHeader?.("content-type", "application/json");
      r.end?.(JSON.stringify({ error: message }));
    },
    async readJsonBody<T extends object>(): Promise<T | null> {
      return { reason: "manual_retire" } as T;
    },
    decodePathComponent(raw, r, fieldName) {
      try {
        return decodeURIComponent(raw);
      } catch {
        ctx.error(r, `Invalid ${fieldName}: malformed URL encoding`, 400);
        return null;
      }
    },
  };
  return { ctx, res };
}

describe("lifeops relationship id encoding", () => {
  beforeEach(() => {
    get.mockClear();
    retire.mockClear();
    upsert.mockClear();
    list.mockClear();
    observe.mockClear();
  });

  test("canonical GET still reaches the relationship store", async () => {
    const { ctx, res } = buildCtx("GET", "/api/lifeops/relationships/rel-1");
    await handleRelationshipRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(get).toHaveBeenCalledWith("rel-1");
    expect(JSON.parse(res.body ?? "")).toEqual({
      relationship: {
        relationshipId: "rel-1",
        fromEntityId: "from-1",
        toEntityId: "to-1",
        type: "friend",
      },
    });
  });

  test("canonical percent-encoded hyphen still decodes before GET", async () => {
    const { ctx, res } = buildCtx("GET", "/api/lifeops/relationships/rel%2D1");
    await handleRelationshipRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(get).toHaveBeenCalledWith("rel-1");
  });

  test.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed GET id %s with 400 before store lookup",
    async (token) => {
      const { ctx, res } = buildCtx(
        "GET",
        `/api/lifeops/relationships/${token}`,
      );
      await handleRelationshipRoutes(ctx);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body ?? "")).toEqual({
        error: "Invalid relationship id: malformed URL encoding",
      });
      expect(get).not.toHaveBeenCalled();
    },
  );

  test.each(["%", "%2", "%ZZ"])(
    "rejects malformed PATCH id %s with 400 before store lookup",
    async (token) => {
      const { ctx, res } = buildCtx(
        "PATCH",
        `/api/lifeops/relationships/${token}`,
      );
      await handleRelationshipRoutes(ctx);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body ?? "")).toEqual({
        error: "Invalid relationship id: malformed URL encoding",
      });
      expect(get).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    },
  );

  test.each(["%", "%2", "%ZZ"])(
    "rejects malformed retire id %s with 400 before store lookup",
    async (token) => {
      const { ctx, res } = buildCtx(
        "POST",
        `/api/lifeops/relationships/${token}/retire`,
      );
      await handleRelationshipRoutes(ctx);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body ?? "")).toEqual({
        error: "Invalid relationship id: malformed URL encoding",
      });
      expect(retire).not.toHaveBeenCalled();
    },
  );
});
