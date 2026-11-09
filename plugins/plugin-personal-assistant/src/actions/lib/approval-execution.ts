/**
 * Runs one durable approval execution attempt around an external provider.
 * The queue claim precedes dispatch, dispatch-start is persisted immediately
 * before the call, and every observed provider outcome is committed without
 * making ambiguous attempts automatically retriable.
 */

import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../../lifeops/approval-queue.types.js";
import {
  ConnectorDeliveryEvidenceError,
  ConnectorSenderChangedError,
} from "../../lifeops/messaging/connector-delivery-evidence.js";
import { ApprovalAmbiguousDeliveryError } from "./approval-delivery-errors.js";

export { ApprovalAmbiguousDeliveryError } from "./approval-delivery-errors.js";

import { ApprovalKnownNonDeliveryError } from "./messaging-helpers.js";

export interface PreparedApprovalDispatch<T> {
  readonly provider: string;
  dispatch(providerIdempotencyKey: string): Promise<{
    readonly value: T;
    readonly receipt: Readonly<Record<string, unknown>>;
  }>;
}

export type ApprovalDispatchOutcome<T> =
  | {
      readonly kind: "delivered";
      readonly value: T;
      readonly request: ApprovalRequest;
    }
  | {
      readonly kind: "known_failure";
      readonly error: Error;
      readonly request: ApprovalRequest;
    }
  | {
      readonly kind: "reconciliation_required";
      readonly error: Error;
      readonly request: ApprovalRequest;
    };

/**
 * Attempts this process is dispatching right now. A claim survives in SQL
 * after a crash, so an `executing` row whose attempt is not here belongs to a
 * stopped process; one that is here is still live and must not be recovered
 * by a second approve or reject.
 */
const liveAttempts = new Set<string>();

/** A live attempt older than this is treated as hung and may be recovered. */
export const APPROVAL_EXECUTION_LEASE_MS = 10 * 60 * 1000;

/** True while this process is still dispatching the row's claimed attempt. */
export function isApprovalExecutionLive(
  request: ApprovalRequest,
  now: number = Date.now(),
): boolean {
  const execution = request.execution;
  if (request.state !== "executing" || !execution) return false;
  if (!liveAttempts.has(execution.attemptId)) return false;
  return now - execution.claimedAt.getTime() < APPROVAL_EXECUTION_LEASE_MS;
}

function executionMutation(
  request: ApprovalRequest,
  subjectUserId: string,
): {
  requestId: string;
  subjectUserId: string;
  attemptId: string;
} {
  if (!request.execution) {
    throw new Error(
      `[approval] claimed request ${request.id} has no execution metadata`,
    );
  }
  return {
    requestId: request.id,
    subjectUserId,
    attemptId: request.execution.attemptId,
  };
}

export async function runApprovalDispatch<T>(args: {
  queue: ApprovalQueue;
  request: ApprovalRequest;
  subjectUserId: string;
  prepared: PreparedApprovalDispatch<T>;
}): Promise<ApprovalDispatchOutcome<T>> {
  const providerIdempotencyKey = `approval:${args.request.id}:${args.prepared.provider}`;
  const claimed = await args.queue.claimExecution({
    requestId: args.request.id,
    subjectUserId: args.subjectUserId,
    provider: args.prepared.provider,
    providerIdempotencyKey,
  });
  const mutation = executionMutation(claimed, args.subjectUserId);
  liveAttempts.add(mutation.attemptId);
  try {
    return await dispatchClaimed(args, mutation, providerIdempotencyKey);
  } finally {
    liveAttempts.delete(mutation.attemptId);
  }
}

async function dispatchClaimed<T>(
  args: {
    queue: ApprovalQueue;
    prepared: PreparedApprovalDispatch<T>;
  },
  mutation: ReturnType<typeof executionMutation>,
  providerIdempotencyKey: string,
): Promise<ApprovalDispatchOutcome<T>> {
  await args.queue.markDispatchStarted(mutation);

  let delivered: {
    readonly value: T;
    readonly receipt: Readonly<Record<string, unknown>>;
  };
  try {
    delivered = await args.prepared.dispatch(providerIdempotencyKey);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (
      error instanceof ApprovalKnownNonDeliveryError ||
      error instanceof ConnectorSenderChangedError
    ) {
      const request = await args.queue.markRetryableFailure({
        ...mutation,
        error: error.message,
      });
      return { kind: "known_failure", error, request };
    }
    const request = await args.queue.markReconciliationRequired({
      ...mutation,
      error: error.message,
      ...(error instanceof ApprovalAmbiguousDeliveryError ||
      error instanceof ConnectorDeliveryEvidenceError
        ? { providerReceipt: error.providerReceipt }
        : {}),
    });
    return { kind: "reconciliation_required", error, request };
  }

  const request = await args.queue.markDone({
    ...mutation,
    providerReceipt: delivered.receipt,
  });
  return {
    kind: "delivered",
    value: delivered.value,
    request,
  };
}

/**
 * Recover an `executing` row whose attempt is no longer live. A live attempt
 * is returned unchanged, still `executing`.
 */
export async function recoverInterruptedApproval(
  queue: ApprovalQueue,
  request: ApprovalRequest,
  subjectUserId: string,
): Promise<ApprovalRequest> {
  if (isApprovalExecutionLive(request)) return request;
  const mutation = executionMutation(request, subjectUserId);
  if (!request.execution?.dispatchStartedAt) {
    return queue.recoverUnstartedExecution(mutation);
  }
  return queue.markReconciliationRequired({
    ...mutation,
    error:
      request.execution.error ??
      "process stopped after dispatch start before recording provider outcome",
  });
}
