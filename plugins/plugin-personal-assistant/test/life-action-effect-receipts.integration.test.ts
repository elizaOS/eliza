/**
 * Real-PGlite proof that the owner life action binds exact callback text to
 * durable definition, goal, occurrence, and deletion outcomes. The production
 * service and repository remain intact; only model rendering uses the standard
 * deterministic test collaborator supplied by the runtime harness.
 */

import type {
  ActionResult,
  AgentRuntime,
  EffectReceipt,
  HandlerCallback,
  Memory,
  UUID,
} from "@elizaos/core";
import {
  attestDeliveryAudienceFromCanonicalRoom,
  executePlannedToolCall,
} from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as taskCreate from "../src/actions/lib/extract-task-plan.js";
import {
  OWNER_OPERATION_TAGS,
  runLifeOperationHandler,
} from "../src/actions/life.js";
import * as appleReminders from "../src/lifeops/apple-reminders.js";
import { materializeDefinitionOccurrences } from "../src/lifeops/engine.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";

let runtimeResult: RealTestRuntimeResult | null = null;
let runtime: AgentRuntime;
let requestSequence = 0;

function extractionPlan(value: Record<string, unknown>) {
  const plan = taskCreate.buildTaskCreatePlan(value);
  if (!plan) throw new Error("Invalid structured extractor fixture");
  return plan;
}

function receipt(result: ActionResult): EffectReceipt {
  expect(result.effectReceipts).toHaveLength(1);
  const value = result.effectReceipts?.[0];
  if (!value) {
    throw new Error("Expected one effect receipt");
  }
  expect(result.userFacingEffectReceiptIds).toEqual([value.receiptId]);
  return value;
}

async function invoke(
  params: Record<string, unknown>,
  text: string,
  internalFailure = false,
  metadata?: Record<string, unknown>,
): Promise<{
  callback: ReturnType<typeof vi.fn<HandlerCallback>>;
  result: ActionResult;
}> {
  requestSequence += 1;
  const callback = vi.fn<HandlerCallback>(async () => []);
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId: crypto.randomUUID() as UUID,
    content: {
      source: "autonomy",
      text,
      requestSequence,
      ...(metadata ? { metadata } : {}),
    },
  } as Memory;
  const result = await runLifeOperationHandler(
    runtime,
    message,
    undefined,
    { parameters: params },
    callback,
  );
  if (internalFailure) {
    expect(result).toMatchObject({
      success: false,
      transcriptVisibility: "internal",
    });
    expect(result.userFacingText).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
  } else {
    expect(callback, JSON.stringify(result)).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]).toEqual({ text: result.text });
  }
  return { callback, result };
}

function recurringDefinitionParams(title: string): Record<string, unknown> {
  return {
    action: "create",
    kind: "definition",
    title,
    intent: `Remind me about ${title}`,
    details: {
      confirmed: true,
      kind: "habit",
      cadence: {
        kind: "times_per_day",
        slots: [
          {
            key: "morning",
            label: "Morning",
            minuteOfDay: 420,
            durationMinutes: 5,
          },
          {
            key: "night",
            label: "Night",
            minuteOfDay: 1320,
            durationMinutes: 5,
          },
        ],
      },
      timeZone: "UTC",
    },
  };
}

beforeAll(async () => {
  runtimeResult = await createLifeOpsTestRuntime();
  runtime = runtimeResult.runtime;
}, 180_000);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await runtimeResult?.cleanup();
  runtimeResult = null;
});

