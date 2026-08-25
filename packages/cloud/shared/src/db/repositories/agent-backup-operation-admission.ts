/** Atomic global-lane admission for one exact, live-source backup capture. */

import { ElizaError } from "@elizaos/core";
import { and, eq, gt, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  type AgentBackupOperationLane,
  agentBackupOperationNodeWatermarks,
  agentBackupOperationTenantWatermarks,
} from "../schemas/agent-backup-operation-lane";
import { agentActivationPublications } from "../schemas/agent-backup-restore-history";
import { agentNodeIncarnationHistories } from "../schemas/agent-node-incarnation-histories";
import {
  agentSandboxBackups,
  agentSandboxes,
  type StoredAgentSandboxBackup,
} from "../schemas/agent-sandboxes";
import { dockerNodes } from "../schemas/docker-nodes";
import { organizations } from "../schemas/organizations";
import type { AgentBackupOperationClaim } from "./agent-backup-catalog";
import {
  type AgentBackupOperationLaneCallerToken,
  type AgentBackupOperationLaneExecution,
  type AgentBackupOperationLaneTarget,
  claimAgentBackupOperationLaneInTransaction,
  lockAgentBackupOperationLaneInTransaction,
  normalizeAgentBackupOperationLaneCallerToken,
  normalizeAgentBackupOperationLaneLeaseMs,
  refreshAgentBackupOperationLaneProofInTransaction,
  renewAgentBackupOperationLaneInTransaction,
} from "./agent-backup-operation-lane";

const CAPTURE_OWNED_STATES = ["scheduled", "capturing"] as const;

export interface AgentBackupOperationAdmission {
  readonly claim: Readonly<AgentBackupOperationClaim>;
  readonly laneExecution: Readonly<AgentBackupOperationLaneExecution>;
  readonly sourceNodeHistoryId: string;
}

export type AgentBackupOperationAdmissionResult =
  | {
      readonly kind: "claimed" | "replayed";
      readonly admission: AgentBackupOperationAdmission;
    }
  | { readonly kind: "empty" }
  | {
      readonly kind: "busy";
      readonly lane: Readonly<AgentBackupOperationLane>;
      readonly databaseNow: Date;
    };

interface ExactSourceAuthority {
  readonly sourceNodeHistoryId: string;
  readonly sourceNodeRecordId: string;
  readonly sourceNodeIncarnation: string;
}

function admissionLost(message: string): ElizaError {
  return new ElizaError(message, {
    code: "AGENT_BACKUP_OPERATION_ADMISSION_LOST",
    severity: "fatal",
  });
}

function laneIsActive(lane: AgentBackupOperationLane, databaseNow: Date): boolean {
  return (
    lane.released_at === null &&
    lane.lease_expires_at !== null &&
    lane.lease_expires_at.getTime() > databaseNow.getTime()
  );
}

function observedLane(lane: AgentBackupOperationLane): Readonly<AgentBackupOperationLane> {
  return Object.freeze({ ...lane });
}

function targetFor(backup: StoredAgentSandboxBackup): AgentBackupOperationLaneTarget {
  if (!backup.catalog_organization_id || !backup.backup_operation_id) {
    throw admissionLost("Backup operation is missing its exact catalogue target");
  }
  return Object.freeze({
    organizationId: backup.catalog_organization_id,
    backupId: backup.id,
    operationId: backup.backup_operation_id,
  });
}

function activeState(backup: StoredAgentSandboxBackup): boolean {
  return (
    CAPTURE_OWNED_STATES.some((state) => state === backup.catalog_state) ||
    (backup.catalog_state === "failed_retryable" &&
      CAPTURE_OWNED_STATES.some((state) => state === backup.catalog_resume_state))
  );
}

function exactLeaseExpiry(lane: Readonly<AgentBackupOperationLane>, field: string): Date {
  if (!(lane.lease_expires_at instanceof Date)) {
    throw admissionLost(`${field} is missing its global-lane lease expiry`);
  }
  return new Date(lane.lease_expires_at.getTime());
}

