/**
 * Unit tests for the #12177 WI-3 workbench schedule-tag → metadata.trigger
 * migration. Uses a minimal in-memory runtime that captures updateTask so we
 * can inspect the rewritten task by hand.
 */

import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { readTriggerConfig, TRIGGER_TASK_NAME } from "./runtime.ts";
import {
  decodeScheduleTag,
  migrateWorkbenchScheduleTags,
} from "./workbench-migration.ts";

const AGENT_ID = stringToUuid("workbench-migration-test-agent");

interface RuntimeHandle {
  runtime: IAgentRuntime;
  updates: Array<{ id: UUID; patch: Partial<Task> }>;
}

function makeRuntime(tasks: Task[]): RuntimeHandle {
  const updates: Array<{ id: UUID; patch: Partial<Task> }> = [];
  const store = new Map<UUID, Task>();
  for (const task of tasks) if (task.id) store.set(task.id, task);

  const runtime = {
    agentId: AGENT_ID,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getTasks: async (params: { tags?: string[] }) => {
      const wanted = params.tags ?? [];
      return [...store.values()].filter((t) =>
        wanted.every((tag) => (t.tags ?? []).includes(tag)),
      );
    },
    updateTask: vi.fn(async (id: UUID, patch: Partial<Task>) => {
      updates.push({ id, patch });
      const existing = store.get(id);
      if (existing) store.set(id, { ...existing, ...patch });
    }),
  } as unknown as IAgentRuntime;

  return { runtime, updates };
}

function makeWorkbenchTask(overrides: Partial<Task>): Task {
  return {
    id: stringToUuid(`wb-${Math.random()}`),
    name: "Morning digest",
    description: "Summarize my calendar",
    tags: ["workbench-task"],
    metadata: {},
    ...overrides,
  } as Task;
}

describe("decodeScheduleTag", () => {
  it("decodes a schedule:<cron> tag", () => {
    expect(
      decodeScheduleTag(["workbench-task", "schedule:0 9 * * 1-5"]),
    ).toEqual({
      triggerType: "cron",
      cronExpression: "0 9 * * 1-5",
    });
  });

  it("decodes an event:<name> tag", () => {
    expect(decodeScheduleTag(["event:calendar.updated"])).toEqual({
      triggerType: "event",
      eventKind: "calendar.updated",
    });
  });

  it("returns null when no schedule tag is present", () => {
    expect(decodeScheduleTag(["workbench-task", "todo"])).toBeNull();
    expect(decodeScheduleTag([])).toBeNull();
    expect(decodeScheduleTag(undefined)).toBeNull();
  });
});

describe("migrateWorkbenchScheduleTags", () => {
  it("rewrites a cron-tagged workbench task into a prompt-kind trigger", async () => {
    const task = makeWorkbenchTask({
      tags: ["workbench-task", "schedule:0 9 * * *"],
    });
    const { runtime, updates } = makeRuntime([task]);

    const migrated = await migrateWorkbenchScheduleTags(runtime);
    expect(migrated).toBe(1);
    expect(updates).toHaveLength(1);

    const patch = updates[0].patch;
    expect(patch.name).toBe(TRIGGER_TASK_NAME);
    // Retagged to the trigger tags; the schedule tag and workbench-task tag are gone.
    expect(patch.tags).toEqual(
      expect.arrayContaining(["queue", "repeat", "trigger"]),
    );
    expect(patch.tags).not.toContain("workbench-task");
    expect(patch.tags?.some((t) => t.startsWith("schedule:"))).toBe(false);

    // The rewritten metadata carries a strict prompt-kind cron TriggerConfig.
    const trigger = readTriggerConfig({ ...task, ...patch } as Task);
    expect(trigger?.kind).toBe("prompt");
    expect(trigger?.triggerType).toBe("cron");
    expect(trigger?.cronExpression).toBe("0 9 * * *");
    expect(trigger?.instructions).toBe("Summarize my calendar");
    expect(trigger?.enabled).toBe(true);
    // A prompt trigger has no workflow target.
    expect((trigger as { workflowId?: string }).workflowId).toBeUndefined();
  });

  it("skips a task that is already a trigger (idempotent)", async () => {
    const already = makeWorkbenchTask({
      tags: ["queue", "repeat", "trigger", "schedule:0 9 * * *"],
      metadata: {
        trigger: {
          version: 1,
          triggerId: stringToUuid("existing"),
          displayName: "Existing",
          instructions: "x",
          triggerType: "cron",
          enabled: true,
          wakeMode: "inject_now",
          createdBy: "test",
          cronExpression: "0 9 * * *",
          runCount: 0,
          kind: "prompt",
        },
      } as Task["metadata"],
    });
    const { runtime, updates } = makeRuntime([already]);

    const migrated = await migrateWorkbenchScheduleTags(runtime);
    expect(migrated).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("leaves a workbench task with no schedule tag untouched", async () => {
    const task = makeWorkbenchTask({ tags: ["workbench-task"] });
    const { runtime, updates } = makeRuntime([task]);

    const migrated = await migrateWorkbenchScheduleTags(runtime);
    expect(migrated).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
