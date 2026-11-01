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
import { afterAll, beforeAll, expect, it, vi } from "vitest";
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
it.each([
  { corrected: true, changeInstructions: false },
  { corrected: false, changeInstructions: false },
  { corrected: true, changeInstructions: true },
])(
  "keeps actual schedule rejection evidence and reports creation truthfully (%j)",
  async ({ corrected, changeInstructions }) => {
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
                  // Repair timing for the same requested reminder. A different
                  // instruction body must not discharge the original rejection.
                  instructions:
                    plans === 1 && changeInstructions
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
    if (changeInstructions) {
      expect(result.finalMessage).not.toBe(expectedMessage);
      expect(result.evaluator?.success).not.toBe(true);
      expect(result.trajectory.evaluatorOutputs.at(-1)?.success).toBe(true);
    } else {
      expect(result.finalMessage).toBe(expectedMessage);
      if (corrected) expect(result.evaluator?.success).toBe(true);
      else expect(result.evaluator?.success).not.toBe(true);
    }
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
it("refuses trigger creation when ELIZA_TRIGGERS_ENABLED is FALSE in any case, like the trigger routes", async () => {
  const before = await fixture.runtime.getTasks({ tags: ["trigger"] });
  const runtime = Object.create(fixture.runtime);
  runtime.getSetting = (key: string) =>
    key === "ELIZA_TRIGGERS_ENABLED" ? null : fixture.runtime.getSetting(key);
  const previous = process.env.ELIZA_TRIGGERS_ENABLED;
  process.env.ELIZA_TRIGGERS_ENABLED = " FALSE";
  try {
    expect(triggersFeatureEnabled(runtime)).toBe(false);
    const result = await triggerAction.handler(
      runtime,
      {
        entityId: fixture.runtime.agentId,
        agentId: fixture.runtime.agentId,
        roomId: randomUUID() as UUID,
        content: { text: "Remind me in 2 minutes." },
      } as Memory,
      undefined,
      {
        parameters: {
          action: "create",
          instructions: "Remind the user.",
          delayMinutes: 2,
        },
      },
    );
    expect(result).toMatchObject({ success: false, error: "TRIGGERS_OFF" });
    expect(await fixture.runtime.getTasks({ tags: ["trigger"] })).toEqual(
      before,
    );
  } finally {
    if (previous === undefined) delete process.env.ELIZA_TRIGGERS_ENABLED;
    else process.env.ELIZA_TRIGGERS_ENABLED = previous;
  }
});
it.each([
  {
    triggerType: "interval",
    intervalMs: 7_200_000,
    expectedType: "interval",
    expectedInterval: 7_200_000,
  },
  {
    // The planner echoes the first fire as a delay beside the interval.
    triggerType: "interval",
    intervalMs: 7_200_000,
    delayMinutes: 120,
    expectedType: "interval",
    expectedInterval: 7_200_000,
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

it("fires an omitted-instructions reminder with the request, not the help envelope", async () => {
  // content.text as chat augmentation rewrites it for a short request.
  const request = `stretch reminder ${randomUUID()}`;
  const text = [
    "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
    "If the answer appears verbatim in the contextual documents, repeat it exactly.",
    "Do not ask follow-up questions or invoke tools/actions when the contextual documents already answer the request.",
    "",
    "<contextual_documents>",
    '<source title="source-1" similarity="1.000">',
    "Q: What can Eliza actually do?\nA: Beyond chatting, Eliza can manage tasks and reminders.",
    "</source>",
    "</contextual_documents>",
    "",
    "<user_request>",
    request,
    "</user_request>",
  ].join("\n");
  const result = await triggerAction.handler(
    fixture.runtime,
    {
      entityId: fixture.runtime.agentId,
      agentId: fixture.runtime.agentId,
      roomId: randomUUID() as UUID,
      content: { text },
    } as Memory,
    undefined,
    { parameters: { action: "create", delayMinutes: 5 } },
  );
  expect(result).toMatchObject({ success: true });
  const tasks = await fixture.runtime.getTasks({ tags: ["trigger"] });
  const task = tasks.find((task) =>
    task.metadata?.trigger?.instructions?.includes(request),
  );
  expect(task && readTriggerConfig(task)?.instructions).toBe(request);
});

it.each<{ label: string; schedule: JsonObject }>([
  {
    label: "triggerType=interval alone when intervalMs is absent",
    schedule: { triggerType: "interval" },
  },
  {
    label: "triggerType=interval over a cron when intervalMs is absent",
    schedule: { triggerType: "interval", cronExpression: "0 9 * * *" },
  },
  {
    label: "intervalMs with a delay and no triggerType",
    schedule: { intervalMs: 7_200_000, delayMinutes: 120 },
  },
  {
    label: "intervalMs with scheduledAtIso and no triggerType",
    schedule: { intervalMs: 7_200_000, scheduledAtIso: "2099-01-01T09:00:00Z" },
  },
])(
  "refuses a trigger create with $label and writes no trigger task",
  async ({ schedule }) => {
    const before = await fixture.runtime.getTasks({ tags: ["trigger"] });
    const result = await triggerAction.handler(
      fixture.runtime,
      {
        entityId: fixture.runtime.agentId,
        agentId: fixture.runtime.agentId,
        roomId: randomUUID() as UUID,
        content: { text: "Remind me every 2 hours to stretch." },
      } as Memory,
      undefined,
      {
        parameters: { action: "create", instructions: "stretch", ...schedule },
      },
    );
    expect(result).toMatchObject({
      success: false,
      error: "MISSING_SCHEDULE",
      data: { acceptance: "rejected", executionStatus: "not_started" },
    });
    expect(result?.effectReceipts).toBeUndefined();
    expect(await fixture.runtime.getTasks({ tags: ["trigger"] })).toEqual(
      before,
    );
  },
);

it("updates a trigger by the triggerId create returned and refuses fields it cannot apply", async () => {
  const message = {
    entityId: fixture.runtime.agentId,
    agentId: fixture.runtime.agentId,
    roomId: randomUUID() as UUID,
    content: { text: "Remind me every morning to water the orchid." },
  } as Memory;
  const created = await triggerAction.handler(
    fixture.runtime,
    message,
    undefined,
    {
      parameters: {
        action: "create",
        displayName: "Water the orchid",
        instructions: "Remind the user to water the orchid.",
        cronExpression: "0 9 * * *",
      },
    },
  );
  if (!created?.success) throw new Error(created?.text ?? "create failed");
  const { taskId, triggerId } = created.data as {
    taskId: UUID;
    triggerId: UUID;
  };
  try {
    // list is the only read; update can only be reached with an id it returns.
    const listed = await triggerAction.handler(
      fixture.runtime,
      message,
      undefined,
      { parameters: { action: "list" } },
    );
    expect(
      (listed?.data as { entries: unknown[] } | undefined)?.entries,
    ).toContainEqual({ taskId, triggerId, displayName: "Water the orchid" });
    const update = (parameters: Record<string, unknown>) =>
      triggerAction.handler(fixture.runtime, message, undefined, {
        parameters: { action: "update", taskId: triggerId, ...parameters },
      });
    for (const [parameters, error] of [
      [{ scheduledAtIso: "2099-01-01T17:00:00Z" }, "INVALID_UPDATE"],
      [{ delayMinutes: 10 }, "INVALID_UPDATE"],
      [{ triggerType: "once" }, "INVALID_UPDATE"],
      [{ enabled: false }, "INVALID_UPDATE"],
      [{}, "NO_UPDATE_FIELDS"],
    ] as const) {
      const refused = await update(parameters);
      expect(refused, JSON.stringify(parameters)).toMatchObject({
        success: false,
        error,
      });
      expect(refused?.effectReceipts).toBeUndefined();
    }
    const unchanged = await fixture.runtime.getTask(taskId);
    expect(unchanged && readTriggerConfig(unchanged)).toMatchObject({
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      displayName: "Water the orchid",
      enabled: true,
    });

    const moved = await update({ cronExpression: "0 17 * * *" });
    expect(moved, moved?.text).toMatchObject({
      success: true,
      data: { taskId, triggerId, cronExpression: "0 17 * * *" },
    });
    const saved = await fixture.runtime.getTask(taskId);
    expect(saved && readTriggerConfig(saved)?.cronExpression).toBe(
      "0 17 * * *",
    );
  } finally {
    await fixture.runtime.deleteTask(taskId);
  }
});

it("edits a paused trigger through the action and keeps it paused", async () => {
  const message = {
    entityId: fixture.runtime.agentId,
    agentId: fixture.runtime.agentId,
    roomId: randomUUID() as UUID,
    content: { text: "Remind me every morning to stretch." },
  } as Memory;
  const run = (parameters: JsonObject) =>
    triggerAction.handler(fixture.runtime, message, undefined, { parameters });
  const created = await run({
    action: "create",
    displayName: "Stretch",
    instructions: "Remind the user to stretch.",
    cronExpression: "0 9 * * *",
  });
  if (!created?.success) throw new Error(created?.text ?? "create failed");
  const { taskId, triggerId } = created.data as {
    taskId: UUID;
    triggerId: UUID;
  };
  try {
    const paused = await run({
      action: "toggle",
      taskId: triggerId,
      enabled: false,
    });
    expect(paused, paused?.text).toMatchObject({ success: true });

    // Like the PUT route's "Renamed while paused": the edit is saved and the
    // trigger stays paused on the disabled interval.
    const edited = await run({
      action: "update",
      taskId: triggerId,
      displayName: "Stretch and breathe",
      cronExpression: "0 17 * * *",
    });
    expect(edited, edited?.text).toMatchObject({ success: true });
    expect(edited?.text).toContain("(paused)");
    const saved = await fixture.runtime.getTask(taskId);
    expect(saved && readTriggerConfig(saved)).toMatchObject({
      displayName: "Stretch and breathe",
      cronExpression: "0 17 * * *",
      enabled: false,
    });
    expect(
      (saved?.metadata as { updateInterval?: number } | undefined)
        ?.updateInterval,
    ).toBe(DISABLED_TRIGGER_INTERVAL_MS);

    // Resuming schedules the edited time.
    const resumed = await run({
      action: "toggle",
      taskId: triggerId,
      enabled: true,
    });
    expect(resumed, resumed?.text).toMatchObject({ success: true });
    const live = await fixture.runtime.getTask(taskId);
    expect(live && readTriggerConfig(live)).toMatchObject({
      cronExpression: "0 17 * * *",
      enabled: true,
    });
    expect(
      (live?.metadata as { updateInterval?: number } | undefined)
        ?.updateInterval,
    ).not.toBe(DISABLED_TRIGGER_INTERVAL_MS);
  } finally {
    await fixture.runtime.deleteTask(taskId);
  }
});

it("reads a once time with no offset in the user's zone on create and update", async () => {
  // Asia/Kolkata is UTC+05:30 all year, so the expected instant does not
  // depend on the zone of the host that runs this test.
  const message = {
    entityId: fixture.runtime.agentId,
    agentId: fixture.runtime.agentId,
    roomId: randomUUID() as UUID,
    content: {
      text: "Remind me to call mom.",
      metadata: { uiTimeZone: "Asia/Kolkata" },
    },
  } as Memory;
  const created = await triggerAction.handler(
    fixture.runtime,
    message,
    undefined,
    {
      parameters: {
        action: "create",
        instructions: "Remind the user to call mom.",
        scheduledAtIso: "2099-01-15T09:00:00",
      },
    },
  );
  if (!created?.success) throw new Error(created?.text ?? "create failed");
  const { taskId } = created.data as { taskId: UUID };
  try {
    const stored = await fixture.runtime.getTask(taskId);
    expect(stored && readTriggerConfig(stored)).toMatchObject({
      triggerType: "once",
      scheduledAtIso: "2099-01-15T03:30:00.000Z",
      nextRunAtMs: Date.parse("2099-01-15T03:30:00.000Z"),
    });
    const update = (scheduledAtIso: string) =>
      triggerAction.handler(fixture.runtime, message, undefined, {
        parameters: { action: "update", taskId, scheduledAtIso },
      });
    const moved = await update("2099-01-16T18:15");
    expect(moved, moved?.text).toMatchObject({ success: true });
    const afterLocal = await fixture.runtime.getTask(taskId);
    expect(afterLocal && readTriggerConfig(afterLocal)?.scheduledAtIso).toBe(
      "2099-01-16T12:45:00.000Z",
    );
    // An explicit offset is an instant already and is stored as given.
    const pinned = await update("2099-01-17T09:00:00-08:00");
    expect(pinned, pinned?.text).toMatchObject({ success: true });
    const afterPinned = await fixture.runtime.getTask(taskId);
    expect(afterPinned && readTriggerConfig(afterPinned)).toMatchObject({
      scheduledAtIso: "2099-01-17T09:00:00-08:00",
      nextRunAtMs: Date.parse("2099-01-17T17:00:00.000Z"),
    });
  } finally {
    await fixture.runtime.deleteTask(taskId);
  }
});
// Live tj-9f09a0f51d65aa, "actually make it 30 minutes": the planner sent
// TRIGGER_UPDATE delayMinutes:30 and got INVALID_UPDATE, then a second round
// re-sent the same move as scheduledAtIso.
it("moves a one-off trigger by a relative delay on update, as create reads it", async () => {
  const message = {
    entityId: fixture.runtime.agentId,
    agentId: fixture.runtime.agentId,
    roomId: randomUUID() as UUID,
    content: { text: "Set a reminder for 20 minutes from now to stretch." },
  } as Memory;
  const instructions = `Remind the user to stretch ${randomUUID()}`;
  const created = await triggerAction.handler(
    fixture.runtime,
    message,
    undefined,
    { parameters: { action: "create", instructions, delayMinutes: 20 } },
  );
  if (!created?.success) throw new Error(created?.text ?? "create failed");
  const { taskId } = created.data as { taskId: UUID };
  try {
    const update = (parameters: Record<string, unknown>) =>
      triggerAction.handler(fixture.runtime, message, undefined, {
        parameters: { action: "update", taskId, ...parameters },
      });
    for (const delayMinutes of [0, -5, 366 * 24 * 60 + 1]) {
      const refused = await update({ delayMinutes });
      expect(refused, String(delayMinutes)).toMatchObject({
        success: false,
        error: "INVALID_UPDATE",
      });
      expect(refused?.effectReceipts).toBeUndefined();
    }
    const before = Date.now();
    const moved = await update({ delayMinutes: 30 });
    const after = Date.now();
    expect(moved, moved?.text).toMatchObject({
      success: true,
      effectReceipts: [{ operation: "trigger.update", outcome: "applied" }],
    });
    const stored = await fixture.runtime.getTask(taskId);
    const config = stored && readTriggerConfig(stored);
    const firesAt = Date.parse(config?.scheduledAtIso ?? "");
    expect(firesAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(firesAt).toBeLessThanOrEqual(after + 30 * 60_000);
    expect(config).toMatchObject({
      triggerType: "once",
      delayMs: 30 * 60_000,
      nextRunAtMs: firesAt,
    });
    // The moved trigger carries create's relative identity: an immediate
    // "in 30 minutes" create for it replays instead of adding a duplicate.
    const retried = await triggerAction.handler(
      fixture.runtime,
      message,
      undefined,
      { parameters: { action: "create", instructions, delayMinutes: 30 } },
    );
    expect(retried?.effectReceipts?.[0]).toMatchObject({ outcome: "noop" });
    // An explicit scheduledAtIso still wins over a delay sent beside it.
    const pinned = await update({
      scheduledAtIso: "2099-01-01T17:00:00Z",
      delayMinutes: 45,
    });
    expect(pinned, pinned?.text).toMatchObject({ success: true });
    const afterPinned = await fixture.runtime.getTask(taskId);
    expect(afterPinned && readTriggerConfig(afterPinned)).toMatchObject({
      scheduledAtIso: "2099-01-01T17:00:00Z",
    });
    expect(
      afterPinned && readTriggerConfig(afterPinned)?.delayMs,
    ).toBeUndefined();
  } finally {
    await fixture.runtime.deleteTask(taskId);
  }
});
it("sets a second relative reminder asked later, and replays only an immediate retry", async () => {
  const message = {
    entityId: fixture.runtime.agentId,
    agentId: fixture.runtime.agentId,
    roomId: randomUUID() as UUID,
    content: { text: "Remind me in 1 hour to move the laundry." },
  } as Memory;
  const remindInAnHour = () =>
    triggerAction.handler(fixture.runtime, message, undefined, {
      parameters: {
        action: "create",
        instructions: "Remind the user to move the laundry.",
        delayMinutes: 60,
      },
    });
  const fireTimes = async () =>
    (await fixture.runtime.getTasks({ tags: [...TRIGGER_TASK_TAGS] }))
      .map((task) => readTriggerConfig(task))
      .filter(
        (cfg) => cfg?.instructions === "Remind the user to move the laundry.",
      )
      .map((cfg) => cfg?.scheduledAtIso)
      .sort();
  const start = Date.now();
  const createdIds: UUID[] = [];
  try {
    const first = await remindInAnHour();
    expect(first, first?.text).toMatchObject({ success: true });
    createdIds.push(
      (first?.data as { taskId: UUID } | undefined)?.taskId as UUID,
    );

    // A planner retry of the same call a moment later is the same reminder.
    const retry = await remindInAnHour();
    expect(retry?.text).toBe("Already set — you're covered.");
    expect(await fireTimes()).toHaveLength(1);

    // Editing instructions must preserve relative-delay retry identity.
    for (const instructions of [
      "Remind the user to move the laundry into the dryer.",
      "Remind the user to move the laundry.",
    ]) {
      const updated = await triggerAction.handler(
        fixture.runtime,
        message,
        undefined,
        {
          parameters: { action: "update", taskId: createdIds[0], instructions },
        },
      );
      expect(updated, updated?.text).toMatchObject({ success: true });
      const repeated = await triggerAction.handler(
        fixture.runtime,
        message,
        undefined,
        {
          parameters: { action: "create", instructions, delayMinutes: 60 },
        },
      );
      expect(repeated).toMatchObject({
        success: true,
        data: { duplicateTaskId: createdIds[0] },
      });
    }

    // The same words 40 minutes later ask for a reminder 40 minutes later.
    vi.spyOn(Date, "now").mockReturnValue(start + 40 * 60_000);
    const later = await remindInAnHour();
    vi.restoreAllMocks();
    expect(later, later?.text).toMatchObject({ success: true });
    expect(later?.text).not.toBe("Already set — you're covered.");
    createdIds.push(
      (later?.data as { taskId: UUID } | undefined)?.taskId as UUID,
    );
    const times = (await fireTimes()).map((iso) => Date.parse(iso ?? ""));
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(39 * 60_000);

    // Moving a relative reminder to an explicit time must retire its old
    // delay identity, so a create for the new time replays that same task.
    const scheduledAtIso = new Date(start + 2 * 60 * 60_000).toISOString();
    const moved = await triggerAction.handler(
      fixture.runtime,
      message,
      undefined,
      {
        parameters: { action: "update", taskId: createdIds[0], scheduledAtIso },
      },
    );
    expect(moved, moved?.text).toMatchObject({ success: true });
    const movedTask = await fixture.runtime.getTask(createdIds[0]);
    expect(movedTask && readTriggerConfig(movedTask)?.delayMs).toBeUndefined();
    const repeated = await triggerAction.handler(
      fixture.runtime,
      message,
      undefined,
      {
        parameters: {
          action: "create",
          instructions: "Remind the user to move the laundry.",
          scheduledAtIso,
        },
      },
    );
    expect(repeated).toMatchObject({
      success: true,
      data: { duplicateTaskId: createdIds[0] },
    });
  } finally {
    vi.restoreAllMocks();
    for (const id of createdIds) if (id) await fixture.runtime.deleteTask(id);
  }
});
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
  // A zone Intl rejects would be scheduled on UTC, so the draft is refused.
  for (const timezone of ["Pacific Time", "America/LosAngeles", ""]) {
    expect(
      normalizeTriggerDraft({
        input: { ...normalized.draft, timezone },
        fallback: normalized.draft,
      }),
    ).toEqual({ error: "timezone must be a valid IANA time zone" });
  }
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
        getTriggerLimit,
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

it("runs a cron time that a DST change skips one gap later, not the next day", () => {
  const nextRun = (
    cronExpression: string,
    timezone: string,
    nowIso: string,
  ): string | undefined => {
    const normalized = normalizeTriggerDraft({
      input: {
        kind: "prompt",
        displayName: "DST gap",
        instructions: "Do not execute",
        triggerType: "cron",
        cronExpression,
        timezone,
      },
      fallback: {
        displayName: "DST gap",
        instructions: "Do not execute",
        triggerType: "cron",
        wakeMode: "inject_now",
        enabled: true,
        createdBy: "api",
      },
    });
    if (!normalized.draft) throw new Error(normalized.error ?? "Missing draft");
    const trigger = buildTriggerConfig({
      draft: normalized.draft,
      triggerId: randomUUID() as UUID,
    });
    const ms = buildTriggerMetadata({ trigger, nowMs: Date.parse(nowIso) })
      ?.trigger?.nextRunAtMs;
    return ms === undefined ? undefined : new Date(ms).toISOString();
  };
  // 2026-03-08 New York has no 02:30; the run is at 03:30 EDT.
  expect(
    nextRun("30 2 * * *", "America/New_York", "2026-03-07T08:00:00.000Z"),
  ).toBe("2026-03-08T07:30:00.000Z");
  // 2026-09-06 Santiago has no midnight; the run is at 01:00 -03.
  expect(
    nextRun("0 0 * * *", "America/Santiago", "2026-09-05T05:00:00.000Z"),
  ).toBe("2026-09-06T04:00:00.000Z");
  // A scan that starts inside the shifted span still sees the gap.
  expect(
    nextRun("*/15 2 * * *", "America/New_York", "2026-03-08T07:00:00.000Z"),
  ).toBe("2026-03-08T07:15:00.000Z");
  // The repeated hour of the fall-back day still runs once.
  expect(
    nextRun("30 1 * * *", "America/New_York", "2026-11-01T05:30:00.000Z"),
  ).toBe("2026-11-02T06:30:00.000Z");
});

it("keeps an interval trigger's next run when an edit leaves the interval", async () => {
  const displayName = `Weekly report ${randomUUID()}`;
  const week = 7 * 24 * 60 * 60 * 1000;
  const created = await requestTrigger("POST", "/api/triggers", {
    kind: "prompt",
    displayName,
    instructions: "Send the weekly report.",
    triggerType: "interval",
    intervalMs: week,
    enabled: true,
  });
  expect(created.status).toBe(201);
  const saved = (await fixture.runtime.getTasks({ tags: ["trigger"] })).find(
    (task) => readTriggerConfig(task)?.displayName === displayName,
  );
  if (!saved?.id) throw new Error("Created interval task missing");
  const taskId = saved.id;
  const nextRunBefore = readTriggerConfig(saved)?.nextRunAtMs;
  const anchorBefore = (saved.metadata as { updatedAt?: number }).updatedAt;
  try {
    // Six days later the owner only renames it; the form sends the full
    // schedule back unchanged.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const renamed = await requestTrigger("PUT", `/api/triggers/${taskId}`, {
      displayName: `${displayName} (renamed)`,
      triggerType: "interval",
      intervalMs: week,
    });
    vi.restoreAllMocks();
    expect(renamed.status).toBe(200);
    const after = await fixture.runtime.getTask(taskId);
    expect(after && readTriggerConfig(after)).toMatchObject({
      displayName: `${displayName} (renamed)`,
      nextRunAtMs: nextRunBefore,
    });
    expect(
      (after?.metadata as { updatedAt?: number } | undefined)?.updatedAt,
    ).toBe(anchorBefore);
  } finally {
    vi.restoreAllMocks();
    await fixture.runtime.deleteTask(taskId);
  }
});

it("removes a trigger's run limit when an edit clears Stop after", async () => {
  const runtime = fixture.runtime;
  const created = await requestTrigger("POST", "/api/triggers", {
    kind: "prompt",
    displayName: `Stretch reminder ${randomUUID()}`,
    instructions: "Remind me to stretch.",
    triggerType: "interval",
    intervalMs: 3_600_000,
    maxRuns: 1,
  });
  expect(created.status).toBe(201);
  const { id: triggerId, taskId } = created.payload.trigger;
  const schedule = { triggerType: "interval", intervalMs: 3_600_000 };
  try {
    // An edit that does not send the field keeps the limit.
    const renamed = await requestTrigger("PUT", `/api/triggers/${triggerId}`, {
      ...schedule,
      displayName: "Stretch reminder (renamed)",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.payload.trigger.maxRuns).toBe(1);
    // The Automations form sends a cleared "Stop after" field as null.
    const cleared = await requestTrigger("PUT", `/api/triggers/${triggerId}`, {
      ...schedule,
      maxRuns: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.payload.trigger.maxRuns).toBeUndefined();
    const task = await runtime.getTask(taskId);
    if (!task) throw new Error("Edited task missing");
    expect(readTriggerConfig(task)?.maxRuns).toBeUndefined();
    const priorMessageService = runtime.messageService;
    runtime.messageService = {
      handleMessage: async () => ({
        outcome: { status: "completed", effects: [] },
        didRespond: false,
        responseMessages: [],
      }),
    } satisfies Pick<
      IMessageService,
      "handleMessage"
    > as unknown as IMessageService;
    try {
      const result = await executeTriggerTask(runtime, task, {
        source: "scheduler",
        force: true,
      });
      expect(result.status).toBe("success");
      expect(result.taskDeleted).toBe(false);
    } finally {
      runtime.messageService = priorMessageService;
    }
    expect(await runtime.getTask(taskId)).not.toBeNull();
  } finally {
    await runtime.deleteTask(taskId);
  }
});

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

it("delivers a workflow trigger edited into a prompt through the owner room", async () => {
  const runtime = fixture.runtime;
  const broadcasts: unknown[] = [];
  const ownerState = () =>
    ({
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
    }) as unknown as ServerState;
  const instructions = `Edited into a prompt ${randomUUID()}`;
  const created = await requestTrigger("POST", "/api/triggers", {
    kind: "workflow",
    workflowId: `wf-${randomUUID()}`,
    workflowName: "Morning digest",
    displayName: instructions,
    triggerType: "interval",
    intervalMs: 3_600_000,
  });
  expect(created.status).toBe(201);
  const { id: triggerId, taskId } = created.payload.trigger;
  // The Automations form: kind toggle -> Prompt, then Save.
  const edit: JsonObject = {
    kind: "prompt",
    instructions,
    triggerType: "interval",
    intervalMs: 3_600_000,
  };
  try {
    const unavailable = ownerState();
    const lost = await ensureOwnerConversation(unavailable, runtime);
    await runtime.deleteRoom(lost.roomId);
    const before = await runtime.getTask(taskId);
    const refused = await requestTrigger(
      "PUT",
      `/api/triggers/${triggerId}`,
      edit,
      unavailable,
    );
    expect(refused.status).toBe(503);
    expect(await runtime.getTask(taskId)).toEqual(before);

    const state = ownerState();
    registerClientChatSendHandler(runtime, state);
    const updated = await requestTrigger(
      "PUT",
      `/api/triggers/${triggerId}`,
      edit,
      state,
    );
    expect(updated.status).toBe(200);
    expect(updated.payload.trigger.kind).toBe("prompt");
    const conversation = await ensureOwnerConversation(state, runtime);
    const task = await runtime.getTask(taskId);
    if (!task) throw new Error("Edited task missing");
    expect(task.roomId).toBe(conversation.roomId);
    const priorMessageService = runtime.messageService;
    runtime.messageService = {
      handleMessage: async (_runtime, message, callback) => {
        expect(message.roomId).toBe(conversation.roomId);
        if (!callback) throw new Error("Missing delivery callback");
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
        source: "manual",
        force: true,
      });
      expect(result.status).toBe("success");
      expect(broadcasts).toContainEqual(
        expect.objectContaining({
          type: "proactive-message",
          conversationId: conversation.id,
          message: expect.objectContaining({ text: instructions }),
        }),
      );
    } finally {
      runtime.messageService = priorMessageService;
    }
  } finally {
    await runtime.deleteTask(taskId);
  }
});

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
