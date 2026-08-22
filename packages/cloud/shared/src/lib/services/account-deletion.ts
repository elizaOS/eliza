/** Coordinates fail-closed account-deletion requests and fenced worker claims. */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { accountDeletionRequestsRepository } from "../../db/repositories/account-deletion-requests";
import type { AccountDeletionExport } from "../../db/schemas/account-deletion-exports";
import type { AccountDeletionRequest } from "../../db/schemas/account-deletion-requests";
import type {
  AccountDeletionAcceptedDto,
  AccountDeletionNextAction,
  AccountDeletionStatus,
  AccountDeletionStatusDto,
} from "../../types/account-lifecycle";
import type { AgentBackupObjectStoreRegistry } from "../storage/agent-backup-object-store";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { logger } from "../utils/logger";
import {
  type AccountDeletionExportRevocationResult,
  reconcileAccountDeletionExportRevocations,
} from "./account-deletion-export";
import { createAccountDeletionProviderAdapters } from "./account-deletion-provider-adapters";
import { purgePersonalOrganizationResources } from "./account-deletion-resource-purge";
import {
  type AccountDeletionProviderAdapters,
  processIrreversibleAccountDeletionSaga,
  reconcileRecoveryStewardDeactivations,
} from "./account-deletion-saga";
import {
  deactivateStewardPlatformUser,
  reactivateStewardPlatformUser,
} from "./steward-platform-users";

const RECOVERY_WINDOW_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const STATUS_CREDENTIAL_RETENTION_MILLISECONDS = 120 * 24 * 60 * 60 * 1_000;
const IMMEDIATE_PHASE_LEASE_MILLISECONDS = 60 * 1_000;
// Outlive the export worker lease so a stale in-flight put cannot recreate an object after revoke.
const EXPORT_REVOCATION_SAFETY_MILLISECONDS = 15 * 60 * 1_000;

export const ACCOUNT_DELETION_PHASES = [
  "account_authority",
  "export",
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
  "database_erasure",
] as const;

const ACCOUNT_DELETION_PHASE_ORDER = new Map<string, number>([
  ["account_authority", 0],
  ["export", 1],
  ["steward_deactivation", 2],
  ["stripe", 10],
  ["domains", 20],
  ["secondary_backups", 30],
  ["spools", 40],
  ["compute_containers", 50],
  ["github_repositories", 60],
  ["connector_credentials", 70],
  ["voice_credentials", 80],
  ["primary_object_storage", 90],
  ["vault_key_bindings", 100],
  ["other_grants", 110],
  ["steward_deletion", 120],
  ["database_erasure", 130],
]);

export type AccountDeletionConflictCode =
  | "ACCOUNT_UNAVAILABLE"
  | "ANONYMOUS_ACCOUNT"
  | "REQUEST_REPLAYED"
  | "TRANSFER_REQUIRED"
  | "LIFECYCLE_RESERVATION_REQUIRED";

export class AccountDeletionConflictError extends Error {
  constructor(
    message: string,
    readonly code: AccountDeletionConflictCode,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "AccountDeletionConflictError";
  }
}

export class AccountDeletionRecoveryError extends Error {
  constructor(
    message: string,
    readonly code: "STATUS_CREDENTIAL_INVALID" | "RECOVERY_WINDOW_EXPIRED",
  ) {
    super(message);
    this.name = "AccountDeletionRecoveryError";
  }
}

function publicStatus(status: AccountDeletionRequest["status"]): AccountDeletionStatus {
  return status === "requested" ? "reserved" : status;
}

function nextActionForStatus(status: AccountDeletionStatus): AccountDeletionNextAction {
  switch (status) {
    case "reserved":
      return "wait_for_export";
    case "recovery":
      return "download_export_or_cancel";
    case "scheduled":
    case "processing":
    case "canceling":
      return "wait_for_reconciliation";
    case "action_required":
      return "contact_support";
    case "completed":
    case "canceled":
      return "none";
  }
}

