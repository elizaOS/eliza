/**
 * A scheduler fire tells the workflow dispatcher which scheduled occurrence it
 * belongs to, so a host that runs only while powered on can record a late
 * occurrence once instead of replaying it. Manual runs carry no occurrence.
 */
import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { executeTriggerTask } from "../src/triggers/runtime.ts";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  normalizeTriggerDraft,
} from "../src/triggers/scheduling.ts";

afterEach(() => vi.useRealTimers());

it("passes the scheduled instant for scheduler fires and none for manual runs", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T08:00:00.000Z"));
  const tasks = new Map<string, Task>();
  const calls: Array<{ scheduledAtMs?: number; idempotencyKey?: string }> = [];
  const dispatch = {
    async execute(
      _workflowId: string,
      _payload: unknown,
      options: { scheduledAtMs?: number; idempotencyKey?: string } = {},
    ) {
      calls.push({ ...options });
      return { ok: true, executionId: `exec-${calls.length}` };
    },
  };
  const noop = () => undefined;
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000b2" as UUID,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    reportError: noop,
    getService: (name: string) =>
      name === "WORKFLOW_DISPATCH" ? dispatch : null,
    getTask: async (id: string) => structuredClone(tasks.get(id) ?? null),
    updateTask: async (id: string, patch: Partial<Task>) => {
      const current = tasks.get(id);
      if (current) tasks.set(id, { ...current, ...patch });
    },
    deleteTask: async (id: string) => void tasks.delete(id),
    getSetting: () => undefined,
  } as unknown as IAgentRuntime;
  const { draft } = normalizeTriggerDraft({
    input: {
      kind: "workflow",
      workflowId: "wf-occurrence",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
    },
    fallback: {
      displayName: "Morning",
      instructions: "",
      triggerType: "cron",
      wakeMode: "inject_now",
      enabled: true,
      createdBy: "owner",
    },
  });
  if (!draft) throw new Error("trigger draft was not created");
  const trigger = buildTriggerConfig({
    draft,
    triggerId: "00000000-0000-0000-0000-00000000c002" as UUID,
  });
  const taskId = "00000000-0000-0000-0000-0000000000d2" as UUID;
  tasks.set(taskId, {
    id: taskId,
    name: "TRIGGER_DISPATCH",
    tags: ["queue", "repeat", "trigger"],
    metadata: buildTriggerMetadata({ trigger, nowMs: Date.now() }),
  } as unknown as Task);
  const run = async (iso: string, source: "scheduler" | "manual") => {
    vi.setSystemTime(new Date(iso));
    const task = await runtime.getTask(taskId);
    if (!task) throw new Error("trigger task is missing");
    return executeTriggerTask(
      runtime,
      task,
      source === "manual" ? { source, force: true } : { source },
    );
  };

  // The phone was off at 09:00 and the runtime reached the fire hours later.
  await run("2026-10-12T13:30:00.000Z", "scheduler");
  await run("2026-10-12T14:00:00.000Z", "manual");
  await run("2026-10-13T09:00:01.000Z", "scheduler");
  expect(calls).toHaveLength(3);
  expect(calls[0].scheduledAtMs).toBe(Date.parse("2026-10-12T09:00:00.000Z"));
  expect(calls[1]).not.toHaveProperty("scheduledAtMs");
  expect(calls[1].idempotencyKey).toBeUndefined();
  expect(calls[2].scheduledAtMs).toBe(Date.parse("2026-10-13T09:00:00.000Z"));
});
