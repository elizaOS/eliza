/**
 * End-to-end proof that the health summary route validates its calendar
 * window before any SQL runs: an HTTP-shaped GET to
 * /api/lifeops/health/summary travels the real route dispatcher →
 * LifeOpsService → HealthDomain → LifeOpsRepository against a real
 * PGlite-backed AgentRuntime. An impossible day such as 2026-02-30 is a 400
 * at the boundary, never a 500 from a rejected timestamp literal, and a real
 * window still reaches the repository and returns 200. No mocks.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { AgentRuntime, type Character, type UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgliteDatabaseAdapter } from "../../../plugin-sql/src/pglite/adapter.js";
import { PGliteClientManager } from "../../../plugin-sql/src/pglite/manager.js";
import {
  handleLifeOpsRoutes,
  type LifeOpsRouteContext,
} from "./lifeops-routes.js";

interface CapturedResponse {
  statusCode?: number;
  body?: string;
}

function buildGet(
  runtime: AgentRuntime,
  search: string,
): { ctx: LifeOpsRouteContext; res: CapturedResponse } {
  const res: CapturedResponse = {};
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const httpReq = new IncomingMessage(socket);
  httpReq.method = "GET";
  httpReq.headers = {};
  const httpRes = new ServerResponse(httpReq);
  httpRes.statusCode = 0;
  httpRes.end = function end(
    this: ServerResponse,
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): ServerResponse {
    res.body = typeof chunk === "string" ? chunk : "";
    res.statusCode = this.statusCode;
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return this;
  };
  const pathname = "/api/lifeops/health/summary";
  const ctx: LifeOpsRouteContext = {
    req: httpReq,
    res: httpRes,
    method: "GET",
    pathname,
    url: new URL(`http://localhost${pathname}${search}`),
    state: { runtime, adminEntityId: null },
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
    decodePathComponent(raw) {
      return raw;
    },
  };
  return { ctx, res };
}

describe("health summary window validation e2e (real runtime + PGlite)", () => {
  let manager: PGliteClientManager;
  let adapter: PgliteDatabaseAdapter;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    const agentId = crypto.randomUUID() as UUID;
    manager = new PGliteClientManager({});
    await manager.initialize();
    adapter = new PgliteDatabaseAdapter(agentId, manager);
    await adapter.init();
    runtime = new AgentRuntime({
      agentId,
      character: { name: "lifeops-health-window-e2e" } as Character,
      adapter,
    });
  });

  afterEach(async () => {
    await adapter.close();
    await manager.close();
  });

  it.each([
    "?startDate=2026-02-30",
    "?endDate=2026-04-31",
    "?startDate=2026-02-29&endDate=2026-03-01",
  ])("rejects an impossible calendar day with a 400: %s", async (search) => {
    const { ctx, res } = buildGet(runtime, search);
    expect(await handleLifeOpsRoutes(ctx)).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "{}")).toMatchObject({
      error: expect.stringContaining("calendar date"),
    });
    expect(runtime.getRecentReportedErrors()).toEqual([]);
  });

  it("serves a real window through the repository", async () => {
    const { ctx, res } = buildGet(
      runtime,
      "?startDate=2026-02-28&endDate=2026-03-01",
    );
    expect(await handleLifeOpsRoutes(ctx)).toBe(true);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}") as {
      providers: unknown[];
      summaries: unknown[];
      samples: unknown[];
      workouts: unknown[];
      sleepEpisodes: unknown[];
    };
    expect(Array.isArray(payload.providers)).toBe(true);
    expect(payload.summaries).toEqual([]);
    expect(payload.samples).toEqual([]);
    expect(payload.workouts).toEqual([]);
    expect(payload.sleepEpisodes).toEqual([]);
    expect(runtime.getRecentReportedErrors()).toEqual([]);
  });
});
