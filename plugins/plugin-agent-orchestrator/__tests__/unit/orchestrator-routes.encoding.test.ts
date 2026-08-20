/**
 * Untrusted path-encoding contract for `/api/orchestrator/*` id segments.
 *
 * `handleOrchestratorRoutes` maps every throw to HTTP 500. Raw
 * `decodeURIComponent` on built-app, task, and session path segments therefore
 * reports client garbage (`%`, truncated UTF-8) as a server fault. These tests
 * drive the real dispatcher with service/registry mocks so a malformed escape
 * is 400 before `deleteBuiltApp`, `getTask`, or `stopTaskAgent`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteContext } from "../../src/api/route-utils.js";

const registry = vi.hoisted(() => ({
  deleteBuiltApp: vi.fn(),
  listBuiltApps: vi.fn(),
}));

const serviceFns = vi.hoisted(() => ({
  getTask: vi.fn(),
  stopTaskAgent: vi.fn(),
}));

vi.mock("../../src/services/built-apps-registry.js", () => ({
  deleteBuiltApp: registry.deleteBuiltApp,
  listBuiltApps: registry.listBuiltApps,
}));

vi.mock("../../src/services/orchestrator-task-service.js", () => ({
  OrchestratorTaskService: { serviceType: "ORCHESTRATOR_TASK_SERVICE" },
  RecoveryConflictError: class RecoveryConflictError extends Error {},
}));

vi.mock("../../src/services/goal-llm-verifier.js", () => ({
  LLM_GOAL_VERIFIER_NAME: "goal-verifier",
  verifyGoalCompletion: vi.fn(),
}));

vi.mock("../../src/services/orchestrator-widget-contract.js", () => ({
  buildOrchestratorWidgetSnapshot: vi.fn(),
}));

vi.mock("../../src/services/types.js", () => ({
  AdmissionQueueFullError: class AdmissionQueueFullError extends Error {},
}));

import { handleOrchestratorRoutes } from "../../src/api/orchestrator-routes.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";

const fakeService = {
  getTask: serviceFns.getTask,
  stopTaskAgent: serviceFns.stopTaskAgent,
};

function ctxWithService(service: typeof fakeService | null): RouteContext {
  return {
    runtime: {
      getService: () => service,
      hasService: () => service !== null,
      getServiceLoadPromise: () => Promise.resolve(undefined),
      reportError: vi.fn(),
    },
    acpService: null,
    workspaceService: null,
  } as never;
}

function makeReq(method: string, url: string): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, { method, url }) as unknown as IncomingMessage;
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

async function call(
  method: string,
  fullPath: string,
  service: typeof fakeService | null = fakeService,
): Promise<{
  matched: boolean;
  status: number;
  json: Record<string, unknown>;
}> {
  const pathname = fullPath.split("?")[0] ?? fullPath;
  const res = new CapturingResponse();
  const matched = await handleOrchestratorRoutes(
    makeReq(method, fullPath),
    res as unknown as ServerResponse,
    pathname,
    ctxWithService(service),
  );
  return { matched, status: res.statusCode, json: res.json() };
}

describe("orchestrator routes — path encoding", () => {
  beforeEach(() => {
    registry.deleteBuiltApp.mockReset();
    serviceFns.getTask.mockReset();
    serviceFns.stopTaskAgent.mockReset();
  });

  it("returns 400 for a malformed built-app slug before deleteBuiltApp", async () => {
    const result = await call(
      "DELETE",
      "/api/orchestrator/built-apps/custom/%",
      null,
    );
    expect(result.matched).toBe(true);
    expect(result.status).toBe(400);
    expect(result.json.error).toBe(
      "Invalid built-app path: malformed URL encoding",
    );
    expect(registry.deleteBuiltApp).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed built-app target", async () => {
    const result = await call(
      "DELETE",
      "/api/orchestrator/built-apps/%E0%A4%A/launchpad",
      null,
    );
    expect(result.matched).toBe(true);
    expect(result.status).toBe(400);
    expect(result.json.error).toBe(
      "Invalid built-app path: malformed URL encoding",
    );
    expect(registry.deleteBuiltApp).not.toHaveBeenCalled();
  });

  it("still deletes a percent-encoded built-app slug", async () => {
    registry.deleteBuiltApp.mockResolvedValue(true);
    const result = await call(
      "DELETE",
      "/api/orchestrator/built-apps/custom/launch%20pad",
      null,
    );
    expect(result.matched).toBe(true);
    expect(result.status).toBe(200);
    expect(result.json.deleted).toBe(true);
    expect(registry.deleteBuiltApp).toHaveBeenCalledWith(
      expect.anything(),
      "custom",
      "launch pad",
    );
  });

  it("returns 400 for a malformed task id before getTask", async () => {
    expect(OrchestratorTaskService.serviceType).toBe(
      "ORCHESTRATOR_TASK_SERVICE",
    );
    const result = await call("GET", "/api/orchestrator/tasks/%ZZ");
    expect(result.matched).toBe(true);
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("Invalid task id: malformed URL encoding");
    expect(serviceFns.getTask).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed session id before stopTaskAgent", async () => {
    const result = await call(
      "POST",
      "/api/orchestrator/tasks/task-1/agents/%/stop",
    );
    expect(result.matched).toBe(true);
    expect(result.status).toBe(400);
    expect(result.json.error).toBe(
      "Invalid session id: malformed URL encoding",
    );
    expect(serviceFns.stopTaskAgent).not.toHaveBeenCalled();
  });
});