describe("owner life action effect receipts — real PGlite", () => {
  it("delivers strict receipts through the canonical action executor", async () => {
    const callback = vi.fn<HandlerCallback>(async () => []);
    const message = {
      id: crypto.randomUUID() as UUID,
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      // The initialized SELF room supplies canonical owner-private membership.
      roomId: runtime.agentId,
      content: {
        source: "autonomy",
        text: "Create an executor-backed daily receipt task",
      },
    } as Memory;
    await attestDeliveryAudienceFromCanonicalRoom(runtime, message);
    const result = await executePlannedToolCall(
      runtime,
      {
        message,
        callback,
        userRoles: ["OWNER"],
        activeContexts: ["general"],
      },
      {
        name: "OWNER_TODOS",
        params: {
          action: "create",
          intent: "Create an executor-backed daily receipt task",
          title: "Executor receipt task",
          details: {
            confirmed: true,
            kind: "habit",
            cadence: {
              kind: "daily",
              windows: ["morning"],
            },
            timeZone: "UTC",
          },
        },
      },
    );

    expect(result.success, JSON.stringify(result)).toBe(true);
    const applied = receipt(result);
    expect(applied).toMatchObject({
      outcome: "applied",
      operation: "lifeops.definition.create",
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      text: result.text,
      effectReceiptIds: [applied.receiptId],
    });
  }, 120_000);

  it("binds create, update, delete, and duplicate replay to repository truth", async () => {
    expect(OWNER_OPERATION_TAGS).toContain("effect:receipt-required");
    const created = await invoke(
      recurringDefinitionParams("Receipt-backed task"),
      "Remind me about the receipt-backed task",
    );
    expect(created.result.success, JSON.stringify(created.result)).toBe(true);
    const createdReceipt = receipt(created.result);
    expect(createdReceipt).toMatchObject({
      outcome: "applied",
      operation: "lifeops.definition.create",
      resource: {
        kind: "lifeops.definition",
        id: expect.any(String),
        version: expect.any(String),
      },
      commit: {
        kind: "durable",
        id: expect.any(String),
        committedAt: expect.any(String),
      },
      idempotency: { key: expect.any(String), replayed: false },
    });
    const definition = (created.result.data as { definition: { id: string } })
      .definition;

    const updated = await invoke(
      {
        action: "update",
        kind: "definition",
        target: definition.id,
        intent: "Add a durable note",
        details: { description: "Durable receipt note" },
      },
      "Add a durable note to that reminder",
    );
    expect(receipt(updated.result)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.definition.update",
      resource: { id: definition.id },
      commit: { kind: "durable" },
    });

    const duplicate = await invoke(
      recurringDefinitionParams("Receipt-backed task"),
      "Save that same receipt-backed task again",
    );
    expect(receipt(duplicate.result)).toMatchObject({
      outcome: "noop",
      operation: "lifeops.definition.create",
      resource: { id: definition.id },
      idempotency: { key: definition.id, replayed: true },
    });
    expect(duplicate.result.text).toMatch(/already saved|nothing new/i);

    const goalParams = {
      action: "create",
      kind: "goal",
      title: "Receipt replay goal",
      intent: "Track a weekly receipt replay review",
      details: {
        confirmed: true,
        cadence: { kind: "weekly" },
        supportStrategy: { approach: "weekly_review" },
        successCriteria: {
          summary: "Review receipt replay once per week",
          metric: "review_completed",
        },
      },
    };
    const createdGoal = await invoke(
      goalParams,
      "Track a weekly receipt replay review",
    );
    expect(receipt(createdGoal.result)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.goal.create",
      resource: { kind: "lifeops.goal", id: expect.any(String) },
      idempotency: { key: expect.any(String), replayed: false },
    });
    const createdGoalId = (createdGoal.result.data as { goal: { id: string } })
      .goal.id;
    const replayedGoal = await invoke(
      goalParams,
      "Track that same weekly receipt replay review again",
    );
    expect(receipt(replayedGoal.result)).toMatchObject({
      outcome: "noop",
      operation: "lifeops.goal.create",
      resource: { kind: "lifeops.goal", id: createdGoalId },
      idempotency: { key: createdGoalId, replayed: true },
    });
    expect(replayedGoal.result.text).toMatch(/already saved|nothing new/i);

    const deletionSeed = await invoke(
      recurringDefinitionParams("Delete receipt target"),
      "Create a reminder that will be deleted",
    );
    const deletionId = (
      deletionSeed.result.data as { definition: { id: string } }
    ).definition.id;
    const deleted = await invoke(
      {
        action: "delete",
        kind: "definition",
        target: deletionId,
        intent: "Delete the receipt target",
      },
      "Delete the receipt target",
    );
    expect(receipt(deleted.result)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.definition.delete",
      resource: {
        kind: "lifeops.definition",
        id: deletionId,
        version: expect.any(String),
      },
      commit: {
        kind: "durable",
        id: expect.any(String),
        committedAt: expect.any(String),
      },
    });
    const service = new LifeOpsService(runtime);
    await expect(
      service.repository.getDefinition(runtime.agentId, deletionId),
    ).resolves.toBeNull();
  }, 120_000);

  it("binds complete, skip, and snooze to exact persisted occurrence rows", async () => {
    const service = new LifeOpsService(runtime);
    const transitions = [
      { action: "complete", expectedState: "completed" },
      { action: "skip", expectedState: "skipped" },
      { action: "snooze", expectedState: "snoozed" },
    ] as const;

    for (const transition of transitions) {
      const seeded = await invoke(
        recurringDefinitionParams(`Occurrence ${transition.action}`),
        `Create the ${transition.action} occurrence`,
      );
      expect(seeded.result.success, JSON.stringify(seeded.result)).toBe(true);
      const definitionId = (
        seeded.result.data as { definition: { id: string } }
      ).definition.id;
      const occurrences = await service.repository.listOccurrencesForDefinition(
        runtime.agentId,
        definitionId,
      );
      expect(occurrences.length).toBeGreaterThan(0);
      const occurrenceId = occurrences.find(
        (occurrence) =>
          !["completed", "skipped", "expired", "muted"].includes(
            occurrence.state,
          ),
      )?.id;
      if (!occurrenceId) {
        throw new Error("Expected a materialized occurrence");
      }

      const transitioned = await invoke(
        {
          action: transition.action,
          kind: "definition",
          target: occurrenceId,
          intent: `${transition.action} the item`,
          ...(transition.action === "snooze"
            ? { details: { occurrenceId, minutes: 30 } }
            : {}),
        },
        `${transition.action} that item`,
      );
      expect(receipt(transitioned.result)).toMatchObject({
        outcome: "applied",
        operation: `lifeops.occurrence.${transition.expectedState}`,
        resource: {
          kind: "lifeops.occurrence",
          id: occurrenceId,
          version: expect.any(String),
        },
        artifacts: [{ kind: "lifeops.definition", id: definitionId }],
        commit: { kind: "durable", id: expect.any(String) },
      });
      await expect(
        service.repository.getOccurrence(runtime.agentId, occurrenceId),
      ).resolves.toMatchObject({ state: transition.expectedState });

      if (transition.action === "complete") {
        const replayed = await invoke(
          {
            action: "complete",
            kind: "definition",
            target: occurrenceId,
            intent: "Complete that already completed item",
            details: { occurrenceId },
          },
          "Complete that already completed item",
        );
        expect(receipt(replayed.result)).toMatchObject({
          outcome: "noop",
          operation: "lifeops.occurrence.completed",
          resource: { id: occurrenceId },
          idempotency: { key: occurrenceId, replayed: true },
        });
      }
    }
  }, 120_000);

  it("marks goal review as noop and failed preconditions as rejected", async () => {
    const service = new LifeOpsService(runtime);
    const goal = await service.createGoal({
      title: "Receipt review goal",
      description: "Review receipt behavior",
      cadence: { kind: "weekly" },
      supportStrategy: { approach: "weekly_review" },
      successCriteria: {
        summary: "Review once per week",
        metric: "review_completed",
      },
      metadata: { source: "life-action-effect-receipts" },
    });
    const reviewed = await invoke(
      {
        action: "review",
        kind: "goal",
        target: goal.goal.id,
        intent: "Review my receipt goal",
      },
      "Review my receipt goal",
    );
    expect(receipt(reviewed.result)).toMatchObject({
      outcome: "noop",
      operation: "lifeops.owner.review",
      resource: { kind: "lifeops.goal", id: goal.goal.id },
      idempotency: { key: null, replayed: false },
    });

    const failed = await invoke(
      {
        action: "complete",
        kind: "definition",
        target: "missing-occurrence",
        intent: "Complete a missing occurrence",
        details: { occurrenceId: "missing-occurrence" },
      },
      "Complete a missing occurrence",
      true,
    );
    expect(failed.result.effectReceipts).toHaveLength(1);
    expect(failed.result.userFacingEffectReceiptIds).toBeUndefined();
    expect(failed.result.effectReceipts?.[0]).toMatchObject({
      outcome: "failed",
      operation: "lifeops.owner.complete",
      failure: {
        code: "LIFEOPS_SERVICE_ERROR",
        retryable: false,
        acceptance: "rejected",
      },
    });
  }, 120_000);
});

