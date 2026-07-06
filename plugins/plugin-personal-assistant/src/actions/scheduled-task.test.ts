/**
 * Unit tests for the `SCHEDULED_TASKS` action's `list` due-window filter.
 *
 * Proves the semantic verb the planner discovers — `action=list dueWindow=…` —
 * routes through the `getScheduledTaskRunner` use case (the SAME runner the
 * Tasks/LifeOps surface reads), calling the runner's own `resolveNextFireAt`
 * projection to partition "overdue"/"today" instead of any synthetic-DOM
 * bridge. The runner primitive itself is covered end-to-end against a real
 * in-memory store in `@elizaos/plugin-scheduling`'s `runner.test.ts`; here we
 * assert the action wires `dueWindow` to that primitive and shapes the result.
 */

import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import type {
  ScheduledTask,
  ScheduledTaskFilter,
} from "@elizaos/plugin-scheduling";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW_MS = Date.parse("2026-05-09T12:00:00.000Z");
const OVERDUE_ISO = "2026-05-09T09:00:00.000Z";
const LATER_TODAY_ISO = "2026-05-09T18:00:00.000Z";

/** Fixed next-fire projection per task, keyed by promptInstructions. `null`
 * models a trigger with no wall-clock fire time (event/manual/after_task). */
const NEXT_FIRE_BY_PROMPT: Record<string, string | null> = {
  "overdue-task": OVERDUE_ISO,
  "later-today-task": LATER_TODAY_ISO,
  "missed-recurring-task": "2026-05-10T09:00:00.000Z",
  "server-tomorrow-owner-tomorrow-task": "2026-05-10T13:00:00.000Z",
  "manual-task": null,
};
const DUE_BY_PROMPT: Record<string, boolean> = {
  "overdue-task": true,
  "later-today-task": false,
  "missed-recurring-task": true,
  "server-tomorrow-owner-tomorrow-task": false,
  "manual-task": false,
};

let storedTasks: ScheduledTask[];
let scheduledInputs: Record<string, unknown>[];
let resolveNextFireAtCalls: string[];
let resolveDueDecisionCalls: string[];
let ownerTimezone: string;

function fakeTask(promptInstructions: string): ScheduledTask {
  return {
    taskId: `id-${promptInstructions}`,
    kind: "reminder",
    promptInstructions,
    trigger: { kind: "manual" },
    priority: "medium",
    respectsGlobalPause: true,
    state: { status: "scheduled", followupCount: 0 },
    source: "user_chat",
    createdBy: "tester",
    ownerVisible: true,
  } as ScheduledTask;
}

// The action resolves its runner through this accessor; return a fake that
// implements exactly the two methods handleList touches so the test isolates
// the action's wiring, not the runner internals.
vi.mock("../lifeops/scheduled-task/service.js", () => ({
  getScheduledTaskRunner: vi.fn(() => ({
    async list(_filter?: ScheduledTaskFilter) {
      return storedTasks;
    },
    async resolveNextFireAt(task: ScheduledTask) {
      resolveNextFireAtCalls.push(task.promptInstructions);
      return NEXT_FIRE_BY_PROMPT[task.promptInstructions] ?? null;
    },
    async resolveDueDecision(task: ScheduledTask) {
      resolveDueDecisionCalls.push(task.promptInstructions);
      return {
        due: DUE_BY_PROMPT[task.promptInstructions] ?? false,
        reason: DUE_BY_PROMPT[task.promptInstructions]
          ? "test_due"
          : "test_pending",
      };
    },
    async resolveOwnerFacts() {
      return { timezone: ownerTimezone };
    },
    async schedule(input: Record<string, unknown>) {
      scheduledInputs.push(input);
      return {
        ...fakeTask("created-task"),
        ...input,
        taskId: "created-task",
      } as ScheduledTask;
    },
  })),
}));

vi.mock("../lifeops/access.js", () => ({
  hasLifeOpsAccess: vi.fn(async () => true),
}));

vi.mock("../lifeops/pending-prompts/store.js", () => ({
  resolvePendingPromptsStore: vi.fn(() => ({
    forgetTask: vi.fn(async () => {}),
  })),
}));

import { scheduledTaskAction } from "./scheduled-task.js";

function makeRuntime(): IAgentRuntime {
  return { agentId: "test-agent" } as unknown as IAgentRuntime;
}

function makeMessage(): Memory {
  return {
    entityId: "owner-entity",
    roomId: "room-1",
    content: { text: "" },
  } as unknown as Memory;
}

interface ListResultData {
  tasks: ScheduledTask[];
  dueWindow?: "overdue" | "today";
}

async function listWith(
  dueWindow?: "overdue" | "today",
): Promise<ListResultData> {
  const callback: HandlerCallback = async () => [];
  const result = await scheduledTaskAction.handler(
    makeRuntime(),
    makeMessage(),
    undefined,
    { parameters: { action: "list", ...(dueWindow ? { dueWindow } : {}) } },
    callback,
  );
  return result.data as ListResultData;
}

