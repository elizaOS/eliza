/**
 * Runs the ordered irreversible account-deletion saga over generation-fenced
 * phase receipts. Provider adapters expose only inspection, mutation, and
 * digest receipts; ambiguous calls must be inspected before any retry.
 */

import { createHash, randomUUID } from "node:crypto";
import { accountDeletionRequestsRepository } from "../../db/repositories/account-deletion-requests";
import type { AccountDeletionRequest } from "../../db/schemas/account-deletion-requests";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { logger } from "../utils/logger";

const PHASE_LEASE_MILLISECONDS = 5 * 60 * 1_000;
const RETRY_MILLISECONDS = 60 * 1_000;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,95}$/;

export type AccountDeletionProviderPhase =
  | "steward_deactivation"
  | "stripe"
  | "domains"
  | "secondary_backups"
  | "spools"
  | "compute_containers"
  | "github_repositories"
  | "connector_credentials"
  | "voice_credentials"
  | "primary_object_storage"
  | "vault_key_bindings"
  | "other_grants"
  | "steward_deletion";

export interface AccountDeletionProviderContext {
  requestId: string;
  requestDigest: string;
  userId: string;
  organizationId: string;
  stewardUserId: string;
  lifecycleRevision: number;
  blob: RuntimeR2Bucket;
}

export type AccountDeletionProviderInspection =
  | { state: "complete"; receiptDigest: string }
  | { state: "needs_execution" }
  | { state: "action_required"; errorCode: string };

export interface AccountDeletionProviderAdapter {
  inspect(context: AccountDeletionProviderContext): Promise<AccountDeletionProviderInspection>;
  execute(context: AccountDeletionProviderContext, idempotencyKey: string): Promise<void>;
}

export type AccountDeletionProviderAdapters = Readonly<
  Record<AccountDeletionProviderPhase, AccountDeletionProviderAdapter>
>;