it("anchors an explicit one-shot reminder at its requested due time", async () => {
  const createPlan = {
    mode: "create",
    requestKind: "reminder",
    nativeProjection: "in_app_only",
    notificationMode: "default",
    timeOfDay: null,
    timeZone: null,
    title: "Two-minute notification",
    cadenceKind: "once",
    description: null,
    dueDate: null,
    dueInDays: null,
    dueWeekday: null,
    dueInMinutes: 2,
    multiStep: false,
  };
  vi.spyOn(taskCreate, "extractTaskCreatePlanWithLlm").mockResolvedValue(
    extractionPlan(createPlan),
  );
  const created = await invoke(
    {
      action: "create",
      kind: "definition",
      confirmed: true,
      intent:
        "Remind me in 2 minutes to check the notification with an alert, in-app only",
      createPlan,
    },
    "Remind me in 2 minutes to check the notification with an alert, in-app only",
  );
  expect(created.result.success, JSON.stringify(created.result)).toBe(true);
  const applied = receipt(created.result);
  expect(applied).toMatchObject({
    outcome: "applied",
    operation: "lifeops.definition.create",
    resource: { kind: "lifeops.definition", id: expect.any(String) },
    commit: { kind: "durable", id: expect.any(String) },
  });
  const id = applied.resource.id;
  if (!id) throw new Error("Missing created definition receipt");
  const service = new LifeOpsService(runtime);
  const definition = await service.repository.getDefinition(
    runtime.agentId,
    id,
  );
  if (definition?.cadence.kind !== "once")
    throw new Error("Missing once definition");
  expect(created.result.effectReceipts?.[0]).toMatchObject({
    outcome: "applied",
    operation: "lifeops.definition.create",
    resource: { id: definition.id },
    commit: { kind: "durable" },
  });
  expect(definition.metadata.nativeProjection).toBe("in_app_only");
  const occurrence = materializeDefinitionOccurrences(definition, [])[0];
  expect(occurrence.relevanceStartAt).toBe(definition.cadence.dueAt);
  const schedule = service.remindersDomain.buildReminderPlanSchedule({
    ownerType: "occurrence",
    ownerId: occurrence.id,
    occurrenceId: occurrence.id,
    title: definition.title,
    occurrence,
    plan: { steps: [{ channel: "in_app", offsetMinutes: 0 }] } as never,
  });
  expect(schedule[0].scheduledFor).toBe(definition.cadence.dueAt);
  const explicit = materializeDefinitionOccurrences(
    {
      ...definition,
      cadence: { ...definition.cadence, visibilityLeadMinutes: 7 },
    },
    [],
  )[0];
  const offsetSchedule = service.remindersDomain.buildReminderPlanSchedule({
    ownerType: "occurrence",
    ownerId: explicit.id,
    occurrenceId: explicit.id,
    title: definition.title,
    occurrence: explicit,
    plan: { steps: [{ channel: "in_app", offsetMinutes: 3 }] } as never,
  });
  expect(Date.parse(offsetSchedule[0].scheduledFor)).toBe(
    Date.parse(definition.cadence.dueAt) - 4 * 60_000,
  );
  const generic = materializeDefinitionOccurrences(
    {
      ...definition,
      cadence: { kind: "once", dueAt: definition.cadence.dueAt },
    },
    [],
  )[0];
  expect(Date.parse(generic.relevanceStartAt)).toBe(
    Date.parse(definition.cadence.dueAt) - 15 * 60_000,
  );
}, 120000);

