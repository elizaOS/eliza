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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  OWNER_OPERATION_TAGS,
  runLifeOperationHandler,
} from "../src/actions/life.js";
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
      idempotency: { key: null, replayed: false },
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
          occurrence.state === "visible" || occurrence.state === "snoozed",
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
        code: "LIFEOPS_OPERATION_REJECTED",
        retryable: false,
        acceptance: "rejected",
      },
    });
  }, 120_000);
});
