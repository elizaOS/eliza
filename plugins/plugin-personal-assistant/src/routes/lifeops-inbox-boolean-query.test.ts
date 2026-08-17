/**
 * GET /api/lifeops/inbox boolean-identity leftovers.
 *
 * `forceSync` / `replyNeededOnly` already use parseBooleanQuery. Inbox
 * `groupByThread`, `missedOnly`, and `sortByPriority` still compared against
 * the exact token `true`, so `groupByThread=1` silently returned a flat list
 * and garbage tokens were treated as false. Channels / cacheMode / limit
 * parsers are untouched.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

const getInbox = vi.hoisted(() =>
  vi.fn(async () => ({ items: [{ id: "m1" }] })),
);

vi.mock("@elizaos/plugin-calendar/routes/calendar-routes", () => ({
  handleCalendarRoutes: vi.fn(async () => false),
}));

vi.mock("../lifeops/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lifeops/service.js")>();
  return {
    ...actual,
    LifeOpsService: class MockLifeOpsService {
      getInbox = getInbox;
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
    pathname: "/api/lifeops/inbox",
    url: new URL(`http://localhost/api/lifeops/inbox${search}`),
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

describe("GET /api/lifeops/inbox boolean query identity", () => {
  beforeEach(() => {
    getInbox.mockClear();
  });

  it("omitted flags still load the inbox", async () => {
    const { ctx, res } = buildCtx();
    await handleLifeOpsRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(getInbox).toHaveBeenCalledWith({
      limit: undefined,
      channels: undefined,
      groupByThread: undefined,
      chatTypeFilter: undefined,
      maxParticipants: undefined,
      gmailAccountId: undefined,
      phoneAccountIds: undefined,
      missedOnly: undefined,
      sortByPriority: undefined,
      cacheMode: undefined,
      cacheLimit: undefined,
    });
  });

  it("accepts groupByThread=1 the same as groupByThread=true", async () => {
    const { ctx, res } = buildCtx("?groupByThread=1");
    await handleLifeOpsRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(getInbox).toHaveBeenCalledWith(
      expect.objectContaining({ groupByThread: true }),
    );
  });

  it("accepts missedOnly=true and sortByPriority=1 together", async () => {
    const { ctx, res } = buildCtx("?missedOnly=true&sortByPriority=1");
    await handleLifeOpsRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(getInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        missedOnly: true,
        sortByPriority: true,
      }),
    );
  });

  it.each([
    ["groupByThread", "maybe"],
    ["groupByThread", "1e2"],
    ["missedOnly", "truee"],
    ["sortByPriority", "12px"],
  ])("rejects non-boolean %s=%s before getInbox", async (field, token) => {
    const { ctx, res } = buildCtx(`?${field}=${token}`);
    await handleLifeOpsRoutes(ctx);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "")).toEqual({
      error: `${field} must be a boolean`,
    });
    expect(getInbox).not.toHaveBeenCalled();
  });
});
