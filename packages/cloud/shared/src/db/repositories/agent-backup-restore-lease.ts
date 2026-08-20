/** Owner-bound lifecycle for dormant backup restore leases. */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  requireBoundedIdentity,
  requireSha256Hex,
} from "../../lib/services/agent-backup-catalog-state";
import { isValidUUID } from "../../lib/utils/validation";
import { dbWrite } from "../helpers";
import {
  type AgentBackupCopyRole,
  type AgentBackupRestoreLease,
  agentBackupRestoreLeases,
} from "../schemas/agent-backup-catalog";
import { agentSandboxBackups } from "../schemas/agent-sandboxes";
import { agentVaultKeyBackupBindings } from "../schemas/agent-vault-key-authority";
import {
  AgentBackupCatalogConflictError,
  lockAgentBackupCatalogAuthority,
} from "./agent-backup-catalog";
import type { AgentBackupRestoreSourceV3Input } from "./agent-backup-restore";
import { hasAgentBackupRestoreAuthority } from "./agent-backup-restore-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export type AgentBackupRestoreLeaseAcquisition =
  | {
      status: "active";
      lease: Readonly<AgentBackupRestoreLease>;
      authority: AgentBackupRestoreLeaseAuthorityReceipt;
    }
  | {
      status: "acquired";
      lease: Readonly<AgentBackupRestoreLease>;
      authority: AgentBackupRestoreLeaseAuthorityReceipt;
    };

/** Exact DB-clock lease receipt; callers never adapt expiry using host time. */
export interface AgentBackupRestoreLeaseAuthorityReceipt extends AgentBackupRestoreSourceV3Input {
  readonly lease: Readonly<AgentBackupRestoreLease>;
  readonly databaseNow: Date;
  readonly expiresAt: Date;
}

function leaseAuthorityReceipt(
  lease: AgentBackupRestoreLease,
  databaseNow: Date,
): AgentBackupRestoreLeaseAuthorityReceipt {
  const frozenLease = Object.freeze({ ...lease });
  return Object.freeze({
    lease: frozenLease,
    leaseId: lease.id,
    organizationId: lease.organization_id,
    agentId: lease.agent_id,
    backupId: lease.backup_id,
    operationId: lease.operation_id,
    sourceActivationGeneration: lease.activation_generation,
    sourceLifecycleRevision: lease.lifecycle_revision.toString(),
    expectedManifestSha256: lease.expected_manifest_sha256,
    copyRole: lease.copy_role,
    restoreAttemptId: lease.restore_attempt_id,
    ownerId: lease.owner_id,
    fencingToken: lease.generation,
    catalogEpoch: lease.catalog_epoch.toString(),
    databaseNow,
    expiresAt: lease.expires_at,
  });
}

