import { type EffectReceipt, normalizeEffectReceipt } from "@elizaos/core";
import type { ApprovalEnqueueResult } from "../approval/types.ts";
import { type DeviceOperation, validateDevicePayload } from "./contract.ts";

/** Only call after authenticated proposal lookup and operation-result validation.
 * Proof refers to persisted queue/native operation identities, never payload text. */
export function deviceActionEffectReceipts(
  outcome: ApprovalEnqueueResult,
): EffectReceipt[] {
  const { request, reused } = outcome;
  const operation = validateDevicePayload(request.payload).operation;
  const observedAt = new Date().toISOString();
  const base = {
    receiptId: request.id,
    operation: "device.approval.create",
    resource: { kind: "device.approval", id: request.id },
    artifacts: [],
    idempotency: { key: request.idempotencyKey, replayed: reused },
    observedAt,
  };
  if (request.state === "pending" && request.expiresAt.getTime() > Date.now()) {
    // The evaluator matches receipt IDs, not resource scope. Queue persistence
    // must not become proof that the owner's requested native effect happened.
    return [
      normalizeEffectReceipt({
        ...base,
        operation: "device." + operation.type,
        outcome: "preview",
        idempotency: { key: request.idempotencyKey, replayed: false },
      }),
    ];
  }
  const execution = request.execution;
  const provider = execution?.providerReceipt;
  if (
    request.state === "done" &&
    execution &&
    provider?.outcome === "applied" &&
    typeof provider.operationId === "string"
  ) {
    const read = deviceOperationIsRead(operation.type);
    const evidence = {
      ...base,
      receiptId: execution.attemptId,
      operation: "device." + operation.type,
      resource: { kind: "device.operation", id: provider.operationId },
      idempotency: { key: execution.providerIdempotencyKey, replayed: true },
    };
    // A selected read is an observation, not proof of a mutation. Its validated
    // snapshot stays in ActionResult.data; no new read occurs during retrieval.
    return [
      normalizeEffectReceipt(
        read
          ? {
              ...evidence,
              idempotency: {
                key: execution.providerIdempotencyKey,
                replayed: false,
              },
              outcome: "noop",
              reason:
                "Retrieved the immutable historical selected-read snapshot; no resource was changed or reread.",
            }
          : {
              ...evidence,
              outcome: "applied",
              commit: {
                kind: "provider_accepted",
                id: provider.operationId,
                committedAt: request.updatedAt.toISOString(),
              },
            },
      ),
    ];
  }
  if (request.state === "reconciliation_required") {
    return [
      normalizeEffectReceipt({
        ...base,
        receiptId: execution?.attemptId ?? request.id,
        operation: "device." + operation.type,
        idempotency: { key: request.idempotencyKey, replayed: false },
        outcome: "failed",
        failure: {
          code: "DEVICE_RESULT_UNCONFIRMED",
          retryable: false,
          acceptance: "unknown",
        },
      }),
    ];
  }
  // Claims and approval alone never establish device execution. Unknown outcomes
  // must not inherit an applied approval-request receipt as desired-state proof.
  return [
    normalizeEffectReceipt({
      ...base,
      operation: "device." + operation.type,
      idempotency: { key: request.idempotencyKey, replayed: false },
      outcome: "noop",
      reason:
        "No verified completed device effect is available; durable proposal state is " +
        request.state +
        ".",
    }),
  ];
}

/** Persisted approval metadata is deliberately NOT a planner completion receipt. */
export function deviceApprovalPersistenceReceipt(
  outcome: ApprovalEnqueueResult,
): EffectReceipt {
  const { request, reused } = outcome;
  return normalizeEffectReceipt({
    receiptId: request.id,
    operation: "device.approval.create",
    resource: { kind: "device.approval", id: request.id },
    artifacts: [],
    idempotency: { key: request.idempotencyKey, replayed: reused },
    observedAt: new Date().toISOString(),
    ...(reused
      ? {
          outcome: "noop",
          reason: "Re-observed the same persisted approval request.",
        }
      : {
          outcome: "applied",
          commit: {
            kind: "durable",
            id: request.id,
            committedAt: request.createdAt.toISOString(),
          },
        }),
  });
}

/** Exhaustive closed operation union: new operations require explicit classification. */
function deviceOperationIsRead(type: DeviceOperation["type"]): boolean {
  switch (type) {
    case "maps_read_selected":
    case "notes_read_selected":
    case "reminder_read_selected":
    case "calendar_read_next":
    case "calendar_read_selected":
    case "read_selected_notes":
    case "read_calendar_range":
      return true;
    case "notes_update":
    case "notes_delete":
    case "reminder_update":
    case "reminder_complete":
    case "reminder_snooze":
    case "reminder_cancel":
    case "calendar_create_local":
    case "calendar_create":
    case "calendar_update":
    case "calendar_delete":
    case "clock_handoff":
    case "clock_alarm":
    case "create_note":
    case "create_reminder":
    case "reminder_create":
    case "open_view":
    case "browser_navigate":
    case "post_notification":
    case "speak_text":
      return false;
    default: {
      const unreachable: never = type;
      throw new Error("Unclassified device operation: " + unreachable);
    }
  }
}
