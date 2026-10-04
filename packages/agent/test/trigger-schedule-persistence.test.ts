import { randomUUID } from "node:crypto";
import type http from "node:http";
import {
  type JsonObject,
  type Memory,
  resolveOwnerEntityIdOrDefault,
  type Task,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  handleTriggerRoutes,
  type TriggerRouteContext,
} from "../../../plugins/plugin-workflow/src/trigger-routes.ts";
import { triggerAction } from "../src/actions/trigger.ts";
import {
  readTriggerConfig,
  readTriggerRuns,
  taskToTriggerSummary,
  triggersFeatureEnabled,
} from "../src/triggers/runtime.ts";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  DISABLED_TRIGGER_INTERVAL_MS,
  normalizeTriggerDraft,
} from "../src/triggers/scheduling.ts";

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  fixture = await createTestRuntime({
    characterName: "TriggerScheduleBoundary",
  });
});
afterAll(async () => {
  await fixture?.cleanup();
});
it("does not persist an invented interval when captured reminder arguments omit timing", async () => {
  const before = await fixture.runtime.getTasks({
    tags: ["trigger"],
  });
  const result = await triggerAction.handler(
    fixture.runtime,
    {
      entityId: fixture.runtime.agentId,
      agentId: fixture.runtime.agentId,
      roomId: randomUUID() as UUID,
      content: {
        text: "Remind me in 2 minutes to check the in-app notification.",
      },
    } as Memory,
    undefined,
    {
      parameters: {
        action: "create",
        displayName: "Check in-app notification",
        instructions: "Remind the user to check the in-app notification.",
      },
    },
  );
  expect(result).toMatchObject({ success: false });
  expect(await fixture.runtime.getTasks({ tags: ["trigger"] })).toEqual(before);
});
it.each([
  {
    triggerType: "interval",
    expectedType: "interval",
    expectedInterval: 43_200_000,
  },
  { delayMinutes: 2, expectedType: "once" },
  { intervalMs: 300_000, expectedType: "interval", expectedInterval: 300_000 },
  { cronExpression: "0 9 * * *", expectedType: "cron" },
])(
  "preserves explicitly selected schedule $expectedType",
  async ({ expectedType, expectedInterval, ...schedule }) => {
    const instructions = `Schedule ${randomUUID()}`;
    const result = await triggerAction.handler(
      fixture.runtime,
      {
        entityId: fixture.runtime.agentId,
        agentId: fixture.runtime.agentId,
        roomId: randomUUID() as UUID,
        content: { text: "Create this scheduled trigger." },
      } as Memory,
      undefined,
      {
        parameters: {
          action: "create",
          instructions,
          ...(Object.fromEntries(
            Object.entries(schedule).filter(([, value]) => value !== undefined),
          ) as JsonObject),
        },
      },
    );
    expect(result).toMatchObject({ success: true });
    const tasks = await fixture.runtime.getTasks({
      tags: ["trigger"],
    });
    const task = tasks.find((task) =>
      task.metadata?.trigger?.instructions !== instructions
        ? false
        : task.metadata.trigger.triggerType === expectedType &&
          (expectedInterval === undefined ||
            task.metadata.trigger.intervalMs === expectedInterval),
    );
    expect(task).toBeDefined();
  },
);

it("persists the timezone through pause and re-enable and schedules in that zone", async () => {
  const triggerId = randomUUID() as UUID;
  const normalized = normalizeTriggerDraft({
    input: {
      kind: "prompt",
      displayName: "Timezone persistence",
      instructions: "Do not execute",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      timezone: "America/Los_Angeles",
    },
    fallback: {
      displayName: "Timezone persistence",
      instructions: "Do not execute",
      triggerType: "cron",
      wakeMode: "inject_now",
      enabled: true,
      createdBy: "api",
    },
  });
  if (!normalized.draft) throw new Error(normalized.error ?? "Missing draft");
  const trigger = buildTriggerConfig({ draft: normalized.draft, triggerId });
  const metadata = buildTriggerMetadata({ trigger, nowMs: Date.now() });
  expect(metadata).not.toBeNull();
  const taskId = await fixture.runtime.createTask({
    name: "trigger",
    agentId: fixture.runtime.agentId,
    tags: ["repeat", "trigger"],
    metadata: metadata as Task["metadata"],
  });
  try {
    for (const { body, enabled } of [
      { body: { enabled: false }, enabled: false },
      { body: { displayName: "Renamed while paused" }, enabled: false },
      { body: { enabled: true }, enabled: true },
    ]) {
      let status: number | undefined;
      const context = {
        method: "PUT",
        pathname: `/api/triggers/${triggerId}`,
        runtime: fixture.runtime,
        ownerEntityId: resolveOwnerEntityIdOrDefault(fixture.runtime),
        localOwnerEntityId: resolveOwnerEntityIdOrDefault(fixture.runtime),
        req: {} as http.IncomingMessage,
        res: {} as http.ServerResponse,
        readJsonBody: async () => body,
        json: (_res: http.ServerResponse, _body: unknown, code?: number) => {
          status = code ?? 200;
        },
        error: (_res: http.ServerResponse, message: string) => {
          throw new Error(message);
        },
        listTriggerTasks: async () => {
          const task = await fixture.runtime.getTask(taskId);
          return task ? [task] : [];
        },
        triggersFeatureEnabled,
        readTriggerConfig,
        readTriggerRuns,
        taskToTriggerSummary,
        buildTriggerConfig,
        buildTriggerMetadata,
        normalizeTriggerDraft,
        DISABLED_TRIGGER_INTERVAL_MS,
      } as unknown as TriggerRouteContext;
      expect(await handleTriggerRoutes(context)).toBe(true);
      expect(status).toBe(200);
      const savedTask = await fixture.runtime.getTask(taskId);
      if (!savedTask) throw new Error("Saved task missing");
      const saved = readTriggerConfig(savedTask);
      expect(saved?.timezone).toBe("America/Los_Angeles");
      expect(saved?.enabled).toBe(enabled);
      expect(saved?.runCount).toBe(0);
      if (enabled) {
        if (saved?.nextRunAtMs === undefined)
          throw new Error("Next run missing");
        const hour = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          hour: "numeric",
          hourCycle: "h23",
        }).format(new Date(saved.nextRunAtMs));
        expect(hour).toBe("09");
      }
    }
  } finally {
    await fixture.runtime.deleteTask(taskId);
  }
});