export interface ProcessAccountDeletionSagaResult {
  processed: number;
  completed: number;
  progressed: number;
  reconciling: number;
  actionRequired: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireReceiptDigest(value: string): string {
  if (!DIGEST_PATTERN.test(value)) {
    throw new Error("Account deletion provider returned an invalid receipt digest");
  }
  return value;
}

function requireActionCode(value: string): string {
  if (!ERROR_CODE_PATTERN.test(value)) {
    throw new Error("Account deletion provider returned an invalid action code");
  }
  return value;
}

function providerContext(
  request: AccountDeletionRequest,
  blob: RuntimeR2Bucket,
): AccountDeletionProviderContext | null {
  if (
    !request.request_digest ||
    !DIGEST_PATTERN.test(request.request_digest) ||
    !request.user_id ||
    !request.organization_id ||
    !request.steward_user_id
  ) {
    return null;
  }
  return {
    requestId: request.id,
    requestDigest: request.request_digest,
    userId: request.user_id,
    organizationId: request.organization_id,
    stewardUserId: request.steward_user_id,
    lifecycleRevision: request.lifecycle_revision,
    blob,
  };
}

function isProviderPhase(value: string): value is AccountDeletionProviderPhase {
  return [
    "steward_deactivation",
    "stripe",
    "domains",
    "secondary_backups",
    "spools",
    "compute_containers",
    "github_repositories",
    "connector_credentials",
    "voice_credentials",
    "primary_object_storage",
    "vault_key_bindings",
    "other_grants",
    "steward_deletion",
  ].includes(value);
}

async function scheduleRetry(input: {
  requestId: string;
  now: Date;
  errorCode: string;
}): Promise<void> {
  await accountDeletionRequestsRepository.scheduleRequestReconciliation({
    requestId: input.requestId,
    now: input.now,
    retryAt: new Date(input.now.getTime() + RETRY_MILLISECONDS),
    errorCode: input.errorCode,
  });
}

async function completeInspectedPhase(input: {
  requestId: string;
  phase: AccountDeletionProviderPhase;
  phaseReceiptId: string;
  generation: number;
  inspection: Extract<AccountDeletionProviderInspection, { state: "complete" }>;
  now: Date;
}): Promise<boolean> {
  if (input.phase === "steward_deactivation") {
    return await accountDeletionRequestsRepository.completeStewardDeactivationPhase({
      requestId: input.requestId,
      phaseReceiptId: input.phaseReceiptId,
      generation: input.generation,
      providerReceiptDigest: requireReceiptDigest(input.inspection.receiptDigest),
      now: input.now,
    });
  }
  return await accountDeletionRequestsRepository.completeProviderPhase({
    requestId: input.requestId,
    phaseReceiptId: input.phaseReceiptId,
    generation: input.generation,
    providerReceiptDigest: requireReceiptDigest(input.inspection.receiptDigest),
    now: input.now,
  });
}

async function processDatabaseErasure(input: {
  request: AccountDeletionRequest;
  phaseReceiptId: string;
  generation: number;
  phaseReceiptDigests: string[];
  now: Date;
}): Promise<"completed" | "stale" | "retry" | "action_required"> {
  const completionReceiptDigest = digest(
    [
      "account-deletion-completion:v1",
      input.request.request_digest,
      ...input.phaseReceiptDigests.sort(),
    ].join(":"),
  );
  try {
    const result = await accountDeletionRequestsRepository.finalizePersonalAccountDeletion({
      requestId: input.request.id,
      phaseReceiptId: input.phaseReceiptId,
      generation: input.generation,
      completionReceiptDigest,
      now: input.now,
    });
    if (result.outcome === "completed" || result.outcome === "already_completed") {
      return "completed";
    }
    if (result.outcome === "stale_generation") return "stale";
    if (result.outcome === "transfer_required" || result.outcome === "phases_incomplete") {
      await accountDeletionRequestsRepository.markPhaseActionRequired({
        requestId: input.request.id,
        phaseReceiptId: input.phaseReceiptId,
        generation: input.generation,
        errorCode:
          result.outcome === "transfer_required"
            ? "TRANSFER_REQUIRED"
            : "ACCOUNT_DELETION_PHASES_INCOMPLETE",
        now: input.now,
      });
      return "action_required";
    }
    await accountDeletionRequestsRepository.markPhaseRetryable({
      phaseReceiptId: input.phaseReceiptId,
      generation: input.generation,
      errorCode: "ACCOUNT_ERASURE_AUTHORITY_UNAVAILABLE",
      retryClass: "definite_pre_provider_failure",
      now: input.now,
      retryAt: new Date(input.now.getTime() + RETRY_MILLISECONDS),
    });
    await scheduleRetry({
      requestId: input.request.id,
      now: input.now,
      errorCode: "ACCOUNT_ERASURE_AUTHORITY_UNAVAILABLE",
    });
    return "retry";
  } catch {
    // error-policy:J1 The database transaction rolled back in full. The exact
    // generation becomes retryable; no provider outcome is ambiguous here.
    await accountDeletionRequestsRepository.markPhaseRetryable({
      phaseReceiptId: input.phaseReceiptId,
      generation: input.generation,
      errorCode: "ACCOUNT_ERASURE_TRANSACTION_FAILED",
      retryClass: "definite_pre_provider_failure",
      now: input.now,
      retryAt: new Date(input.now.getTime() + RETRY_MILLISECONDS),
    });
    await scheduleRetry({
      requestId: input.request.id,
      now: input.now,
      errorCode: "ACCOUNT_ERASURE_TRANSACTION_FAILED",
    });
    return "retry";
  }
}

async function processProviderPhase(input: {
  request: AccountDeletionRequest;
  phase: AccountDeletionProviderPhase;
  adapter: AccountDeletionProviderAdapter;
  context: AccountDeletionProviderContext;
  now: Date;
}): Promise<"progressed" | "stale" | "reconciling" | "action_required"> {
  const lease = await accountDeletionRequestsRepository.leasePhase({
    requestId: input.request.id,
    phase: input.phase,
    leaseOwnerDigest: digest(randomUUID()),
    now: input.now,
    leaseMilliseconds: PHASE_LEASE_MILLISECONDS,
  });
  if (!lease) return "stale";

  let inspection: AccountDeletionProviderInspection;
  try {
    inspection = await input.adapter.inspect(input.context);
  } catch {
    // error-policy:J1 Inspection happens before a provider mutation. A phase
    // already reconciling stays reconciling so an outage cannot authorize a
    // blind replay; a fresh phase may retry inspection safely.
    const retryAt = new Date(input.now.getTime() + RETRY_MILLISECONDS);
    if (lease.receipt.status === "reconciling") {
      await accountDeletionRequestsRepository.deferPhaseReconciliation({
        phaseReceiptId: lease.receipt.id,
        generation: lease.generation,
        errorCode: "ACCOUNT_DELETION_PROVIDER_INSPECTION_FAILED",
        now: input.now,
        retryAt,
      });
    } else {
      await accountDeletionRequestsRepository.markPhaseRetryable({
        phaseReceiptId: lease.receipt.id,
        generation: lease.generation,
        errorCode: "ACCOUNT_DELETION_PROVIDER_INSPECTION_FAILED",
        retryClass: "definite_pre_provider_failure",
        now: input.now,
        retryAt,
      });
    }
    await scheduleRetry({
      requestId: input.request.id,
      now: input.now,
      errorCode: "ACCOUNT_DELETION_PROVIDER_INSPECTION_FAILED",
    });
    return "reconciling";
  }

  if (inspection.state === "complete") {
    const committed = await completeInspectedPhase({
      requestId: input.request.id,
      phase: input.phase,
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      inspection,
      now: input.now,
    });
    return committed ? "progressed" : "stale";
  }
  if (inspection.state === "action_required") {
    const committed = await accountDeletionRequestsRepository.markPhaseActionRequired({
      requestId: input.request.id,
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      errorCode: requireActionCode(inspection.errorCode),
      now: input.now,
    });
    return committed ? "action_required" : "stale";
  }

  if (lease.receipt.status === "reconciling") {
    const retryAt = new Date(input.now.getTime() + RETRY_MILLISECONDS);
    await accountDeletionRequestsRepository.markPhaseRetryable({
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      errorCode: "ACCOUNT_DELETION_PROVIDER_EFFECT_INCOMPLETE",
      retryClass: "provider_absence_confirmed",
      now: input.now,
      retryAt,
    });
    await scheduleRetry({
      requestId: input.request.id,
      now: input.now,
      errorCode: "ACCOUNT_DELETION_PROVIDER_EFFECT_INCOMPLETE",
    });
    return "reconciling";
  }

  const providerOperationDigest = digest(
    `account-deletion-provider-operation:v1:${input.request.id}:${input.phase}`,
  );
  const started = await accountDeletionRequestsRepository.markPhaseProviderCallStarted(
    lease.receipt.id,
    lease.generation,
    input.now,
    providerOperationDigest,
  );
  if (!started) return "stale";

  try {
    await input.adapter.execute(
      input.context,
      `account-deletion:${input.request.id}:${input.phase}`,
    );
    const reconciled = await input.adapter.inspect(input.context);
    if (reconciled.state === "complete") {
      const committed = await completeInspectedPhase({
        requestId: input.request.id,
        phase: input.phase,
        phaseReceiptId: lease.receipt.id,
        generation: lease.generation,
        inspection: reconciled,
        now: new Date(),
      });
      return committed ? "progressed" : "stale";
    }
    if (reconciled.state === "action_required") {
      const committed = await accountDeletionRequestsRepository.markPhaseActionRequired({
        requestId: input.request.id,
        phaseReceiptId: lease.receipt.id,
        generation: lease.generation,
        errorCode: requireActionCode(reconciled.errorCode),
        now: new Date(),
      });
      return committed ? "action_required" : "stale";
    }
    throw new Error("Provider mutation returned without a terminal inspection");
  } catch {
    // error-policy:J1 Any error after the durable before-call marker may be a
    // lost successful response. Persist reconciliation and never mutate again
    // until a later generation has inspected canonical provider state.
    const failureAt = new Date();
    await accountDeletionRequestsRepository.markPhaseForReconciliation({
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      errorCode: "ACCOUNT_DELETION_PROVIDER_OUTCOME_AMBIGUOUS",
      now: failureAt,
      retryAt: new Date(failureAt.getTime() + RETRY_MILLISECONDS),
    });
    await scheduleRetry({
      requestId: input.request.id,
      now: failureAt,
      errorCode: "ACCOUNT_DELETION_PROVIDER_OUTCOME_AMBIGUOUS",
    });
    return "reconciling";
  }
}

/** Reconciles ambiguous immediate Steward deactivation during the undo window. */
export async function reconcileRecoveryStewardDeactivations(input: {
  limit: number;
  blob: RuntimeR2Bucket;
  adapter: AccountDeletionProviderAdapter;
  now?: Date;
}): Promise<{ processed: number; completed: number; reconciling: number; actionRequired: number }> {
  const now = input.now ?? new Date();
  const requests = await accountDeletionRequestsRepository.findRecoveryPhaseCandidates(
    "steward_deactivation",
    now,
    input.limit,
  );
  const result = { processed: requests.length, completed: 0, reconciling: 0, actionRequired: 0 };
  for (const request of requests) {
    const context = providerContext(request, input.blob);
    if (!context) {
      result.actionRequired++;
      continue;
    }
    const outcome = await processProviderPhase({
      request,
      phase: "steward_deactivation",
      adapter: input.adapter,
      context,
      now,
    });
    if (outcome === "progressed") result.completed++;
    else if (outcome === "reconciling") result.reconciling++;
    else if (outcome === "action_required") result.actionRequired++;
  }
  return result;
}

/** Runs at most one ordered irreversible phase for each due request. */
export async function processIrreversibleAccountDeletionSaga(input: {
  limit: number;
  blob: RuntimeR2Bucket;
  adapters: AccountDeletionProviderAdapters;
  now?: Date;
}): Promise<ProcessAccountDeletionSagaResult> {
  const now = input.now ?? new Date();
  const requests = await accountDeletionRequestsRepository.findRunnableIrreversibleRequests(
    now,
    input.limit,
  );
  const result: ProcessAccountDeletionSagaResult = {
    processed: requests.length,
    completed: 0,
    progressed: 0,
    reconciling: 0,
    actionRequired: 0,
  };

  for (const request of requests) {
    const context = providerContext(request, input.blob);
    if (!context) {
      result.actionRequired++;
      logger.error("[AccountDeletionSaga] Irreversible receipt lacks provider authority", {
        requestId: request.id,
      });
      continue;
    }
    const phases = await accountDeletionRequestsRepository.listPhaseReceipts(request.id);
    const next = phases.find(
      (phase) => phase.status !== "completed" && phase.status !== "canceled",
    );
    if (!next) {
      result.actionRequired++;
      logger.error("[AccountDeletionSaga] Irreversible receipt has no terminal erasure phase", {
        requestId: request.id,
      });
      continue;
    }
    if (next.status === "action_required") {
      result.actionRequired++;
      continue;
    }

    if (next.phase === "database_erasure") {
      const lease = await accountDeletionRequestsRepository.leasePhase({
        requestId: request.id,
        phase: next.phase,
        leaseOwnerDigest: digest(randomUUID()),
        now,
        leaseMilliseconds: PHASE_LEASE_MILLISECONDS,
      });
      if (!lease) continue;
      const outcome = await processDatabaseErasure({
        request,
        phaseReceiptId: lease.receipt.id,
        generation: lease.generation,
        phaseReceiptDigests: phases.flatMap((phase) =>
          phase.provider_receipt_digest ? [phase.provider_receipt_digest] : [],
        ),
        now,
      });
      if (outcome === "completed") result.completed++;
      else if (outcome === "retry") result.reconciling++;
      else if (outcome === "action_required") result.actionRequired++;
      continue;
    }

    if (!isProviderPhase(next.phase)) {
      // Export creation and export revocation have dedicated workers. Their
      // incomplete receipt remains the ordered head and blocks provider purge.
      continue;
    }
    const outcome = await processProviderPhase({
      request,
      phase: next.phase,
      adapter: input.adapters[next.phase],
      context,
      now,
    });
    if (outcome === "progressed") result.progressed++;
    else if (outcome === "reconciling") result.reconciling++;
    else if (outcome === "action_required") result.actionRequired++;
  }
  return result;
}
