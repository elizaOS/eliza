/**
 * Guards GET /api/orchestrator/capacity on two fronts:
 *  1. The path template is REGISTERED in the runtime route matcher, so the
 *     handler is reachable over real HTTP (an unregistered handler 404s).
 *  2. The handler returns the AcpService.getCapacity() shape, and honestly 503s
 *     when the ACP service is absent instead of fabricating a healthy count.
 * Deterministic harness: a hand-built RouteContext, no live subprocess.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleOrchestratorRoutes } from "../../src/api/orchestrator-routes.js";
import type { RouteContext } from "../../src/api/route-utils.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import { codingAgentRoutePlugin } from "../../src/setup-routes.ts";
import type { AcpCapacity } from "../../src/services/types.js";

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

function ctxWith(
  service: OrchestratorTaskService,
  capacity: AcpCapacity | null,
): RouteContext {
  return {
    runtime: {
      getService: () => service,
      hasService: () => true,
      getServiceLoadPromise: () => Promise.resolve(undefined),
    },
    acpService: capacity
      ? { getCapacity: () => Promise.resolve(capacity) }
      : null,
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

async function get(ctx: RouteContext): Promise<CapturingResponse> {
  const req = Object.assign(Readable.from([]), {
    method: "GET",
    url: "/api/orchestrator/capacity",
  }) as unknown as IncomingMessage;
  const res = new CapturingResponse();
  const matched = await handleOrchestratorRoutes(
    req,
    res as unknown as ServerResponse,
    "/api/orchestrator/capacity",
    ctx,
  );
  expect(matched).toBe(true);
  return res;
}

describe("GET /api/orchestrator/capacity", () => {
  it("is registered as a runtime route template", () => {
    const registered = (codingAgentRoutePlugin.routes ?? []).some(
      (r) => r.type === "GET" && r.path === "/api/orchestrator/capacity",
    );
    expect(registered).toBe(true);
  });

  it("returns the AcpService capacity shape", async () => {
    const capacity: AcpCapacity = {
      maxSessions: 8,
      systemHeadroom: 2,
      activeWorkers: 8,
      activeSystem: 1,
      freeWorkerSlots: 0,
      freeSystemSlots: 1,
    };
    const res = await get(ctxWith(makeService(), capacity));
    expect(res.statusCode === 0 || res.statusCode === 200).toBe(true);
    expect(res.json()).toEqual(capacity);
  });

  it("503s when the ACP service is unavailable (never fabricates a count)", async () => {
    const res = await get(ctxWith(makeService(), null));
    expect(res.statusCode).toBe(503);
  });
});