export function toAccountDeletionRequestDto(
  request: AccountDeletionRequest,
  exportReceipt: AccountDeletionExport | null = null,
): AccountDeletionStatusDto {
  const status = publicStatus(request.status);
  return {
    requestId: request.id,
    status,
    requestedAt: request.requested_at.toISOString(),
    recoveryExpiresAt: request.recovery_expires_at?.toISOString() ?? null,
    scheduledDeletionAt: request.execute_after.toISOString(),
    irreversibleAt: request.irreversible_at?.toISOString() ?? null,
    completedAt: request.completed_at?.toISOString() ?? null,
    identityDeactivated: request.identity_deactivated_at !== null,
    accessState: status === "completed" ? "erased" : status === "canceled" ? "active" : "fenced",
    canCancel: status === "reserved" || status === "recovery",
    nextAction: nextActionForStatus(status),
    export: exportReceipt
      ? {
          status: exportReceipt.status,
          readyAt: exportReceipt.ready_at?.toISOString() ?? null,
          expiresAt: exportReceipt.expires_at.toISOString(),
          contentDigest: exportReceipt.content_digest,
        }
      : null,
  };
}

export async function getOpenAccountDeletionRequest(userId: string) {
  return await accountDeletionRequestsRepository.findOpenByUserId(userId);
}

export async function getAccountDeletionStatusByCredential(
  statusCredential: string,
): Promise<AccountDeletionStatusDto | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(statusCredential)) return null;
  const tokenHash = createHash("sha256").update(statusCredential).digest("hex");
  const record = await accountDeletionRequestsRepository.findByStatusTokenHash(tokenHash);
  return record ? toAccountDeletionRequestDto(record.request, record.exportReceipt) : null;
}

export async function cancelAccountDeletion(
  recoveryCredential: string,
): Promise<AccountDeletionStatusDto> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(recoveryCredential)) {
    throw new AccountDeletionRecoveryError(
      "Recovery credential is invalid",
      "STATUS_CREDENTIAL_INVALID",
    );
  }
  const recoveryTokenHash = createHash("sha256").update(recoveryCredential).digest("hex");
  const now = new Date();
  const cancellation = await accountDeletionRequestsRepository.cancelDuringRecovery({
    recoveryTokenHash,
    reactivationIdempotencyKeyDigest: createHash("sha256")
      .update(`steward-reactivation:v1:${recoveryTokenHash}`)
      .digest("hex"),
    exportRevocationIdempotencyKeyDigest: createHash("sha256")
      .update(`account-deletion-export-revoke:v1:${recoveryTokenHash}`)
      .digest("hex"),
    exportRevocationNotBefore: new Date(now.getTime() + EXPORT_REVOCATION_SAFETY_MILLISECONDS),
    now,
  });
  if (cancellation.outcome === "invalid_credential") {
    throw new AccountDeletionRecoveryError(
      "Recovery credential is invalid",
      "STATUS_CREDENTIAL_INVALID",
    );
  }
  if (cancellation.outcome === "recovery_expired") {
    throw new AccountDeletionRecoveryError(
      "The deletion recovery window has expired",
      "RECOVERY_WINDOW_EXPIRED",
    );
  }
  if (cancellation.outcome === "already_canceled" || cancellation.outcome === "already_canceling") {
    return toAccountDeletionRequestDto(cancellation.request);
  }

  await attemptImmediateStewardReactivation({
    requestId: cancellation.request.id,
    stewardUserId: cancellation.stewardUserId,
  });
  const latest = await accountDeletionRequestsRepository.findById(cancellation.request.id);
  return toAccountDeletionRequestDto(latest ?? cancellation.request);
}

