/** Atomic global-lane admission for source-node-detached backup publication. */

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
import { agentSandboxBackups, type StoredAgentSandboxBackup } from "../schemas/agent-sandboxes";
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

const PUBLICATION_OWNED_STATES = [
  "captured",
  "uploading",
  "primary_uploaded",
  "primary_verified",
  "secondary_pending",
] as const;

export interface AgentBackupPublicationAdmission {
  readonly claim: Readonly<AgentBackupOperationClaim>;
  readonly laneExecution: Readonly<AgentBackupOperationLaneExecution>;
  readonly sourceNodeHistoryId: string;
}

export type AgentBackupPublicationAdmissionResult =
  | {
      readonly kind: "claimed" | "replayed";
      readonly admission: AgentBackupPublicationAdmission;
    }
  | { readonly kind: "empty" }
  | {
      readonly kind: "busy";
      readonly lane: Readonly<AgentBackupOperationLane>;
      readonly databaseNow: Date;
    };

interface DetachedSourceAuthority {
  readonly sourceNodeHistoryId: string;
  readonly sourceNodeRecordId: string;
  readonly sourceNodeIncarnation: string;
}

function admissionLost(message: string): ElizaError {
  return new ElizaError(message, {
    code: "AGENT_BACKUP_PUBLICATION_ADMISSION_LOST",
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
    throw admissionLost("Backup publication is missing its exact catalogue target");
  }
  return Object.freeze({
    organizationId: backup.catalog_organization_id,
    backupId: backup.id,
    operationId: backup.backup_operation_id,
    operationPhase: "publication" as const,
  });
}

function activeState(backup: StoredAgentSandboxBackup): boolean {
  return (
    PUBLICATION_OWNED_STATES.some((state) => state === backup.catalog_state) ||
    (backup.catalog_state === "failed_retryable" &&
      PUBLICATION_OWNED_STATES.some((state) => state === backup.catalog_resume_state))
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
}): AgentBackupPublicationAdmission {
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
  if (target.operationPhase !== "publication") {
    throw admissionLost("Global lane target is not a publication execution");
  }
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
    throw admissionLost("Global lane target no longer names an executable publication");
  }
  return backup;
}

/**
 * The singleton is already locked. Publication deliberately avoids mutable
 * sandbox and docker-node rows: its source is the captured manifest plus the
 * append-only activation publication and node-occurrence history.
 */
