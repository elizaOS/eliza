/** Atomically converts one exact admission lease into a catalogue reservation. */

import { and, eq, gt, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import { agentBackupAdmissionWork } from "../schemas/agent-backup-admission";
import { agentNodeIncarnationHistories } from "../schemas/agent-node-incarnation-histories";
import { agentSandboxBackups, agentSandboxes } from "../schemas/agent-sandboxes";
import { organizations } from "../schemas/organizations";
import type { AgentBackupAdmissionClaim } from "./agent-backup-admission-claim";
import {
  AgentBackupCatalogConflictError,
  lockAgentBackupReservationReplayInTransaction,
  reserveAgentBackupOperationInTransaction,
} from "./agent-backup-catalog";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export const DEFAULT_AGENT_BACKUP_ADMISSION_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const AGENT_BACKUP_ADMISSION_RESERVED_REASON = "CAPTURE_RESERVED" as const;

const MIN_RETENTION_MS = 24 * 60 * 60_000;
const MAX_RETENTION_MS = 365 * 24 * 60 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface AgentBackupAdmissionReservation {
  workId: string;
  operationId: string;
  backupId: string;
  replayed: boolean;
}

function conflict(message: string): never {
  throw new AgentBackupCatalogConflictError(message);
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(`${field} must be a canonical lowercase UUID`);
}

function requireCanonicalNonNegativeInteger(value: string, field: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a canonical non-negative integer`);
  }
}

function requireCanonicalPositiveInteger(value: string, field: string): void {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${field} must be a canonical positive integer`);
  }
}

function requireDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${field} must be a valid Date`);
  }
}

function requireRetentionMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_RETENTION_MS || value > MAX_RETENTION_MS) {
    throw new Error(
      `retentionMs must be a safe integer between ${MIN_RETENTION_MS} and ${MAX_RETENTION_MS}`,
    );
  }
  return value;
}

function validateClaim(claim: AgentBackupAdmissionClaim): void {
  requireUuid(claim.workId, "claim.workId");
  requireUuid(claim.organizationId, "claim.organizationId");
  requireUuid(claim.sandboxId, "claim.sandboxId");
  requireUuid(claim.nodeHistoryId, "claim.nodeHistoryId");
  requireUuid(claim.sourceActivationGeneration, "claim.sourceActivationGeneration");
  requireUuid(claim.generation, "claim.generation");
  requireCanonicalNonNegativeInteger(
    claim.sourceLifecycleRevision,
    "claim.sourceLifecycleRevision",
  );
  requireCanonicalPositiveInteger(claim.claimCycleStartTurn, "claim.claimCycleStartTurn");
  requireCanonicalPositiveInteger(claim.claimProofTurn, "claim.claimProofTurn");
  requireCanonicalPositiveInteger(claim.claimProofXid, "claim.claimProofXid");
  if (!Number.isSafeInteger(claim.workAttempt) || claim.workAttempt < 1) {
    throw new Error("claim.workAttempt must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(claim.claimProofPriorityPass) ||
    claim.claimProofPriorityPass < 0 ||
    claim.claimProofPriorityPass > 3
  ) {
    throw new Error("claim.claimProofPriorityPass must be between 0 and 3");
  }
  if (claim.effectivePriority !== claim.claimProofPriorityPass) {
    throw new Error("claim effective priority must match its trigger-owned proof");
  }
  if (
    !Number.isSafeInteger(claim.sourceRpoMs) ||
    claim.sourceRpoMs < 60_000 ||
    claim.sourceRpoMs > 900_000
  ) {
    throw new Error("claim.sourceRpoMs must be between 60000 and 900000");
  }
  if (
    claim.sourceProviderHandle !== claim.sourceProviderHandle.trim() ||
    new TextEncoder().encode(claim.sourceProviderHandle).byteLength < 1 ||
    new TextEncoder().encode(claim.sourceProviderHandle).byteLength > 512 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(claim.sourceProviderHandle)
  ) {
    throw new Error("claim.sourceProviderHandle is not canonical");
  }
  if (!/^[0-9a-f]{64}$/.test(claim.sourceContainerId)) {
    throw new Error("claim.sourceContainerId must be a canonical immutable Docker ID");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(claim.sourceImageDigest)) {
    throw new Error("claim.sourceImageDigest must be a canonical sha256 digest");
  }
  requireDate(claim.sourceDueAt, "claim.sourceDueAt");
  requireDate(claim.rpoDeadlineAt, "claim.rpoDeadlineAt");
  requireDate(claim.firstEligibleAt, "claim.firstEligibleAt");
  requireDate(claim.expiresAt, "claim.expiresAt");
}

type LockedAdmissionWork = Awaited<ReturnType<typeof lockAdmissionWork>>;

async function lockAdmissionWork(tx: DbTransaction, workId: string) {
  const [work] = await tx
    .select({
      id: agentBackupAdmissionWork.id,
      workKind: agentBackupAdmissionWork.work_kind,
      workStage: agentBackupAdmissionWork.work_stage,
      organizationId: agentBackupAdmissionWork.organization_id,
      sandboxId: agentBackupAdmissionWork.sandbox_id,
      nodeHistoryId: agentBackupAdmissionWork.node_history_id,
      sourceActivationGeneration: agentBackupAdmissionWork.source_activation_generation,
      sourceLifecycleRevision: agentBackupAdmissionWork.source_lifecycle_revision,
      sourceProviderHandle: agentBackupAdmissionWork.source_provider_handle,
      sourceContainerId: agentBackupAdmissionWork.source_container_id,
      sourceImageDigest: agentBackupAdmissionWork.source_image_digest,
      sourceRpoMs: agentBackupAdmissionWork.source_rpo_ms,
      sourceDueAt: agentBackupAdmissionWork.source_due_at,
      rpoDeadlineAt: agentBackupAdmissionWork.rpo_deadline_at,
      firstEligibleAt: agentBackupAdmissionWork.first_eligible_at,
      state: agentBackupAdmissionWork.state,
      leaseOwner: agentBackupAdmissionWork.lease_owner,
      leaseGeneration: agentBackupAdmissionWork.lease_generation,
      leaseExpiresAt: agentBackupAdmissionWork.lease_expires_at,
      attempts: agentBackupAdmissionWork.attempts,
      claimCycleStartTurn: agentBackupAdmissionWork.claim_cycle_start_turn,
      claimProofTurn: agentBackupAdmissionWork.claim_proof_turn,
      claimProofXid: agentBackupAdmissionWork.claim_proof_xid,
      claimProofPriorityPass: agentBackupAdmissionWork.claim_proof_priority_pass,
      claimProofAttempt: agentBackupAdmissionWork.claim_proof_attempt,
      settledAt: agentBackupAdmissionWork.settled_at,
      settledReason: agentBackupAdmissionWork.settled_reason,
    })
    .from(agentBackupAdmissionWork)
    .where(eq(agentBackupAdmissionWork.id, workId))
    .for("update")
    .limit(1);
  if (!work) conflict("Backup admission work disappeared before reservation");
  return work;
}

async function lockActiveOrganization(
  tx: DbTransaction,
  claim: AgentBackupAdmissionClaim,
): Promise<void> {
  const [organization] = await tx
    .select({
      lifecycleState: organizations.account_lifecycle_state,
      deletionRequestId: organizations.account_deletion_request_id,
      paidWorkFencedAt: organizations.paid_work_fenced_at,
      isActive: organizations.is_active,
    })
    .from(organizations)
    .where(eq(organizations.id, claim.organizationId))
    .for("share")
    .limit(1);
  if (
    !organization ||
    organization.lifecycleState !== "active" ||
    organization.deletionRequestId !== null ||
    organization.paidWorkFencedAt !== null ||
    !organization.isActive
  ) {
    conflict("Backup admission organization no longer permits paid work");
  }
}

function sameDate(left: Date | null, right: Date): boolean {
  return left instanceof Date && left.getTime() === right.getTime();
}

function assertClaimMatchesWork(claim: AgentBackupAdmissionClaim, work: LockedAdmissionWork): void {
  const exactIdentity =
    work.id === claim.workId &&
    work.workKind === "schedule_capture" &&
    work.workStage === "reserve_capture" &&
    work.organizationId === claim.organizationId &&
    work.sandboxId === claim.sandboxId &&
    work.nodeHistoryId === claim.nodeHistoryId &&
    work.sourceActivationGeneration === claim.sourceActivationGeneration &&
    work.sourceLifecycleRevision?.toString() === claim.sourceLifecycleRevision &&
    work.sourceProviderHandle === claim.sourceProviderHandle &&
    work.sourceContainerId === claim.sourceContainerId &&
    work.sourceImageDigest === claim.sourceImageDigest &&
    work.sourceRpoMs === claim.sourceRpoMs &&
    sameDate(work.sourceDueAt, claim.sourceDueAt) &&
    sameDate(work.rpoDeadlineAt, claim.rpoDeadlineAt) &&
    sameDate(work.firstEligibleAt, claim.firstEligibleAt) &&
    work.attempts === claim.workAttempt &&
    work.claimCycleStartTurn?.toString() === claim.claimCycleStartTurn &&
    work.claimProofTurn?.toString() === claim.claimProofTurn &&
    work.claimProofXid === claim.claimProofXid &&
    work.claimProofPriorityPass === claim.claimProofPriorityPass &&
    work.claimProofAttempt === claim.workAttempt;
  if (!exactIdentity) conflict("Backup admission claim no longer matches its durable work");

  if (work.state === "leased") {
    if (
      work.leaseOwner !== claim.ownerId ||
      work.leaseGeneration !== claim.generation ||
      work.leaseExpiresAt === null ||
      work.settledAt !== null ||
      work.settledReason !== null
    ) {
      conflict("Backup admission claim lease fence is stale");
    }
    return;
  }
  if (
    work.state !== "settled" ||
    work.settledReason !== AGENT_BACKUP_ADMISSION_RESERVED_REASON ||
    work.settledAt === null ||
    work.leaseOwner !== null ||
    work.leaseGeneration !== null ||
    work.leaseExpiresAt !== null
  ) {
    conflict("Backup admission work was settled by a different outcome");
  }
}

async function readSourceOccurrence(tx: DbTransaction, claim: AgentBackupAdmissionClaim) {
  const [source] = await tx
    .select({
      nodeHistoryId: agentNodeIncarnationHistories.id,
      nodeRecordId: agentNodeIncarnationHistories.docker_node_record_id,
      nodeId: agentNodeIncarnationHistories.node_id,
      nodeIncarnation: agentNodeIncarnationHistories.node_incarnation,
      fleetKind: agentNodeIncarnationHistories.fleet_kind,
      infrastructureProvider: agentNodeIncarnationHistories.infrastructure_provider,
      providerServerId: agentNodeIncarnationHistories.provider_server_id,
    })
    .from(agentNodeIncarnationHistories)
    .where(eq(agentNodeIncarnationHistories.id, claim.nodeHistoryId))
    .limit(1);
  if (
    !source ||
    source.infrastructureProvider !== "hetzner" ||
    (source.fleetKind !== "robot" && source.fleetKind !== "cloud") ||
    (source.fleetKind === "robot" && source.providerServerId !== null) ||
    (source.fleetKind === "cloud" && source.providerServerId === null)
  ) {
    conflict("Backup admission source occurrence authority is missing or malformed");
  }
  return source;
}

function assertPersistedReservationMatches(params: {
  backup: typeof agentSandboxBackups.$inferSelect;
  claim: AgentBackupAdmissionClaim;
  source: Awaited<ReturnType<typeof readSourceOccurrence>>;
}): void {
  const { backup, claim, source } = params;
  const sourceProvider = source.fleetKind === "robot" ? "operator-onboarded" : "hetzner-cloud";
  if (
    backup.backup_operation_id !== claim.workId ||
    backup.catalog_organization_id !== claim.organizationId ||
    backup.catalog_agent_id !== claim.sandboxId ||
    backup.sandbox_record_id !== claim.sandboxId ||
    backup.lifecycle_generation !== claim.sourceActivationGeneration ||
    backup.lifecycle_revision?.toString() !== claim.sourceLifecycleRevision ||
    backup.snapshot_type !== "auto" ||
    backup.backup_kind !== "full" ||
    backup.parent_backup_id !== null ||
    backup.base_backup_id !== null ||
    backup.source_provider !== sourceProvider ||
    backup.source_node_record_id !== source.nodeRecordId ||
    backup.source_node_id !== source.nodeId ||
    backup.source_node_incarnation !== source.nodeIncarnation ||
    backup.source_node_history_id !== source.nodeHistoryId ||
    backup.source_provider_server_id !== source.providerServerId ||
    backup.source_provider_handle !== claim.sourceProviderHandle ||
    backup.source_container_id !== claim.sourceContainerId ||
    backup.retention_reason !== "schedule" ||
    backup.retention_until === null ||
    backup.catalog_payload_digest === null ||
    backup.catalog_state === null ||
    backup.catalog_revision <= 0n
  ) {
    conflict("Backup admission operation was already reserved with a different payload");
  }
}

/**
 * Reserve `operationId = workId` and consume the exact admission fence in one
 * primary-database transaction. This repository performs no remote effect,
 * node-capacity mutation, provider discovery, or autoscaling.
 */
export async function reserveAndSettleAgentBackupAdmissionClaim(params: {
  claim: AgentBackupAdmissionClaim;
  retentionMs?: number;
}): Promise<AgentBackupAdmissionReservation> {
  const claim = params.claim;
  validateClaim(claim);
  const retentionMs = requireRetentionMs(
    params.retentionMs ?? DEFAULT_AGENT_BACKUP_ADMISSION_RETENTION_MS,
  );

  return dbWrite.transaction(async (tx) => {
    // This must remain the first lock: catalog capture paths lock an existing
    // operation backup before sandbox/source/catalog authorities.
    await lockAgentBackupReservationReplayInTransaction(tx, {
      organizationId: claim.organizationId,
      agentId: claim.sandboxId,
      operationId: claim.workId,
    });

    // Account deletion owns this row before publishing its paid-work fence.
    // Keep the same organization-before-work order as claim recovery so the
    // live claim cannot cross a deletion activation boundary.
    await lockActiveOrganization(tx, claim);
    const work = await lockAdmissionWork(tx, claim.workId);
    assertClaimMatchesWork(claim, work);
    const source = await readSourceOccurrence(tx, claim);
    const [existingBackup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.catalog_organization_id, claim.organizationId),
          eq(agentSandboxBackups.catalog_agent_id, claim.sandboxId),
          eq(agentSandboxBackups.backup_operation_id, claim.workId),
        ),
      )
      .limit(1);

    if (work.state === "settled") {
      if (!existingBackup) {
        conflict("Settled backup admission work has no catalogue reservation");
      }
      assertPersistedReservationMatches({ backup: existingBackup, claim, source });
      return {
        workId: claim.workId,
        operationId: claim.workId,
        backupId: existingBackup.id,
        replayed: true,
      };
    }

    const [sandbox] = await tx
      .select({
        id: agentSandboxes.id,
        organizationId: agentSandboxes.organization_id,
        activationImageDigest: agentSandboxes.activation_image_digest,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, claim.sandboxId),
          eq(agentSandboxes.organization_id, claim.organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!sandbox || sandbox.activationImageDigest !== claim.sourceImageDigest) {
      conflict("Backup admission source image no longer matches");
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (!(work.leaseExpiresAt instanceof Date) || work.leaseExpiresAt <= databaseNow) {
      conflict("Backup admission claim expired while waiting for source authority");
    }
    const retentionUntil = existingBackup?.retention_until
      ? existingBackup.retention_until
      : new Date(databaseNow.getTime() + retentionMs);
    const backup = await reserveAgentBackupOperationInTransaction(tx, {
      organizationId: claim.organizationId,
      agentId: claim.sandboxId,
      sandboxRecordId: claim.sandboxId,
      operationId: claim.workId,
      activationGeneration: claim.sourceActivationGeneration,
      lifecycleRevision: claim.sourceLifecycleRevision,
      snapshotType: "auto",
      backupKind: "full",
      sourceProvider: source.fleetKind === "robot" ? "operator-onboarded" : "hetzner-cloud",
      sourceNodeRecordId: source.nodeRecordId,
      sourceNodeId: source.nodeId,
      sourceNodeIncarnation: source.nodeIncarnation,
      sourceProviderServerId: source.providerServerId,
      sourceProviderHandle: claim.sourceProviderHandle,
      sourceContainerId: claim.sourceContainerId,
      retentionReason: "schedule",
      retentionUntil,
    });

    const [settled] = await tx
      .update(agentBackupAdmissionWork)
      .set({
        state: "settled",
        deferred_reason: null,
        lease_owner: null,
        lease_generation: null,
        lease_expires_at: null,
        settled_at: sql`clock_timestamp()`,
        settled_reason: AGENT_BACKUP_ADMISSION_RESERVED_REASON,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(agentBackupAdmissionWork.id, claim.workId),
          eq(agentBackupAdmissionWork.work_kind, "schedule_capture"),
          eq(agentBackupAdmissionWork.work_stage, "reserve_capture"),
          eq(agentBackupAdmissionWork.state, "leased"),
          eq(agentBackupAdmissionWork.organization_id, claim.organizationId),
          eq(agentBackupAdmissionWork.sandbox_id, claim.sandboxId),
          eq(agentBackupAdmissionWork.node_history_id, claim.nodeHistoryId),
          eq(
            agentBackupAdmissionWork.source_activation_generation,
            claim.sourceActivationGeneration,
          ),
          eq(
            agentBackupAdmissionWork.source_lifecycle_revision,
            BigInt(claim.sourceLifecycleRevision),
          ),
          eq(agentBackupAdmissionWork.source_provider_handle, claim.sourceProviderHandle),
          eq(agentBackupAdmissionWork.source_container_id, claim.sourceContainerId),
          eq(agentBackupAdmissionWork.source_image_digest, claim.sourceImageDigest),
          eq(agentBackupAdmissionWork.source_rpo_ms, claim.sourceRpoMs),
          eq(agentBackupAdmissionWork.lease_owner, claim.ownerId),
          eq(agentBackupAdmissionWork.lease_generation, claim.generation),
          eq(agentBackupAdmissionWork.attempts, claim.workAttempt),
          eq(agentBackupAdmissionWork.claim_cycle_start_turn, BigInt(claim.claimCycleStartTurn)),
          eq(agentBackupAdmissionWork.claim_proof_turn, BigInt(claim.claimProofTurn)),
          eq(agentBackupAdmissionWork.claim_proof_xid, claim.claimProofXid),
          eq(agentBackupAdmissionWork.claim_proof_priority_pass, claim.claimProofPriorityPass),
          eq(agentBackupAdmissionWork.claim_proof_attempt, claim.workAttempt),
          gt(agentBackupAdmissionWork.lease_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: agentBackupAdmissionWork.id });
    if (!settled) {
      conflict("Backup admission reservation lost its final live-fence CAS");
    }

    return {
      workId: claim.workId,
      operationId: claim.workId,
      backupId: backup.id,
      replayed: Boolean(existingBackup),
    };
  });
}