export async function requestAccountDeletion(input: {
  userId: string;
  organizationId: string;
  stewardUserId: string;
  now?: Date;
}): Promise<AccountDeletionAcceptedDto> {
  const now = input.now ?? new Date();
  const requestId = randomUUID();
  const statusCredential = randomBytes(32).toString("base64url");
  const recoveryCredential = randomBytes(32).toString("base64url");
  const statusTokenHash = createHash("sha256").update(statusCredential).digest("hex");
  const recoveryTokenHash = createHash("sha256").update(recoveryCredential).digest("hex");
  const recoveryExpiresAt = new Date(now.getTime() + RECOVERY_WINDOW_MILLISECONDS);
  const statusTokenExpiresAt = new Date(now.getTime() + STATUS_CREDENTIAL_RETENTION_MILLISECONDS);
  const requestDigest = createHash("sha256")
    .update(`account-deletion:v1:${requestId}`)
    .digest("hex");
  const phases = ACCOUNT_DELETION_PHASES.map((phase) => ({
    phase,
    phaseOrder: ACCOUNT_DELETION_PHASE_ORDER.get(phase)!,
    idempotencyKeyDigest: createHash("sha256")
      .update(`account-deletion-phase:v1:${requestId}:${phase}`)
      .digest("hex"),
    completed: phase === "account_authority",
  }));

  const reservation = await accountDeletionRequestsRepository.reservePersonalAccountDeletion({
    requestId,
    userId: input.userId,
    organizationId: input.organizationId,
    stewardUserId: input.stewardUserId,
    now,
    recoveryExpiresAt,
    statusTokenHash,
    statusTokenExpiresAt,
    recoveryTokenHash,
    recoveryTokenExpiresAt: recoveryExpiresAt,
    requestDigest,
    phases,
  });

  if (reservation.outcome === "account_unavailable") {
    throw new AccountDeletionConflictError("Account is no longer available", "ACCOUNT_UNAVAILABLE");
  }
  if (reservation.outcome === "anonymous_account") {
    throw new AccountDeletionConflictError(
      "Anonymous sessions do not have an account to delete",
      "ANONYMOUS_ACCOUNT",
    );
  }
  if (reservation.outcome === "transfer_required") {
    throw new AccountDeletionConflictError(
      "Transfer or revoke shared organization resources before deleting this account",
      "TRANSFER_REQUIRED",
      {
        successorOwnerRequired: true,
        activeOwnerCount: reservation.activeOwnerCount,
      },
    );
  }
  if (reservation.outcome === "existing") {
    throw new AccountDeletionConflictError(
      "An account deletion request is already active; use its status credential",
      "REQUEST_REPLAYED",
    );
  }

  await attemptImmediateStewardDeactivation({
    requestId: reservation.request.id,
    stewardUserId: input.stewardUserId,
    now,
  });

  return {
    request: toAccountDeletionRequestDto(reservation.request),
    statusCredential,
    recoveryCredential,
  };
}

async function attemptImmediateStewardDeactivation(input: {
  requestId: string;
  stewardUserId: string;
  now: Date;
}): Promise<void> {
  const workerNonce = randomUUID();
  const lease = await accountDeletionRequestsRepository.leasePhase({
    requestId: input.requestId,
    phase: "steward_deactivation",
    leaseOwnerDigest: createHash("sha256").update(workerNonce).digest("hex"),
    now: input.now,
    leaseMilliseconds: IMMEDIATE_PHASE_LEASE_MILLISECONDS,
  });
  if (!lease) return;
  const started = await accountDeletionRequestsRepository.markPhaseProviderCallStarted(
    lease.receipt.id,
    lease.generation,
    input.now,
  );
  if (!started) return;

  try {
    const result = await deactivateStewardPlatformUser(input.stewardUserId);
    const providerReceiptDigest = createHash("sha256")
      .update(`steward-deactivation:v1:${result.userId}`)
      .digest("hex");
    const committed = await accountDeletionRequestsRepository.completeStewardDeactivationPhase({
      requestId: input.requestId,
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      providerReceiptDigest,
      now: new Date(),
    });
    if (!committed) {
      logger.warn("[AccountDeletion] Steward deactivation acknowledgement lost lease authority", {
        requestId: input.requestId,
      });
    }
  } catch {
    // error-policy:J1 A failed response can be ambiguous. Persist reconciliation
    // rather than repeating a provider mutation or discarding call evidence.
    await accountDeletionRequestsRepository.markPhaseForReconciliation({
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      errorCode: "STEWARD_DEACTIVATION_AMBIGUOUS",
      now: new Date(),
      retryAt: new Date(Date.now() + 60_000),
    });
    logger.warn("[AccountDeletion] Steward deactivation requires reconciliation", {
      requestId: input.requestId,
    });
  }
}

