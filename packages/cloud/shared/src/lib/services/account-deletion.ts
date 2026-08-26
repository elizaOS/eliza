/** Coordinates fail-closed account-deletion requests and fenced worker claims. */

import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core/edge";
import { accountDeletionRequestsRepository } from "../../db/repositories/account-deletion-requests";
import type { AccountDeletionExport } from "../../db/schemas/account-deletion-exports";
import type { AccountDeletionRequest } from "../../db/schemas/account-deletion-requests";
import type {
  AccountDeletionAcceptedDto,
  AccountDeletionNextAction,
  AccountDeletionStatus,
  AccountDeletionStatusDto,
} from "../../types/account-lifecycle";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { logger } from "../utils/logger";
import {
  type AccountDeletionExportRevocationResult,
  reconcileAccountDeletionExportRevocations,
} from "./account-deletion-export";
import {
  type AccountDeletionBackupAuthority,
  type AccountDeletionSpoolAuthority,
  createAccountDeletionProviderAdapters,
} from "./account-deletion-provider-adapters";
import { purgePersonalOrganizationResources } from "./account-deletion-resource-purge";
import {
  type AccountDeletionProviderAdapters,
  type AccountDeletionProviderPhase,
  processIrreversibleAccountDeletionSaga,
  reconcileRecoveryStewardDeactivations,
} from "./account-deletion-saga";
import {
  deactivateStewardPlatformUser,
  inspectStewardPlatformUser,
  reactivateStewardPlatformUser,
} from "./steward-platform-users";