function admissionFor(params: {
  backup: StoredAgentSandboxBackup;
  execution: AgentBackupOperationLaneExecution;
  sourceNodeHistoryId: string;
}): AgentBackupOperationAdmission {
  const backup = Object.freeze({ ...params.backup });
  const execution = Object.freeze({ ...params.execution });
  return Object.freeze({
    claim: Object.freeze({
      backup,
      ownerId: execution.ownerId,
      generation: execution.generation,
    }),
    laneExecution: execution,
    sourceNodeHistoryId: params.sourceNodeHistoryId,
  });
}

async function lockBackupByTargetInTransaction(
  tx: DbTransaction,
  target: AgentBackupOperationLaneTarget,
): Promise<StoredAgentSandboxBackup> {
  const [backup] = await tx
    .select()
    .from(agentSandboxBackups)
    .where(
      and(
        eq(agentSandboxBackups.id, target.backupId),
        eq(agentSandboxBackups.catalog_organization_id, target.organizationId),
        eq(agentSandboxBackups.backup_operation_id, target.operationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!backup || !activeState(backup)) {
    throw admissionLost("Global lane target no longer names an executable backup operation");
  }
  return backup;
}

/**
 * The global lane is already held before this function locks the backup row.
 * Only live-source capture states are eligible here. Publication, verification,
 * and GC must use a detached admission path that survives source-node loss.
 */
async function lockNextDueBackupInTransaction(
  tx: DbTransaction,
): Promise<StoredAgentSandboxBackup | null> {
  const [candidate] = await tx
    .select({ id: agentSandboxBackups.id })
    .from(agentSandboxBackups)
    .innerJoin(
      agentSandboxes,
      and(
        eq(agentSandboxes.id, agentSandboxBackups.sandbox_record_id),
        eq(agentSandboxes.id, agentSandboxBackups.catalog_agent_id),
        eq(agentSandboxes.organization_id, agentSandboxBackups.catalog_organization_id),
        eq(agentSandboxes.status, "running"),
        eq(agentSandboxes.activation_phase, "active"),
        eq(agentSandboxes.activation_generation, agentSandboxBackups.lifecycle_generation),
        sql`${agentSandboxes.lifecycle_revision}::numeric
          = ${agentSandboxBackups.lifecycle_revision}`,
        sql`${agentSandboxes.activation_lifecycle_revision}::numeric
          = ${agentSandboxBackups.lifecycle_revision}`,
        eq(agentSandboxes.node_id, agentSandboxBackups.source_node_id),
        eq(agentSandboxes.activation_node_id, agentSandboxBackups.source_node_id),
        eq(agentSandboxes.sandbox_id, agentSandboxBackups.source_provider_handle),
        eq(agentSandboxes.activation_container_id, agentSandboxBackups.source_container_id),
        eq(agentSandboxes.activation_boot_id, agentSandboxBackups.source_node_incarnation),
        sql`${agentSandboxes.activation_receipt} IS NOT NULL`,
        sql`${agentSandboxes.activation_receipt_hash} IS NOT NULL`,
        sql`${agentSandboxes.activation_image_digest} IS NOT NULL`,
        sql`${agentSandboxes.activation_boot_id} IS NOT NULL`,
        sql`${agentSandboxes.activation_token_hash} IS NOT NULL`,
        sql`${agentSandboxes.activation_funding_revision} IS NOT NULL`,
        sql`${agentSandboxes.activation_authority_published_at} IS NOT NULL`,
        sql`${agentSandboxes.activation_dispatched_at} IS NOT NULL`,
        sql`${agentSandboxes.activation_completed_at} IS NOT NULL`,
      ),
    )
    .innerJoin(
      agentActivationPublications,
      and(
        eq(
          agentActivationPublications.organization_id,
          agentSandboxBackups.catalog_organization_id,
        ),
        eq(agentActivationPublications.agent_id, agentSandboxBackups.catalog_agent_id),
        eq(
          agentActivationPublications.activation_generation,
          agentSandboxBackups.lifecycle_generation,
        ),
        eq(agentActivationPublications.lifecycle_revision, agentSandboxBackups.lifecycle_revision),
        eq(agentActivationPublications.purpose, agentSandboxes.activation_purpose),
        sql`${agentActivationPublications.previous_activation_generation}
          IS NOT DISTINCT FROM ${agentSandboxes.activation_previous_generation}`,
        sql`${agentActivationPublications.backup_id}
          IS NOT DISTINCT FROM ${agentSandboxes.activation_backup_id}`,
        sql`${agentActivationPublications.backup_manifest_sha256}
          IS NOT DISTINCT FROM ${agentSandboxes.activation_backup_hash}`,
        sql`${agentActivationPublications.activation_receipt}
          = ${agentSandboxes.activation_receipt}`,
        eq(
          agentActivationPublications.activation_receipt_sha256,
          agentSandboxes.activation_receipt_hash,
        ),
        eq(agentActivationPublications.container_id, agentSandboxBackups.source_container_id),
        eq(agentActivationPublications.image_digest, agentSandboxes.activation_image_digest),
        eq(
          agentActivationPublications.published_at,
          agentSandboxes.activation_authority_published_at,
        ),
        eq(
          agentActivationPublications.docker_node_record_id,
          agentSandboxBackups.source_node_record_id,
        ),
        eq(agentActivationPublications.node_id, agentSandboxBackups.source_node_id),
        eq(
          agentActivationPublications.node_incarnation,
          agentSandboxBackups.source_node_incarnation,
        ),
        eq(agentActivationPublications.node_incarnation, agentSandboxes.activation_boot_id),
        eq(agentActivationPublications.token_sha256, agentSandboxes.activation_token_hash),
        eq(
          agentActivationPublications.funding_revision,
          agentSandboxes.activation_funding_revision,
        ),
      ),
    )
    .innerJoin(
      dockerNodes,
      and(
        eq(dockerNodes.id, agentSandboxBackups.source_node_record_id),
        eq(dockerNodes.node_id, agentSandboxBackups.source_node_id),
        eq(dockerNodes.node_incarnation, agentSandboxBackups.source_node_incarnation),
        eq(dockerNodes.current_node_history_id, agentActivationPublications.node_history_id),
      ),
    )
    .innerJoin(
      agentNodeIncarnationHistories,
      and(
        eq(agentNodeIncarnationHistories.id, agentActivationPublications.node_history_id),
        eq(agentNodeIncarnationHistories.docker_node_record_id, dockerNodes.id),
        eq(agentNodeIncarnationHistories.node_id, dockerNodes.node_id),
        eq(agentNodeIncarnationHistories.node_incarnation, dockerNodes.node_incarnation),
        eq(agentNodeIncarnationHistories.fleet_kind, dockerNodes.fleet_kind),
        eq(
          agentNodeIncarnationHistories.infrastructure_provider,
          dockerNodes.infrastructure_provider,
        ),
        sql`${agentNodeIncarnationHistories.provider_server_id}
          IS NOT DISTINCT FROM ${dockerNodes.provider_server_id}`,
        eq(agentNodeIncarnationHistories.host_key_fingerprint, dockerNodes.host_key_fingerprint),
      ),
    )
    .leftJoin(
      agentBackupOperationTenantWatermarks,
      eq(
        agentBackupOperationTenantWatermarks.organization_id,
        agentSandboxBackups.catalog_organization_id,
      ),
    )
    .leftJoin(
      agentBackupOperationNodeWatermarks,
      eq(
        agentBackupOperationNodeWatermarks.source_node_history_id,
        dockerNodes.current_node_history_id,
      ),
    )
    .where(
      and(
        eq(agentSandboxBackups.catalog_version, 2),
        sql`${agentSandboxBackups.sandbox_record_id} IS NOT NULL`,
        sql`${agentSandboxBackups.catalog_organization_id} IS NOT NULL`,
        sql`${agentSandboxBackups.backup_operation_id} IS NOT NULL`,
        sql`${agentSandboxBackups.source_provider} IN ('operator-onboarded', 'hetzner-cloud')`,
        sql`${agentSandboxBackups.source_node_record_id} IS NOT NULL`,
        sql`${agentSandboxBackups.source_node_id} IS NOT NULL
          AND ${agentSandboxBackups.source_node_id} <> ''`,
        sql`${agentSandboxBackups.source_node_incarnation} IS NOT NULL`,
        sql`${agentSandboxBackups.source_provider_handle} IS NOT NULL
          AND ${agentSandboxBackups.source_provider_handle} <> ''`,
        sql`${agentSandboxBackups.source_container_id} ~ '^[0-9a-f]{64}$'`,
        eq(dockerNodes.infrastructure_provider, "hetzner"),
        sql`(
          (${agentSandboxBackups.source_provider} = 'operator-onboarded'
            AND ${agentSandboxBackups.source_provider_server_id} IS NULL
            AND ${dockerNodes.fleet_kind} = 'robot'
            AND ${dockerNodes.provider_server_id} IS NULL)
          OR
          (${agentSandboxBackups.source_provider} = 'hetzner-cloud'
            AND ${dockerNodes.fleet_kind} = 'cloud'
            AND ${dockerNodes.provider_server_id}
              = ${agentSandboxBackups.source_provider_server_id})
        )`,
        sql`(${agentSandboxBackups.catalog_state} IN ('scheduled', 'capturing')
          OR (${agentSandboxBackups.catalog_state} = 'failed_retryable'
            AND ${agentSandboxBackups.catalog_resume_state} IN ('scheduled', 'capturing')))`,
        sql`(${agentSandboxBackups.catalog_next_attempt_at} IS NULL
          OR ${agentSandboxBackups.catalog_next_attempt_at} <= clock_timestamp())`,
        sql`(${agentSandboxBackups.catalog_lease_expires_at} IS NULL
          OR ${agentSandboxBackups.catalog_lease_expires_at} <= clock_timestamp())`,
      ),
    )
    .orderBy(
      sql`COALESCE(${agentBackupOperationTenantWatermarks.service_count}, 0)`,
      sql`COALESCE(${agentBackupOperationNodeWatermarks.service_count}, 0)`,
      sql`COALESCE(${agentBackupOperationTenantWatermarks.last_served_at}, '-infinity'::timestamptz)`,
      sql`COALESCE(${agentBackupOperationNodeWatermarks.last_served_at}, '-infinity'::timestamptz)`,
      sql`COALESCE(${agentSandboxBackups.catalog_next_attempt_at}, ${agentSandboxBackups.created_at})`,
      agentSandboxBackups.created_at,
      agentSandboxBackups.id,
    )
    .for("update", { of: agentSandboxBackups, skipLocked: true })
    .limit(1);
  if (!candidate) return null;

  const [backup] = await tx
    .select()
    .from(agentSandboxBackups)
    .where(eq(agentSandboxBackups.id, candidate.id))
    .for("update")
    .limit(1);
  if (!backup) throw admissionLost("Selected backup operation disappeared while locked");
  return backup;
}

async function lockExactSourceAuthorityInTransaction(
  tx: DbTransaction,
  backup: StoredAgentSandboxBackup,
): Promise<ExactSourceAuthority> {
  if (
    !backup.sandbox_record_id ||
    !backup.catalog_organization_id ||
    !backup.catalog_agent_id ||
    !backup.source_node_record_id ||
    !backup.source_node_id ||
    !backup.source_node_incarnation ||
    !backup.source_provider ||
    !backup.source_provider_handle ||
    !backup.source_container_id
  ) {
    throw admissionLost("Backup operation is missing its immutable source authority");
  }

  const [sandbox] = await tx
    .select({
      id: agentSandboxes.id,
      status: agentSandboxes.status,
      nodeId: agentSandboxes.node_id,
      providerHandle: agentSandboxes.sandbox_id,
      lifecycleRevision: sql<string>`${agentSandboxes.lifecycle_revision}::text`,
      activationGeneration: agentSandboxes.activation_generation,
      activationLifecycleRevision: sql<
        string | null
      >`${agentSandboxes.activation_lifecycle_revision}::text`,
      activationPhase: agentSandboxes.activation_phase,
      activationPurpose: agentSandboxes.activation_purpose,
      activationPreviousGeneration: agentSandboxes.activation_previous_generation,
      activationBackupId: agentSandboxes.activation_backup_id,
      activationBackupHash: agentSandboxes.activation_backup_hash,
      activationReceipt: agentSandboxes.activation_receipt,
      activationReceiptHash: agentSandboxes.activation_receipt_hash,
      activationContainerId: agentSandboxes.activation_container_id,
      activationNodeId: agentSandboxes.activation_node_id,
      activationImageDigest: agentSandboxes.activation_image_digest,
      activationBootId: agentSandboxes.activation_boot_id,
      activationTokenHash: agentSandboxes.activation_token_hash,
      activationFundingRevision: agentSandboxes.activation_funding_revision,
      activationAuthorityPublishedAt: agentSandboxes.activation_authority_published_at,
      activationDispatchedAt: agentSandboxes.activation_dispatched_at,
      activationCompletedAt: agentSandboxes.activation_completed_at,
    })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, backup.sandbox_record_id),
        eq(agentSandboxes.organization_id, backup.catalog_organization_id),
      ),
    )
    .for("update")
    .limit(1);
  if (!sandbox || sandbox.id !== backup.catalog_agent_id) {
    throw admissionLost("Backup source sandbox authority disappeared or changed tenant");
  }
  if (
    backup.lifecycle_revision === null ||
    !backup.lifecycle_generation ||
    sandbox.status !== "running" ||
    sandbox.activationPhase !== "active" ||
    sandbox.activationGeneration !== backup.lifecycle_generation ||
    sandbox.lifecycleRevision !== backup.lifecycle_revision.toString() ||
    sandbox.activationLifecycleRevision !== backup.lifecycle_revision.toString() ||
    !sandbox.activationPurpose ||
    !sandbox.activationReceipt ||
    !sandbox.activationReceiptHash ||
    !sandbox.activationImageDigest ||
    sandbox.activationBootId !== backup.source_node_incarnation ||
    !sandbox.activationTokenHash ||
    sandbox.activationFundingRevision === null ||
    !sandbox.activationAuthorityPublishedAt ||
    !sandbox.activationDispatchedAt ||
    !sandbox.activationCompletedAt ||
    sandbox.nodeId !== backup.source_node_id ||
    sandbox.activationNodeId !== backup.source_node_id ||
    sandbox.providerHandle !== backup.source_provider_handle ||
    sandbox.activationContainerId !== backup.source_container_id
  ) {
    throw admissionLost("Backup capture source is no longer the exact active sandbox generation");
  }

  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, backup.catalog_organization_id))
    .for("update")
    .limit(1);
  if (!organization) throw admissionLost("Backup organization authority disappeared");

  const [publication] = await tx
    .select({
      lifecycleRevision: sql<string>`${agentActivationPublications.lifecycle_revision}::text`,
      purpose: agentActivationPublications.purpose,
      previousActivationGeneration: agentActivationPublications.previous_activation_generation,
      backupId: agentActivationPublications.backup_id,
      backupManifestHash: agentActivationPublications.backup_manifest_sha256,
      activationReceipt: agentActivationPublications.activation_receipt,
      activationReceiptHash: agentActivationPublications.activation_receipt_sha256,
      containerId: agentActivationPublications.container_id,
      nodeHistoryId: agentActivationPublications.node_history_id,
      nodeRecordId: agentActivationPublications.docker_node_record_id,
      nodeId: agentActivationPublications.node_id,
      nodeIncarnation: agentActivationPublications.node_incarnation,
      imageDigest: agentActivationPublications.image_digest,
      tokenHash: agentActivationPublications.token_sha256,
      fundingRevision: agentActivationPublications.funding_revision,
      publishedAt: agentActivationPublications.published_at,
    })
    .from(agentActivationPublications)
    .where(
      and(
        eq(agentActivationPublications.organization_id, backup.catalog_organization_id),
        eq(agentActivationPublications.agent_id, backup.catalog_agent_id),
        eq(agentActivationPublications.activation_generation, backup.lifecycle_generation),
      ),
    )
    .limit(1);
  if (
    !publication ||
    publication.lifecycleRevision !== backup.lifecycle_revision.toString() ||
    publication.purpose !== sandbox.activationPurpose ||
    publication.previousActivationGeneration !== sandbox.activationPreviousGeneration ||
    publication.backupId !== sandbox.activationBackupId ||
    publication.backupManifestHash !== sandbox.activationBackupHash ||
    JSON.stringify(publication.activationReceipt) !== JSON.stringify(sandbox.activationReceipt) ||
    publication.activationReceiptHash !== sandbox.activationReceiptHash ||
    publication.containerId !== backup.source_container_id ||
    publication.nodeRecordId !== backup.source_node_record_id ||
    publication.nodeId !== backup.source_node_id ||
    publication.nodeIncarnation !== backup.source_node_incarnation ||
    publication.imageDigest !== sandbox.activationImageDigest ||
    publication.tokenHash !== sandbox.activationTokenHash ||
    publication.fundingRevision !== sandbox.activationFundingRevision ||
    publication.publishedAt.getTime() !== sandbox.activationAuthorityPublishedAt.getTime()
  ) {
    throw admissionLost("Backup capture source lost its immutable activation publication");
  }

  const [node] = await tx
    .select({
      recordId: dockerNodes.id,
      nodeId: dockerNodes.node_id,
      incarnation: dockerNodes.node_incarnation,
      historyId: dockerNodes.current_node_history_id,
      fleetKind: dockerNodes.fleet_kind,
      infrastructureProvider: dockerNodes.infrastructure_provider,
      providerServerId: dockerNodes.provider_server_id,
      hostKeyFingerprint: dockerNodes.host_key_fingerprint,
    })
    .from(dockerNodes)
    .where(
      and(
        eq(dockerNodes.id, backup.source_node_record_id),
        eq(dockerNodes.node_id, backup.source_node_id),
        eq(dockerNodes.node_incarnation, backup.source_node_incarnation),
        eq(dockerNodes.current_node_history_id, publication.nodeHistoryId),
      ),
    )
    .for("update")
    .limit(1);
  if (!node?.incarnation || !node.historyId) {
    throw admissionLost("Backup source node is no longer the reserved exact occurrence");
  }
  const expectedFleetKind =
    backup.source_provider === "operator-onboarded"
      ? "robot"
      : backup.source_provider === "hetzner-cloud"
        ? "cloud"
        : null;
  if (
    !expectedFleetKind ||
    node.fleetKind !== expectedFleetKind ||
    node.infrastructureProvider !== "hetzner" ||
    node.providerServerId !== backup.source_provider_server_id ||
    !node.hostKeyFingerprint?.trim()
  ) {
    throw admissionLost("Backup source Robot/Cloud provider authority changed");
  }

  const [history] = await tx
    .select({
      id: agentNodeIncarnationHistories.id,
      nodeId: agentNodeIncarnationHistories.node_id,
      fleetKind: agentNodeIncarnationHistories.fleet_kind,
      infrastructureProvider: agentNodeIncarnationHistories.infrastructure_provider,
      providerServerId: agentNodeIncarnationHistories.provider_server_id,
      hostKeyFingerprint: agentNodeIncarnationHistories.host_key_fingerprint,
    })
    .from(agentNodeIncarnationHistories)
    .where(
      and(
        eq(agentNodeIncarnationHistories.id, publication.nodeHistoryId),
        eq(agentNodeIncarnationHistories.docker_node_record_id, node.recordId),
        eq(agentNodeIncarnationHistories.node_incarnation, node.incarnation),
      ),
    )
    .for("share")
    .limit(1);
  if (
    !history ||
    history.nodeId !== node.nodeId ||
    history.fleetKind !== node.fleetKind ||
    history.infrastructureProvider !== node.infrastructureProvider ||
    history.providerServerId !== node.providerServerId ||
    history.hostKeyFingerprint !== node.hostKeyFingerprint
  ) {
    throw admissionLost("Backup source node-history occurrence disappeared or changed");
  }

  return Object.freeze({
    sourceNodeHistoryId: history.id,
    sourceNodeRecordId: node.recordId,
    sourceNodeIncarnation: node.incarnation,
  });
}

