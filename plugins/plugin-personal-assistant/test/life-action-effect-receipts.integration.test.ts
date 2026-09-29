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
import { executePlannedToolCall } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  expect(callback).toHaveBeenCalledOnce();
  expect(callback.mock.calls[0]?.[0]).toEqual({ text: result.text });
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
      roomId: crypto.randomUUID() as UUID,
      content: {
        source: "autonomy",
        text: "Create an executor-backed daily receipt task",
      },
    } as Memory;
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
    );
    expect(failed.result.success).toBe(false);
    expect(receipt(failed.result)).toMatchObject({
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
      intent: "Remind me in 2 minutes to check the notification",
      createPlan: {
        mode: "create",
        requestKind: "reminder",
        title: "Two-minute notification",
        cadenceKind: "once",
        dueInMinutes: 2,
        multiStep: false,
      },
    },
    "Remind me in 2 minutes to check the notification",
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
it.each([undefined, "apple_reminders"])(
  "preserves native projection for legacy/Apple preference %s",
  async (nativeProjection) => {
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
          intent: "Remind me in 2 minutes",
          createPlan: {
            mode: "create",
            requestKind: "reminder",
            ...(nativeProjection ? { nativeProjection } : {}),
            title: `Native projection ${nativeProjection ?? "legacy"}`,
            cadenceKind: "once",
            dueInMinutes: 2,
            multiStep: false,
          },
        },
        "Remind me in 2 minutes",
      );
      expect(created.result.success).toBe(true);
      const id = created.result.effectReceipts?.[0]?.resource.id;
      if (!id) throw Error("Missing receipt");
      const definition = await new LifeOpsService(
        runtime,
      ).repository.getDefinition(runtime.agentId, id);
      expect(definition?.metadata?.nativeAppleReminder).toMatchObject({
        provider: "apple_reminders",
        kind: "reminder",
      });
      expect(native).toHaveBeenCalledOnce();
    } finally {
      native.mockRestore();
    }
  },
  120000,
);