function requireUuid(value: string, field: string): string {
  if (!isValidUUID(value) || value !== value.toLowerCase()) {
    throw new Error(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function requireCanonicalUint64(value: string, field: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a canonical unsigned decimal integer`);
  }
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) throw new Error(`${field} must fit uint64`);
  return parsed;
}

function requireOwnerId(value: string): string {
  requireBoundedIdentity(value, "ownerId");
  if (Buffer.byteLength(value, "utf8") > 255) {
    throw new Error("ownerId must contain at most 255 UTF-8 bytes");
  }
  return value;
}

function requireCopyRole(value: AgentBackupCopyRole): AgentBackupCopyRole {
  if (value !== "primary" && value !== "secondary") {
    throw new Error("copyRole must be primary or secondary");
  }
  return value;
}

export async function acquireAgentBackupRestoreLease(params: {
  organizationId: string;
  backupId: string;
  operationId: string;
  sourceActivationGeneration: string;
  sourceLifecycleRevision: string;
  expectedManifestSha256: string;
  copyRole: AgentBackupCopyRole;
  restoreAttemptId: string;
  ownerId: string;
  fencingToken?: string;
  leaseMs: number;
}): Promise<AgentBackupRestoreLeaseAcquisition> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.backupId, "backupId");
  requireUuid(params.operationId, "operationId");
  requireUuid(params.sourceActivationGeneration, "sourceActivationGeneration");
  const sourceLifecycleRevision = requireCanonicalUint64(
    params.sourceLifecycleRevision,
    "sourceLifecycleRevision",
  );
  requireSha256Hex(params.expectedManifestSha256, "expectedManifestSha256");
  requireCopyRole(params.copyRole);
  requireUuid(params.restoreAttemptId, "restoreAttemptId");
  requireOwnerId(params.ownerId);
  const generation = requireUuid(params.fencingToken ?? randomUUID(), "fencingToken");
  if (!Number.isSafeInteger(params.leaseMs) || params.leaseMs < 1 || params.leaseMs > 3_600_000) {
    throw new Error("leaseMs must be a safe integer between 1 and 3600000");
  }

  return dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select({
        state: agentSandboxBackups.catalog_state,
        agentId: agentSandboxBackups.catalog_agent_id,
        manifestVersion: agentSandboxBackups.manifest_version,
        vaultKeyGenerationId: agentSandboxBackups.vault_key_generation_id,
        vaultKeyAuthorityReceiptDigest: agentSandboxBackups.vault_key_authority_receipt_digest,
      })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, params.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
          eq(agentSandboxBackups.backup_operation_id, params.operationId),
          eq(agentSandboxBackups.lifecycle_generation, params.sourceActivationGeneration),
          eq(agentSandboxBackups.lifecycle_revision, sourceLifecycleRevision),
          eq(agentSandboxBackups.manifest_digest, params.expectedManifestSha256),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup?.agentId) {
      throw new AgentBackupCatalogConflictError("Backup restore authority is missing");
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      params.organizationId,
      backup.agentId,
    );
    if (
      !hasAgentBackupRestoreAuthority(backup.state) ||
      backup.manifestVersion !== 3 ||
      !backup.vaultKeyGenerationId ||
      !backup.vaultKeyAuthorityReceiptDigest
    ) {
      throw new AgentBackupCatalogConflictError("Backup is not in a restorable catalogue state");
    }
    const [binding] = await tx
      .select({ backupId: agentVaultKeyBackupBindings.backup_id })
      .from(agentVaultKeyBackupBindings)
      .where(
        and(
          eq(agentVaultKeyBackupBindings.organization_id, params.organizationId),
          eq(agentVaultKeyBackupBindings.agent_id, backup.agentId),
          eq(agentVaultKeyBackupBindings.backup_id, params.backupId),
          eq(agentVaultKeyBackupBindings.operation_id, params.operationId),
          eq(
            agentVaultKeyBackupBindings.source_activation_generation,
            params.sourceActivationGeneration,
          ),
          eq(agentVaultKeyBackupBindings.source_lifecycle_revision, sourceLifecycleRevision),
          eq(agentVaultKeyBackupBindings.manifest_sha256, params.expectedManifestSha256),
          eq(agentVaultKeyBackupBindings.vault_key_generation_id, backup.vaultKeyGenerationId),
          eq(
            agentVaultKeyBackupBindings.vault_key_authority_receipt_digest,
            backup.vaultKeyAuthorityReceiptDigest,
          ),
        ),
      )
      .limit(1);
    if (!binding) {
      throw new AgentBackupCatalogConflictError(
        "Manifest-v3 backup is missing its immutable vault-key binding",
      );
    }
    const [existingAttempt] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.organization_id, params.organizationId),
          eq(agentBackupRestoreLeases.restore_attempt_id, params.restoreAttemptId),
          eq(agentBackupRestoreLeases.backup_id, params.backupId),
        ),
      )
      .for("update")
      .limit(1);
    if (!existingAttempt) {
      // A replay bound to another backup is only an authority conflict. Do not
      // wait on its lease after taking this agent's catalogue lock: exact
      // restore consumers take that lease before the catalogue lock.
      const [divergentAttempt] = await tx
        .select({ id: agentBackupRestoreLeases.id })
        .from(agentBackupRestoreLeases)
        .where(
          and(
            eq(agentBackupRestoreLeases.organization_id, params.organizationId),
            eq(agentBackupRestoreLeases.restore_attempt_id, params.restoreAttemptId),
          ),
        )
        .limit(1);
      if (divergentAttempt) {
        throw new AgentBackupCatalogConflictError("Restore attempt replay authority mismatch");
      }
    }
    const [unreleased] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.organization_id, params.organizationId),
          eq(agentBackupRestoreLeases.backup_id, params.backupId),
          isNull(agentBackupRestoreLeases.released_at),
        ),
      )
      .for("update")
      .limit(1);
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (existingAttempt) {
      if (
        existingAttempt.organization_id !== params.organizationId.toLowerCase() ||
        existingAttempt.agent_id !== backup.agentId ||
        existingAttempt.backup_id !== params.backupId.toLowerCase() ||
        existingAttempt.operation_id !== params.operationId.toLowerCase() ||
        existingAttempt.activation_generation !== params.sourceActivationGeneration.toLowerCase() ||
        existingAttempt.lifecycle_revision !== sourceLifecycleRevision ||
        existingAttempt.expected_manifest_sha256 !== params.expectedManifestSha256 ||
        existingAttempt.copy_role !== params.copyRole ||
        existingAttempt.owner_id !== params.ownerId
      ) {
        throw new AgentBackupCatalogConflictError("Restore attempt replay authority mismatch");
      }
      if (
        params.fencingToken !== undefined &&
        existingAttempt.generation !== params.fencingToken.toLowerCase()
      ) {
        throw new AgentBackupCatalogConflictError("Restore attempt fencing-token mismatch");
      }
      if (existingAttempt.released_at !== null) {
        throw new AgentBackupCatalogConflictError(
          "Restore attempt is terminal and cannot be reopened",
        );
      }
      if (existingAttempt.catalog_epoch !== authority.catalog_revision) {
        throw new AgentBackupCatalogConflictError(
          "Restore attempt was invalidated by a catalogue revision",
        );
      }
      if (existingAttempt.expires_at.getTime() <= databaseNow.getTime()) {
        throw new AgentBackupCatalogConflictError("Restore attempt lease has expired");
      }
      const authorityReceipt = leaseAuthorityReceipt(existingAttempt, databaseNow);
      return { status: "active", lease: authorityReceipt.lease, authority: authorityReceipt };
    }
    if (unreleased) {
      if (
        unreleased.expires_at.getTime() > databaseNow.getTime() &&
        unreleased.catalog_epoch === authority.catalog_revision
      ) {
        throw new AgentBackupCatalogConflictError(
          "Another restore attempt already owns this backup",
        );
      }
      const [released] = await tx
        .update(agentBackupRestoreLeases)
        .set({ released_at: databaseNow })
        .where(
          and(
            eq(agentBackupRestoreLeases.id, unreleased.id),
            isNull(agentBackupRestoreLeases.released_at),
          ),
        )
        .returning({ id: agentBackupRestoreLeases.id });
      if (!released) {
        throw new AgentBackupCatalogConflictError("Stale restore lease release CAS lost");
      }
    }
    const requestedExpiresAt = new Date(databaseNow.getTime() + params.leaseMs);
    const [inserted] = await tx
      .insert(agentBackupRestoreLeases)
      .values({
        organization_id: params.organizationId.toLowerCase(),
        agent_id: backup.agentId,
        backup_id: params.backupId.toLowerCase(),
        operation_id: params.operationId.toLowerCase(),
        activation_generation: params.sourceActivationGeneration.toLowerCase(),
        lifecycle_revision: sourceLifecycleRevision,
        expected_manifest_sha256: params.expectedManifestSha256,
        copy_role: params.copyRole,
        restore_attempt_id: params.restoreAttemptId.toLowerCase(),
        owner_id: params.ownerId,
        generation,
        catalog_epoch: authority.catalog_revision,
        expires_at: requestedExpiresAt,
        created_at: databaseNow,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      const authorityReceipt = leaseAuthorityReceipt(inserted, inserted.created_at);
      return { status: "acquired", lease: authorityReceipt.lease, authority: authorityReceipt };
    }
    const [existing] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.organization_id, params.organizationId),
          eq(agentBackupRestoreLeases.restore_attempt_id, params.restoreAttemptId),
        ),
      )
      .limit(1);
    if (
      !existing ||
      existing.organization_id !== params.organizationId.toLowerCase() ||
      existing.agent_id !== backup.agentId ||
      existing.backup_id !== params.backupId.toLowerCase() ||
      existing.operation_id !== params.operationId.toLowerCase() ||
      existing.activation_generation !== params.sourceActivationGeneration.toLowerCase() ||
      existing.lifecycle_revision !== sourceLifecycleRevision ||
      existing.expected_manifest_sha256 !== params.expectedManifestSha256 ||
      existing.copy_role !== params.copyRole ||
      existing.owner_id !== params.ownerId ||
      existing.generation !== generation ||
      existing.catalog_epoch !== authority.catalog_revision ||
      existing.released_at !== null ||
      existing.expires_at.getTime() <= databaseNow.getTime()
    ) {
      throw new AgentBackupCatalogConflictError("Restore lease generation replay mismatch");
    }
    const authorityReceipt = leaseAuthorityReceipt(existing, databaseNow);
    return { status: "active", lease: authorityReceipt.lease, authority: authorityReceipt };
  });
}

/** Extend an owned, still-live restore lease while the backup remains restorable. */
export async function renewAgentBackupRestoreLease(params: {
  organizationId: string;
  backupId: string;
  operationId: string;
  sourceActivationGeneration: string;
  sourceLifecycleRevision: string;
  expectedManifestSha256: string;
  copyRole: AgentBackupCopyRole;
  restoreAttemptId: string;
  leaseId: string;
  ownerId: string;
  fencingToken: string;
  catalogEpoch: string;
  leaseMs: number;
}): Promise<AgentBackupRestoreLeaseAuthorityReceipt> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.backupId, "backupId");
  requireUuid(params.operationId, "operationId");
  requireUuid(params.sourceActivationGeneration, "sourceActivationGeneration");
  const sourceLifecycleRevision = requireCanonicalUint64(
    params.sourceLifecycleRevision,
    "sourceLifecycleRevision",
  );
  requireSha256Hex(params.expectedManifestSha256, "expectedManifestSha256");
  requireCopyRole(params.copyRole);
  requireUuid(params.restoreAttemptId, "restoreAttemptId");
  requireUuid(params.leaseId, "leaseId");
  requireUuid(params.fencingToken, "fencingToken");
  const catalogEpoch = requireCanonicalUint64(params.catalogEpoch, "catalogEpoch");
  requireOwnerId(params.ownerId);
  if (!Number.isSafeInteger(params.leaseMs) || params.leaseMs < 1 || params.leaseMs > 3_600_000) {
    throw new Error("leaseMs must be a safe integer between 1 and 3600000");
  }

  return dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select({
        state: agentSandboxBackups.catalog_state,
        agentId: agentSandboxBackups.catalog_agent_id,
        manifestVersion: agentSandboxBackups.manifest_version,
        vaultKeyGenerationId: agentSandboxBackups.vault_key_generation_id,
        vaultKeyAuthorityReceiptDigest: agentSandboxBackups.vault_key_authority_receipt_digest,
      })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, params.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
          eq(agentSandboxBackups.backup_operation_id, params.operationId),
          eq(agentSandboxBackups.lifecycle_generation, params.sourceActivationGeneration),
          eq(agentSandboxBackups.lifecycle_revision, sourceLifecycleRevision),
          eq(agentSandboxBackups.manifest_digest, params.expectedManifestSha256),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !backup?.state ||
      !backup.agentId ||
      !hasAgentBackupRestoreAuthority(backup.state) ||
      backup.manifestVersion !== 3 ||
      !backup.vaultKeyGenerationId ||
      !backup.vaultKeyAuthorityReceiptDigest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore lease cannot renew after backup expiration begins",
      );
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      params.organizationId,
      backup.agentId,
    );
    if (authority.catalog_revision !== catalogEpoch) {
      throw new AgentBackupCatalogConflictError(
        "Restore lease cannot renew after catalogue authority changed",
      );
    }
    const [binding] = await tx
      .select({ backupId: agentVaultKeyBackupBindings.backup_id })
      .from(agentVaultKeyBackupBindings)
      .where(
        and(
          eq(agentVaultKeyBackupBindings.organization_id, params.organizationId),
          eq(agentVaultKeyBackupBindings.agent_id, backup.agentId),
          eq(agentVaultKeyBackupBindings.backup_id, params.backupId),
          eq(agentVaultKeyBackupBindings.operation_id, params.operationId),
          eq(
            agentVaultKeyBackupBindings.source_activation_generation,
            params.sourceActivationGeneration,
          ),
          eq(agentVaultKeyBackupBindings.source_lifecycle_revision, sourceLifecycleRevision),
          eq(agentVaultKeyBackupBindings.manifest_sha256, params.expectedManifestSha256),
          eq(agentVaultKeyBackupBindings.vault_key_generation_id, backup.vaultKeyGenerationId),
          eq(
            agentVaultKeyBackupBindings.vault_key_authority_receipt_digest,
            backup.vaultKeyAuthorityReceiptDigest,
          ),
        ),
      )
      .limit(1);
    if (!binding) {
      throw new AgentBackupCatalogConflictError(
        "Restore lease cannot renew without its immutable vault-key binding",
      );
    }
    const [existing] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.organization_id, params.organizationId),
          eq(agentBackupRestoreLeases.agent_id, backup.agentId),
          eq(agentBackupRestoreLeases.backup_id, params.backupId),
          eq(agentBackupRestoreLeases.operation_id, params.operationId),
          eq(agentBackupRestoreLeases.activation_generation, params.sourceActivationGeneration),
          eq(agentBackupRestoreLeases.lifecycle_revision, sourceLifecycleRevision),
          eq(agentBackupRestoreLeases.expected_manifest_sha256, params.expectedManifestSha256),
          eq(agentBackupRestoreLeases.copy_role, params.copyRole),
          eq(agentBackupRestoreLeases.id, params.leaseId),
          eq(agentBackupRestoreLeases.restore_attempt_id, params.restoreAttemptId),
          eq(agentBackupRestoreLeases.owner_id, params.ownerId),
          eq(agentBackupRestoreLeases.generation, params.fencingToken),
          eq(agentBackupRestoreLeases.catalog_epoch, catalogEpoch),
        ),
      )
      .for("update")
      .limit(1);
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (
      !existing ||
      existing.released_at !== null ||
      existing.expires_at.getTime() <= databaseNow.getTime()
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore lease renewal lost ownership or crossed its expiry",
      );
    }
    const requestedExpiresAt = new Date(databaseNow.getTime() + params.leaseMs);
    if (requestedExpiresAt.getTime() <= existing.expires_at.getTime()) {
      throw new AgentBackupCatalogConflictError("Restore lease renewal must extend its expiry");
    }
    const [renewed] = await tx
      .update(agentBackupRestoreLeases)
      .set({ expires_at: requestedExpiresAt })
      .where(
        and(
          eq(agentBackupRestoreLeases.id, existing.id),
          isNull(agentBackupRestoreLeases.released_at),
          eq(agentBackupRestoreLeases.expires_at, existing.expires_at),
        ),
      )
      .returning();
    if (!renewed) {
      throw new AgentBackupCatalogConflictError(
        "Restore lease renewal lost ownership or crossed its expiry",
      );
    }
    return leaseAuthorityReceipt(renewed, databaseNow);
  });
}

export async function releaseAgentBackupRestoreLease(
  params: Readonly<AgentBackupRestoreSourceV3Input>,
): Promise<AgentBackupRestoreLease> {
  requireUuid(params.organizationId, "organizationId");
  requireUuid(params.agentId, "agentId");
  requireUuid(params.backupId, "backupId");
  requireUuid(params.operationId, "operationId");
  requireUuid(params.sourceActivationGeneration, "sourceActivationGeneration");
  const sourceLifecycleRevision = requireCanonicalUint64(
    params.sourceLifecycleRevision,
    "sourceLifecycleRevision",
  );
  requireSha256Hex(params.expectedManifestSha256, "expectedManifestSha256");
  requireCopyRole(params.copyRole);
  requireUuid(params.restoreAttemptId, "restoreAttemptId");
  requireUuid(params.leaseId, "leaseId");
  requireUuid(params.fencingToken, "fencingToken");
  const catalogEpoch = requireCanonicalUint64(params.catalogEpoch, "catalogEpoch");
  requireOwnerId(params.ownerId);
  return dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select({ agentId: agentSandboxBackups.catalog_agent_id })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, params.backupId),
          eq(agentSandboxBackups.catalog_organization_id, params.organizationId),
          eq(agentSandboxBackups.catalog_agent_id, params.agentId),
          eq(agentSandboxBackups.backup_operation_id, params.operationId),
          eq(agentSandboxBackups.lifecycle_generation, params.sourceActivationGeneration),
          eq(agentSandboxBackups.lifecycle_revision, sourceLifecycleRevision),
          eq(agentSandboxBackups.manifest_digest, params.expectedManifestSha256),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup?.agentId) {
      throw new AgentBackupCatalogConflictError("Restore lease backup authority is absent");
    }
    await lockAgentBackupCatalogAuthority(tx, params.organizationId, params.agentId);
    const [existing] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.organization_id, params.organizationId),
          eq(agentBackupRestoreLeases.agent_id, params.agentId),
          eq(agentBackupRestoreLeases.backup_id, params.backupId),
          eq(agentBackupRestoreLeases.operation_id, params.operationId),
          eq(agentBackupRestoreLeases.activation_generation, params.sourceActivationGeneration),
          eq(agentBackupRestoreLeases.lifecycle_revision, sourceLifecycleRevision),
          eq(agentBackupRestoreLeases.expected_manifest_sha256, params.expectedManifestSha256),
          eq(agentBackupRestoreLeases.copy_role, params.copyRole),
          eq(agentBackupRestoreLeases.id, params.leaseId),
          eq(agentBackupRestoreLeases.restore_attempt_id, params.restoreAttemptId),
          eq(agentBackupRestoreLeases.owner_id, params.ownerId),
          eq(agentBackupRestoreLeases.generation, params.fencingToken),
          eq(agentBackupRestoreLeases.catalog_epoch, catalogEpoch),
        ),
      )
      .for("update")
      .limit(1);
    if (!existing) throw new AgentBackupCatalogConflictError("Restore lease is absent");
    if (existing.released_at) return existing;
    const databaseNow = await readPostLockDatabaseNow(tx);
    const [released] = await tx
      .update(agentBackupRestoreLeases)
      .set({ released_at: databaseNow })
      .where(
        and(
          eq(agentBackupRestoreLeases.id, existing.id),
          isNull(agentBackupRestoreLeases.released_at),
        ),
      )
      .returning();
    if (!released) throw new AgentBackupCatalogConflictError("Restore lease release CAS lost");
    return released;
  });
}