it.each([
  { requestKind: "alarm", ownerSurface: "OWNER_TODOS", minutesEarly: 0 },
  {
    requestKind: "unspecified",
    ownerSurface: "OWNER_REMINDERS",
    minutesEarly: 0,
  },
  { requestKind: "unspecified", ownerSurface: "OWNER_TODOS", minutesEarly: 15 },
])(
  "anchors a one-shot $requestKind on $ownerSurface with its expected lead",
  async ({ requestKind, ownerSurface, minutesEarly }) => {
    const intent =
      requestKind === "alarm"
        ? "Set an alarm for 2 minutes from now"
        : ownerSurface === "OWNER_REMINDERS"
          ? "Add check the notification as a task due in 2 minutes and notify me then"
          : "Add check the notification as a task due in 2 minutes";
    if (ownerSurface === "OWNER_REMINDERS" || requestKind === "alarm") {
      vi.spyOn(taskCreate, "extractTaskCreatePlanWithLlm").mockResolvedValue(
        extractionPlan({
          mode: "create",
          requestKind: requestKind === "alarm" ? "alarm" : "reminder",
          notificationMode: "default",
          nativeProjection: "in_app_only",
          title: `${ownerSurface} two-minute ${requestKind}`,
          cadenceKind: "once",
          dueInMinutes: 2,
          multiStep: false,
        }),
      );
    }
    const created = await invoke(
      {
        action: "create",
        ownerSurface,
        kind: "definition",
        confirmed: true,
        intent,
        createPlan: {
          mode: "create",
          requestKind,
          nativeProjection: "in_app_only",
          notificationMode: "default",
          timeOfDay: null,
          timeZone: null,
          title: `${ownerSurface} two-minute ${requestKind}`,
          cadenceKind: "once",
          description: null,
          dueDate: null,
          dueInDays: null,
          dueWeekday: null,
          dueInMinutes: 2,
          multiStep: false,
        },
      },
      intent,
    );
    expect(created.result.success, JSON.stringify(created.result)).toBe(true);
    const applied = receipt(created.result);
    expect(applied).toMatchObject({
      outcome: "applied",
      operation: "lifeops.definition.create",
      resource: { kind: "lifeops.definition", id: expect.any(String) },
      commit: { kind: "durable", id: expect.any(String) },
    });
    const id = applied.resource.id;
    if (!id) throw new Error("Missing created definition receipt");
    const service = new LifeOpsService(runtime);
    const definition = await service.repository.getDefinition(
      runtime.agentId,
      id,
    );
    if (definition?.cadence.kind !== "once")
      throw new Error("Missing once definition");
    const occurrence = materializeDefinitionOccurrences(definition, [])[0];
    const schedule = service.remindersDomain.buildReminderPlanSchedule({
      ownerType: "occurrence",
      ownerId: occurrence.id,
      occurrenceId: occurrence.id,
      title: definition.title,
      occurrence,
      plan: { steps: [{ channel: "in_app", offsetMinutes: 0 }] } as never,
    });
    expect(Date.parse(schedule[0].scheduledFor)).toBe(
      Date.parse(definition.cadence.dueAt) - minutesEarly * 60_000,
    );
    const explicit = materializeDefinitionOccurrences(
      {
        ...definition,
        cadence: { ...definition.cadence, visibilityLeadMinutes: 7 },
      },
      [],
    )[0];
    const explicitSchedule = service.remindersDomain.buildReminderPlanSchedule({
      ownerType: "occurrence",
      ownerId: explicit.id,
      occurrenceId: explicit.id,
      title: definition.title,
      occurrence: explicit,
      plan: { steps: [{ channel: "in_app", offsetMinutes: 0 }] } as never,
    });
    expect(Date.parse(explicitSchedule[0].scheduledFor)).toBe(
      Date.parse(definition.cadence.dueAt) - 7 * 60_000,
    );
  },
  120000,
);

