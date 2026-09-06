import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

const { getOverview, listDefinitions } = vi.hoisted(() => ({
  getOverview: vi.fn(async () => ({ owner: { occurrences: [] } })),
  listDefinitions: vi.fn(async () => [] as Array<Record<string, unknown>>),
}));

vi.mock("@elizaos/plugin-calendar/routes/calendar-routes", () => ({
  handleCalendarRoutes: vi.fn(async () => false),
}));

vi.mock("../lifeops/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lifeops/service.js")>();
  return {
    ...actual,
    LifeOpsService: class MockLifeOpsService {
      getOverview = getOverview;
      listDefinitions = listDefinitions;
    },
  };
});

const { handleLifeOpsRoutes } = await import("./lifeops-routes.js");

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
    pathname: "/api/lifeops/todos",
    url: new URL(`http://localhost/api/lifeops/todos${search}`),
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
    decodePathComponent(raw) {
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    },
  };
  return { ctx, res };
}

describe("GET /api/lifeops/todos unscheduled tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDefinitions.mockResolvedValue([]);
  });

  it("includes active owner unscheduled tasks without manufacturing scheduled occurrences", async () => {
    listDefinitions.mockResolvedValue([
      {
        definition: {
          id: "undated",
          title: "Read the draft",
          kind: "task",
          subjectType: "owner",
          status: "active",
          cadence: { kind: "unscheduled" },
        },
      },
    ]);
    const { ctx, res } = buildCtx();
    await handleLifeOpsRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "{}").todos).toEqual([
      {
        id: "undated",
        title: "Read the draft",
        status: "pending",
        dueDate: null,
        progress: null,
      },
    ]);
  });

  it("excludes agent operations, inactive tasks, and scheduled definitions from the unscheduled projection", async () => {
    const base = {
      id: "excluded",
      title: "Hidden",
      kind: "task",
      subjectType: "owner",
      status: "active",
      cadence: { kind: "unscheduled" },
    };
    listDefinitions.mockResolvedValue([
      { definition: { ...base, subjectType: "agent" } },
      { definition: { ...base, status: "archived" } },
      { definition: { ...base, cadence: { kind: "once" } } },
      { definition: { ...base, kind: "routine" } },
    ]);
    const { ctx, res } = buildCtx();
    await handleLifeOpsRoutes(ctx);
    expect(JSON.parse(res.body ?? "{}").todos).toEqual([]);
  });
});
