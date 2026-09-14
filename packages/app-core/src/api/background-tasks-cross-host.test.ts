/**
 * Cross-host conformance coverage for the standalone agent and app-core
 * background-task adapters. It exercises both real route modules against the
 * same service and compares their transport responses.
 */
import * as http from "node:http";
import { Socket } from "node:net";
import { handleBackgroundTasksRoute as handleAgentRoute } from "@elizaos/agent/api/background-tasks-routes";
import { describe, expect, it, vi } from "vitest";
import { handleBackgroundTasksRoute as handleAppCoreRoute } from "./background-tasks-routes.ts";
import type { CompatRuntimeState } from "./compat-route-shared.ts";

vi.mock("./auth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.ts")>()),
  ensureRouteAuthorized: vi.fn(async () => true),
}));

function responseCapture(): {
  res: http.ServerResponse;
  body: () => unknown;
  status: () => number;
} {
  let body = "";
  const res = new http.ServerResponse(new http.IncomingMessage(new Socket()));
  res.end = ((chunk?: string | Buffer) => {
    if (chunk) body += chunk.toString();
    return res;
  }) as typeof res.end;
  return {
    res,
    body: () => JSON.parse(body),
    status: () => res.statusCode,
  };
}

describe("background-task host adapter conformance", () => {
  it("returns the same successful controller result in both hosts", async () => {
    const service = { runDueTasks: vi.fn(async () => {}) };
    const runtime = { getService: () => service };
    const agentBody: unknown[] = [];
    await handleAgentRoute({
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: "POST",
      pathname: "/api/background/run-due-tasks",
      state: { runtime },
      json: (_res, data) => agentBody.push(data),
    });

    const appResponse = responseCapture();
    const req = new http.IncomingMessage(new Socket());
    req.method = "POST";
    req.url = "/api/background/run-due-tasks";
    await handleAppCoreRoute(req, appResponse.res, {
      current: runtime,
      pendingAgentName: null,
      pendingRestartReasons: [],
    } as unknown as CompatRuntimeState);

    expect(agentBody[0]).toMatchObject({ ok: true, coalesced: false });
    expect(appResponse.status()).toBe(200);
    expect(appResponse.body()).toMatchObject({ ok: true, coalesced: false });
  });
});