it("persists an explicit in-app-only reminder without native projection", async () => {
  const createPlan = {
    mode: "create",
    requestKind: "reminder",
    nativeProjection: "in_app_only",
    notificationMode: "default",
    timeOfDay: null,
    timeZone: null,
    title: "In-app only QA",
    cadenceKind: "once",
    description: null,
    dueDate: null,
    dueInDays: null,
    dueWeekday: null,
    dueInMinutes: 2,
    multiStep: false,
  };
  vi.spyOn(taskCreate, "extractTaskCreatePlanWithLlm").mockResolvedValue(
    extractionPlan(createPlan),
  );
  const native = vi.spyOn(appleReminders, "createNativeAppleReminderLikeItem");
  try {
    const created = await invoke(
      {
        action: "create",
        kind: "definition",
        confirmed: true,
        details: {
          metadata: {
            nativeAppleReminder: {
              kind: "reminder",
              provider: "apple_reminders",
              source: "llm",
            },
          },
        },
        intent: "Remind me in 2 minutes with an alert, in-app only",
        createPlan,
      },
      "Remind me in 2 minutes with an alert, in-app only",
    );
    expect(created.result.success, JSON.stringify(created.result)).toBe(true);
    const applied = receipt(created.result);
    expect(applied).toMatchObject({
      outcome: "applied",
      operation: "lifeops.definition.create",
      resource: { kind: "lifeops.definition", id: expect.any(String) },
      commit: { kind: "durable", id: expect.any(String) },
    });
    const id = applied.resource.id;
    if (!id) throw Error("Missing receipt");
    const definition = await new LifeOpsService(
      runtime,
    ).repository.getDefinition(runtime.agentId, id);
    expect(definition?.metadata?.nativeAppleReminder).toBeUndefined();
    expect(definition?.metadata?.nativeProjection).toBe("in_app_only");
    expect(definition?.reminderPlanId).toBeTruthy();
    expect(native).not.toHaveBeenCalled();
  } finally {
    native.mockRestore();
  }
}, 120000);
it("does not create a timed reminder when destination recovery has no usable plan", async () => {
  const service = new LifeOpsService(runtime, {
    ownerEntityId: runtime.agentId,
  });
  const before = (await service.listDefinitions())
    .map((record) => record.definition.id)
    .sort();
  const extraction = vi.spyOn(taskCreate, "extractTaskCreatePlanWithLlm");
  const native = vi
    .spyOn(appleReminders, "createNativeAppleReminderLikeItem")
    .mockResolvedValue({
      ok: false,
      reason: "unsupported",
      message: "test native boundary",
    } as never);
  try {
    const created = await invoke(
      {
        action: "create",
        kind: "definition",
        confirmed: true,
        intent: "Remind me in 2 minutes to check the unknown destination",
        createPlan: {
          mode: "create",
          requestKind: "reminder",
          title: "Unknown destination QA",
          cadenceKind: "once",
          description: null,
          dueDate: null,
          dueInDays: null,
          dueWeekday: null,
          dueInMinutes: 2,
          multiStep: false,
        },
      },
      "Remind me in 2 minutes to check the unknown destination",
    );
    expect(extraction).toHaveBeenCalledOnce();
    expect(extraction.mock.calls[0]?.[0].intent).toContain(
      "check the unknown destination",
    );
    expect(created.result.data).toMatchObject({
      noop: true,
      awaitingUserInput: true,
    });
    expect(created.result.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
    });
    expect(
      (await service.listDefinitions())
        .map((record) => record.definition.id)
        .sort(),
    ).toEqual(before);
    expect(native).not.toHaveBeenCalled();
  } finally {
    extraction.mockRestore();
    native.mockRestore();
  }
}, 120000);

