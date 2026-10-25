/**
 * "Run now" on a scheduled workflow trigger is its own run and keeps the
 * scheduled run. The real
 * executeTriggerTask runs against a dispatch fake that follows the
 * WORKFLOW_DISPATCH contract: a repeated (workflowId, idempotencyKey) is a
 * duplicate and does not start a new execution.
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

async function setUpTrigger(
  input: Record<string, unknown>,
  displayName: string,
) {
  const tasks = new Map<string, Task>();
  const executions: string[] = [];
  const seen = new Set<string>();
  const dispatch = {
    async execute(
      workflowId: string,
      _payload: unknown,
      options: { idempotencyKey?: string } = {},
    ) {
      if (options.idempotencyKey) {
        const key = `${workflowId}::${options.idempotencyKey}`;
        if (seen.has(key))
          return { ok: true, executionId: "prior", dedup: true };
        seen.add(key);
      }
      executions.push(new Date(Date.now()).toISOString());
      return { ok: true, executionId: `exec-${executions.length}` };
    },
  };
  const noop = () => undefined;
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000b1" as UUID,
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
    input: { kind: "workflow", workflowId: "wf-1", ...input },
    fallback: {
      displayName,
      instructions: "",
      triggerType: input.triggerType as "cron" | "once",
      wakeMode: "inject_now",
      enabled: true,
      createdBy: "owner",
    },
  });
  if (!draft) throw new Error("trigger draft was not created");
  const trigger = buildTriggerConfig({
    draft,
    triggerId: "00000000-0000-0000-0000-00000000c001" as UUID,
  });
  const taskId = "00000000-0000-0000-0000-0000000000d1" as UUID;
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
  return { run, executions, stored: () => tasks.has(taskId) };
}

it("keeps the next scheduled run when the user runs the trigger manually", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T08:00:00.000Z"));
  const { run, executions } = await setUpTrigger(
    { triggerType: "cron", cronExpression: "0 9 * * *", timezone: "UTC" },
    "Daily report",
  );
  expect((await run("2026-10-12T09:00:05.000Z", "scheduler")).status).toBe(
    "success",
  );
  expect((await run("2026-10-12T14:00:00.000Z", "manual")).status).toBe(
    "success",
  );
  expect((await run("2026-10-12T15:00:00.000Z", "manual")).status).toBe(
    "success",
  );
  expect((await run("2026-10-13T09:00:05.000Z", "scheduler")).status).toBe(
    "success",
  );
  expect(executions).toEqual([
    "2026-10-12T09:00:05.000Z",
    "2026-10-12T14:00:00.000Z",
    "2026-10-12T15:00:00.000Z",
    "2026-10-13T09:00:05.000Z",
  ]);
});

it("keeps a one-time trigger's scheduled run after the user runs it manually", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T07:00:00.000Z"));
  const { run, executions, stored } = await setUpTrigger(
    { triggerType: "once", scheduledAtIso: "2026-10-16T09:00:00.000Z" },
    "Friday report",
  );
  expect((await run("2026-10-14T08:00:00.000Z", "manual")).status).toBe(
    "success",
  );
  expect(stored()).toBe(true);
  expect((await run("2026-10-16T09:00:05.000Z", "scheduler")).status).toBe(
    "success",
  );
  expect(stored()).toBe(false);
  expect(executions).toEqual([
    "2026-10-14T08:00:00.000Z",
    "2026-10-16T09:00:05.000Z",
  ]);
});
