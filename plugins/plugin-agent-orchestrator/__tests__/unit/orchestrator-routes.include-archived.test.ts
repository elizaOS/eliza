/** Exercises archived-task filter validation through the orchestrator route harness. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core/client-public", () => ({
  resolveAliasedEnvValue: (key: string) => process.env[key],
  isTruthyEnvValue: () => false,
  isElizaSettingsDebugEnabled: () => false,
  sanitizeForSettingsDebug: (value: unknown) => value,
  settingsDebugCloudSummary: () => ({}),
  sanitizeSpeechText: (value: string) => value,
  formatError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("../../src/services/orchestrator-task-service.js", () => ({
  OrchestratorTaskService: class OrchestratorTaskService {},
  RecoveryConflictError: class RecoveryConflictError extends Error {},
}));

vi.mock("../../src/services/goal-llm-verifier.js", () => ({
  LLM_GOAL_VERIFIER_NAME: "goal-llm-verifier",
  verifyGoalCompletion: async () => ({ ok: true }),
}));

vi.mock("../../src/services/built-apps-registry.js", () => ({
  deleteBuiltApp: async () => undefined,
  listBuiltApps: async () => [],
}));

vi.mock("../../src/services/orchestrator-widget-contract.js", () => ({
  buildOrchestratorWidgetSnapshot: (tasks: unknown[]) => ({ tasks }),
}));

import { handleOrchestratorRoutes } from "../../src/api/orchestrator-routes.js";
import type { RouteContext } from "../../src/api/route-utils.js";
import type { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";

const listTasks = vi.fn(async () => [{ id: "task-1" }]);

function ctxWith(service: OrchestratorTaskService | null): RouteContext {
  return {
    runtime: {
      getService: () => service,
      hasService: () => service !== null,
      getServiceLoadPromise: () => Promise.resolve(undefined),
      getCache: async () => undefined,
      setCache: async () => undefined,
    },
    acpService: null,
    workspaceService: null,
  } as never;
}

function makeReq(url: string): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, {
    method: "GET",
    url,
  }) as unknown as IncomingMessage;
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

async function list(query = "") {
  const req = makeReq(`/api/orchestrator/tasks${query}`);
  const res = new CapturingResponse();
  const service = { listTasks } as unknown as OrchestratorTaskService;
  const matched = await handleOrchestratorRoutes(
    req,
    res as unknown as ServerResponse,
    "/api/orchestrator/tasks",
    ctxWith(service),
  );
  expect(matched).toBe(true);
  return { status: res.statusCode, body: res.json() };
}

describe("GET /api/orchestrator/tasks includeArchived identity", () => {
  beforeEach(() => {
    listTasks.mockClear();
  });

  it.each(["", "?includeArchived=", "?includeArchived=false"])(
    "accepts %s as the live task list",
    async (query) => {
      const result = await list(query);
      expect(result.status).toBe(200);
      expect(listTasks).toHaveBeenCalledTimes(1);
      expect(listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ includeArchived: false }),
      );
    },
  );

  it("accepts includeArchived=true as the full archive-inclusive list", async () => {
    const result = await list("?includeArchived=true");
    expect(result.status).toBe(200);
    expect(listTasks).toHaveBeenCalledWith(
      expect.objectContaining({ includeArchived: true }),
    );
  });

  it.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo", "1e2"])(
    "rejects includeArchived=%s before listTasks",
    async (token) => {
      const result = await list(
        `?includeArchived=${encodeURIComponent(token)}`,
      );
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: "Invalid includeArchived" });
      expect(listTasks).not.toHaveBeenCalled();
    },
  );

  it.each([
    "?includeArchived=true&includeArchived=true",
    "?includeArchived=true&includeArchived=false",
    "?includeArchived=&includeArchived=true",
    "?includeArchived=foo&includeArchived=true",
  ])(
    "rejects duplicate includeArchived values in %s before listTasks",
    async (query) => {
      const result = await list(query);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: "Invalid includeArchived" });
      expect(listTasks).not.toHaveBeenCalled();
    },
  );
});