it.each([undefined, "apple_reminders"])(
  "keeps unresolved destinations effect-free and preserves explicit Apple preference %s",
  async (nativeProjection) => {
    const native = vi
      .spyOn(appleReminders, "createNativeAppleReminderLikeItem")
      .mockResolvedValue({
        ok: false,
        reason: "unsupported",
        message: "test native boundary",
      } as never);
    const createPlan = {
      mode: "create",
      requestKind: "reminder",
      notificationMode: "default",
      timeOfDay: null,
      timeZone: null,
      ...(nativeProjection ? { nativeProjection } : {}),
      title: `Native projection ${nativeProjection ?? "legacy"}`,
      cadenceKind: "once",
      description: null,
      dueDate: null,
      dueInDays: null,
      dueWeekday: null,
      dueInMinutes: 2,
      multiStep: false,
    };
    const extracted = taskCreate.buildTaskCreatePlan(
      nativeProjection
        ? createPlan
        : {
            mode: "respond",
            requestKind: "reminder",
            nativeProjection: null,
            notificationMode: null,
            multiStep: false,
            response: "Which app should keep this reminder?",
          },
    );
    if (!extracted) throw new Error("Invalid structured extractor fixture");
    // Unknown native destination requires extraction; the generic runtime
    // fixture returns dispatch prose, not a structured task-create plan.
    const extraction = vi
      .spyOn(taskCreate, "extractTaskCreatePlanWithLlm")
      .mockResolvedValue(extracted);
    const service = new LifeOpsService(runtime, {
      ownerEntityId: runtime.agentId,
    });
    const before = (await service.listDefinitions())
      .map((record) => record.definition.id)
      .sort();
    const intent = nativeProjection
      ? "Remind me in 2 minutes in Apple Reminders with an alert"
      : "Remind me in 2 minutes with an alert";
    try {
      const created = await invoke(
        {
          action: "create",
          kind: "definition",
          confirmed: true,
          intent,
          ...(nativeProjection
            ? { details: { metadata: { nativeProjection: "in_app_only" } } }
            : {}),
          createPlan,
        },
        intent,
      );
      if (!nativeProjection) {
        // This fixture supplies no prior Apple preference; keep an unknown destination a question.
        expect(created.result.data).toMatchObject({
          noop: true,
          awaitingUserInput: true,
        });
        expect(receipt(created.result)).toMatchObject({ outcome: "noop" });
        expect(
          (await service.listDefinitions())
            .map((record) => record.definition.id)
            .sort(),
        ).toEqual(before);
        expect(native).not.toHaveBeenCalled();
        expect(extraction).toHaveBeenCalledOnce();
        expect(extraction.mock.calls[0]?.[0].intent).toBe(intent);
        return;
      }
      expect(created.result.success).toBe(true);
      const applied = receipt(created.result);
      expect(applied).toMatchObject({
        outcome: "applied",
        operation: "lifeops.definition.create",
        resource: { kind: "lifeops.definition", id: expect.any(String) },
        commit: { kind: "durable", id: expect.any(String) },
      });
      const id = applied.resource.id;
      if (!id) throw Error("Missing receipt");
      const definition = await service.repository.getDefinition(
        runtime.agentId,
        id,
      );
      expect(created.result.effectReceipts?.[0]).toMatchObject({
        outcome: "applied",
        operation: "lifeops.definition.create",
        resource: { id },
        commit: { kind: "durable" },
      });
      expect((await service.listDefinitions()).length).toBe(before.length + 1);
      expect(definition?.cadence.kind).toBe("once");
      expect(definition?.metadata?.nativeAppleReminder).toMatchObject({
        provider: "apple_reminders",
        kind: "reminder",
      });
      expect(definition?.metadata?.nativeProjection).toBe(nativeProjection);
      expect(native).toHaveBeenCalledOnce();
      expect(extraction).toHaveBeenCalledOnce();
      if (!nativeProjection)
        expect(extraction.mock.calls[0]?.[0].intent).toBe(intent);
    } finally {
      extraction.mockRestore();
      native.mockRestore();
    }
  },
  120000,
);

it("keeps an unresolved reminder alert choice effect-free instead of treating a due time as an alert", async () => {
  const service = new LifeOpsService(runtime, {
    ownerEntityId: runtime.agentId,
  });
  const before = (await service.listDefinitions())
    .map((record) => record.definition.id)
    .sort();
  const native = vi.spyOn(appleReminders, "createNativeAppleReminderLikeItem");
  try {
    const intent = "Add check the notification as a task due in 2 minutes";
    vi.spyOn(taskCreate, "extractTaskCreatePlanWithLlm").mockResolvedValue(
      extractionPlan({
        mode: "create",
        requestKind: "reminder",
        notificationMode: null,
        nativeProjection: "in_app_only",
        title: "Unresolved alert choice",
        cadenceKind: "once",
        dueInMinutes: 2,
        multiStep: false,
      }),
    );
    const created = await invoke(
      {
        action: "create",
        ownerSurface: "OWNER_REMINDERS",
        kind: "definition",
        confirmed: true,
        intent,
        createPlan: {
          mode: "create",
          requestKind: "unspecified",
          notificationMode: null,
          nativeProjection: "in_app_only",
          title: "Unresolved alert choice",
          cadenceKind: "once",
          description: null,
          dueDate: null,
          dueInDays: null,
          dueWeekday: null,
          dueInMinutes: 2,
          timeOfDay: null,
          timeZone: null,
          multiStep: false,
        },
      },
      intent,
    );
    expect(created.result.success).toBe(false);
    expect(created.result.data).toMatchObject({
      error: "REMINDER_ALERT_PREFERENCE_UNRESOLVED",
      awaitingUserInput: true,
    });
    expect(receipt(created.result)).toMatchObject({
      outcome: "failed",
      failure: {
        code: "REMINDER_ALERT_PREFERENCE_UNRESOLVED",
        acceptance: "rejected",
      },
    });
    expect(
      (await service.listDefinitions())
        .map((record) => record.definition.id)
        .sort(),
    ).toEqual(before);
    expect(native).not.toHaveBeenCalled();
  } finally {
    native.mockRestore();
  }
}, 120000);

