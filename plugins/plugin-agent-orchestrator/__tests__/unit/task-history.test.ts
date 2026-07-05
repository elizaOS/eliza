/**
 * Verifies TASKS:history.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { taskHistoryAction } from "../../src/actions/tasks.js";
import type { TaskThreadDto } from "../../src/services/orchestrator-task-mapper.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import {
  callback,
  memory,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

function task(overrides: Partial<TaskThreadDto>): TaskThreadDto {
  const now = Date.now();
  return {
    id: "task-1",
    title: "Ship feature",
    kind: "coding",
    status: "active",
    priority: "normal",
    paused: false,
    originalRequest: "Ship feature",
    sessionCount: 1,
    activeSessionCount: 1,
    latestSessionId: "session-1",
    latestSessionLabel: "agent-one",
    latestWorkdir: "/repo",
    latestRepo: null,
    latestActivityAt: now,
    decisionCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      state: "unavailable",
      byProvider: [],
    },
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    closedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function runtimeWithServices(opts: {
  taskService?: unknown;
  acpService?: unknown;
}): IAgentRuntime {
  return {
    getService: vi.fn((serviceType: string) =>
      serviceType === OrchestratorTaskService.serviceType
        ? (opts.taskService ?? null)
        : (opts.acpService ?? null),
    ),
    hasService: vi.fn(() => Boolean(opts.taskService ?? opts.acpService)),
    getRoom: vi.fn(async () => null),
    reportError: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

describe("TASKS:history", () => {
  it("validates history when the durable task service is available without ACP", async () => {
    const taskService = { listTasks: vi.fn(async () => []) };
    const runtime = runtimeWithServices({ taskService });

    await expect(
      taskHistoryAction.validate(runtime, memory({ action: "history" })),
    ).resolves.toBe(true);
    await expect(
      taskHistoryAction.validate(runtime, memory({ action: "create" })),
    ).resolves.toBe(false);
  });

  it("honors planner-provided status and search filters against durable task threads", async () => {
    const tasks = [
      task({ id: "task-active", title: "Login flow", status: "active" }),
      task({ id: "task-done", title: "Billing cleanup", status: "done" }),
      task({ id: "task-blocked", title: "Billing gateway", status: "blocked" }),
      task({
        id: "task-blocked-auth",
        title: "Auth gateway",
        status: "blocked",
      }),
    ];
    const taskService = { listTasks: vi.fn(async () => tasks) };

    const result = await taskHistoryAction.handler(
      runtimeWithServices({ taskService }),
      memory({ text: "show blocked billing tasks" }),
      state,
      {
        parameters: {
          action: "history",
          metric: "list",
          statuses: ["blocked"],
          search: "billing",
        },
      },
      callback(),
    );

    expect(taskService.listTasks).toHaveBeenCalledWith({
      includeArchived: false,
      search: "billing",
    });
    expect(result?.success).toBe(true);
    expect(result?.text).toContain("Billing gateway [blocked]");
    expect(result?.text).not.toContain("Billing cleanup");
    expect(result?.text).not.toContain("Auth gateway");
    expect(result?.data?.taskIds).toEqual(["task-blocked"]);
    expect(result?.data?.filters).toMatchObject({
      statuses: ["blocked"],
      search: "billing",
      includeArchived: false,
    });
  });

  it("applies the active window before the requested result limit", async () => {
    const tasks = [
      task({ id: "task-active", title: "Active task", status: "active" }),
      task({ id: "task-open", title: "Open task", status: "open" }),
      task({ id: "task-done", title: "Done task", status: "done" }),
    ];
    const taskService = { listTasks: vi.fn(async () => tasks) };

    const result = await taskHistoryAction.handler(
      runtimeWithServices({ taskService }),
      memory({ text: "active task history" }),
      state,
      {
        parameters: {
          action: "history",
          metric: "list",
          window: "active",
          limit: 1,
        },
      },
      callback(),
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("I found 2 orchestrator tasks");
    expect(result?.text).toContain("Active task [active]");
    expect(result?.text).not.toContain("Open task");
    expect(result?.data?.count).toBe(2);
    expect(result?.data?.taskIds).toEqual(["task-active"]);
    expect(result?.data?.filters).toMatchObject({
      window: "active",
      limit: 1,
    });
  });

  it("falls back to ACP session history when the durable task service is absent", async () => {
    const acpService = serviceMock({
      listSessions: vi.fn(() => [
        {
          id: "session-a",
          name: "agent-a",
          agentType: "codex",
          workdir: "/repo/a",
          status: "ready",
          approvalPreset: "standard",
          createdAt: new Date("2026-05-03T10:00:00.000Z"),
          lastActivityAt: new Date("2026-05-03T10:00:00.000Z"),
          metadata: { label: "billing" },
        },
        {
          id: "session-b",
          name: "agent-b",
          agentType: "codex",
          workdir: "/repo/b",
          status: "errored",
          approvalPreset: "standard",
          createdAt: new Date("2026-05-03T10:00:00.000Z"),
          lastActivityAt: new Date("2026-05-03T10:00:00.000Z"),
          metadata: { label: "other" },
        },
        {
          id: "session-c",
          name: "agent-c",
          agentType: "codex",
          workdir: "/repo/c",
          status: "errored",
          approvalPreset: "standard",
          createdAt: new Date("2026-05-03T10:00:00.000Z"),
          lastActivityAt: new Date("2026-05-03T10:00:00.000Z"),
          metadata: { label: "billing" },
        },
      ]),
    });

    const result = await taskHistoryAction.handler(
      runtimeWithServices({ acpService }),
      memory({ text: "show active billing sessions" }),
      state,
      {
        parameters: {
          action: "history",
          metric: "list",
          window: "active",
          search: "billing",
        },
      },
      callback(),
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("billing");
    expect(result?.text).not.toContain("session-b");
    expect(result?.text).not.toContain("session-c");
    expect(result?.data?.sessionIds).toEqual(["session-a"]);
  });
});
