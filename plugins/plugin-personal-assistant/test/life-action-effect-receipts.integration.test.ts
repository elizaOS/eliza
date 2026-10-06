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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    expect(callback).toHaveBeenCalledOnce();
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
  const created = await invoke(
    {
      action: "create",
      kind: "definition",
      confirmed: true,
      intent: "Remind me in 2 minutes to check the notification, in-app only",
      createPlan: {
        mode: "create",
        requestKind: "reminder",
        nativeProjection: "in_app_only",
        title: "Two-minute notification",
        cadenceKind: "once",
        dueInMinutes: 2,
        multiStep: false,
      },
    },
    "Remind me in 2 minutes to check the notification, in-app only",
  );
  expect(created.result.success, JSON.stringify(created.result)).toBe(true);
  const id = created.result.effectReceipts?.[0]?.resource.id;
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
        : "Add check the notification as a task due in 2 minutes";
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
          title: `${ownerSurface} two-minute ${requestKind}`,
          cadenceKind: "once",
          dueInMinutes: 2,
          multiStep: false,
        },
      },
      intent,
    );
    expect(created.result.success, JSON.stringify(created.result)).toBe(true);
    const id = created.result.effectReceipts?.[0]?.resource.id;
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
        intent: "Remind me in 2 minutes, in-app only",
        createPlan: {
          mode: "create",
          requestKind: "reminder",
          nativeProjection: "in_app_only",
          title: "In-app only QA",
          cadenceKind: "once",
          dueInMinutes: 2,
          multiStep: false,
        },
      },
      "Remind me in 2 minutes, in-app only",
    );
    expect(created.result.success, JSON.stringify(created.result)).toBe(true);
    const id = created.result.effectReceipts?.[0]?.resource.id;
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
  "preserves native projection after recovered legacy/explicit Apple preference %s",
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
      ...(nativeProjection ? { nativeProjection } : {}),
      title: `Native projection ${nativeProjection ?? "legacy"}`,
      cadenceKind: "once",
      dueInMinutes: 2,
      multiStep: false,
    };
    const extracted = taskCreate.buildTaskCreatePlan(createPlan);
    if (!extracted) throw new Error("Invalid structured extractor fixture");
    // Unknown native destination requires extraction; the generic runtime
    // fixture returns dispatch prose, not a structured task-create plan.
    const extraction = vi
      .spyOn(taskCreate, "extractTaskCreatePlanWithLlm")
      .mockResolvedValue(extracted);
    const service = new LifeOpsService(runtime, {
      ownerEntityId: runtime.agentId,
    });
    const before = (await service.listDefinitions()).length;
    const intent = nativeProjection
      ? "Remind me in 2 minutes in Apple Reminders"
      : "Remind me in 2 minutes";
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
      expect(created.result.success).toBe(true);
      const id = created.result.effectReceipts?.[0]?.resource.id;
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
      expect((await service.listDefinitions()).length).toBe(before + 1);
      expect(definition?.cadence.kind).toBe("once");
      expect(definition?.metadata?.nativeAppleReminder).toMatchObject({
        provider: "apple_reminders",
        kind: "reminder",
      });
      expect(definition?.metadata?.nativeProjection).toBe(nativeProjection);
      expect(native).toHaveBeenCalledOnce();
      expect(extraction).toHaveBeenCalledTimes(nativeProjection ? 0 : 1);
      if (!nativeProjection)
        expect(extraction.mock.calls[0]?.[0].intent).toBe(intent);
    } finally {
      extraction.mockRestore();
      native.mockRestore();
    }
  },
  120000,
);