it.each(["OWNER_REMINDERS", "OWNER_TODOS"])(
  "rejects a planner-supplied reminder for a Calendar-only owner request on %s",
  async (ownerSurface) => {
    const service = new LifeOpsService(runtime, {
      ownerEntityId: runtime.agentId,
    });
    const before = (await service.listDefinitions())
      .map((record) => record.definition.id)
      .sort();
    const ownerText =
      'Create "Calendar only" tomorrow from 5:43 PM to 5:48 PM in my Calendar. No guests or reminders.';
    const extraction = vi
      .spyOn(taskCreate, "extractTaskCreatePlanWithLlm")
      .mockResolvedValue(
        extractionPlan({
          mode: "respond",
          requestKind: null,
          response: "Use Calendar for this event.",
          multiStep: false,
        }),
      );
    try {
      const rejected = await invoke(
        {
          action: "create",
          ownerSurface,
          kind: "definition",
          confirmed: true,
          title: "Calendar only",
          intent: "Remind me about Calendar only",
          createPlan: {
            mode: "create",
            requestKind: "reminder",
            nativeProjection: "in_app_only",
            notificationMode: "default",
            title: "Calendar only",
            description: null,
            cadenceKind: "once",
            dueInMinutes: 2,
            multiStep: false,
          },
        },
        ownerText,
      );
      expect(extraction).toHaveBeenCalledOnce();
      expect(extraction.mock.calls[0]?.[0].intent).toBe(ownerText);
      expect(rejected.result.success).toBe(false);
      expect(rejected.result.data).toMatchObject({
        error: "OWNER_REMINDER_INTENT_MISMATCH",
        coachingFailure: true,
      });
      expect(
        (await service.listDefinitions())
          .map((record) => record.definition.id)
          .sort(),
      ).toEqual(before);
      expect(
        rejected.result.effectReceipts?.some(
          (value) => value.outcome === "applied",
        ),
      ).not.toBe(true);
    } finally {
      extraction.mockRestore();
    }
  },
  120000,
);

it.each([
  "Remind me in 2 minutes to check the notification in this app with an alert",
  "Recuérdame revisar la notificación en esta app dentro de 2 minutos",
])(
  "keeps an explicit reminder actionable after checking its owner request: %s",
  async (ownerText) => {
    const createPlan = {
      mode: "create",
      requestKind: "reminder",
      nativeProjection: "in_app_only",
      notificationMode: "default",
      title: "Explicit reminder",
      cadenceKind: "once",
      dueInMinutes: 2,
      multiStep: false,
    };
    const extraction = vi
      .spyOn(taskCreate, "extractTaskCreatePlanWithLlm")
      .mockResolvedValue(extractionPlan(createPlan));
    try {
      const created = await invoke(
        {
          action: "create",
          ownerSurface: "OWNER_REMINDERS",
          kind: "definition",
          confirmed: true,
          intent: ownerText,
          createPlan,
        },
        ownerText,
      );
      expect(extraction).toHaveBeenCalledOnce();
      expect(created.result.success, JSON.stringify(created.result)).toBe(true);
      const applied = receipt(created.result);
      expect(applied.outcome).toBe("applied");
      const service = new LifeOpsService(runtime, {
        ownerEntityId: runtime.agentId,
      });
      const id = applied.resource.id;
      if (!id) throw new Error("Missing created reminder receipt");
      const definition = await service.repository.getDefinition(
        runtime.agentId,
        id,
      );
      expect(definition?.title).toBe("Explicit reminder");
      expect(definition?.metadata.ownerSurface).toBe("OWNER_REMINDERS");
    } finally {
      extraction.mockRestore();
    }
  },
  120000,
);

