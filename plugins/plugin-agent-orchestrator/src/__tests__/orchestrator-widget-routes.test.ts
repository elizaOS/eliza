/** Validates widget HTTP and SSE boundaries with an in-memory route harness. */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { handleOrchestratorRoutes } from "../api/orchestrator-routes.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { codingAgentRoutePlugin } from "../setup-routes.js";

function harness(pathname: string, method = "GET") {
  const req = Object.assign(new EventEmitter(), {
    method,
    url: pathname,
    headers: {},
  });
  const chunks: string[] = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    writeHead: vi.fn((status: number) => {
      res.statusCode = status;
      res.headersSent = true;
    }),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
    end: vi.fn((chunk?: string) => {
      if (chunk) chunks.push(chunk);
      res.writableEnded = true;
    }),
  };
  const service = {
    getStatus: vi.fn(async () => ({ running: true })),
    getCapacityOverview: vi.fn(async () => ({ active: 1 })),
    getAccountOverview: vi.fn(async () => ({ providers: [] })),
    getAccountReadiness: vi.fn(() => ({ ready: true })),
    getRoomRoster: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    pauseAll: vi.fn(async () => 2),
    resumeAll: vi.fn(async () => 2),
    getTask: vi.fn(async () => ({ task: { id: "task-1" } })),
    deleteTask: vi.fn(async () => true),
    pauseTask: vi.fn(async () => ({
      task: { id: "task-1", status: "paused" },
    })),
    resumeTask: vi.fn(async () => ({
      task: { id: "task-1", status: "active" },
    })),
    archiveTask: vi.fn(async () => ({
      task: { id: "task-1", status: "archived" },
    })),
    reopenTask: vi.fn(async () => ({ task: { id: "task-1", status: "open" } })),
    listMessages: vi.fn(async () => ({ items: [], nextCursor: null })),
    listTimeline: vi.fn(async () => ({ items: [], nextCursor: null })),
    listEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
    getUsage: vi.fn(async () => ({ totalTokens: 0 })),
    getTraceUsage: vi.fn(async () => ({ totalTokens: 0 })),
    createTask: vi.fn(async () => ({ task: { id: "created" } })),
    updateTask: vi.fn(async () => ({ task: { id: "task-1" } })),
    forkTask: vi.fn(async () => ({ task: { id: "forked" } })),
    postUserMessage: vi.fn(async () => ({ id: "message-1" })),
    spawnAgentForTask: vi.fn(async () => ({ task: { id: "task-1" } })),
    stopTaskAgent: vi.fn(async () => true),
    retryTaskTurn: vi.fn(async () => ({ task: { id: "task-1" } })),
    rerunFromEvent: vi.fn(async () => ({ task: { id: "task-1" } })),
    restartTask: vi.fn(async () => ({ task: { id: "task-1" } })),
    restartWithEditedPlan: vi.fn(async () => ({ task: { id: "task-1" } })),
  };
  const runtime = {
    getService: vi.fn((type: string) =>
      type === OrchestratorTaskService.serviceType ? service : undefined,
    ),
    hasService: vi.fn(() => false),
    reportError: vi.fn(),
  };
  return {
    req,
    res,
    chunks,
    service,
    runtime,
    ctx: { runtime, acpService: null, workspaceService: null },
  };
}

