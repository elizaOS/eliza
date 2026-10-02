/**
 * A scheduled trigger fire must persist its run on top of the live task, so a
 * pause written while the dispatch is in flight is kept instead of being
 * overwritten by the pre-dispatch snapshot.
 */
import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { executeTriggerTask, readTriggerConfig } from "./runtime.ts";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  normalizeTriggerDraft,
} from "./scheduling.ts";

function present<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined)
    throw new Error(`missing ${label}`);
  return value;
}

describe("scheduler fire vs concurrent pause", () => {
  it("keeps a trigger paused when the user disables it while a scheduled fire is in flight", async () => {
    const { draft } = normalizeTriggerDraft({
      input: {
        kind: "workflow",
        workflowId: "wf-1",
        triggerType: "interval",
        intervalMs: 3_600_000,
      },
      fallback: {
        displayName: "Hourly",
        instructions: "",
        triggerType: "interval",
        wakeMode: "inject_now",
        enabled: true,
        createdBy: "api",
      },
    });
    const trigger = buildTriggerConfig({
      draft: present(draft, "draft"),
      triggerId: "00000000-0000-0000-0000-000000000001" as UUID,
    });
    const taskId = "00000000-0000-0000-0000-0000000000aa" as UUID;
    const store = new Map<string, Task>();
    store.set(taskId, {
      id: taskId,
      name: "TRIGGER_DISPATCH",
      tags: ["queue", "repeat", "trigger"],
      metadata: buildTriggerMetadata({
        trigger,
        nowMs: Date.now(),
      }) as Task["metadata"],
    } as Task);
    const storedTask = () => present(store.get(taskId), "task");
    const storedTrigger = () =>
      present(readTriggerConfig(storedTask()), "trigger");

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const dispatchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    const runtime = {
      agentId: "00000000-0000-0000-0000-0000000000bb",
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      getSetting: () => undefined,
      reportError() {},
      getService: (name: string) =>
        name === "WORKFLOW_DISPATCH"
          ? {
              execute: async () => {
                started();
                await gate;
                return { ok: true, executionId: "e1" };
              },
            }
          : null,
      getTask: async (id: UUID) => structuredClone(store.get(id) ?? null),
      updateTask: async (id: UUID, patch: Partial<Task>) => {
        const current = store.get(id);
        if (!current) return;
        store.set(id, { ...current, ...patch });
      },
      deleteTask: async (id: UUID) => {
        store.delete(id);
      },
    } as unknown as IAgentRuntime;

    const fire = executeTriggerTask(runtime, structuredClone(storedTask()), {
      source: "scheduler",
    });
    await dispatchStarted;

    const live = storedTask();
    store.set(taskId, {
      ...live,
      metadata: {
        ...live.metadata,
        trigger: { ...storedTrigger(), enabled: false },
      } as Task["metadata"],
    });

    release();
    await fire;

    expect(storedTrigger().enabled).toBe(false);
  });
});
