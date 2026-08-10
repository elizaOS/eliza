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
  it("keeps history planner-visible on the umbrella action", () => {
    expect(
      taskHistoryAction.parameters?.find(
        (parameter) => parameter.name === "action",
      )?.schema.enum,
    ).toContain("history");
  });

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
    const historyCallback = callback();

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
      historyCallback,
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
    expect(historyCallback).not.toHaveBeenCalled();
  });

  it("resolves an older session through the durable session index", async () => {
    const targetedTask = task({
      id: "task-target",
      title: "Long-running migration",
      latestSessionId: "session-newest",
      latestSessionLabel: "newest-agent",
    });
    const unrelatedTask = task({
      id: "task-unrelated",
      title: "Unrelated work",
      latestSessionId: "session-unrelated",
    });
    const taskService = {
      getTaskForSession: vi.fn(async (sessionId: string) =>
        sessionId === "session-older" ? { id: targetedTask.id } : null,
      ),
      listTasks: vi.fn(async () => [unrelatedTask, targetedTask]),
    };
    const historyCallback = callback();

    const result = await taskHistoryAction.handler(
      runtimeWithServices({ taskService }),
      memory({ text: "show that older agent session" }),
      state,
      {
        parameters: {
          action: "history",
          metric: "detail",
          sessionId: "session-older",
        },
      },
      historyCallback,
    );

    expect(taskService.getTaskForSession).toHaveBeenCalledWith("session-older");
    expect(taskService.listTasks).toHaveBeenCalledWith({
      includeArchived: false,
    });
    expect(result?.success).toBe(true);
    expect(result?.text).toContain(
      'The orchestrator task for that session is "Long-running migration" [active].',
    );
    // The raw session uuid is planner/log detail — user-bound text never
    // carries it (it stays in data.filters below).
    expect(result?.text).not.toContain("session-older");
    expect(result?.text).toContain("Latest session: newest-agent");
    expect(result?.text).not.toContain("Unrelated work");
    expect(result?.data?.taskIds).toEqual(["task-target"]);
    expect(result?.data?.filters).toMatchObject({
      sessionId: "session-older",
      includeArchived: false,
    });
    expect(historyCallback).not.toHaveBeenCalled();
  });

  it("treats planner sentinel id filters as absent, never as a literal query or leaked text", async () => {
    // Live 2026-08-10: a rhetorical "any burning fires?" routed to TASKS with
    // projectId:"none" + sessionId:"none". Sentinels must not become real
    // filters (a project/session named "none" matches nothing) nor surface in
    // the reply as "project none" / "that session".
    const tasks = [task({ id: "task-active", status: "active" })];
    const taskService = {
      getTaskForSession: vi.fn(async () => null),
      listTasks: vi.fn(async () => tasks),
    };
    const historyCallback = callback();

    const result = await taskHistoryAction.handler(
      runtimeWithServices({ taskService }),
      memory({ text: "any burning fires or admin things needed?" }),
      state,
      {
        parameters: {
          action: "history",
          metric: "list",
          projectId: "none",
          sessionId: "none",
        },
      },
      historyCallback,
    );

    // No session-scoping was attempted, and listTasks got no project filter.
    expect(taskService.getTaskForSession).not.toHaveBeenCalled();
    expect(taskService.listTasks).toHaveBeenCalledWith({
      includeArchived: false,
    });
    expect(result?.success).toBe(true);
    expect(result?.text).not.toContain("project none");
    expect(result?.text).not.toContain("that session");
    expect(result?.data?.filters).not.toHaveProperty("projectId");
    expect(result?.data?.filters).not.toHaveProperty("sessionId");
  });

  it("returns an empty scoped result when the session index has no match", async () => {
    const taskService = {
      getTaskForSession: vi.fn(async () => null),
      listTasks: vi.fn(async () => [task({ id: "task-unrelated" })]),
    };
    const historyCallback = callback();

    const result = await taskHistoryAction.handler(
      runtimeWithServices({ taskService }),
      memory({ text: "show missing session" }),
      state,
      {
        parameters: {
          action: "history",
          sessionId: "session-missing",
        },
      },
      historyCallback,
    );

    expect(taskService.getTaskForSession).toHaveBeenCalledWith(
      "session-missing",
    );
    expect(taskService.listTasks).not.toHaveBeenCalled();
    expect(result?.success).toBe(true);
    expect(result?.text).toContain(
      "I did not find any orchestrator task threads matching that session.",
    );
    // The raw session uuid stays out of user-bound text; the structural
    // filter value remains available in the action data.
    expect(result?.text).not.toContain("session-missing");
    expect(result?.data?.filters).toMatchObject({
      sessionId: "session-missing",
    });
    expect(result?.data?.count).toBe(0);
    expect(result?.data?.taskIds).toEqual([]);
    expect(historyCallback).not.toHaveBeenCalled();
  });

  it("names the in-flight task instead of claiming nothing was found when filters exclude a running build", async () => {
    const tasks = [
      task({
        id: "task-building",
        title: "color-pop",
        status: "active",
        activeSessionCount: 1,
      }),
    ];
    const taskService = { listTasks: vi.fn(async () => tasks) };

    const result = await taskHistoryAction.handler(
      runtimeWithServices({ taskService }),
      memory({ text: "what did you just change?" }),
      state,
      {
        parameters: {
          action: "history",
          metric: "list",
          statuses: ["done"],
        },
      },
      callback(),
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain('still working on "color-pop"');
    expect(result?.text).not.toContain("did not find");
    expect(result?.data?.count).toBe(0);
    expect(result?.data?.inFlight).toEqual({ taskId: "task-building" });
  });

  it("falls back to a running ACP session for the in-flight answer on a session-index miss", async () => {
    const taskService = {
      getTaskForSession: vi.fn(async () => null),
      listTasks: vi.fn(async () => []),
    };
    const acpService = serviceMock({
      listSessions: vi.fn(() => [
        {
          id: "01234567-89ab-cdef-0123-456789abcdef",
          name: "agent-one",
          agentType: "codex",
          workdir: "/repo/a",
          status: "running",
          approvalPreset: "standard",
          createdAt: new Date("2026-08-07T10:00:00.000Z"),
          lastActivityAt: new Date("2026-08-07T10:00:00.000Z"),
          metadata: { label: "color-pop" },
        },
      ]),
    });

    const result = await taskHistoryAction.handler(
      runtimeWithServices({ taskService, acpService }),
      memory({ text: "what did you just change?" }),
      state,
      {
        parameters: {
          action: "history",
          sessionId: "session-missing",
        },
      },
      callback(),
    );

    expect(taskService.listTasks).not.toHaveBeenCalled();
    expect(result?.success).toBe(true);
    expect(result?.text).toContain('still working on "color-pop"');
    // Neither the queried session uuid nor the running session's uuid may
    // reach user-bound text; the running session id rides the action data.
    expect(result?.text).not.toContain("session-missing");
    expect(result?.text).not.toContain("01234567-89ab-cdef");
    expect(result?.data?.inFlight).toEqual({
      sessionId: "01234567-89ab-cdef-0123-456789abcdef",
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
    const historyCallback = callback();

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
      historyCallback,
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("billing");
    expect(result?.text).not.toContain("session-b");
    expect(result?.text).not.toContain("session-c");
    expect(result?.data?.sessionIds).toEqual(["session-a"]);
    expect(acpService.listSessions).toHaveBeenCalledTimes(1);
    expect(historyCallback).not.toHaveBeenCalled();
  });
});
