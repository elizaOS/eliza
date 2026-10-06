import { randomUUID } from "node:crypto";
import http from "node:http";
import {
  type IMessageService,
  type JsonObject,
  type Memory,
  type PlannerToolResult,
  resolveOwnerEntityIdOrDefault,
  type Task,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runPlannerLoop } from "../../../plugins/plugin-assistant/src/runtime/planner-loop.ts";
import {
  handleTriggerRoutes,
  type TriggerRouteContext,
} from "../../../plugins/plugin-workflow/src/trigger-routes.ts";
import { triggerAction } from "../src/actions/trigger.ts";
import {
  ensureOwnerConversation,
  resolvePromptDeliveryRoom,
} from "../src/api/conversation-routes.ts";
import type { ServerState } from "../src/api/server-types.ts";
import { registerClientChatSendHandler } from "../src/services/client-chat-sender.ts";
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
  expect(result).toMatchObject({
    success: false,
    error: "MISSING_SCHEDULE",
    failureProvenance: {
      kind: "handler_error",
      boundary: "handler",
      code: "MISSING_SCHEDULE",
      retryable: true,
    },
    data: { acceptance: "rejected", executionStatus: "not_started" },
  });
  expect(result?.effectReceipts).toBeUndefined();
  expect(await fixture.runtime.getTasks({ tags: ["trigger"] })).toEqual(before);
});
it.each([true, false])(
  "keeps actual schedule rejection evidence and reports creation truthfully (corrected=%s)",
  async (corrected) => {
    const before = await fixture.runtime.getTasks({ tags: ["trigger"] });
    const roomId = randomUUID() as UUID;
    const instructions = `Send a short shoulder-stretch nudge ${randomUUID()}`;
    let plans = 0;
    const results: PlannerToolResult[] = [];
    const expectedMessage = corrected
      ? "Your reminder is set for two minutes from now."
      : "Your reminder wasn't created because its time was missing.";
    const result = await runPlannerLoop({
      codingMode: false,
      context: { id: `trigger-schedule-recovery-${corrected}`, events: [] },
      runtime: {
        useModel: async () => {
          if (!corrected && plans === 1) {
            plans++;
            return { text: expectedMessage };
          }
          if (++plans > (corrected ? 2 : 1))
            throw new Error("Unexpected failure-authority synthesis");
          return {
            text: "",
            toolCalls: [
              {
                id: `trigger-${plans}`,
                name: "TRIGGER_CREATE",
                arguments: {
                  displayName: "Stretch your shoulders",
                  instructions:
                    plans === 1
                      ? "Remind the user to stretch their shoulders. Message: Stretch your shoulders."
                      : instructions,
                  ...(plans === 2 ? { delayMinutes: 2 } : {}),
                  eliza_turn_scope: "final",
                },
              },
            ],
          };
        },
      },
      executeToolCall: async (call) => {
        const executed = await triggerAction.handler(
          fixture.runtime,
          {
            entityId: fixture.runtime.agentId,
            agentId: fixture.runtime.agentId,
            roomId,
            content: {
              text: "Remind me here to stretch my shoulders in two minutes.",
            },
          } as Memory,
          undefined,
          { parameters: { ...call.params, action: "create" } },
        );
        if (!executed) throw new Error("Trigger returned no result");
        results.push(executed as PlannerToolResult);
        return executed as PlannerToolResult;
      },
      evaluate: async () => {
        if (corrected && results.length === 1)
          return {
            decision: "CONTINUE",
            success: false,
            thought: "Provide the requested relative delay.",
          };
        return {
          decision: "FINISH",
          success: corrected,
          thought: corrected
            ? "The corrected trigger has a durable receipt."
            : "No trigger was created.",
          messageToUser: expectedMessage,
          requestFullyCovered: corrected,
          ...(corrected
            ? {
                replyEffectStatus: "applied" as const,
                effectReceiptIds: results[1].effectReceipts?.map(
                  (receipt) => receipt.receiptId,
                ),
              }
            : {}),
        };
      },
    });
    expect(result.finalMessage).toBe(expectedMessage);
    if (corrected) expect(result.evaluator?.success).toBe(true);
    else expect(result.evaluator?.success).not.toBe(true);
    expect(
      result.trajectory.steps.some(
        (step) => step.result?.error === "MISSING_SCHEDULE",
      ),
    ).toBe(true);
    expect(results[0].effectReceipts).toBeUndefined();
    const after = await fixture.runtime.getTasks({ tags: ["trigger"] });
    expect(after).toHaveLength(before.length + (corrected ? 1 : 0));
    if (corrected) {
      expect(results[1].effectReceipts).toEqual([
        expect.objectContaining({
          operation: "trigger.create",
          outcome: "applied",
          commit: expect.objectContaining({ kind: "durable" }),
        }),
      ]);
      expect(
        after.find(
          (task) => task.metadata?.trigger?.instructions === instructions,
        )?.metadata?.trigger?.triggerType,
      ).toBe("once");
    } else expect(after).toEqual(before);
  },
);
it("does not label disabled trigger creation as a retryable schedule rejection", async () => {
  const before = await fixture.runtime.getTasks({ tags: ["trigger"] });
  const runtime = Object.create(fixture.runtime);
  runtime.getSetting = (key: string) =>
    key === "ELIZA_TRIGGERS_ENABLED" ? false : fixture.runtime.getSetting(key);
  const result = await triggerAction.handler(
    runtime,
    {
      entityId: fixture.runtime.agentId,
      agentId: fixture.runtime.agentId,
      roomId: randomUUID() as UUID,
      content: { text: "Create a reminder." },
    } as Memory,
    undefined,
    {
      parameters: {
        action: "create",
        instructions: "Do not run",
        delayMinutes: 2,
      },
    },
  );
  expect(result).toMatchObject({ success: false, error: "TRIGGERS_OFF" });
  expect(result?.failureProvenance?.retryable).not.toBe(true);
  expect(result?.data?.executionStatus).not.toBe("not_started");
  expect(result?.effectReceipts).toBeUndefined();
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
  state: ServerState = {
    runtime: fixture.runtime,
    config: {},
    agentName: "TriggerScheduleBoundary",
    adminEntityId: null,
    chatUserId: null,
    logBuffer: [],
    conversations: new Map(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
  } as unknown as ServerState,
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
        resolvePromptDeliveryRoom: (runtime) =>
          resolvePromptDeliveryRoom(state, runtime),
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
  const { WORKBENCH_TASK_TAG } = await import("@elizaos/host/protocol");
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

it.each([
  "new",
  "existing",
  "delivery-failure",
  "missing-at-create",
  "missing-at-dispatch",
])(
  "delivers an API Once reply through the persisted owner room (%s)",
  async (scenario) => {
    const existing = scenario !== "new";
    const fails =
      scenario === "delivery-failure" || scenario === "missing-at-dispatch";
    const runtime = fixture.runtime;
    const broadcasts: unknown[] = [];
    const state = {
      runtime,
      config: {},
      agentName: "TriggerScheduleBoundary",
      adminEntityId: null,
      chatUserId: null,
      logBuffer: [],
      conversations: new Map(),
      activeChatTurnCount: 0,
      conversationRestorePromise: null,
      deletedConversationIds: new Set(),
      broadcastWs: (event: unknown) => broadcasts.push(event),
    } as unknown as ServerState;
    const original = existing
      ? await ensureOwnerConversation(state, runtime)
      : undefined;
    if (scenario === "missing-at-create" && original) {
      await runtime.deleteRoom(original.roomId);
    }
    registerClientChatSendHandler(runtime, state);
    const instructions = `Offline Once delivery ${randomUUID()}`;
    const response = await requestTrigger(
      "POST",
      "/api/triggers",
      {
        kind: "prompt",
        displayName: instructions,
        instructions,
        triggerType: "once",
        scheduledAtIso: new Date(Date.now() + 60_000).toISOString(),
        roomId: randomUUID(),
      },
      state,
    );
    if (scenario === "missing-at-create") {
      expect(response.status).toBe(503);
      expect(
        (await listTriggerTasks(runtime)).some(
          (task) => readTriggerConfig(task)?.instructions === instructions,
        ),
      ).toBe(false);
      if (original) expect(await runtime.getRoom(original.roomId)).toBeNull();
      return;
    }
    expect(response.status).toBe(201);
    expect(state.conversations.size).toBe(1);
    const conversation = await ensureOwnerConversation(state, runtime);
    if (original) expect(conversation.id).toBe(original.id);
    const task = (await listTriggerTasks(runtime)).find(
      (task) => readTriggerConfig(task)?.instructions === instructions,
    );
    if (!task?.id) throw new Error("Created task missing");
    expect(task.roomId).toBe(conversation.roomId);
    expect(task.entityId).toBe(resolveOwnerEntityIdOrDefault(runtime));
    if (!task.roomId) throw new Error("Prompt delivery room missing");
    expect((await runtime.getRoom(task.roomId))?.source).toBe("client_chat");
    if (scenario === "missing-at-dispatch")
      await runtime.deleteRoom(task.roomId);
    let handledMessages = 0;
    const priorMessageService = runtime.messageService;
    runtime.messageService = {
      handleMessage: async (_runtime, message, callback) => {
        handledMessages++;
        expect(message.roomId).toBe(conversation.roomId);
        if (!callback) throw new Error("Missing delivery callback");
        if (fails) throw new Error("Delivery unavailable");
        const responseMessages = await callback({ text: instructions });
        return {
          outcome: { status: "completed", effects: [] },
          didRespond: true,
          responseMessages: responseMessages ?? [],
        };
      },
    } satisfies Pick<
      IMessageService,
      "handleMessage"
    > as unknown as IMessageService;
    try {
      const result = await executeTriggerTask(runtime, task, {
        source: "scheduler",
        force: true,
      });
      expect(result.status).toBe(fails ? "error" : "success");
      expect(result.taskDeleted).toBe(true);
      if (fails) {
        const error =
          scenario === "missing-at-dispatch"
            ? "Prompt automation delivery conversation is unavailable"
            : "Delivery unavailable";
        expect(result.error).toBe(error);
        expect(result.runRecord?.error).toBe(error);
      }
      if (scenario === "missing-at-dispatch") {
        expect(handledMessages).toBe(0);
        expect(await runtime.getRoom(conversation.roomId)).toBeNull();
      }
      const messages = await runtime.getMemories({
        roomId: conversation.roomId,
        tableName: "messages",
        count: 20,
      });
      expect(
        messages.filter((memory) => memory.content.text === instructions),
      ).toHaveLength(fails ? 0 : 1);
      if (!fails)
        expect(broadcasts).toContainEqual(
          expect.objectContaining({
            type: "proactive-message",
            conversationId: conversation.id,
            message: expect.objectContaining({ text: instructions }),
          }),
        );
    } finally {
      runtime.messageService = priorMessageService;
      await runtime.deleteTask(task.id);
    }
  },
);

it("rejects a prompt delivery binding when the host runtime changes during conversation restore", async () => {
  const runtime = fixture.runtime;
  const replacement = await createTestRuntime({
    characterName: "ReplacementPromptOwner",
  });
  const state = {
    runtime,
    config: {},
    agentName: "TriggerScheduleBoundary",
    adminEntityId: null,
    chatUserId: null,
    logBuffer: [],
    conversations: new Map(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
  } as unknown as ServerState;
  const conversation = await ensureOwnerConversation(state, runtime);
  let release!: () => void;
  state.conversationRestorePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = resolvePromptDeliveryRoom(state, runtime);
  // The real resolver passed its initial fence and is awaiting the restoration
  // promise. The same state object now belongs to another real runtime.
  state.runtime = replacement.runtime;
  const rejection = expect(pending).rejects.toThrow(
    "Runtime changed during prompt automation creation",
  );
  release();
  try {
    await rejection;
    await expect(resolvePromptDeliveryRoom(state, runtime)).rejects.toThrow(
      "Runtime changed before prompt automation creation",
    );
    expect(state.conversations.get(conversation.id)).toBe(conversation);
  } finally {
    release();
    await replacement.cleanup();
  }
});