function assertCatalogueReplay(params: {
  backup: StoredAgentSandboxBackup;
  callerToken: Readonly<AgentBackupOperationLaneCallerToken>;
  target: AgentBackupOperationLaneTarget;
  laneExpiry: Date;
  databaseNow: Date;
}): void {
  if (
    params.backup.catalog_organization_id !== params.target.organizationId ||
    params.backup.id !== params.target.backupId ||
    params.backup.backup_operation_id !== params.target.operationId ||
    params.backup.catalog_lease_owner !== params.callerToken.ownerId ||
    params.backup.catalog_lease_generation !== params.callerToken.generation ||
    !(params.backup.catalog_lease_expires_at instanceof Date) ||
    params.backup.catalog_lease_expires_at.getTime() !== params.laneExpiry.getTime() ||
    params.backup.catalog_lease_expires_at.getTime() <= params.databaseNow.getTime()
  ) {
    throw admissionLost("Catalogue lease does not replay the exact active global lane");
  }
}

/**
 * Lock the singleton first, then atomically claim one exact live-source capture
 * and stamp both cross-tick fairness receipts. No provider runs here.
 */
export async function claimNextAgentBackupOperationAdmission(params: {
  readonly callerToken: AgentBackupOperationLaneCallerToken;
  readonly leaseMs: number;
}): Promise<AgentBackupOperationAdmissionResult> {
  const callerToken = normalizeAgentBackupOperationLaneCallerToken(params.callerToken);
  const leaseMs = normalizeAgentBackupOperationLaneLeaseMs(params.leaseMs);

  return dbWrite.transaction(async (tx) => {
    const initial = await lockAgentBackupOperationLaneInTransaction(tx);
    if (laneIsActive(initial.lane, initial.databaseNow)) {
      if (
        initial.lane.owner_id !== callerToken.ownerId ||
        initial.lane.generation !== callerToken.generation
      ) {
        return Object.freeze({
          kind: "busy" as const,
          lane: observedLane(initial.lane),
          databaseNow: new Date(initial.databaseNow.getTime()),
        });
      }
      if (!initial.lane.organization_id || !initial.lane.backup_id || !initial.lane.operation_id) {
        throw admissionLost("Active global lane is missing its exact catalogue target");
      }
      const target = Object.freeze({
        organizationId: initial.lane.organization_id,
        backupId: initial.lane.backup_id,
        operationId: initial.lane.operation_id,
      });
      const backup = await lockBackupByTargetInTransaction(tx, target);
      const source = await lockExactSourceAuthorityInTransaction(tx, backup);
      const replay = await claimAgentBackupOperationLaneInTransaction(tx, {
        ...target,
        callerToken,
        leaseMs,
        fairness: source,
      });
      if (replay.kind === "busy") {
        throw admissionLost("Exact active global lane unexpectedly became foreign");
      }
      const laneExpiry = exactLeaseExpiry(replay.proof.lane, "Replayed admission");
      assertCatalogueReplay({
        backup,
        callerToken,
        target,
        laneExpiry,
        databaseNow: replay.proof.databaseNow,
      });
      return Object.freeze({
        kind: "replayed" as const,
        admission: admissionFor({
          backup,
          execution: replay.execution,
          sourceNodeHistoryId: source.sourceNodeHistoryId,
        }),
      });
    }

    const backup = await lockNextDueBackupInTransaction(tx);
    if (!backup) return Object.freeze({ kind: "empty" as const });
    const target = targetFor(backup);
    const source = await lockExactSourceAuthorityInTransaction(tx, backup);
    const laneClaim = await claimAgentBackupOperationLaneInTransaction(tx, {
      ...target,
      callerToken,
      leaseMs,
      fairness: source,
    });
    if (laneClaim.kind === "busy") {
      return Object.freeze({
        kind: "busy" as const,
        lane: laneClaim.lane,
        databaseNow: laneClaim.databaseNow,
      });
    }
    if (laneClaim.kind !== "claimed") {
      throw admissionLost("Fresh catalogue candidate unexpectedly replayed the global lane");
    }
    const laneExpiry = exactLeaseExpiry(laneClaim.proof.lane, "Claimed admission");
    const [claimed] = await tx
      .update(agentSandboxBackups)
      .set({
        catalog_lease_owner: callerToken.ownerId,
        catalog_lease_generation: callerToken.generation,
        catalog_lease_expires_at: laneExpiry,
        catalog_updated_at: laneClaim.proof.databaseNow,
      })
      .where(
        and(
          eq(agentSandboxBackups.id, target.backupId),
          eq(agentSandboxBackups.catalog_organization_id, target.organizationId),
          eq(agentSandboxBackups.backup_operation_id, target.operationId),
          sql`(${agentSandboxBackups.catalog_state} IN ('scheduled', 'capturing')
            OR (${agentSandboxBackups.catalog_state} = 'failed_retryable'
              AND ${agentSandboxBackups.catalog_resume_state} IN ('scheduled', 'capturing')))`,
          sql`(${agentSandboxBackups.catalog_lease_expires_at} IS NULL
            OR ${agentSandboxBackups.catalog_lease_expires_at} <= clock_timestamp())`,
        ),
      )
      .returning();
    if (!claimed) {
      throw admissionLost("Catalogue operation changed after the global lane was claimed");
    }
    const finalProof = await refreshAgentBackupOperationLaneProofInTransaction(tx, laneClaim.proof);
    if (
      exactLeaseExpiry(finalProof.lane, "Committed admission").getTime() !== laneExpiry.getTime()
    ) {
      throw admissionLost("Catalogue lease diverged from the global lane before commit");
    }
    return Object.freeze({
      kind: "claimed" as const,
      admission: admissionFor({
        backup: claimed,
        execution: laneClaim.execution,
        sourceNodeHistoryId: source.sourceNodeHistoryId,
      }),
    });
  });
}