async function attemptImmediateStewardReactivation(input: {
  requestId: string;
  stewardUserId: string;
}): Promise<boolean> {
  const now = new Date();
  const lease = await accountDeletionRequestsRepository.leasePhase({
    requestId: input.requestId,
    phase: "steward_reactivation",
    leaseOwnerDigest: createHash("sha256").update(randomUUID()).digest("hex"),
    now,
    leaseMilliseconds: IMMEDIATE_PHASE_LEASE_MILLISECONDS,
  });
  if (!lease) return false;
  const started = await accountDeletionRequestsRepository.markPhaseProviderCallStarted(
    lease.receipt.id,
    lease.generation,
    now,
  );
  if (!started) return false;

  try {
    const result = await reactivateStewardPlatformUser(input.stewardUserId);
    return await accountDeletionRequestsRepository.completeStewardReactivationPhase({
      requestId: input.requestId,
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      providerReceiptDigest: createHash("sha256")
        .update(`steward-reactivation:v1:${result.userId}`)
        .digest("hex"),
      now: new Date(),
    });
  } catch {
    // error-policy:J1 Reactivation can also succeed with a lost response; it
    // remains a reconciliation phase and is never blindly repeated.
    await accountDeletionRequestsRepository.markPhaseForReconciliation({
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      errorCode: "STEWARD_REACTIVATION_AMBIGUOUS",
      now: new Date(),
      retryAt: new Date(Date.now() + 60_000),
    });
    logger.warn("[AccountDeletion] Steward reactivation requires reconciliation", {
      requestId: input.requestId,
    });
    return false;
  }
}

export interface ProcessAccountDeletionResult {
  exportRevocations: AccountDeletionExportRevocationResult;
  cancellationsFinalized: number;
  stewardDeactivationReconciliations: number;
  activated: number;
  recovered: number;
  processed: number;
  completed: number;
  progressed: number;
  reconciling: number;
  actionRequired: number;
}

export interface ProcessAccountDeletionResources {
  blob: RuntimeR2Bucket;
  adapters?: AccountDeletionProviderAdapters;
  backupRegistry?: AgentBackupObjectStoreRegistry;
  purgeOrganizationResources?: typeof purgePersonalOrganizationResources;
}

function requireProcessAccountDeletionResources(
  resources: ProcessAccountDeletionResources | undefined,
): asserts resources is ProcessAccountDeletionResources {
  const blob = resources?.blob;
  if (
    !blob ||
    typeof blob.get !== "function" ||
    typeof blob.put !== "function" ||
    typeof blob.delete !== "function"
  ) {
    throw new Error("Account deletion requires a valid Cloud object-storage binding");
  }
  if (!resources.purgeOrganizationResources && typeof blob.list !== "function") {
    throw new Error("Account deletion's default resource purge requires Cloud object listing");
  }
}

/**
 * Activates expired recovery reservations and advances one ordered, inspected
 * provider phase per request. Pre-reservation legacy rows remain on the
 * deliberate fail-closed path and never share the new saga authority.
 */