const RECOVERY_WINDOW_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const STATUS_CREDENTIAL_RETENTION_MILLISECONDS = 120 * 24 * 60 * 60 * 1_000;
const IMMEDIATE_PHASE_LEASE_MILLISECONDS = 60 * 1_000;
// Outlive the export worker lease so a stale in-flight put cannot recreate an object after revoke.
const EXPORT_REVOCATION_SAFETY_MILLISECONDS = 15 * 60 * 1_000;
const CANCELLATION_RETRY_MILLISECONDS = 60 * 1_000;
const OPAQUE_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const ACCOUNT_DELETION_PHASES = [
  "account_authority",
  "export",
  "steward_deactivation",
  "stripe",
  "domains",
  "spools",
  "secondary_backups",
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
  ["spools", 30],
  ["secondary_backups", 40],
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
  | "ADMISSION_CREDENTIAL_REQUIRED"
  | "ANONYMOUS_ACCOUNT"
  | "PROVIDER_WORK_IN_FLIGHT"
  | "REQUEST_REPLAYED"
  | "TRANSFER_REQUIRED"
  | "LIFECYCLE_RESERVATION_REQUIRED";

export class AccountDeletionConflictError extends ElizaError {
  override readonly name = "AccountDeletionConflictError";
  override readonly code: AccountDeletionConflictCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    code: AccountDeletionConflictCode,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message, { code, severity: "fatal" });
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AccountDeletionRecoveryError extends ElizaError {
  override readonly name = "AccountDeletionRecoveryError";
  override readonly code: "STATUS_CREDENTIAL_INVALID" | "RECOVERY_WINDOW_EXPIRED";

  constructor(message: string, code: "STATUS_CREDENTIAL_INVALID" | "RECOVERY_WINDOW_EXPIRED") {
    super(message, { code, severity: "fatal" });
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function publicStatus(status: AccountDeletionRequest["status"]): AccountDeletionStatus {
  return status === "requested" ? "pending_activation" : status;
}

function nextActionForStatus(status: AccountDeletionStatus): AccountDeletionNextAction {
  switch (status) {
    case "pending_activation":
      return "confirm_recovery_package";
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
    accessState:
      status === "completed"
        ? "erased"
        : status === "canceled" || status === "pending_activation"
          ? "active"
          : "fenced",
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

export async function getOpenAccountDeletionRequest(input: {
  userId: string;
  organizationId: string;
}) {
  return await accountDeletionRequestsRepository.findOpenByUserAndOrganizationId(
    input.userId,
    input.organizationId,
    true,
  );
}

export async function getAccountDeletionStatusByCredential(
  statusCredential: string,
): Promise<AccountDeletionStatusDto | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(statusCredential)) return null;
  const tokenHash = createHash("sha256").update(statusCredential).digest("hex");
  const record = await accountDeletionRequestsRepository.findByStatusTokenHash(tokenHash);
  return record ? toAccountDeletionRequestDto(record.request, record.exportReceipt) : null;
}

function hashOpaqueCredential(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deriveAdmissionCapabilities(admissionCredential: string): {
  statusCredential: string;
  recoveryCredential: string;
} {
  return {
    statusCredential: createHash("sha256")
      .update(`account-deletion-status:v1:${admissionCredential}`)
      .digest("base64url"),
    recoveryCredential: createHash("sha256")
      .update(`account-deletion-recovery:v1:${admissionCredential}`)
      .digest("base64url"),
  };
}

/**
 * Re-delivers only the first receipt's deterministic capabilities after a
 * committed response is lost. The client secret is never persisted in plaintext.
 */
export async function recoverAccountDeletionAdmission(
  admissionCredential: string,
  now = new Date(),
): Promise<AccountDeletionAcceptedDto | null> {
  if (!OPAQUE_CREDENTIAL_PATTERN.test(admissionCredential)) return null;
  const record = await accountDeletionRequestsRepository.findByAdmissionTokenHash(
    hashOpaqueCredential(admissionCredential),
    now,
  );
  if (!record) return null;
  const capabilities = deriveAdmissionCapabilities(admissionCredential);
  if (
    hashOpaqueCredential(capabilities.statusCredential) !== record.request.status_token_hash ||
    hashOpaqueCredential(capabilities.recoveryCredential) !== record.request.recovery_token_hash
  ) {
    return null;
  }
  return {
    request: toAccountDeletionRequestDto(record.request, record.exportReceipt),
    ...capabilities,
  };
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
  admissionCredential: string;
  now?: Date;
}): Promise<AccountDeletionAcceptedDto> {
  if (!OPAQUE_CREDENTIAL_PATTERN.test(input.admissionCredential)) {
    throw new AccountDeletionConflictError(
      "A valid deletion admission credential is required",
      "ADMISSION_CREDENTIAL_REQUIRED",
    );
  }
  const now = input.now ?? new Date();
  const requestId = randomUUID();
  const { statusCredential, recoveryCredential } = deriveAdmissionCapabilities(
    input.admissionCredential,
  );
  const statusTokenHash = hashOpaqueCredential(statusCredential);
  const recoveryTokenHash = hashOpaqueCredential(recoveryCredential);
  const admissionTokenHash = hashOpaqueCredential(input.admissionCredential);
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
    completed: false,
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
    admissionTokenHash,
    admissionTokenExpiresAt: recoveryExpiresAt,
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

  if (reservation.outcome === "replayed") {
    if (
      reservation.request.status_token_hash !== statusTokenHash ||
      reservation.request.recovery_token_hash !== recoveryTokenHash
    ) {
      throw new AccountDeletionConflictError(
        "The deletion admission receipt failed capability verification",
        "ACCOUNT_UNAVAILABLE",
      );
    }
    return {
      request: toAccountDeletionRequestDto(reservation.request),
      statusCredential,
      recoveryCredential,
    };
  }

  return {
    request: toAccountDeletionRequestDto(reservation.request),
    statusCredential,
    recoveryCredential,
  };
}

/**
 * Activates a pre-fence reservation only after the client proves possession of
 * its durably stored recovery package. Replays drive a missing Steward call
 * through the same generation-fenced phase instead of issuing a second call.
 */
export async function activateAccountDeletion(
  recoveryCredential: string,
  now = new Date(),
): Promise<AccountDeletionStatusDto> {
  if (!OPAQUE_CREDENTIAL_PATTERN.test(recoveryCredential)) {
    throw new AccountDeletionRecoveryError(
      "Recovery credential is invalid",
      "STATUS_CREDENTIAL_INVALID",
    );
  }
  const activation =
    await accountDeletionRequestsRepository.activateReservedPersonalAccountDeletion({
      recoveryTokenHash: hashOpaqueCredential(recoveryCredential),
      now,
    });
  if (activation.outcome === "invalid_credential") {
    throw new AccountDeletionRecoveryError(
      "Recovery credential is invalid or expired",
      "STATUS_CREDENTIAL_INVALID",
    );
  }
  if (activation.outcome === "account_unavailable") {
    throw new AccountDeletionConflictError("Account is no longer available", "ACCOUNT_UNAVAILABLE");
  }
  if (activation.outcome === "provider_work_in_flight") {
    throw new AccountDeletionConflictError(
      "Provider work is reconciling; retry deletion activation",
      "PROVIDER_WORK_IN_FLIGHT",
    );
  }
  if (activation.outcome === "transfer_required") {
    throw new AccountDeletionConflictError(
      "Transfer or revoke shared organization resources before deleting this account",
      "TRANSFER_REQUIRED",
      {
        successorOwnerRequired: true,
        activeOwnerCount: activation.activeOwnerCount,
      },
    );
  }

  const request = activation.request;
  if ((request.status === "reserved" || request.status === "recovery") && request.steward_user_id) {
    await attemptImmediateStewardDeactivation({
      requestId: request.id,
      stewardUserId: request.steward_user_id,
      now,
    });
  }
  const latest = await accountDeletionRequestsRepository.findById(request.id);
  return toAccountDeletionRequestDto(latest ?? request);
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

async function reconcileCancelingStewardReactivations(input: {
  limit: number;
  now: Date;
}): Promise<{ completed: number; reconciling: number; actionRequired: number }> {
  const result = { completed: 0, reconciling: 0, actionRequired: 0 };
  const requests = await accountDeletionRequestsRepository.findCancellationPhaseCandidates(
    "steward_reactivation",
    input.now,
    input.limit,
  );
  for (const request of requests) {
    if (!request.steward_user_id) {
      result.actionRequired++;
      continue;
    }
    const lease = await accountDeletionRequestsRepository.leasePhase({
      requestId: request.id,
      phase: "steward_reactivation",
      leaseOwnerDigest: createHash("sha256").update(randomUUID()).digest("hex"),
      now: input.now,
      leaseMilliseconds: IMMEDIATE_PHASE_LEASE_MILLISECONDS,
    });
    if (!lease) continue;

    let state: Awaited<ReturnType<typeof inspectStewardPlatformUser>>;
    try {
      state = await inspectStewardPlatformUser(request.steward_user_id);
    } catch {
      const retryAt = new Date(input.now.getTime() + CANCELLATION_RETRY_MILLISECONDS);
      if (lease.receipt.status === "reconciling") {
        await accountDeletionRequestsRepository.deferPhaseReconciliation({
          phaseReceiptId: lease.receipt.id,
          generation: lease.generation,
          errorCode: "STEWARD_REACTIVATION_INSPECTION_FAILED",
          now: input.now,
          retryAt,
        });
      } else {
        await accountDeletionRequestsRepository.markPhaseRetryable({
          phaseReceiptId: lease.receipt.id,
          generation: lease.generation,
          errorCode: "STEWARD_REACTIVATION_INSPECTION_FAILED",
          retryClass: "definite_pre_provider_failure",
          now: input.now,
          retryAt,
        });
      }
      result.reconciling++;
      continue;
    }

    if (state === "active") {
      const completed = await accountDeletionRequestsRepository.completeStewardReactivationPhase({
        requestId: request.id,
        phaseReceiptId: lease.receipt.id,
        generation: lease.generation,
        providerReceiptDigest: createHash("sha256")
          .update(`steward-reactivation-inspection:v1:${request.steward_user_id}`)
          .digest("hex"),
        now: input.now,
      });
      if (completed) result.completed++;
      continue;
    }
    if (state === "absent") {
      const parked = await accountDeletionRequestsRepository.markPhaseActionRequired({
        requestId: request.id,
        phaseReceiptId: lease.receipt.id,
        generation: lease.generation,
        errorCode: "STEWARD_IDENTITY_MISSING_DURING_CANCELLATION",
        now: input.now,
      });
      if (parked) result.actionRequired++;
      continue;
    }
    if (lease.receipt.status === "reconciling") {
      await accountDeletionRequestsRepository.markPhaseRetryable({
        phaseReceiptId: lease.receipt.id,
        generation: lease.generation,
        errorCode: "STEWARD_REACTIVATION_ABSENCE_CONFIRMED",
        retryClass: "provider_absence_confirmed",
        now: input.now,
        retryAt: new Date(input.now.getTime() + CANCELLATION_RETRY_MILLISECONDS),
      });
      result.reconciling++;
      continue;
    }

    const started = await accountDeletionRequestsRepository.markPhaseProviderCallStarted(
      lease.receipt.id,
      lease.generation,
      input.now,
      createHash("sha256").update(`steward-reactivation-operation:v1:${request.id}`).digest("hex"),
    );
    if (!started) continue;
    try {
      await reactivateStewardPlatformUser(request.steward_user_id);
      if ((await inspectStewardPlatformUser(request.steward_user_id)) !== "active") {
        throw new ElizaError("Steward reactivation was not visible after acknowledgement", {
          code: "ACCOUNT_DELETION_STEWARD_REACTIVATION_NOT_VISIBLE",
          severity: "ephemeral",
        });
      }
      const completed = await accountDeletionRequestsRepository.completeStewardReactivationPhase({
        requestId: request.id,
        phaseReceiptId: lease.receipt.id,
        generation: lease.generation,
        providerReceiptDigest: createHash("sha256")
          .update(`steward-reactivation:v1:${request.steward_user_id}`)
          .digest("hex"),
        now: new Date(),
      });
      if (completed) result.completed++;
    } catch {
      const failedAt = new Date();
      await accountDeletionRequestsRepository.markPhaseForReconciliation({
        phaseReceiptId: lease.receipt.id,
        generation: lease.generation,
        errorCode: "STEWARD_REACTIVATION_AMBIGUOUS",
        now: failedAt,
        retryAt: new Date(failedAt.getTime() + CANCELLATION_RETRY_MILLISECONDS),
      });
      result.reconciling++;
    }
  }
  return result;
}

export interface ProcessAccountDeletionResult {
  exportRevocations: AccountDeletionExportRevocationResult;
  stewardReactivationReconciliations: number;
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
  backupAuthority?: AccountDeletionBackupAuthority;
  spoolAuthority?: AccountDeletionSpoolAuthority;
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
    throw new ElizaError("Account deletion requires a valid Cloud object-storage binding", {
      code: "ACCOUNT_DELETION_OBJECT_STORAGE_INVALID",
      severity: "fatal",
    });
  }
  if (!resources.purgeOrganizationResources && typeof blob.list !== "function") {
    throw new ElizaError(
      "Account deletion's default resource purge requires Cloud object listing",
      {
        code: "ACCOUNT_DELETION_OBJECT_LISTING_UNAVAILABLE",
        severity: "fatal",
      },
    );
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
  const stewardReactivations = await reconcileCancelingStewardReactivations({ limit, now });
  const adapters =
    resources.adapters ??
    createAccountDeletionProviderAdapters({
      backupAuthority: resources.backupAuthority,
      spoolAuthority: resources.spoolAuthority,
    });
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
    allowedPhases:
      resources.backupAuthority && resources.spoolAuthority
        ? undefined
        : new Set(
            Object.keys(adapters).filter(
              (phase) => phase !== "secondary_backups" && phase !== "spools",
            ) as AccountDeletionProviderPhase[],
          ),
    now,
  });

  const recovered = await accountDeletionRequestsRepository.recoverStaleProcessing(
    new Date(now.getTime() - 15 * 60 * 1_000),
  );
  const due = await accountDeletionRequestsRepository.claimDue(limit);
  const result = {
    exportRevocations,
    stewardReactivationReconciliations: stewardReactivations.completed,
    cancellationsFinalized,
    stewardDeactivationReconciliations: stewardDeactivations.completed,
    activated,
    recovered,
    processed: saga.processed + due.length,
    completed: saga.completed,
    progressed: saga.progressed,
    reconciling: saga.reconciling,
    actionRequired:
      saga.actionRequired +
      activationActionRequired +
      stewardDeactivations.actionRequired +
      stewardReactivations.actionRequired,
  };

  for (const request of due) {
    try {
      if (!request.steward_user_id || !request.user_id) {
        throw new ElizaError("Claimed deletion request is missing account identifiers", {
          code: "ACCOUNT_DELETION_CLAIM_IDENTIFIERS_MISSING",
          severity: "fatal",
        });
      }
      if (!request.organization_id) {
        throw new ElizaError("Claimed deletion request is missing its organization identifier", {
          code: "ACCOUNT_DELETION_CLAIM_ORGANIZATION_MISSING",
          severity: "fatal",
        });
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
