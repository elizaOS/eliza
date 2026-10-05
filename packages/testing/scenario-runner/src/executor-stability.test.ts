/**
 * Tests for `runScenario` (executor.ts), the core turn loop. Drives message /
 * action / api / tick turns against a stubbed runtime to assert turn dispatch,
 * assertion evaluation, and report shape without a real model.
 */
import type { Action, AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "./executor";

const { executeLifeOpsReminderTaskMock, processDueScheduledTasksMock } =
  vi.hoisted(() => ({
    executeLifeOpsReminderTaskMock: vi.fn(),
    processDueScheduledTasksMock: vi.fn(),
  }));

vi.mock("@elizaos/plugin-personal-assistant/plugin", () => ({
  executeLifeOpsReminderTask: executeLifeOpsReminderTaskMock,
  processDueScheduledTasks: processDueScheduledTasksMock,
}));

function createRuntime(
  actions: Action[],
  overrides: Partial<AgentRuntime> = {},
): AgentRuntime {
  return {
    actions,
    agentId: "00000000-0000-4000-8000-000000000001",
    plugins: [],
    ensureConnection: vi.fn(async () => undefined),
    getEntityById: vi.fn(async () => null),
    createEntity: vi.fn(async () => true),
    getRelationships: vi.fn(async () => []),
    createRelationship: vi.fn(async () => true),
    getTasksByName: async () => [],
    getService: vi.fn(() => null),
    reportError: vi.fn(),
    setSetting: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  } as unknown as AgentRuntime;
}

describe("scenario executor scheduled-task tick turns", () => {
  it("invokes only the focused production reminder processor", async () => {
    executeLifeOpsReminderTaskMock.mockResolvedValueOnce({
      now: "2099-01-02T09:00:00.000Z",
      attempts: [{ id: "attempt-1", status: "sent" }],
    });
    const runtime = createRuntime([]);

    const report = await runScenario(
      {
        id: "lifeops-reminder-tick",
        title: "Focused LifeOps reminder tick",
        domain: "executor",
        turns: [
          {
            kind: "tick",
            name: "deliver due reminders",
            worker: "lifeops_reminders",
            now: "2099-01-02T09:00:00.000Z",
            options: { reminderLimit: 7 },
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("passed");
    expect(executeLifeOpsReminderTaskMock).toHaveBeenCalledExactlyOnceWith(
      runtime,
      { now: "2099-01-02T09:00:00.000Z", limit: 7 },
    );
    expect(report.turns[0]?.responseText).toContain('"id":"attempt-1"');
  });

  it("invokes the focused production scheduled-task processor", async () => {
    processDueScheduledTasksMock.mockResolvedValueOnce({
      completions: [],
      fires: [{ taskId: "task-1", status: "fired", reason: "due" }],
      completionTimeouts: [],
      pendingPrompts: [],
      errors: [],
    });
    const runtime = createRuntime([]);

    const report = await runScenario(
      {
        id: "scheduled-task-tick",
        title: "Focused scheduled task tick",
        domain: "executor",
        turns: [
          {
            kind: "tick",
            name: "fire due scheduled task",
            worker: "scheduled_tasks",
            now: "2099-01-02T09:00:00.000Z",
            options: { scheduledTaskLimit: 7 },
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("passed");
    expect(processDueScheduledTasksMock).toHaveBeenCalledExactlyOnceWith({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2099-01-02T09:00:00.000Z"),
      limit: 7,
    });
    expect(report.turns[0]?.responseText).toContain('"taskId":"task-1"');
  });

  it("rejects an invalid scheduled-task limit before invoking the processor", async () => {
    processDueScheduledTasksMock.mockClear();
    const report = await runScenario(
      {
        id: "scheduled-task-invalid-limit",
        title: "Invalid focused scheduled task limit",
        domain: "executor",
        turns: [
          {
            kind: "tick",
            name: "reject invalid limit",
            worker: "scheduled_tasks",
            options: { scheduledTaskLimit: 0 },
          },
        ],
      },
      createRuntime([]),
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.error).toContain(
      "scheduledTaskLimit must be a positive integer",
    );
    expect(processDueScheduledTasksMock).not.toHaveBeenCalled();
  });
});