describe("SCHEDULED_TASKS list — dueWindow filter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    storedTasks = [
      fakeTask("overdue-task"),
      fakeTask("later-today-task"),
      fakeTask("missed-recurring-task"),
      fakeTask("manual-task"),
    ];
    scheduledInputs = [];
    resolveNextFireAtCalls = [];
    resolveDueDecisionCalls = [];
    ownerTimezone = "UTC";
  });

  it("returns every task with no dueWindow and never consults resolveNextFireAt", async () => {
    const data = await listWith();
    expect(data.tasks.map((t) => t.promptInstructions).sort()).toEqual([
      "later-today-task",
      "manual-task",
      "missed-recurring-task",
      "overdue-task",
    ]);
    expect(data.dueWindow).toBeUndefined();
    // Unfiltered list must not pay the per-task next-fire projection cost.
    expect(resolveNextFireAtCalls).toEqual([]);
    expect(resolveDueDecisionCalls).toEqual([]);
  });

  it("dueWindow=overdue keeps already-due tasks, including missed recurring occurrences", async () => {
    const data = await listWith("overdue");
    expect(data.tasks.map((t) => t.promptInstructions).sort()).toEqual([
      "missed-recurring-task",
      "overdue-task",
    ]);
    expect(data.dueWindow).toBe("overdue");
    // Pending tasks do not pay the next-fire projection cost for overdue.
    expect(resolveNextFireAtCalls).toEqual([]);
    expect(resolveDueDecisionCalls.sort()).toEqual([
      "later-today-task",
      "manual-task",
      "missed-recurring-task",
      "overdue-task",
    ]);
  });

  it("dueWindow=today keeps past and later-today fires, excludes no-fire-time tasks", async () => {
    const data = await listWith("today");
    expect(data.tasks.map((t) => t.promptInstructions).sort()).toEqual([
      "later-today-task",
      "missed-recurring-task",
      "overdue-task",
    ]);
    expect(data.dueWindow).toBe("today");
  });

  it("dueWindow=today uses the owner timezone boundary, not the server date", async () => {
    vi.setSystemTime(Date.parse("2026-05-10T02:00:00.000Z"));
    ownerTimezone = "America/New_York";
    storedTasks = [fakeTask("server-tomorrow-owner-tomorrow-task")];

    const data = await listWith("today");

    expect(data.tasks).toEqual([]);
    expect(resolveNextFireAtCalls).toEqual([
      "server-tomorrow-owner-tomorrow-task",
    ]);
  });

  it("ignores an unknown dueWindow value (no filtering, no projection)", async () => {
    const callback: HandlerCallback = async () => [];
    const result = await scheduledTaskAction.handler(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { action: "list", dueWindow: "next-week" } },
      callback,
    );
    const data = result.data as ListResultData;
    expect(data.tasks).toHaveLength(4);
    expect(data.dueWindow).toBeUndefined();
    expect(resolveNextFireAtCalls).toEqual([]);
    expect(resolveDueDecisionCalls).toEqual([]);
  });

  it("exposes dueWindow on the semantic action's parameters", () => {
    const paramNames = (scheduledTaskAction.parameters ?? []).map(
      (p) => p.name,
    );
    expect(paramNames).toContain("dueWindow");
  });

  it("normalizes planner create aliases and empty structural objects before scheduling", async () => {
    const result = await scheduledTaskAction.handler(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          action: "create",
          kind: "reminder",
          promptInstructions: "Remind the user to send the Q3 budget report.",
          trigger: { fire_at: "2026-07-14T09:30:00Z" },
          contextRequest: {},
          shouldFire: {},
          completionCheck: { type: "user_acknowledged" },
          output: {},
          pipeline: {},
          escalation: {},
        },
      },
      undefined,
    );

    expect(result.success).toBe(true);
    expect(scheduledInputs).toHaveLength(1);
    const input = scheduledInputs[0];
    expect(input).toMatchObject({
      trigger: { kind: "once", atIso: "2026-07-14T09:30:00Z" },
      completionCheck: { kind: "user_acknowledged" },
      output: { destination: "channel", target: "in_app:room-1" },
    });
    expect(input).not.toHaveProperty("contextRequest");
    expect(input).not.toHaveProperty("shouldFire");
    expect(input).not.toHaveProperty("pipeline");
    expect(input).not.toHaveProperty("escalation");
  });

  it("maps common planner output aliases back to the channel destination", async () => {
    const result = await scheduledTaskAction.handler(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          action: "create",
          kind: "reminder",
          promptInstructions: "Remind the user to send the Q3 budget report.",
          trigger: { kind: "once", atIso: "2026-07-14T09:30:00Z" },
          output: { destination: "push" },
        },
      },
      undefined,
    );

    expect(result.success).toBe(true);
    expect(scheduledInputs.at(-1)).toMatchObject({
      output: { destination: "channel", target: "in_app:room-1" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
