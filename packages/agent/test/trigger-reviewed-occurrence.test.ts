/**
 * A workflow schedule armed for one reviewed version passes that version and the
 * exact occurrence it fires for. Typed phone workflows use `reviewedVersionId`;
 * hosted digests keep their stored `hostedVersionId`. A late fire after the host
 * was off still carries the original occurrence, so the workflow can record it as
 * missed instead of running it late; the next occurrence is computed from now.
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

async function armed(metadata: Record<string, unknown>) {
  const tasks = new Map<string, Task>();
  const payloads: unknown[] = [];
  const dispatch = {
    async execute(_workflowId: string, payload: unknown) {
      payloads.push(structuredClone(payload));
      return { ok: true, executionId: `exec-${payloads.length}` };
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
      workflowId: "wf-typed",
      triggerType: "cron",
      cronExpression: "30 7 * * 1,2,3,4,5",
      timezone: "America/New_York",
    },
    fallback: {
      displayName: "Morning workflow schedule",
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
    metadata: {
      ...buildTriggerMetadata({ trigger, nowMs: Date.now() }),
      ...metadata,
    },
  } as unknown as Task);
  const fire = async (iso: string) => {
    vi.setSystemTime(new Date(iso));
    const task = await runtime.getTask(taskId);
    if (!task) throw new Error("trigger task is missing");
    return executeTriggerTask(runtime, task, { source: "scheduler" });
  };
  const next = async () =>
    (
      (await runtime.getTask(taskId))?.metadata as {
        trigger?: { nextRunAtMs?: number };
      }
    )?.trigger?.nextRunAtMs;
  return { fire, payloads, next };
}

it("passes the reviewed version and each exact occurrence to the workflow", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Monday 2026-10-26 07:00 in New York (EDT, UTC-4).
  vi.setSystemTime(new Date("2026-10-26T11:00:00.000Z"));
  const { fire, payloads, next } = await armed({
    reviewedVersionId: "version-7",
  });
  expect(await next()).toBe(Date.parse("2026-10-26T11:30:00.000Z"));
  expect((await fire("2026-10-26T11:30:04.000Z")).status).toBe("success");
  expect(payloads).toEqual([
    {
      scheduledAtMs: Date.parse("2026-10-26T11:30:00.000Z"),
      workflowVersionId: "version-7",
    },
  ]);
  expect(await next()).toBe(Date.parse("2026-10-27T11:30:00.000Z"));
});

it("a late fire after the host was off still names the passed occurrence, then advances from now", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T10:00:00.000Z"));
  const { fire, payloads, next } = await armed({
    reviewedVersionId: "version-8",
  });
  const missed = Date.parse("2026-10-30T11:30:00.000Z");
  expect(await next()).toBe(missed);
  // The phone was off through Friday's occurrence and the whole weekend.
  expect((await fire("2026-11-02T13:05:00.000Z")).status).toBe("success");
  expect(payloads).toEqual([
    { scheduledAtMs: missed, workflowVersionId: "version-8" },
  ]);
  // Monday 2026-11-02 07:30 in New York is EST (UTC-5) and has already passed.
  expect(await next()).toBe(Date.parse("2026-11-03T12:30:00.000Z"));
});

it("keeps the stored hosted digest key and sends nothing extra for other schedules", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T11:00:00.000Z"));
  const hosted = await armed({ hostedVersionId: "digest-version" });
  await hosted.fire("2026-10-26T11:30:01.000Z");
  expect(hosted.payloads).toEqual([
    {
      scheduledAtMs: Date.parse("2026-10-26T11:30:00.000Z"),
      workflowVersionId: "digest-version",
    },
  ]);
  const plain = await armed({});
  await plain.fire("2026-10-26T11:30:01.000Z");
  expect(plain.payloads).toEqual([{}]);
});
