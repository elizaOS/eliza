/**
 * Proves owner approval settlement against the real PGlite queue and workflow
 * ledger. Calls enter through the canonical executor so callback delivery,
 * replay suppression, authorization, and failed execution receipts are tested
 * at the same boundary production uses.
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
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import type {
  ApprovalEnqueueInput,
  ApprovalQueue,
} from "../src/lifeops/approval-queue.types.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";

let runtimeResult: RealTestRuntimeResult | null = null;
let runtime: AgentRuntime;
let queue: ApprovalQueue;

function receipt(result: ActionResult): EffectReceipt {
  expect(result.effectReceipts).toHaveLength(1);
  const value = result.effectReceipts?.[0];
  if (!value) throw new Error("expected one effect receipt");
  expect(result.userFacingEffectReceiptIds).toEqual([value.receiptId]);
  return value;
}

function approvalInput(
  input: Pick<ApprovalEnqueueInput, "action" | "payload"> &
    Partial<ApprovalEnqueueInput>,
): ApprovalEnqueueInput {
  return {
    requestedBy: "agent:lifeops",
    subjectUserId: String(runtime.agentId),
    channel: "internal",
    reason: "owner confirmation is required",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    idempotencyKey: `approval-receipt-${crypto.randomUUID()}`,
    ...input,
  };
}

async function invoke(
  action: "approve" | "reject",
  requestId: string,
): Promise<{
  callback: ReturnType<typeof vi.fn<HandlerCallback>>;
  result: ActionResult;
}> {
  const callback = vi.fn<HandlerCallback>(async () => []);
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId: crypto.randomUUID() as UUID,
    content: {
      source: "test",
      text: `${action} ${requestId}`,
    },
    createdAt: Date.now(),
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
      name: "RESOLVE_REQUEST",
      params: { action, requestId, reason: `test ${action}` },
    },
  );
  expect(callback).toHaveBeenCalledOnce();
  return { callback, result };
}

beforeAll(async () => {
  runtimeResult = await createLifeOpsTestRuntime();
  runtime = runtimeResult.runtime;
  queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
}, 180_000);

afterAll(async () => {
  await runtimeResult?.cleanup();
  runtimeResult = null;
});

describe("RESOLVE_REQUEST effect receipts — real PGlite", () => {
  it("executes an approved workflow once and suppresses a completed replay", async () => {
    const service = new LifeOpsService(runtime);
    const workflow = await service.createWorkflow({
      title: "Approval receipt workflow",
      triggerType: "manual",
      schedule: { kind: "manual" },
      actionPlan: {
        steps: [
          {
            kind: "summarize",
            prompt: "Record that the approved workflow ran.",
          },
        ],
      },
      metadata: { test: "resolve-request-effect-receipts" },
    });
    const request = await queue.enqueue(
      approvalInput({
        action: "execute_workflow",
        payload: {
          action: "execute_workflow",
          workflowId: workflow.definition.id,
          input: {},
        },
      }),
    );

    const applied = await invoke("approve", request.id);
    expect(applied.result.success).toBe(true);
    const appliedReceipt = receipt(applied.result);
    expect(appliedReceipt).toMatchObject({
      outcome: "applied",
      operation: "lifeops.approval.approve",
      resource: { kind: "lifeops.approval_request", id: request.id },
      commit: { kind: "durable", id: expect.any(String) },
      artifacts: [{ kind: "lifeops.workflow_run", id: expect.any(String) }],
    });
    expect(applied.callback.mock.calls[0]?.[0]).toMatchObject({
      text: applied.result.text,
      effectReceiptIds: [appliedReceipt.receiptId],
    });
    expect(await queue.byId(request.id)).toMatchObject({ state: "done" });
    expect(
      (await service.getWorkflow(workflow.definition.id)).runs,
    ).toHaveLength(1);

    const replay = await invoke("approve", request.id);
    expect(replay.result.success).toBe(true);
    expect(receipt(replay.result)).toMatchObject({
      outcome: "noop",
      operation: "lifeops.approval.approve",
      resource: { id: request.id },
      idempotency: { replayed: true },
    });
    expect(
      (await service.getWorkflow(workflow.definition.id)).runs,
    ).toHaveLength(1);
  }, 120_000);

  it("persists rejection and reports an exact noop on replay", async () => {
    const request = await queue.enqueue(
      approvalInput({
        action: "spend_money",
        payload: {
          action: "spend_money",
          vendor: "Example vendor",
          amountCents: 2500,
          currency: "USD",
          memo: "receipt rejection proof",
        },
      }),
    );

    const rejected = await invoke("reject", request.id);
    expect(rejected.result.success).toBe(true);
    expect(receipt(rejected.result)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.approval.reject",
      resource: { id: request.id },
      commit: { kind: "durable", id: expect.any(String) },
    });
    expect(await queue.byId(request.id)).toMatchObject({ state: "rejected" });

    const replay = await invoke("reject", request.id);
    expect(replay.result.success).toBe(true);
    expect(receipt(replay.result)).toMatchObject({
      outcome: "noop",
      operation: "lifeops.approval.reject",
      idempotency: { replayed: true },
    });
    expect(await queue.byId(request.id)).toMatchObject({ state: "rejected" });
  }, 120_000);

  it("keeps a pre-dispatch failure retryable from its persisted approval", async () => {
    const request = await queue.enqueue(
      approvalInput({
        action: "spend_money",
        payload: {
          action: "spend_money",
          vendor: "Unavailable rail vendor",
          amountCents: 4200,
          currency: "USD",
          memo: "prove approved-state retry",
        },
      }),
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await invoke("approve", request.id);
      expect(failed.result.success).toBe(false);
      expect(failed.result.data).toMatchObject({
        error: "SPEND_RAIL_UNAVAILABLE",
        requestId: request.id,
        state: "approved",
        spent: false,
        executed: false,
      });
      expect(receipt(failed.result)).toMatchObject({
        outcome: "failed",
        operation: "lifeops.approval.approve",
        failure: {
          code: "SPEND_RAIL_UNAVAILABLE",
          acceptance: "rejected",
        },
      });
      expect(await queue.byId(request.id)).toMatchObject({ state: "approved" });
    }
  }, 120_000);

  it("fails closed when an owner targets another subject's request", async () => {
    const request = await queue.enqueue(
      approvalInput({
        subjectUserId: "another-owner",
        action: "spend_money",
        payload: {
          action: "spend_money",
          vendor: "Forbidden vendor",
          amountCents: 100,
          currency: "USD",
          memo: "must remain pending",
        },
      }),
    );

    const denied = await invoke("reject", request.id);
    expect(denied.result.success).toBe(false);
    expect(denied.result.data).toMatchObject({
      error: "CROSS_SUBJECT_APPROVAL_FORBIDDEN",
    });
    expect(receipt(denied.result)).toMatchObject({
      outcome: "failed",
      operation: "lifeops.approval.reject",
      resource: { id: request.id },
      failure: { code: "CROSS_SUBJECT_APPROVAL_FORBIDDEN" },
    });
    expect(await queue.byId(request.id)).toMatchObject({ state: "pending" });
  }, 120_000);
});
