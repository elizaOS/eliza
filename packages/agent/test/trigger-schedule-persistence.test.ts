import { randomUUID } from "node:crypto";
import http from "node:http";
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
  executeTriggerTask,
  getTriggerHealthSnapshot,
  getTriggerLimit,
  listTriggerTasks,
  readTriggerConfig,
  readTriggerRuns,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
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

async function requestTrigger(
  method: string,
  pathname: string,
  body: JsonObject,
) {
  let routeFailure: unknown;
  const sendJson = (
    res: http.ServerResponse,
    payload: unknown,
    status = 200,
  ) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const context: TriggerRouteContext = {
        method,
        pathname,
        req,
        res,
        runtime: fixture.runtime,
        ownerEntityId: resolveOwnerEntityIdOrDefault(fixture.runtime),
        localOwnerEntityId: resolveOwnerEntityIdOrDefault(fixture.runtime),
        readJsonBody: async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        },
        json: sendJson,
        error: (response, message, status) =>
          sendJson(response, { error: message }, status),
        executeTriggerTask,
        getTriggerHealthSnapshot,
        getTriggerLimit,
        listTriggerTasks,
        readTriggerConfig,
        readTriggerRuns,
        taskToTriggerSummary,
        triggersFeatureEnabled,
        buildTriggerConfig,
        buildTriggerMetadata,
        normalizeTriggerDraft,
        DISABLED_TRIGGER_INTERVAL_MS,
        TRIGGER_TASK_NAME,
        TRIGGER_TASK_TAGS: [...TRIGGER_TASK_TAGS],
      };
      if (!(await handleTriggerRoutes(context)))
        sendJson(res, { error: "Route not found" }, 404);
    } catch (error) {
      routeFailure = error;
      res.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing loopback port");
    const response = await fetch(
      `http://127.0.0.1:${address.port}${pathname}`,
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const payload = await response.json();
    if (routeFailure) throw routeFailure;
    return { status: response.status, payload };
  } catch (error) {
    throw routeFailure ?? error;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

it.each([
  { future: false, enabled: true, status: 400 },
  { future: true, enabled: true, status: 201 },
  { future: false, enabled: false, status: 201 },
])(
  "validates new once schedules over HTTP: $future / $enabled",
  async ({ future, enabled, status }) => {
    const before = await fixture.runtime.getTasks({ tags: ["trigger"] });
    const instructions = `HTTP once ${randomUUID()}`;
    const scheduledAtIso = new Date(
      Date.now() + (future ? 3_600_000 : -60_000),
    ).toISOString();
    const response = await requestTrigger("POST", "/api/triggers", {
      kind: "prompt",
      displayName: instructions,
      instructions,
      triggerType: "once",
      scheduledAtIso,
      enabled,
    });
    expect(response.status).toBe(status);
    const after = await fixture.runtime.getTasks({ tags: ["trigger"] });
    if (status === 400) {
      expect(response.payload).toEqual({
        error: "Once trigger requires a future scheduledAtIso",
      });
      expect(after).toEqual(before);
    } else {
      const saved = after.find(
        (task) => readTriggerConfig(task)?.instructions === instructions,
      );
      if (!saved?.id) throw new Error("Created once task missing");
      try {
        expect(readTriggerConfig(saved)).toMatchObject({
          enabled,
          scheduledAtIso,
          runCount: 0,
        });
        expect(saved.entityId).toBe(
          resolveOwnerEntityIdOrDefault(fixture.runtime),
        );
      } finally {
        await fixture.runtime.deleteTask(saved.id);
      }
    }
  },
);

const onceUpdates: { enabled: boolean; body: JsonObject; status: number }[] = [
  {
    enabled: true,
    body: { displayName: "Rename past completed trigger" },
    status: 200,
  },
  { enabled: true, body: { enabled: true }, status: 200 },
  {
    enabled: false,
    body: { displayName: "Rename paused trigger" },
    status: 200,
  },
  { enabled: true, body: { enabled: false }, status: 200 },
  { enabled: false, body: { enabled: true }, status: 400 },
  {
    enabled: true,
    body: { scheduledAtIso: "2000-01-01T00:00:00.000Z" },
    status: 400,
  },
  {
    enabled: false,
    body: {
      enabled: true,
      scheduledAtIso: new Date(Date.now() + 3_600_000).toISOString(),
    },
    status: 200,
  },
];
it.each(onceUpdates)(
  "preserves once update intent over HTTP: $body",
  async ({ enabled, body, status }) => {
    const triggerId = randomUUID() as UUID;
    const normalized = normalizeTriggerDraft({
      input: {
        kind: "prompt",
        triggerType: "once",
        scheduledAtIso: "2001-01-01T00:00:00.000Z",
      },
      fallback: {
        displayName: "Completed once",
        instructions: "Do not execute",
        triggerType: "once",
        wakeMode: "inject_now",
        enabled,
        createdBy: "api",
      },
    });
    if (!normalized.draft) throw new Error(normalized.error ?? "Missing draft");
    const trigger = {
      ...buildTriggerConfig({ draft: normalized.draft, triggerId }),
      runCount: 1,
      lastStatus: "success" as const,
      lastRunAtIso: "2001-01-01T00:00:00.000Z",
    };
    const taskId = await fixture.runtime.createTask({
      name: TRIGGER_TASK_NAME,
      agentId: fixture.runtime.agentId,
      entityId: resolveOwnerEntityIdOrDefault(fixture.runtime),
      tags: [...TRIGGER_TASK_TAGS],
      metadata: {
        trigger,
        updatedAt: Date.now(),
        updateInterval: DISABLED_TRIGGER_INTERVAL_MS,
      },
    });
    try {
      const before = await fixture.runtime.getTask(taskId);
      const response = await requestTrigger(
        "PUT",
        `/api/triggers/${triggerId}`,
        body,
      );
      expect(response.status).toBe(status);
      const saved = await fixture.runtime.getTask(taskId);
      if (!saved) throw new Error("Updated task missing");
      if (status === 400) expect(saved).toEqual(before);
      else
        expect(readTriggerConfig(saved)).toMatchObject({
          triggerId,
          runCount: 1,
          lastStatus: "success",
          lastRunAtIso: trigger.lastRunAtIso,
          enabled: "enabled" in body ? body.enabled : enabled,
          scheduledAtIso:
            typeof body.scheduledAtIso === "string"
              ? body.scheduledAtIso
              : trigger.scheduledAtIso,
          ...("displayName" in body ? { displayName: body.displayName } : {}),
        });
    } finally {
      await fixture.runtime.deleteTask(taskId);
    }
  },
);

it("upgrades persisted workbench schedules without losing timing or duplicating triggers", async () => {
  const { runRuntimeStartupMaintenance } = await import(
    "../src/runtime/runtime-maintenance.ts"
  );
  const { WORKBENCH_TASK_TAG } = await import(
    "../src/api/workbench-helpers.ts"
  );
  const taskId = await fixture.runtime.createTask({
    name: "Retained morning reminder",
    description: "Read the retained morning note",
    agentId: fixture.runtime.agentId,
    entityId: resolveOwnerEntityIdOrDefault(fixture.runtime),
    tags: [WORKBENCH_TASK_TAG, "schedule:0 9 * * *"],
    metadata: {},
  });
  try {
    await runRuntimeStartupMaintenance(fixture.runtime);
    const saved = await fixture.runtime.getTask(taskId);
    if (!saved) throw new Error("Retained task disappeared");
    expect(saved.name).toBe(TRIGGER_TASK_NAME);
    expect(saved.tags).toEqual(expect.arrayContaining([...TRIGGER_TASK_TAGS]));
    expect(readTriggerConfig(saved)).toMatchObject({
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      instructions: "Read the retained morning note",
    });
    await runRuntimeStartupMaintenance(fixture.runtime);
    const reread = await fixture.runtime.getTask(taskId);
    if (!reread) throw new Error("Migrated task disappeared");
    expect(readTriggerConfig(reread)).toEqual(readTriggerConfig(saved));
  } finally {
    await fixture.runtime.deleteTask(taskId);
  }
});