/** Renew the global and catalogue leases atomically; never shorten either. */
export async function renewAgentBackupOperationAdmission(params: {
  readonly admission: AgentBackupOperationAdmission;
  readonly leaseMs: number;
}): Promise<AgentBackupOperationAdmission> {
  const input = params.admission;
  if (!input?.claim?.backup || !input.laneExecution || !input.sourceNodeHistoryId) {
    throw admissionLost("Admission is missing its exact catalogue and lane authorities");
  }
  const target = targetFor(input.claim.backup);
  const execution = Object.freeze({
    ownerId: input.laneExecution.ownerId,
    generation: input.laneExecution.generation,
    claimSequence: input.laneExecution.claimSequence,
  });
  const sourceNodeHistoryId = input.sourceNodeHistoryId;
  const leaseMs = normalizeAgentBackupOperationLaneLeaseMs(params.leaseMs);

  return dbWrite.transaction(async (tx) => {
    const renewedProof = await renewAgentBackupOperationLaneInTransaction(tx, {
      ...target,
      execution,
      leaseMs,
    });
    const backup = await lockBackupByTargetInTransaction(tx, target);
    if (
      backup.catalog_lease_owner !== execution.ownerId ||
      backup.catalog_lease_generation !== execution.generation ||
      !(backup.catalog_lease_expires_at instanceof Date) ||
      backup.catalog_lease_expires_at.getTime() <= renewedProof.databaseNow.getTime()
    ) {
      throw admissionLost("Catalogue lease was lost before atomic admission renewal");
    }
    const source = await lockExactSourceAuthorityInTransaction(tx, backup);
    if (source.sourceNodeHistoryId !== sourceNodeHistoryId) {
      throw admissionLost("Backup source occurrence changed before admission renewal");
    }
    const currentProof = await refreshAgentBackupOperationLaneProofInTransaction(tx, renewedProof);
    const laneExpiry = exactLeaseExpiry(currentProof.lane, "Renewed admission");
    const [renewed] = await tx
      .update(agentSandboxBackups)
      .set({
        catalog_lease_expires_at: laneExpiry,
        catalog_updated_at: currentProof.databaseNow,
      })
      .where(
        and(
          eq(agentSandboxBackups.id, target.backupId),
          eq(agentSandboxBackups.catalog_organization_id, target.organizationId),
          eq(agentSandboxBackups.backup_operation_id, target.operationId),
          eq(agentSandboxBackups.catalog_lease_owner, execution.ownerId),
          eq(agentSandboxBackups.catalog_lease_generation, execution.generation),
          gt(agentSandboxBackups.catalog_lease_expires_at, sql`clock_timestamp()`),
          sql`(${agentSandboxBackups.catalog_state} IN ('scheduled', 'capturing')
            OR (${agentSandboxBackups.catalog_state} = 'failed_retryable'
              AND ${agentSandboxBackups.catalog_resume_state} IN ('scheduled', 'capturing')))`,
        ),
      )
      .returning();
    if (!renewed) throw admissionLost("Catalogue lease was lost during atomic admission renewal");
    await refreshAgentBackupOperationLaneProofInTransaction(tx, currentProof);
    return admissionFor({
      backup: renewed,
      execution,
      sourceNodeHistoryId,
    });
  });
}