async function lockNextDuePublicationInTransaction(
  tx: DbTransaction,
): Promise<StoredAgentSandboxBackup | null> {
  const [candidate] = await tx
    .select({ id: agentSandboxBackups.id })
    .from(agentSandboxBackups)
    .innerJoin(organizations, eq(organizations.id, agentSandboxBackups.catalog_organization_id))
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
        eq(agentActivationPublications.container_id, agentSandboxBackups.source_container_id),
        eq(
          agentActivationPublications.docker_node_record_id,
          agentSandboxBackups.source_node_record_id,
        ),
        eq(agentActivationPublications.node_id, agentSandboxBackups.source_node_id),
        eq(
          agentActivationPublications.node_incarnation,
          agentSandboxBackups.source_node_incarnation,
        ),
        eq(agentActivationPublications.image_digest, agentSandboxBackups.image_digest),
        sql`jsonb_typeof(${agentActivationPublications.activation_receipt}) = 'object'`,
        sql`${agentActivationPublications.activation_receipt} -> 'schemaVersion' = '1'::jsonb`,
        sql`${agentActivationPublications.activation_receipt} -> 'generation'
          = to_jsonb(${agentSandboxBackups.lifecycle_generation}::text)`,
        sql`${agentActivationPublications.activation_receipt} -> 'purpose'
          = to_jsonb(${agentActivationPublications.purpose})`,
        sql`${agentActivationPublications.activation_receipt} -> 'agentId'
          = to_jsonb(${agentSandboxBackups.catalog_agent_id}::text)`,
        sql`${agentActivationPublications.activation_receipt} -> 'organizationId'
          = to_jsonb(${agentSandboxBackups.catalog_organization_id}::text)`,
        sql`${agentActivationPublications.activation_receipt} -> 'lifecycleRevision'
          = to_jsonb(${agentSandboxBackups.lifecycle_revision}::text)`,
        sql`(
          (${agentActivationPublications.backup_id} IS NULL
            AND ${agentActivationPublications.activation_receipt} -> 'backupId' = 'null'::jsonb)
          OR (${agentActivationPublications.backup_id} IS NOT NULL
            AND ${agentActivationPublications.activation_receipt} -> 'backupId'
              = to_jsonb(${agentActivationPublications.backup_id}::text))
        )`,
        sql`(
          (${agentActivationPublications.backup_manifest_sha256} IS NULL
            AND ${agentActivationPublications.activation_receipt} -> 'backupHash' = 'null'::jsonb)
          OR (${agentActivationPublications.backup_manifest_sha256} IS NOT NULL
            AND ${agentActivationPublications.activation_receipt} -> 'backupHash'
              = to_jsonb(${agentActivationPublications.backup_manifest_sha256}))
        )`,
        sql`${agentActivationPublications.activation_receipt} -> 'containerId'
          = to_jsonb(${agentSandboxBackups.source_container_id})`,
        sql`${agentActivationPublications.activation_receipt} -> 'imageDigest'
          = to_jsonb(${agentSandboxBackups.image_digest})`,
        sql`${agentActivationPublications.activation_receipt} -> 'restored' = 'true'::jsonb`,
      ),
    )
    .innerJoin(
      agentNodeIncarnationHistories,
      and(
        eq(agentNodeIncarnationHistories.id, agentActivationPublications.node_history_id),
        eq(
          agentNodeIncarnationHistories.docker_node_record_id,
          agentSandboxBackups.source_node_record_id,
        ),
        eq(agentNodeIncarnationHistories.node_id, agentSandboxBackups.source_node_id),
        eq(
          agentNodeIncarnationHistories.node_incarnation,
          agentSandboxBackups.source_node_incarnation,
        ),
        eq(agentNodeIncarnationHistories.infrastructure_provider, "hetzner"),
        sql`${agentNodeIncarnationHistories.provider_server_id}
          IS NOT DISTINCT FROM ${agentSandboxBackups.source_provider_server_id}`,
        sql`btrim(${agentNodeIncarnationHistories.host_key_fingerprint}) <> ''`,
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
        agentActivationPublications.node_history_id,
      ),
    )
    .where(
      and(
        eq(agentSandboxBackups.catalog_version, 2),
        sql`${agentSandboxBackups.sandbox_record_id} IS NOT NULL`,
        sql`${agentSandboxBackups.catalog_organization_id} IS NOT NULL`,
        sql`${agentSandboxBackups.catalog_agent_id} IS NOT NULL`,
        sql`${agentSandboxBackups.backup_operation_id} IS NOT NULL`,
        sql`${agentSandboxBackups.lifecycle_generation} IS NOT NULL`,
        sql`${agentSandboxBackups.lifecycle_revision} IS NOT NULL`,
        sql`${agentSandboxBackups.source_provider} IN ('operator-onboarded', 'hetzner-cloud')`,
        sql`${agentSandboxBackups.source_node_record_id} IS NOT NULL`,
        sql`${agentSandboxBackups.source_node_id} IS NOT NULL
          AND ${agentSandboxBackups.source_node_id} <> ''`,
        sql`${agentSandboxBackups.source_node_incarnation} IS NOT NULL`,
        sql`${agentSandboxBackups.source_provider_handle} IS NOT NULL
          AND ${agentSandboxBackups.source_provider_handle} <> ''`,
        sql`${agentSandboxBackups.source_container_id} ~ '^[0-9a-f]{64}$'`,
        sql`${agentSandboxBackups.image_digest} ~ '^sha256:[0-9a-f]{64}$'`,
        sql`(
          (${agentSandboxBackups.source_provider} = 'operator-onboarded'
            AND ${agentSandboxBackups.source_provider_server_id} IS NULL
            AND ${agentNodeIncarnationHistories.fleet_kind} = 'robot')
          OR
          (${agentSandboxBackups.source_provider} = 'hetzner-cloud'
            AND ${agentNodeIncarnationHistories.fleet_kind} = 'cloud'
            AND CASE
              WHEN ${agentSandboxBackups.source_provider_server_id} ~ '^[1-9][0-9]{0,19}$'
                THEN ${agentSandboxBackups.source_provider_server_id}::numeric
                  <= 18446744073709551615
              ELSE FALSE
            END)
        )`,
        sql`(${agentSandboxBackups.catalog_state} IN (
            'captured', 'uploading', 'primary_uploaded', 'primary_verified', 'secondary_pending'
          ) OR (${agentSandboxBackups.catalog_state} = 'failed_retryable'
            AND ${agentSandboxBackups.catalog_resume_state} IN (
              'captured', 'uploading', 'primary_uploaded', 'primary_verified', 'secondary_pending'
            )))`,
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
  if (!backup) throw admissionLost("Selected backup publication disappeared while locked");
  return backup;
}

async function lockDetachedSourceAuthorityInTransaction(
  tx: DbTransaction,
  backup: StoredAgentSandboxBackup,
): Promise<DetachedSourceAuthority> {
  if (
    !backup.sandbox_record_id ||
    !backup.catalog_organization_id ||
    !backup.catalog_agent_id ||
    !backup.lifecycle_generation ||
    backup.lifecycle_revision === null ||
    !backup.source_node_record_id ||
    !backup.source_node_id ||
    !backup.source_node_incarnation ||
    !backup.source_provider ||
    !backup.source_provider_handle ||
    !backup.source_container_id ||
    !backup.image_digest
  ) {
    throw admissionLost("Backup publication is missing its captured source authority");
  }

  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, backup.catalog_organization_id))
    .for("update")
    .limit(1);
  if (!organization) throw admissionLost("Backup publication organization disappeared");

  const [publication] = await tx
    .select({
      lifecycleRevision: sql<string>`${agentActivationPublications.lifecycle_revision}::text`,
      purpose: agentActivationPublications.purpose,
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
  const receipt = publication?.activationReceipt;
  if (
    !publication ||
    publication.lifecycleRevision !== backup.lifecycle_revision.toString() ||
    publication.containerId !== backup.source_container_id ||
    publication.nodeRecordId !== backup.source_node_record_id ||
    publication.nodeId !== backup.source_node_id ||
    publication.nodeIncarnation !== backup.source_node_incarnation ||
    publication.imageDigest !== backup.image_digest ||
    !publication.activationReceiptHash ||
    !publication.tokenHash ||
    publication.fundingRevision < 0n ||
    !publication.publishedAt ||
    !receipt ||
    receipt.schemaVersion !== 1 ||
    receipt.generation !== backup.lifecycle_generation ||
    receipt.purpose !== publication.purpose ||
    receipt.agentId !== backup.catalog_agent_id ||
    receipt.organizationId !== backup.catalog_organization_id ||
    receipt.lifecycleRevision !== backup.lifecycle_revision.toString() ||
    receipt.backupId !== publication.backupId ||
    receipt.backupHash !== publication.backupManifestHash ||
    receipt.containerId !== backup.source_container_id ||
    receipt.imageDigest !== backup.image_digest ||
    receipt.restored !== true
  ) {
    throw admissionLost("Backup publication lost its immutable activation authority");
  }

  const [history] = await tx
    .select({
      id: agentNodeIncarnationHistories.id,
      nodeRecordId: agentNodeIncarnationHistories.docker_node_record_id,
      nodeId: agentNodeIncarnationHistories.node_id,
      nodeIncarnation: agentNodeIncarnationHistories.node_incarnation,
      fleetKind: agentNodeIncarnationHistories.fleet_kind,
      infrastructureProvider: agentNodeIncarnationHistories.infrastructure_provider,
      providerServerId: agentNodeIncarnationHistories.provider_server_id,
      hostKeyFingerprint: agentNodeIncarnationHistories.host_key_fingerprint,
    })
    .from(agentNodeIncarnationHistories)
    .where(
      and(
        eq(agentNodeIncarnationHistories.id, publication.nodeHistoryId),
        eq(agentNodeIncarnationHistories.docker_node_record_id, backup.source_node_record_id),
        eq(agentNodeIncarnationHistories.node_incarnation, backup.source_node_incarnation),
      ),
    )
    .limit(1);
  const expectedFleetKind =
    backup.source_provider === "operator-onboarded"
      ? "robot"
      : backup.source_provider === "hetzner-cloud"
        ? "cloud"
        : null;
  if (
    !history ||
    history.nodeRecordId !== publication.nodeRecordId ||
    history.nodeId !== publication.nodeId ||
    history.nodeIncarnation !== publication.nodeIncarnation ||
    !expectedFleetKind ||
    history.fleetKind !== expectedFleetKind ||
    history.infrastructureProvider !== "hetzner" ||
    history.providerServerId !== backup.source_provider_server_id ||
    !history.hostKeyFingerprint.trim()
  ) {
    throw admissionLost("Backup publication node-history authority disappeared or changed");
  }

  return Object.freeze({
    sourceNodeHistoryId: history.id,
    sourceNodeRecordId: history.nodeRecordId,
    sourceNodeIncarnation: history.nodeIncarnation,
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
    params.target.operationPhase !== "publication" ||
    params.backup.catalog_organization_id !== params.target.organizationId ||
    params.backup.id !== params.target.backupId ||
    params.backup.backup_operation_id !== params.target.operationId ||
    params.backup.catalog_lease_owner !== params.callerToken.ownerId ||
    params.backup.catalog_lease_generation !== params.callerToken.generation ||
    !(params.backup.catalog_lease_expires_at instanceof Date) ||
    params.backup.catalog_lease_expires_at.getTime() !== params.laneExpiry.getTime() ||
    params.backup.catalog_lease_expires_at.getTime() <= params.databaseNow.getTime()
  ) {
    throw admissionLost("Catalogue lease does not replay the exact publication lane");
  }
}

/** Atomically claim one detached publication; no provider or mutable node runs here. */
export async function claimNextAgentBackupPublicationAdmission(params: {
  readonly callerToken: AgentBackupOperationLaneCallerToken;
  readonly leaseMs: number;
}): Promise<AgentBackupPublicationAdmissionResult> {
  const callerToken = normalizeAgentBackupOperationLaneCallerToken(params.callerToken);
  const leaseMs = normalizeAgentBackupOperationLaneLeaseMs(params.leaseMs);

  return dbWrite.transaction(async (tx) => {
    const initial = await lockAgentBackupOperationLaneInTransaction(tx);
    if (laneIsActive(initial.lane, initial.databaseNow)) {
      if (
        initial.lane.owner_id !== callerToken.ownerId ||
        initial.lane.generation !== callerToken.generation ||
        initial.lane.operation_phase !== "publication"
      ) {
        return Object.freeze({
          kind: "busy" as const,
          lane: observedLane(initial.lane),
          databaseNow: new Date(initial.databaseNow.getTime()),
        });
      }
      if (!initial.lane.organization_id || !initial.lane.backup_id || !initial.lane.operation_id) {
        throw admissionLost("Active publication lane is missing its exact catalogue target");
      }
      const target = Object.freeze({
        organizationId: initial.lane.organization_id,
        backupId: initial.lane.backup_id,
        operationId: initial.lane.operation_id,
        operationPhase: "publication" as const,
      });
      const backup = await lockBackupByTargetInTransaction(tx, target);
      const source = await lockDetachedSourceAuthorityInTransaction(tx, backup);
      const replay = await claimAgentBackupOperationLaneInTransaction(tx, {
        ...target,
        callerToken,
        leaseMs,
        fairness: source,
      });
      if (replay.kind === "busy") {
        throw admissionLost("Exact active publication lane unexpectedly became foreign");
      }
      const laneExpiry = exactLeaseExpiry(replay.proof.lane, "Replayed publication admission");
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

    const backup = await lockNextDuePublicationInTransaction(tx);
    if (!backup) return Object.freeze({ kind: "empty" as const });
    const target = targetFor(backup);
    const source = await lockDetachedSourceAuthorityInTransaction(tx, backup);
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
      throw admissionLost("Fresh publication candidate unexpectedly replayed the global lane");
    }
    const laneExpiry = exactLeaseExpiry(laneClaim.proof.lane, "Claimed publication admission");
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
          sql`(${agentSandboxBackups.catalog_state} IN (
              'captured', 'uploading', 'primary_uploaded', 'primary_verified', 'secondary_pending'
            ) OR (${agentSandboxBackups.catalog_state} = 'failed_retryable'
              AND ${agentSandboxBackups.catalog_resume_state} IN (
                'captured', 'uploading', 'primary_uploaded', 'primary_verified', 'secondary_pending'
              )))`,
          sql`(${agentSandboxBackups.catalog_lease_expires_at} IS NULL
            OR ${agentSandboxBackups.catalog_lease_expires_at} <= clock_timestamp())`,
        ),
      )
      .returning();
    if (!claimed) {
      throw admissionLost("Catalogue publication changed after the global lane was claimed");
    }
    const finalProof = await refreshAgentBackupOperationLaneProofInTransaction(tx, laneClaim.proof);
    if (
      exactLeaseExpiry(finalProof.lane, "Committed publication admission").getTime() !==
      laneExpiry.getTime()
    ) {
      throw admissionLost("Catalogue publication lease diverged from the lane before commit");
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

/** Renew publication and catalogue leases atomically without a live source node. */
export async function renewAgentBackupPublicationAdmission(params: {
  readonly admission: AgentBackupPublicationAdmission;
  readonly leaseMs: number;
}): Promise<AgentBackupPublicationAdmission> {
  const input = params.admission;
  if (!input?.claim?.backup || !input.laneExecution || !input.sourceNodeHistoryId) {
    throw admissionLost("Publication admission is missing its catalogue and lane authorities");
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
      throw admissionLost("Catalogue publication lease was lost before atomic renewal");
    }
    const source = await lockDetachedSourceAuthorityInTransaction(tx, backup);
    if (source.sourceNodeHistoryId !== sourceNodeHistoryId) {
      throw admissionLost("Publication source occurrence changed before admission renewal");
    }
    const currentProof = await refreshAgentBackupOperationLaneProofInTransaction(tx, renewedProof);
    const laneExpiry = exactLeaseExpiry(currentProof.lane, "Renewed publication admission");
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
          sql`(${agentSandboxBackups.catalog_state} IN (
              'captured', 'uploading', 'primary_uploaded', 'primary_verified', 'secondary_pending'
            ) OR (${agentSandboxBackups.catalog_state} = 'failed_retryable'
              AND ${agentSandboxBackups.catalog_resume_state} IN (
                'captured', 'uploading', 'primary_uploaded', 'primary_verified', 'secondary_pending'
              )))`,
        ),
      )
      .returning();
    if (!renewed) throw admissionLost("Catalogue publication lease was lost during renewal");
    await refreshAgentBackupOperationLaneProofInTransaction(tx, currentProof);
    return admissionFor({
      backup: renewed,
      execution,
      sourceNodeHistoryId,
    });
  });
}
