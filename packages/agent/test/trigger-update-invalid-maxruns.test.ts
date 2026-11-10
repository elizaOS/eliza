import { randomUUID } from "node:crypto";
import type { IAgentRuntime, Memory, Task, UUID } from "@elizaos/core";
import { TRIGGER_SCHEMA_VERSION } from "@elizaos/core";
import { expect, it } from "vitest";
import { triggerAction } from "../src/actions/trigger.ts";

const agentId = randomUUID() as UUID;
const roomId = randomUUID() as UUID;
const entityId = randomUUID() as UUID;

function makeRuntime() {
  const tasks = new Map<string, Task>();
  const taskId = randomUUID() as UUID;
  const triggerId = randomUUID() as UUID;
  tasks.set(taskId, {
    id: taskId,
    name: "TRIGGER",
    description: "Stretch reminder",
    tags: ["trigger", "repeat"],
    agentId,
    worldId: agentId,
    roomId,
    metadata: {
      trigger: {
        version: TRIGGER_SCHEMA_VERSION,
        triggerId,
        displayName: "Stretch reminder",
        instructions: "Remind me to stretch.",
        triggerType: "interval",
        enabled: true,
        wakeMode: "inject_now",
        createdBy: entityId,
        kind: "prompt",
        intervalMs: 3_600_000,
        runCount: 0,
      },
    },
  } as Task);
  const runtime = {
    agentId,
    getSetting: () => undefined,
    getTask: async (id: UUID) => tasks.get(id),
    getTasks: async () => [...tasks.values()],
    updateTask: async (id: UUID, update: Partial<Task>) => {
      const task = tasks.get(id);
      if (!task) throw new Error("task missing");
      const next = {
        ...task,
        ...update,
        metadata: {
          ...(task.metadata as object),
          ...(update.metadata as object),
        },
      } as Task;
      tasks.set(id, next);
      return next;
    },
    reportError: () => {},
  } as unknown as IAgentRuntime;
  return { runtime, tasks, taskId };
}

const message = {
  entityId,
  roomId,
  content: { text: "update the stretch reminder" },
} as Memory;

async function updateTrigger(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
) {
  return triggerAction.handler(runtime, message, undefined, {
    parameters: { action: "update", ...parameters },
  });
}

// An unparsable maxRuns must be refused, not dropped while the update
// reports success: the planner (and the user) would believe the run limit
// applies when it does not.
it.each([{ maxRuns: "abc" }, { maxRuns: 0 }, { maxRuns: -3 }])(
  "TRIGGER_UPDATE refuses an unusable maxRuns (%j) instead of dropping it",
  async (parameters) => {
    const { runtime, tasks, taskId } = makeRuntime();
    const result = await updateTrigger(runtime, {
      taskId,
      displayName: "Stretch reminder (renamed)",
      ...parameters,
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("INVALID_UPDATE");
    expect(result?.text).toContain("maxRuns");
    const task = tasks.get(taskId);
    const trigger = (task?.metadata as { trigger?: { maxRuns?: number } })
      ?.trigger;
    expect(trigger?.maxRuns).toBeUndefined();
    expect(task?.description).toBe("Stretch reminder");
  },
);

it("TRIGGER_UPDATE refuses an unknown wakeMode instead of dropping it", async () => {
  const { runtime, tasks, taskId } = makeRuntime();
  const result = await updateTrigger(runtime, {
    taskId,
    displayName: "Stretch reminder (renamed)",
    wakeMode: "bogus",
  });
  expect(result?.success).toBe(false);
  expect(result?.error).toBe("INVALID_UPDATE");
  expect(result?.text).toContain("wakeMode");
  expect(tasks.get(taskId)?.description).toBe("Stretch reminder");
});

it("TRIGGER_UPDATE still applies a usable maxRuns", async () => {
  const { runtime, tasks, taskId } = makeRuntime();
  const result = await updateTrigger(runtime, {
    taskId,
    displayName: "Stretch reminder (renamed)",
    maxRuns: 3,
  });
  expect(result?.success).toBe(true);
  const trigger = (
    tasks.get(taskId)?.metadata as { trigger?: { maxRuns?: number } }
  )?.trigger;
  expect(trigger?.maxRuns).toBe(3);
  expect(tasks.get(taskId)?.description).toBe("Stretch reminder (renamed)");
});