async function dispatchJson(
  h: ReturnType<typeof harness>,
  pathname: string,
  body: Record<string, unknown>,
) {
  const pending = handleOrchestratorRoutes(
    h.req as never,
    h.res as never,
    pathname,
    h.ctx as never,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  h.req.emit("data", Buffer.from(JSON.stringify(body)));
  h.req.emit("end");
  return pending;
}

describe("orchestrator widget routes", () => {
  it("is reachable through the runtime plugin route adapter", async () => {
    const h = harness("/api/orchestrator/widgets");
    const route = codingAgentRoutePlugin.routes?.find(
      (candidate) => candidate.path === "/api/orchestrator/widgets",
    );
    if (!route?.handler) throw new Error("widget plugin route missing");
    await route.handler(h.req as never, h.res as never, h.runtime as never);
    expect(JSON.parse(h.chunks.join(""))).toMatchObject({
      version: "orchestrator.widgets.v1",
    });
  });

  it.each([
    ["/api/orchestrator/status", "getStatus"],
    ["/api/orchestrator/capacity", "getCapacityOverview"],
    ["/api/orchestrator/accounts", "getAccountOverview"],
    ["/api/orchestrator/accounts/readiness?rotation=1", "getAccountReadiness"],
    ["/api/orchestrator/rooms", "getRoomRoster"],
    ["/api/orchestrator/tasks?limit=7", "listTasks"],
  ])("serves %s through its task-service operation", async (url, operation) => {
    const pathname = url.split("?")[0] ?? url;
    const h = harness(url);
    expect(
      await handleOrchestratorRoutes(
        h.req as never,
        h.res as never,
        pathname,
        h.ctx as never,
      ),
    ).toBe(true);
    expect(h.service[operation as keyof typeof h.service]).toHaveBeenCalled();
  });

  it.each([
    ["/api/orchestrator/pause-all", "pauseAll", "paused"],
    ["/api/orchestrator/resume-all", "resumeAll", "resumed"],
  ])("serves %s as an explicit mutation", async (url, operation, responseKey) => {
    const h = harness(url, "POST");
    await handleOrchestratorRoutes(
      h.req as never,
      h.res as never,
      url,
      h.ctx as never,
    );
    expect(h.service[operation as keyof typeof h.service]).toHaveBeenCalled();
    expect(JSON.parse(h.chunks.join(""))).toEqual({ [responseKey]: 2 });
  });

  it("returns task detail and a not-found boundary", async () => {
    const h = harness("/api/orchestrator/tasks/task-1");
    await handleOrchestratorRoutes(
      h.req as never,
      h.res as never,
      "/api/orchestrator/tasks/task-1",
      h.ctx as never,
    );
    expect(h.service.getTask).toHaveBeenCalledWith("task-1");
    expect(JSON.parse(h.chunks.join(""))).toMatchObject({
      task: { id: "task-1" },
    });

    const missing = harness("/api/orchestrator/tasks/missing");
    missing.service.getTask.mockResolvedValueOnce(null as never);
    await handleOrchestratorRoutes(
      missing.req as never,
      missing.res as never,
      "/api/orchestrator/tasks/missing",
      missing.ctx as never,
    );
    expect(missing.res.statusCode).toBe(404);
  });

  it.each([
    ["GET", "/api/orchestrator/tasks/task-1/messages?limit=3", "listMessages"],
    ["GET", "/api/orchestrator/tasks/task-1/timeline", "listTimeline"],
    ["GET", "/api/orchestrator/tasks/task-1/events", "listEvents"],
    ["GET", "/api/orchestrator/tasks/task-1/usage", "getUsage"],
    ["GET", "/api/orchestrator/tasks/task-1/trace-usage", "getTraceUsage"],
    ["POST", "/api/orchestrator/tasks/task-1/pause", "pauseTask"],
    ["POST", "/api/orchestrator/tasks/task-1/resume", "resumeTask"],
    ["POST", "/api/orchestrator/tasks/task-1/archive", "archiveTask"],
    ["POST", "/api/orchestrator/tasks/task-1/reopen", "reopenTask"],
    ["DELETE", "/api/orchestrator/tasks/task-1", "deleteTask"],
  ])("dispatches %s %s", async (method, url, operation) => {
    const pathname = url.split("?")[0] ?? url;
    const h = harness(url, method);
    expect(
      await handleOrchestratorRoutes(
        h.req as never,
        h.res as never,
        pathname,
        h.ctx as never,
      ),
    ).toBe(true);
    expect(h.service[operation as keyof typeof h.service]).toHaveBeenCalled();
    expect(h.res.statusCode).not.toBe(404);
  });

  it.each([
    [
      "/api/orchestrator/tasks",
      "createTask",
      { title: "Create route tests", priority: "high" },
    ],
    ["/api/orchestrator/tasks/task-1", "updateTask", { title: "Updated" }],
    ["/api/orchestrator/tasks/task-1/fork", "forkTask", { title: "Forked" }],
    [
      "/api/orchestrator/tasks/task-1/messages",
      "postUserMessage",
      { content: "Continue" },
    ],
    [
      "/api/orchestrator/tasks/task-1/agents",
      "spawnAgentForTask",
      { framework: "claude" },
    ],
  ])("validates and dispatches JSON for %s", async (url, operation, body) => {
    const h = harness(url, url.endsWith("task-1") ? "PATCH" : "POST");
    expect(await dispatchJson(h, url, body)).toBe(true);
    expect(h.service[operation as keyof typeof h.service]).toHaveBeenCalled();
    expect(h.res.statusCode).not.toBe(400);
  });

  it("stops a named task session", async () => {
    const url = "/api/orchestrator/tasks/task-1/agents/session-1/stop";
    const h = harness(url, "POST");
    await handleOrchestratorRoutes(
      h.req as never,
      h.res as never,
      url,
      h.ctx as never,
    );
    expect(h.service.stopTaskAgent).toHaveBeenCalledWith("task-1", "session-1");
    expect(JSON.parse(h.chunks.join(""))).toEqual({ stopped: true });
  });

  it.each([
    [
      "/api/orchestrator/tasks/task-1/retry-turn",
      "retryTaskTurn",
      { instruction: "Try with the failing test", mode: "new-session" },
    ],
    [
      "/api/orchestrator/tasks/task-1/rerun-from-event",
      "rerunFromEvent",
      { eventId: "event-1", preserveHistory: true },
    ],
    [
      "/api/orchestrator/tasks/task-1/restart",
      "restartTask",
      { instruction: "Restart cleanly" },
    ],
    [
      "/api/orchestrator/tasks/task-1/restart-with-edited-plan",
      "restartWithEditedPlan",
      { plan: { steps: [] }, editSummary: "Remove stale step" },
    ],
  ])("dispatches recovery operation %s", async (url, operation, body) => {
    const h = harness(url, "POST");
    expect(await dispatchJson(h, url, body)).toBe(true);
    expect(h.service[operation as keyof typeof h.service]).toHaveBeenCalled();
    expect(h.res.statusCode).not.toBe(400);
  });

  it("returns a compact JSON snapshot with bounded query options", async () => {
    const h = harness(
      "/api/orchestrator/widgets?limit=5&includeArchived=true&projectId=project-1",
    );
    expect(
      await handleOrchestratorRoutes(
        h.req as never,
        h.res as never,
        "/api/orchestrator/widgets",
        h.ctx as never,
      ),
    ).toBe(true);
    expect(h.service.listTasks).toHaveBeenCalledWith({
      includeArchived: true,
      projectId: "project-1",
    });
    expect(JSON.parse(h.chunks.join(""))).toMatchObject({
      version: "orchestrator.widgets.v1",
      totalTaskCount: 0,
      tasks: [],
    });
  });

  it("opens an SSE stream with an initial snapshot and closes on disconnect", async () => {
    const h = harness("/api/orchestrator/widgets/stream");
    expect(
      await handleOrchestratorRoutes(
        h.req as never,
        h.res as never,
        "/api/orchestrator/widgets/stream",
        h.ctx as never,
      ),
    ).toBe(true);
    expect(h.res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "text/event-stream" }),
    );
    expect(h.chunks.join("")).toContain("event: snapshot");
    h.req.emit("close");
    expect(h.res.end).toHaveBeenCalled();
  });

  it("terminates the SSE response when the initial snapshot fails", async () => {
    const h = harness("/api/orchestrator/widgets/stream");
    h.service.listTasks.mockRejectedValueOnce(new Error("store unavailable"));
    await handleOrchestratorRoutes(
      h.req as never,
      h.res as never,
      "/api/orchestrator/widgets/stream",
      h.ctx as never,
    );
    expect(h.chunks.join("")).toContain("event: error");
    expect(h.chunks.join("")).toContain("store unavailable");
    expect(h.res.end).toHaveBeenCalled();
  });
});