export async function processDueAccountDeletions(
  limit = 10,
  resources?: ProcessAccountDeletionResources,
): Promise<ProcessAccountDeletionResult> {
  requireProcessAccountDeletionResources(resources);

  const now = new Date();
  const exportRevocations = await reconcileAccountDeletionExportRevocations(limit, {
    bucket: resources.blob,
    now: () => now,
  });
  const adapters =
    resources.adapters ??
    createAccountDeletionProviderAdapters({ backupRegistry: resources.backupRegistry });
  const stewardDeactivations = await reconcileRecoveryStewardDeactivations({
    limit,
    blob: resources.blob,
    adapter: adapters.steward_deactivation,
    now,
  });
  let cancellationsFinalized = 0;
  for (const requestId of await accountDeletionRequestsRepository.findCancelingRequestIds(limit)) {
    if (
      await accountDeletionRequestsRepository.finalizeCancellationIfComplete({ requestId, now })
    ) {
      cancellationsFinalized++;
    }
  }

  let activated = 0;
  let activationActionRequired = 0;
  for (const requestId of await accountDeletionRequestsRepository.findExpiredRecoveryRequestIds(
    now,
    limit,
  )) {
    const activation =
      await accountDeletionRequestsRepository.activateExpiredPersonalAccountDeletion({
        requestId,
        exportRevocationIdempotencyKeyDigest: createHash("sha256")
          .update(`account-deletion-export-revoke:v1:${requestId}`)
          .digest("hex"),
        exportRevocationNotBefore: new Date(now.getTime() + EXPORT_REVOCATION_SAFETY_MILLISECONDS),
        now,
      });
    if (activation.outcome === "activated") {
      activated++;
      continue;
    }
    const activationErrorCode =
      activation.outcome === "transfer_required"
        ? "TRANSFER_REQUIRED"
        : activation.outcome === "export_required"
          ? "EXPORT_REQUIRED_BEFORE_ERASURE"
          : activation.outcome === "identity_deactivation_required"
            ? "STEWARD_DEACTIVATION_RECONCILIATION_REQUIRED"
            : null;
    if (activationErrorCode) {
      const parked = await accountDeletionRequestsRepository.markRecoveryActionRequired({
        requestId,
        errorCode: activationErrorCode,
        now,
      });
      if (parked) activationActionRequired++;
    }
  }

  const saga = await processIrreversibleAccountDeletionSaga({
    limit,
    blob: resources.blob,
    adapters,
    now,
  });

  const recovered = await accountDeletionRequestsRepository.recoverStaleProcessing(
    new Date(now.getTime() - 15 * 60 * 1_000),
  );
  const due = await accountDeletionRequestsRepository.claimDue(limit);
  const result = {
    exportRevocations,
    cancellationsFinalized,
    stewardDeactivationReconciliations: stewardDeactivations.completed,
    activated,
    recovered,
    processed: saga.processed + due.length,
    completed: saga.completed,
    progressed: saga.progressed,
    reconciling: saga.reconciling,
    actionRequired:
      saga.actionRequired + activationActionRequired + stewardDeactivations.actionRequired,
  };

  for (const request of due) {
    try {
      if (!request.steward_user_id || !request.user_id) {
        throw new Error("Claimed deletion request is missing account identifiers");
      }
      if (!request.organization_id) {
        throw new Error("Claimed deletion request is missing its organization identifier");
      }
      if (!request.processing_started_at) {
        logger.error("[AccountDeletion] Claimed request is missing its generation", {
          requestId: request.id,
        });
        continue;
      }

      // No membership writer shares a lifecycle reservation with this worker. Until #23098
      // provides that contract, every organization-backed permanent deletion must fail closed.
      const parked = await accountDeletionRequestsRepository.markActionRequired(
        request.id,
        request.processing_started_at,
        "LIFECYCLE_RESERVATION_REQUIRED",
      );
      if (!parked) {
        logger.warn("[AccountDeletion] Ignored a stale worker while parking deletion", {
          requestId: request.id,
        });
        continue;
      }
      result.actionRequired++;
      logger.warn("[AccountDeletion] Permanent deletion requires a lifecycle reservation", {
        requestId: request.id,
      });
    } catch (error) {
      // error-policy:J1 The per-request worker boundary records a fenced retry outcome.
      if (!request.processing_started_at) continue;
      const failed = await accountDeletionRequestsRepository.recordPurgeFailure(
        request.id,
        request.processing_started_at,
        "purge_failed",
      );
      if (failed?.status === "action_required") result.actionRequired++;
      logger.error("[AccountDeletion] Account deletion needs operator action", {
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
