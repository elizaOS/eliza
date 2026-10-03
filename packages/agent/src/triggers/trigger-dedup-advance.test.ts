/**
 * Workflow dispatch deduplicates scheduled fires by a per-occurrence
 * idempotency key. A scheduled fire that is deduplicated must still advance
 * the trigger to its next occurrence and refresh that key; otherwise every
 * later fire reuses the stale key and the trigger never runs again.
 */
import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTriggerTask, readTriggerConfig } from "./runtime.ts";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  normalizeTriggerDraft,
} from "./scheduling.ts";

function present<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`missing ${label}`);
  }
  return value;
}

function mondaysTask(nowMs: number): Task {
  const { draft } = normalizeTriggerDraft({
    input: {
      kind: "workflow",
      workflowId: "wf-report",
      triggerType: "cron",
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
    },
    fallback: {
      displayName: "Mondays",
      instructions: "",
      triggerType: "cron",
      wakeMode: "inject_now",
      enabled: true,
      createdBy: "api",
    },
  });
  const trigger = buildTriggerConfig({
    draft: present(draft, "draft"),
    triggerId: "00000000-0000-0000-0000-0000000000b1" as UUID,
  });
  const metadata = present(
    buildTriggerMetadata({ trigger, nowMs }),
    "metadata",
  );
  const nextRunAtMs = present(metadata.trigger?.nextRunAtMs, "nextRunAtMs");
  metadata.idempotencyKey = `wf-report:${Math.floor(nextRunAtMs / 60_000)}`;
  return {
    id: "00000000-0000-0000-0000-00000000000b" as UUID,
    name: "TRIGGER_DISPATCH",
    tags: ["queue", "repeat", "trigger"],
    metadata,
  } as Task;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduled workflow trigger dedup", () => {
  it("advances a deduplicated scheduled fire so the next occurrence runs", async () => {
    const seenKeys = new Set<string>();
    const executions: string[] = [];
    const dispatch = {
      execute: async (
        _workflowId: string,
        _payload: unknown,
        options: { idempotencyKey?: string },
      ) => {
        const key = options.idempotencyKey;
        if (key && seenKeys.has(key)) {
          return { ok: true, dedup: true, executionId: "existing" };
        }
        if (key) seenKeys.add(key);
        executions.push(new Date().toISOString());
        return { ok: true, executionId: `exec-${executions.length}` };
      },
    };
    const store = new Map<string, Task>();
    const runtime = {
      agentId: "00000000-0000-0000-0000-0000000000bb",
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      getSetting: () => undefined,
      reportError() {},
      getService: (name: string) =>
        name === "WORKFLOW_DISPATCH" ? dispatch : null,
      getTask: async (id: UUID) => structuredClone(store.get(id) ?? null),
      updateTask: async (id: UUID, patch: Partial<Task>) => {
        const current = store.get(id);
        if (current) store.set(id, { ...current, ...patch });
      },
      deleteTask: async (id: UUID) => {
        store.delete(id);
      },
    } as unknown as IAgentRuntime;

    const task = mondaysTask(Date.parse("2026-05-25T09:00:30Z"));
    const taskId = present(task.id, "task id");
    store.set(taskId, task);
    seenKeys.add(present(task.metadata?.idempotencyKey, "key") as string);

    vi.useFakeTimers({ now: new Date("2026-06-01T09:00:01Z") });
    const deduped = await executeTriggerTask(
      runtime,
      structuredClone(present(store.get(taskId), "task")),
      { source: "scheduler" },
    );
    expect(deduped.status).toBe("skipped");
    expect(typeof deduped.updateInterval).toBe("number");
    expect(
      readTriggerConfig(present(store.get(taskId), "task"))?.nextRunAtMs,
    ).toBe(Date.parse("2026-06-08T09:00:00Z"));

    vi.setSystemTime(new Date("2026-06-08T09:00:01Z"));
    const next = await executeTriggerTask(
      runtime,
      structuredClone(present(store.get(taskId), "task")),
      { source: "scheduler" },
    );

    expect(next.status).toBe("success");
    expect(executions).toEqual(["2026-06-08T09:00:01.000Z"]);

    const advancedTask = present(store.get(taskId), "task");
    const staleSnapshot = structuredClone(advancedTask);
    staleSnapshot.metadata = {
      ...staleSnapshot.metadata,
      idempotencyKey: `wf-report:${Math.floor(Date.parse("2026-06-08T09:00:00Z") / 60_000)}`,
    };
    vi.setSystemTime(new Date("2026-06-08T09:05:00Z"));
    const stale = await executeTriggerTask(runtime, staleSnapshot, {
      source: "scheduler",
    });
    expect(stale.status).toBe("skipped");
    expect(store.get(taskId)?.metadata).toEqual(advancedTask.metadata);
  });
});