it("retains the supplied reminder clock after independent intent verification", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
  const createPlan = {
    mode: "create",
    requestKind: "reminder",
    nativeProjection: "in_app_only",
    notificationMode: "none",
    title: "Verified local reminder clock",
    description: "check the release",
    cadenceKind: "once",
    dueDate: "2026-11-12",
    timeOfDay: "19:20",
    timeZone: "America/Los_Angeles",
    multiStep: false,
  };
  vi.spyOn(taskCreate, "extractTaskCreatePlanWithLlm").mockResolvedValue(
    extractionPlan({
      ...createPlan,
      timeZone: "UTC",
      nativeProjection: "apple_reminders",
      notificationMode: "default",
    }),
  );
  const created = await invoke(
    {
      action: "create",
      ownerSurface: "OWNER_REMINDERS",
      kind: "definition",
      confirmed: true,
      createPlan,
    },
    "Remind me on November 12 at 7:20 PM local time to check the release in this app without alerts.",
  );
  expect(created.result.success, JSON.stringify(created.result)).toBe(true);
  const id = receipt(created.result).resource.id;
  if (!id) throw new Error("Missing reminder receipt");
  const definition = await new LifeOpsService(runtime).repository.getDefinition(
    runtime.agentId,
    id,
  );
  expect(definition?.timezone).toBe("America/Los_Angeles");
  expect(definition?.cadence).toMatchObject({
    kind: "once",
    dueAt: "2026-11-13T03:20:00.000Z",
  });
  expect(definition?.reminderPlanId).toBeNull();
  expect(definition?.metadata.nativeProjection).toBe("in_app_only");
});

it("uses the current client clock when a reminder plan needs extraction", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
  const extraction = vi
    .spyOn(taskCreate, "extractTaskCreatePlanWithLlm")
    .mockResolvedValue(
      extractionPlan({
        mode: "create",
        requestKind: "reminder",
        nativeProjection: "in_app_only",
        notificationMode: "none",
        title: "Current client reminder clock",
        description: null,
        cadenceKind: "once",
        dueDate: "2026-11-12",
        timeOfDay: "19:20",
        timeZone: null,
        multiStep: false,
      }),
    );
  const created = await invoke(
    {
      action: "create",
      ownerSurface: "OWNER_REMINDERS",
      kind: "definition",
      confirmed: true,
    },
    "Remind me on November 12 at 7:20 PM local time in this app without an alert.",
    false,
    { uiTimeZone: "America/Los_Angeles" },
  );
  expect(extraction.mock.calls[0]?.[0].timeZone).toBe("America/Los_Angeles");
  expect(created.result.success, JSON.stringify(created.result)).toBe(true);
  const id = receipt(created.result).resource.id;
  if (!id) throw new Error("Missing reminder receipt");
  const definition = await new LifeOpsService(runtime).repository.getDefinition(
    runtime.agentId,
    id,
  );
  expect(definition?.timezone).toBe("America/Los_Angeles");
  expect(definition?.cadence).toMatchObject({
    kind: "once",
    dueAt: "2026-11-13T03:20:00.000Z",
  });
});

it.each(["destination", "alert", "destination and alert"])(
  "recovers unresolved %s from verification while retaining supplied reminder timing",
  async (unresolved) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
    const createPlan = {
      mode: "create",
      requestKind: "unspecified",
      nativeProjection: unresolved.includes("destination")
        ? null
        : "in_app_only",
      notificationMode: unresolved.includes("alert") ? null : "default",
      title: `Recovered reminder ${unresolved}`,
      description: null,
      cadenceKind: "once",
      dueDate: "2026-11-12",
      timeOfDay: "19:20",
      timeZone: "America/Los_Angeles",
      multiStep: false,
    };
    const extraction = vi
      .spyOn(taskCreate, "extractTaskCreatePlanWithLlm")
      .mockResolvedValue(
        extractionPlan({
          ...createPlan,
          requestKind: "reminder",
          nativeProjection: "in_app_only",
          notificationMode: "default",
          timeZone: "UTC",
        }),
      );
    const native = vi
      .spyOn(appleReminders, "createNativeAppleReminderLikeItem")
      .mockResolvedValue({
        ok: false,
        reason: "unsupported",
        message: "test native boundary",
      } as never);
    const ownerText =
      "Remind me on November 12 at 7:20 PM local time to check the release in this app with an alert.";
    const created = await invoke(
      {
        action: "create",
        ownerSurface: "OWNER_REMINDERS",
        kind: "definition",
        confirmed: true,
        createPlan,
      },
      ownerText,
    );
    expect(created.result.success, JSON.stringify(created.result)).toBe(true);
    expect(extraction).toHaveBeenCalledOnce();
    expect(extraction.mock.calls[0]?.[0].intent).toBe(ownerText);
    const id = receipt(created.result).resource.id;
    if (!id) throw new Error("Missing recovered reminder receipt");
    const definition = await new LifeOpsService(
      runtime,
    ).repository.getDefinition(runtime.agentId, id);
    expect(definition?.metadata.nativeProjection).toBe("in_app_only");
    expect(definition?.reminderPlanId).toBeTruthy();
    expect(definition?.timezone).toBe("America/Los_Angeles");
    expect(definition?.cadence).toMatchObject({
      kind: "once",
      dueAt: "2026-11-13T03:20:00.000Z",
    });
    expect(native).not.toHaveBeenCalled();
  },
  120000,
);
