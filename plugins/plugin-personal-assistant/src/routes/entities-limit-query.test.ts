/**
 * GET /api/lifeops/entities?limit= must reject prefix-coerced tokens before
 * EntityStore.list. Malformed limits used to be dropped, so the knowledge
 * graph dumped every entity.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleEntityRoutes } from "./entities.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

const kg = vi.hoisted(() => {
  const list = vi.fn(async (_filter: unknown) => {
    return [{ entityId: "e1" }, { entityId: "e2" }];
  });
  return { list };
});

vi.mock("@elizaos/agent", () => ({
  resolveKnowledgeGraphService: () => ({
    getEntityStore: () => ({
      list: kg.list,
    }),
  }),
}));

interface CapturedResponse {
  statusCode?: number;
  body?: string;
  ended: boolean;
}

function buildCtx(search = ""): {
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
  httpReq.method = "GET";
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
    method: "GET",
    pathname: "/api/lifeops/entities",
    url: new URL(`http://localhost/api/lifeops/entities${search}`),
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
      return null;
    },
    decodePathComponent(raw, _res, _label) {
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    },
  };
  return { ctx, res };
}

describe("GET /api/lifeops/entities limit query", () => {
  beforeEach(() => {
    kg.list.mockClear();
  });

  it("omitted limit still lists without a bound", async () => {
    const { ctx, res } = buildCtx();
    await handleEntityRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(kg.list).toHaveBeenCalledWith({});
    expect(JSON.parse(res.body ?? "")).toEqual({
      entities: [{ entityId: "e1" }, { entityId: "e2" }],
    });
  });

  it("empty limit (?limit=) still lists without a bound", async () => {
    const { ctx, res } = buildCtx("?limit=");
    await handleEntityRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(kg.list).toHaveBeenCalledWith({});
    expect(JSON.parse(res.body ?? "")).toEqual({
      entities: [{ entityId: "e1" }, { entityId: "e2" }],
    });
  });

  it("canonical limit=2 reaches store.list", async () => {
    const { ctx, res } = buildCtx("?limit=2");
    await handleEntityRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(kg.list).toHaveBeenCalledWith({ limit: 2 });
  });

  it("keeps type filter when limit is canonical", async () => {
    const { ctx, res } = buildCtx("?type=person&limit=2");
    await handleEntityRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(kg.list).toHaveBeenCalledWith({ type: "person", limit: 2 });
  });

  it.each([
    "1e2",
    "12px",
    "007",
    "0",
    "abc",
    "-1",
    "50abc",
    "9007199254740992",
    // Whitespace-only and whitespace-padded tokens must not trim into either
    // an "unbounded" list or a coerced integer. encodeURIComponent preserves
    // the raw whitespace through the URL parser (e.g. " 2" -> "%202" -> " 2").
    " ",
    " 2",
    "2 ",
    "\t2",
    "2\n",
  ])("rejects limit=%j with 400 before store.list", async (limit) => {
    const { ctx, res } = buildCtx(`?limit=${encodeURIComponent(limit)}`);
    await handleEntityRoutes(ctx);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "")).toEqual({
      error: "limit must be a positive integer",
    });
    expect(kg.list).not.toHaveBeenCalled();
  });
});
