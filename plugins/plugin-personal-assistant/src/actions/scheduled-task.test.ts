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
  "manual-task": null,
};

let storedTasks: ScheduledTask[];
let resolveNextFireAtCalls: string[];

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
      fakeTask("manual-task"),
    ];
    resolveNextFireAtCalls = [];
  });

  it("returns every task with no dueWindow and never consults resolveNextFireAt", async () => {
    const data = await listWith();
    expect(data.tasks.map((t) => t.promptInstructions).sort()).toEqual([
      "later-today-task",
      "manual-task",
      "overdue-task",
    ]);
    expect(data.dueWindow).toBeUndefined();
    // Unfiltered list must not pay the per-task next-fire projection cost.
    expect(resolveNextFireAtCalls).toEqual([]);
  });

  it("dueWindow=overdue keeps only tasks whose fire time is already past", async () => {
    const data = await listWith("overdue");
    expect(data.tasks.map((t) => t.promptInstructions)).toEqual([
      "overdue-task",
    ]);
    expect(data.dueWindow).toBe("overdue");
    // Every candidate is projected through the runner's own next-fire math.
    expect(resolveNextFireAtCalls.sort()).toEqual([
      "later-today-task",
      "manual-task",
      "overdue-task",
    ]);
  });

  it("dueWindow=today keeps past and later-today fires, excludes no-fire-time tasks", async () => {
    const data = await listWith("today");
    expect(data.tasks.map((t) => t.promptInstructions).sort()).toEqual([
      "later-today-task",
      "overdue-task",
    ]);
    expect(data.dueWindow).toBe("today");
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
    expect(data.tasks).toHaveLength(3);
    expect(data.dueWindow).toBeUndefined();
    expect(resolveNextFireAtCalls).toEqual([]);
  });

  it("exposes dueWindow on the semantic action's parameters", () => {
    const paramNames = (scheduledTaskAction.parameters ?? []).map(
      (p) => p.name,
    );
    expect(paramNames).toContain("dueWindow");
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
