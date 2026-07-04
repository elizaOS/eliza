/**
 * Verifies agent-routes goal wrapper.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleAgentRoutes } from "../../src/api/agent-routes.ts";
import type { RouteContext } from "../../src/api/route-utils.ts";

function fakeRequest(opts: {
  method: string;
  url: string;
  body?: unknown;
}): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage;
  (emitter as { method: string }).method = opts.method;
  (emitter as { url: string }).url = opts.url;
  (emitter as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  queueMicrotask(() => {
    if (opts.body !== undefined) {
      emitter.emit("data", Buffer.from(JSON.stringify(opts.body)));
    }
    emitter.emit("end");
  });
  return emitter;
}

function fakeResponse(): {
  res: ServerResponse;
  status: () => number;
  body: () => unknown;
} {
  const writes: Buffer[] = [];
  let statusCode = 0;
  const res = {
    writeHead(code: number) {
      statusCode = code;
    },
    end(chunk?: Buffer | string) {
      if (chunk) {
        writes.push(Buffer.from(typeof chunk === "string" ? chunk : chunk));
      }
      (res as { writableEnded: boolean }).writableEnded = true;
    },
    writableEnded: false,
  } as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    body: () => {
      const merged = Buffer.concat(writes).toString("utf8");
      if (!merged) return null;
      try {
        return JSON.parse(merged);
      } catch {
        return merged;
      }
    },
  };
}

type AcpMock = NonNullable<RouteContext["acpService"]>;

function makeCtx(acp: Partial<AcpMock>): RouteContext {
  return {
    runtime: {} as unknown as RouteContext["runtime"],
    acpService: acp as unknown as AcpMock,
    workspaceService: null,
  };
}

describe("agent-routes goal wrapper", () => {
  it("GET /metrics returns real session counts instead of an empty object", async () => {
    const ctx = makeCtx({
      listSessions: vi.fn().mockResolvedValue([
        { id: "a", status: "ready", agentType: "codex" },
        { id: "b", status: "completed", agentType: "claude" },
      ]),
    });
    const req = fakeRequest({
      method: "GET",
      url: "/api/coding-agents/metrics",
    });
    const { res, status, body } = fakeResponse();

    const handled = await handleAgentRoutes(
      req,
      res,
      "/api/coding-agents/metrics",
      ctx,
    );

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(body()).toMatchObject({
      sessionCount: 2,
      activeSessionCount: 1,
      byStatus: { ready: 1, completed: 1 },
      byAgentType: { codex: 1, claude: 1 },
    });
  });

  it("POST /spawn wraps the raw task via buildGoalPrompt and stores the bare goal", async () => {
    const spawnSession = vi.fn().mockResolvedValue({
      id: "sess-1",
      agentType: "codex",
      workdir: process.cwd(),
      status: "ready",
    });
    const ctx = makeCtx({
      listSessions: vi.fn().mockResolvedValue([]),
      spawnSession,
    });
    const req = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/spawn",
      body: {
        agentType: "codex",
        task: "Refactor the parser",
        workdir: process.cwd(),
      },
    });
    const { res, status } = fakeResponse();

    const handled = await handleAgentRoutes(
      req,
      res,
      "/api/coding-agents/spawn",
      ctx,
    );

    expect(handled).toBe(true);
    expect(status()).toBe(201);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    const call = spawnSession.mock.calls[0]?.[0] as {
      initialTask?: string;
      metadata?: Record<string, unknown>;
    };
    expect(call.initialTask).toContain("--- Goal ---");
    expect(call.initialTask).toContain("Refactor the parser");
    expect(call.initialTask).toContain("--- Working Agreement ---");
    // The bare goal is persisted so follow-up sends can re-anchor cleanly.
    expect(call.metadata?.goal).toBe("Refactor the parser");
  });

  it("POST /:id/send re-anchors the message to the session goal via buildGoalFollowUp", async () => {
    const sendToSession = vi.fn().mockResolvedValue({ stopReason: "end" });
    const ctx = makeCtx({
      getSession: vi.fn().mockResolvedValue({
        id: "sess-1",
        metadata: { goal: "Migrate to the new schema", roomId: "room-1" },
      }),
      sendToSession,
    });
    const req = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/sess-1/send",
      body: { input: "Also drop the legacy column" },
    });
    const { res, status } = fakeResponse();

    const handled = await handleAgentRoutes(
      req,
      res,
      "/api/coding-agents/sess-1/send",
      ctx,
    );

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(sendToSession).toHaveBeenCalledTimes(1);
    const wrapped = sendToSession.mock.calls[0]?.[1] as string;
    expect(wrapped).toContain("--- Continue Goal ---");
    expect(wrapped).toContain("Migrate to the new schema");
    expect(wrapped).toContain("room-1");
    expect(wrapped).toContain("Also drop the legacy column");
  });

  it("POST /:id/send still wraps when the session carries no goal", async () => {
    const sendToSession = vi.fn().mockResolvedValue({ stopReason: "end" });
    const ctx = makeCtx({
      getSession: vi.fn().mockResolvedValue({ id: "sess-2", metadata: {} }),
      sendToSession,
    });
    const req = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/sess-2/send",
      body: { input: "Start the build" },
    });
    const { res, status } = fakeResponse();

    await handleAgentRoutes(req, res, "/api/coding-agents/sess-2/send", ctx);

    expect(status()).toBe(200);
    const wrapped = sendToSession.mock.calls[0]?.[1] as string;
    expect(wrapped).toContain("--- Continue Goal ---");
    expect(wrapped).toContain("Start the build");
  });

  it("POST /:id/send returns 404 when the session is unknown", async () => {
    const sendToSession = vi.fn();
    const ctx = makeCtx({
      getSession: vi.fn().mockResolvedValue(undefined),
      sendToSession,
    });
    const req = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/ghost/send",
      body: { input: "hello" },
    });
    const { res, status } = fakeResponse();

    await handleAgentRoutes(req, res, "/api/coding-agents/ghost/send", ctx);

    expect(status()).toBe(404);
    expect(sendToSession).not.toHaveBeenCalled();
  });
});
