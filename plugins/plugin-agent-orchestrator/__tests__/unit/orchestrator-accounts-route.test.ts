/**
 * Guards GET /api/orchestrator/accounts on two fronts:
 *  1. The path template is REGISTERED in CODING_AGENT_ROUTE_PATHS — the runtime
 *     route matcher needs an exact-segment template, so a handler that exists
 *     in orchestrator-routes.ts but is unregistered 404s over real HTTP (the
 *     bug this surface shipped with until this test).
 *  2. The handler dispatches to OrchestratorTaskService.getAccountOverview and
 *     returns the {strategy, availability, assignments} shape.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleOrchestratorRoutes } from "../../src/api/orchestrator-routes.js";
import type { RouteContext } from "../../src/api/route-utils.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import { codingAgentRoutePlugin } from "../../src/setup-routes.ts";

function makeService(): OrchestratorTaskService {
  return new OrchestratorTaskService(
    {
      getService: () => null,
      getSetting: () => undefined,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never,
    { store: new OrchestratorTaskStore({ backend: "memory" }) },
  );
}

function ctxWith(service: OrchestratorTaskService): RouteContext {
  return {
    runtime: {
      getService: () => service,
      hasService: () => true,
      getServiceLoadPromise: () => Promise.resolve(undefined),
    },
    acpService: null,
    workspaceService: null,
  } as never;
}

class CapturingResponse {
  statusCode = 0;
  body = "";
  writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }
  end(chunk?: string): this {
    if (chunk !== undefined) this.body = chunk;
    return this;
  }
  json(): Record<string, unknown> {
    return this.body ? (JSON.parse(this.body) as Record<string, unknown>) : {};
  }
}

describe("GET /api/orchestrator/accounts", () => {
  it("is registered as a runtime route template", () => {
    const registered = (codingAgentRoutePlugin.routes ?? []).some(
      (r) => r.type === "GET" && r.path === "/api/orchestrator/accounts",
    );
    expect(registered).toBe(true);
  });

  it("returns the account overview shape", async () => {
    const service = makeService();
    const req = Object.assign(Readable.from([]), {
      method: "GET",
      url: "/api/orchestrator/accounts",
    }) as unknown as IncomingMessage;
    const res = new CapturingResponse();
    const matched = await handleOrchestratorRoutes(
      req,
      res as unknown as ServerResponse,
      "/api/orchestrator/accounts",
      ctxWith(service),
    );
    expect(matched).toBe(true);
    expect(res.statusCode === 0 || res.statusCode === 200).toBe(true);
    const body = res.json();
    expect(typeof body.strategy).toBe("string");
    expect(Array.isArray(body.assignments)).toBe(true);
    expect(typeof body.availability).toBe("object");
  });
});
