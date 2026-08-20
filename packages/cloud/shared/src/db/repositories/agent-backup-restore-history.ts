/** Appends and replays immutable restore authorities without wiring a production coordinator. */

import { and, eq, inArray } from "drizzle-orm";
import {
  assertAgentBackupCatalogTransition,
  requireBoundedIdentity,
  requireSha256Hex,
} from "../../lib/services/agent-backup-catalog-state";
import { isValidUUID } from "../../lib/utils/validation";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  agentBackupCatalogAuthorities,
  agentBackupRestoreLeases,
} from "../schemas/agent-backup-catalog";
import {
  type AgentActivationPublication,
  type AgentBackupRestoreReceipt,
  type AgentNodeIncarnationHistory,
  type AgentVaultKeySeedReceipt,
  agentActivationPublications,
  agentBackupRestoreReceipts,
  agentNodeIncarnationHistories,
  agentVaultKeySeedReceipts,
} from "../schemas/agent-backup-restore-history";
import { agentSandboxBackups, agentSandboxes } from "../schemas/agent-sandboxes";
import { agentVaultKeyBackupBindings } from "../schemas/agent-vault-key-authority";
import { dockerNodes } from "../schemas/docker-nodes";
import { AgentBackupCatalogConflictError } from "./agent-backup-catalog";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

function requireUuid(value: string, field: string): string {
  if (!isValidUUID(value) || value !== value.toLowerCase()) {
    throw new Error(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function conflict(message: string): never {
  throw new AgentBackupCatalogConflictError(message);
}

async function lockCurrentNodeHistory(
  tx: DbTransaction,
  input: { nodeRecordId: string; nodeId?: string; nodeIncarnation: string },
): Promise<AgentNodeIncarnationHistory> {
  const [node] = await tx
    .select()
    .from(dockerNodes)
    .where(
      and(
        eq(dockerNodes.id, input.nodeRecordId),
        input.nodeId ? eq(dockerNodes.node_id, input.nodeId) : undefined,
        eq(dockerNodes.node_incarnation, input.nodeIncarnation),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !node?.fleet_kind ||
    !node.infrastructure_provider ||
    !node.host_key_fingerprint ||
    node.infrastructure_provider !== "hetzner"
  ) {
    conflict("Target node incarnation is absent or lacks typed immutable authority");
  }
  await tx
    .insert(agentNodeIncarnationHistories)
    .values({
      docker_node_record_id: node.id,
      node_id: node.node_id,
      node_incarnation: input.nodeIncarnation,
      fleet_kind: node.fleet_kind,
      infrastructure_provider: node.infrastructure_provider,
      provider_server_id: node.provider_server_id,
      host_key_fingerprint: node.host_key_fingerprint,
    })
    .onConflictDoNothing({
      target: [
        agentNodeIncarnationHistories.docker_node_record_id,
        agentNodeIncarnationHistories.node_incarnation,
      ],
    });
  // Read back on the same composite key the insert arbitrates on. A boot id is
  // unique per node record, not globally (0259), so selecting on the incarnation
  // alone would pick an arbitrary record's row once a host re-registers.
  const [history] = await tx
    .select()
    .from(agentNodeIncarnationHistories)
    .where(
      and(
        eq(agentNodeIncarnationHistories.docker_node_record_id, node.id),
        eq(agentNodeIncarnationHistories.node_incarnation, input.nodeIncarnation),
      ),
    )
    .limit(1);
  if (
    !history ||
    history.docker_node_record_id !== node.id ||
    history.node_id !== node.node_id ||
    history.fleet_kind !== node.fleet_kind ||
    history.infrastructure_provider !== node.infrastructure_provider ||
    history.provider_server_id !== node.provider_server_id ||
    history.host_key_fingerprint !== node.host_key_fingerprint
  ) {
    conflict("Target node incarnation conflicts with immutable history");
  }
  return history;
}

export interface RecordAgentActivationPublicationInput {
  publicationId: string;
  organizationId: string;
  agentId: string;
  activationGeneration: string;
  expectedActivationReceiptSha256: string;
  expectedContainerId: string;
  expectedNodeRecordId: string;
  expectedNodeIncarnation: string;
  expectedTokenSha256: string;
}

function validatePublicationInput(input: RecordAgentActivationPublicationInput): void {
  requireUuid(input.publicationId, "publicationId");
  requireUuid(input.organizationId, "organizationId");
  requireUuid(input.agentId, "agentId");
  requireUuid(input.activationGeneration, "activationGeneration");
  requireUuid(input.expectedNodeRecordId, "expectedNodeRecordId");
  requireUuid(input.expectedNodeIncarnation, "expectedNodeIncarnation");
  requireSha256Hex(input.expectedActivationReceiptSha256, "expectedActivationReceiptSha256");
  requireSha256Hex(input.expectedTokenSha256, "expectedTokenSha256");
  if (!/^[0-9a-f]{64}$/.test(input.expectedContainerId)) {
    throw new Error("expectedContainerId must be a lowercase 64-character container id");
  }
}

function publicationMatchesInput(
  publication: AgentActivationPublication,
  input: RecordAgentActivationPublicationInput,
): boolean {
  return (
    publication.id === input.publicationId &&
    publication.organization_id === input.organizationId &&
    publication.agent_id === input.agentId &&
    publication.activation_generation === input.activationGeneration &&
    publication.activation_receipt_sha256 === input.expectedActivationReceiptSha256 &&
    publication.container_id === input.expectedContainerId &&
    publication.docker_node_record_id === input.expectedNodeRecordId &&
    publication.node_incarnation === input.expectedNodeIncarnation &&
    publication.token_sha256 === input.expectedTokenSha256
  );
}

/**
 * Publish one immutable activation authority after restart attestation. Exact
 * replay returns the original row; a changed mutable generation is rejected.
 */
export async function recordAgentActivationPublication(
  input: Readonly<RecordAgentActivationPublicationInput>,
): Promise<{ publication: AgentActivationPublication; replayed: boolean }> {
  validatePublicationInput(input);
  return dbWrite.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(agentActivationPublications)
      .where(
        and(
          eq(agentActivationPublications.organization_id, input.organizationId),
          eq(agentActivationPublications.agent_id, input.agentId),
          eq(agentActivationPublications.activation_generation, input.activationGeneration),
        ),
      )
      .limit(1);
    if (existing) {
      if (!publicationMatchesInput(existing, input))
        conflict("Activation publication replay mismatch");
      return { publication: existing, replayed: true };
    }

    const [sandbox] = await tx
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, input.agentId),
          eq(agentSandboxes.organization_id, input.organizationId),
          eq(agentSandboxes.activation_generation, input.activationGeneration),
          inArray(agentSandboxes.activation_phase, ["restart_attested", "active"]),
        ),
      )
      .for("update")
      .limit(1);
    const [concurrentPublication] = await tx
      .select()
      .from(agentActivationPublications)
      .where(
        and(
          eq(agentActivationPublications.organization_id, input.organizationId),
          eq(agentActivationPublications.agent_id, input.agentId),
          eq(agentActivationPublications.activation_generation, input.activationGeneration),
        ),
      )
      .limit(1);
    if (concurrentPublication) {
      if (!publicationMatchesInput(concurrentPublication, input)) {
        conflict("Activation publication replay mismatch");
      }
      return { publication: concurrentPublication, replayed: true };
    }
    if (
      !sandbox?.activation_purpose ||
      !sandbox.activation_receipt ||
      !sandbox.activation_receipt_hash ||
      !sandbox.activation_container_id ||
      !sandbox.activation_node_id ||
      !sandbox.activation_boot_id ||
      !sandbox.activation_image_digest ||
      !sandbox.activation_token_hash ||
      sandbox.activation_funding_revision === null ||
      sandbox.activation_lifecycle_revision === null ||
      sandbox.activation_receipt_hash !== input.expectedActivationReceiptSha256 ||
      sandbox.activation_container_id !== input.expectedContainerId ||
      sandbox.activation_boot_id !== input.expectedNodeIncarnation ||
      sandbox.activation_token_hash !== input.expectedTokenSha256
    ) {
      conflict("Mutable activation authority is incomplete or differs from publication input");
    }
    if (
      sandbox.activation_purpose === "restore" &&
      (!sandbox.activation_backup_id || !sandbox.activation_backup_hash)
    ) {
      conflict("Restore activation lacks an exact backup authority");
    }
    const history = await lockCurrentNodeHistory(tx, {
      nodeRecordId: input.expectedNodeRecordId,
      nodeId: sandbox.activation_node_id,
      nodeIncarnation: input.expectedNodeIncarnation,
    });
    const [publication] = await tx
      .insert(agentActivationPublications)
      .values({
        id: input.publicationId,
        organization_id: input.organizationId,
        agent_id: input.agentId,
        activation_generation: input.activationGeneration,
        previous_activation_generation: sandbox.activation_previous_generation,
        lifecycle_revision: sandbox.activation_lifecycle_revision,
        purpose: sandbox.activation_purpose,
        backup_id: sandbox.activation_backup_id,
        backup_manifest_sha256: sandbox.activation_backup_hash,
        activation_receipt: sandbox.activation_receipt,
        activation_receipt_sha256: sandbox.activation_receipt_hash,
        container_id: sandbox.activation_container_id,
        node_history_id: history.id,
        docker_node_record_id: history.docker_node_record_id,
        node_id: history.node_id,
        node_incarnation: history.node_incarnation,
        image_digest: sandbox.activation_image_digest,
        token_sha256: sandbox.activation_token_hash,
        funding_revision: sandbox.activation_funding_revision,
      })
      .returning();
    if (!publication) conflict("Activation publication insert returned no row");
    return { publication, replayed: false };
  });
}

/** Reauthorize only the exact current generation represented by a publication. */
export async function authorizeAgentActivationDispatch(
  input: Readonly<RecordAgentActivationPublicationInput>,
): Promise<AgentActivationPublication> {
  validatePublicationInput(input);
  return dbWrite.transaction(async (tx) => {
    const [publication] = await tx
      .select()
      .from(agentActivationPublications)
      .where(eq(agentActivationPublications.id, input.publicationId))
      .for("update")
      .limit(1);
    if (!publication || !publicationMatchesInput(publication, input)) {
      conflict("Activation dispatch lacks exact publication authority");
    }
    const [sandbox] = await tx
      .select({
        generation: agentSandboxes.activation_generation,
        phase: agentSandboxes.activation_phase,
        receiptSha256: agentSandboxes.activation_receipt_hash,
        containerId: agentSandboxes.activation_container_id,
        nodeId: agentSandboxes.activation_node_id,
        nodeIncarnation: agentSandboxes.activation_boot_id,
        tokenSha256: agentSandboxes.activation_token_hash,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, input.agentId),
          eq(agentSandboxes.organization_id, input.organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !sandbox ||
      sandbox.generation !== publication.activation_generation ||
      (sandbox.phase !== "restart_attested" && sandbox.phase !== "active") ||
      sandbox.receiptSha256 !== publication.activation_receipt_sha256 ||
      sandbox.containerId !== publication.container_id ||
      sandbox.nodeId !== publication.node_id ||
      sandbox.nodeIncarnation !== publication.node_incarnation ||
      sandbox.tokenSha256 !== publication.token_sha256
    ) {
      conflict("Activation dispatch lost current mutable authority");
    }
    await lockCurrentNodeHistory(tx, {
      nodeRecordId: publication.docker_node_record_id,
      nodeId: publication.node_id,
      nodeIncarnation: publication.node_incarnation,
    });
    return publication;
  });
}

export interface RecordAgentVaultKeySeedReceiptInput {
  receiptId: string;
  /** SHA-256 of the authenticated seeding result; the future coordinator verifies its payload. */
  receiptDigest: string;
  organizationId: string;
  agentId: string;
  backupId: string;
  restoreAttemptId: string;
  leaseId: string;
  leaseOwnerId: string;
  leaseFencingToken: string;
  targetActivationGeneration: string;
  targetNodeRecordId: string;
  targetNodeIncarnation: string;
}

function validateSeedInput(input: RecordAgentVaultKeySeedReceiptInput): void {
  for (const [field, value] of Object.entries(input)) {
    if (field === "receiptDigest" || field === "leaseOwnerId") continue;
    requireUuid(value, field);
  }
  requireSha256Hex(input.receiptDigest, "receiptDigest");
  requireBoundedIdentity(input.leaseOwnerId, "leaseOwnerId");
}

function seedMatchesInput(
  receipt: AgentVaultKeySeedReceipt,
  input: RecordAgentVaultKeySeedReceiptInput,
): boolean {
  return (
    receipt.id === input.receiptId &&
    receipt.receipt_digest === input.receiptDigest &&
    receipt.organization_id === input.organizationId &&
    receipt.agent_id === input.agentId &&
    receipt.backup_id === input.backupId &&
    receipt.restore_attempt_id === input.restoreAttemptId &&
    receipt.lease_id === input.leaseId &&
    receipt.lease_owner_id === input.leaseOwnerId &&
    receipt.lease_fencing_token === input.leaseFencingToken &&
    receipt.target_activation_generation === input.targetActivationGeneration &&
    receipt.docker_node_record_id === input.targetNodeRecordId &&
    receipt.node_incarnation === input.targetNodeIncarnation
  );
}

/** Append a post-seed receipt only while the exact database lease remains live. */
export async function recordAgentVaultKeySeedReceipt(
  input: Readonly<RecordAgentVaultKeySeedReceiptInput>,
): Promise<{ receipt: AgentVaultKeySeedReceipt; replayed: boolean }> {
  validateSeedInput(input);
  return dbWrite.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(agentVaultKeySeedReceipts)
      .where(
        and(
          eq(agentVaultKeySeedReceipts.organization_id, input.organizationId),
          eq(agentVaultKeySeedReceipts.restore_attempt_id, input.restoreAttemptId),
        ),
      )
      .limit(1);
    if (existing) {
      if (!seedMatchesInput(existing, input)) conflict("Vault-seed receipt replay mismatch");
      return { receipt: existing, replayed: true };
    }

    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, input.backupId),
          eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
          eq(agentSandboxBackups.catalog_agent_id, input.agentId),
        ),
      )
      .for("update")
      .limit(1);
    const [concurrentReceipt] = await tx
      .select()
      .from(agentVaultKeySeedReceipts)
      .where(
        and(
          eq(agentVaultKeySeedReceipts.organization_id, input.organizationId),
          eq(agentVaultKeySeedReceipts.restore_attempt_id, input.restoreAttemptId),
        ),
      )
      .limit(1);
    if (concurrentReceipt) {
      if (!seedMatchesInput(concurrentReceipt, input)) {
        conflict("Vault-seed receipt replay mismatch");
      }
      return { receipt: concurrentReceipt, replayed: true };
    }
    if (
      !backup?.backup_operation_id ||
      !backup.lifecycle_generation ||
      backup.lifecycle_revision === null ||
      !backup.manifest_digest ||
      !backup.vault_key_generation_id ||
      !backup.vault_key_authority_receipt_digest ||
      !["protected", "retained", "restore_verified"].includes(backup.catalog_state ?? "")
    ) {
      conflict("Vault seed source is absent or lacks restorable manifest-v3 authority");
    }
    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, input.leaseId),
          eq(agentBackupRestoreLeases.organization_id, input.organizationId),
          eq(agentBackupRestoreLeases.agent_id, input.agentId),
          eq(agentBackupRestoreLeases.backup_id, input.backupId),
          eq(agentBackupRestoreLeases.restore_attempt_id, input.restoreAttemptId),
          eq(agentBackupRestoreLeases.owner_id, input.leaseOwnerId),
          eq(agentBackupRestoreLeases.generation, input.leaseFencingToken),
        ),
      )
      .for("update")
      .limit(1);
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (
      !lease ||
      lease.released_at !== null ||
      lease.expires_at.getTime() <= databaseNow.getTime() ||
      lease.operation_id !== backup.backup_operation_id ||
      lease.activation_generation !== backup.lifecycle_generation ||
      lease.lifecycle_revision !== backup.lifecycle_revision ||
      lease.expected_manifest_sha256 !== backup.manifest_digest
    ) {
      conflict("Vault seed lost its exact live restore lease");
    }
    const [binding] = await tx
      .select()
      .from(agentVaultKeyBackupBindings)
      .where(
        and(
          eq(agentVaultKeyBackupBindings.organization_id, input.organizationId),
          eq(agentVaultKeyBackupBindings.agent_id, input.agentId),
          eq(agentVaultKeyBackupBindings.backup_id, input.backupId),
          eq(agentVaultKeyBackupBindings.operation_id, backup.backup_operation_id),
          eq(agentVaultKeyBackupBindings.manifest_sha256, backup.manifest_digest),
          eq(agentVaultKeyBackupBindings.vault_key_generation_id, backup.vault_key_generation_id),
        ),
      )
      .limit(1);
    if (!binding) conflict("Vault seed source lacks its exact immutable vault binding");
    const [sandbox] = await tx
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, input.agentId),
          eq(agentSandboxes.organization_id, input.organizationId),
          eq(agentSandboxes.activation_generation, input.targetActivationGeneration),
          eq(agentSandboxes.activation_purpose, "restore"),
          eq(agentSandboxes.activation_backup_id, input.backupId),
          eq(agentSandboxes.activation_backup_hash, backup.manifest_digest),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !sandbox ||
      (sandbox.activation_phase !== "restart_attested" && sandbox.activation_phase !== "active") ||
      !sandbox.activation_node_id ||
      sandbox.activation_boot_id !== input.targetNodeIncarnation
    ) {
      conflict("Vault seed target activation is absent, unattested, changed, or blocked");
    }
    const history = await lockCurrentNodeHistory(tx, {
      nodeRecordId: input.targetNodeRecordId,
      nodeId: sandbox.activation_node_id,
      nodeIncarnation: input.targetNodeIncarnation,
    });
    // Backup writers that also fence a live sandbox take sandbox and node
    // authority before the per-agent catalogue authority. Keeping this global
    // order aligned with reservation/capture and vault-key rotation prevents
    // sandbox <-> catalogue-authority AB-BA deadlocks.
    const [authority] = await tx
      .select()
      .from(agentBackupCatalogAuthorities)
      .where(
        and(
          eq(agentBackupCatalogAuthorities.organization_id, input.organizationId),
          eq(agentBackupCatalogAuthorities.agent_id, input.agentId),
        ),
      )
      .for("update")
      .limit(1);
    if (!authority || lease.catalog_epoch !== authority.catalog_revision) {
      conflict("Vault seed lost its exact live restore lease");
    }
    const finalDatabaseNow = await readPostLockDatabaseNow(tx);
    if (lease.expires_at.getTime() <= finalDatabaseNow.getTime()) {
      conflict("Vault seed lease expired while mutable authorities were revalidated");
    }
    const [receipt] = await tx
      .insert(agentVaultKeySeedReceipts)
      .values({
        id: input.receiptId,
        organization_id: input.organizationId,
        agent_id: input.agentId,
        restore_attempt_id: input.restoreAttemptId,
        lease_id: lease.id,
        lease_owner_id: lease.owner_id,
        lease_fencing_token: lease.generation,
        lease_expires_at: lease.expires_at,
        backup_id: backup.id,
        operation_id: backup.backup_operation_id,
        source_activation_generation: backup.lifecycle_generation,
        source_lifecycle_revision: backup.lifecycle_revision,
        manifest_sha256: backup.manifest_digest,
        vault_key_generation_id: binding.vault_key_generation_id,
        vault_key_authority_receipt_digest: binding.vault_key_authority_receipt_digest,
        target_activation_generation: input.targetActivationGeneration,
        node_history_id: history.id,
        docker_node_record_id: history.docker_node_record_id,
        node_incarnation: history.node_incarnation,
        receipt_digest: input.receiptDigest,
      })
      .returning();
    if (!receipt) conflict("Vault-seed receipt insert returned no row");
    return { receipt, replayed: false };
  });
}

export interface CommitAgentBackupRestoreInput {
  receiptId: string;
  /** SHA-256 of the authenticated restore result; the future coordinator verifies its payload. */
  receiptDigest: string;
  organizationId: string;
  agentId: string;
  backupId: string;
  restoreAttemptId: string;
  seedReceiptId: string;
  seedReceiptDigest: string;
  activationPublicationId: string;
  targetActivationGeneration: string;
  expectedActivationReceiptSha256: string;
}

function validateCommitInput(input: CommitAgentBackupRestoreInput): void {
  for (const [field, value] of Object.entries(input)) {
    if (field.endsWith("Digest") || field.endsWith("Sha256")) continue;
    requireUuid(value, field);
  }
  requireSha256Hex(input.receiptDigest, "receiptDigest");
  requireSha256Hex(input.seedReceiptDigest, "seedReceiptDigest");
  requireSha256Hex(input.expectedActivationReceiptSha256, "expectedActivationReceiptSha256");
}

function finalReceiptMatchesInput(
  receipt: AgentBackupRestoreReceipt,
  input: CommitAgentBackupRestoreInput,
): boolean {
  return (
    receipt.id === input.receiptId &&
    receipt.receipt_digest === input.receiptDigest &&
    receipt.organization_id === input.organizationId &&
    receipt.agent_id === input.agentId &&
    receipt.backup_id === input.backupId &&
    receipt.restore_attempt_id === input.restoreAttemptId &&
    receipt.seed_receipt_id === input.seedReceiptId &&
    receipt.seed_receipt_digest === input.seedReceiptDigest &&
    receipt.activation_publication_id === input.activationPublicationId &&
    receipt.target_activation_generation === input.targetActivationGeneration &&
    receipt.activation_receipt_sha256 === input.expectedActivationReceiptSha256
  );
}

/**
 * Atomically append the final receipt, advance the monotone restore counter,
 * and mark the exact source backup restore-verified. This remains unwired.
 */
export async function commitAgentBackupRestore(
  input: Readonly<CommitAgentBackupRestoreInput>,
): Promise<{ receipt: AgentBackupRestoreReceipt; replayed: boolean }> {
  validateCommitInput(input);
  return dbWrite.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(agentBackupRestoreReceipts)
      .where(
        and(
          eq(agentBackupRestoreReceipts.organization_id, input.organizationId),
          eq(agentBackupRestoreReceipts.restore_attempt_id, input.restoreAttemptId),
        ),
      )
      .limit(1);
    if (existing) {
      if (!finalReceiptMatchesInput(existing, input))
        conflict("Final restore receipt replay mismatch");
      return { receipt: existing, replayed: true };
    }

    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, input.backupId),
          eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
          eq(agentSandboxBackups.catalog_agent_id, input.agentId),
        ),
      )
      .for("update")
      .limit(1);
    const [concurrentReceipt] = await tx
      .select()
      .from(agentBackupRestoreReceipts)
      .where(
        and(
          eq(agentBackupRestoreReceipts.organization_id, input.organizationId),
          eq(agentBackupRestoreReceipts.restore_attempt_id, input.restoreAttemptId),
        ),
      )
      .limit(1);
    if (concurrentReceipt) {
      if (!finalReceiptMatchesInput(concurrentReceipt, input)) {
        conflict("Final restore receipt replay mismatch");
      }
      return { receipt: concurrentReceipt, replayed: true };
    }
    if (
      !backup?.backup_operation_id ||
      !backup.lifecycle_generation ||
      backup.lifecycle_revision === null ||
      !backup.manifest_digest ||
      (backup.catalog_state !== "protected" && backup.catalog_state !== "retained")
    ) {
      conflict("Final restore source is absent, already finalized, or no longer restorable");
    }
    assertAgentBackupCatalogTransition({ from: backup.catalog_state, to: "restore_verified" });
    const [seed] = await tx
      .select()
      .from(agentVaultKeySeedReceipts)
      .where(
        and(
          eq(agentVaultKeySeedReceipts.id, input.seedReceiptId),
          eq(agentVaultKeySeedReceipts.organization_id, input.organizationId),
          eq(agentVaultKeySeedReceipts.agent_id, input.agentId),
          eq(agentVaultKeySeedReceipts.restore_attempt_id, input.restoreAttemptId),
          eq(agentVaultKeySeedReceipts.receipt_digest, input.seedReceiptDigest),
        ),
      )
      .limit(1);
    const [publication] = await tx
      .select()
      .from(agentActivationPublications)
      .where(
        and(
          eq(agentActivationPublications.id, input.activationPublicationId),
          eq(agentActivationPublications.organization_id, input.organizationId),
          eq(agentActivationPublications.agent_id, input.agentId),
          eq(agentActivationPublications.activation_generation, input.targetActivationGeneration),
          eq(agentActivationPublications.purpose, "restore"),
          eq(
            agentActivationPublications.activation_receipt_sha256,
            input.expectedActivationReceiptSha256,
          ),
        ),
      )
      .limit(1);
    if (
      !seed ||
      !publication ||
      seed.backup_id !== backup.id ||
      seed.source_activation_generation !== backup.lifecycle_generation ||
      seed.source_lifecycle_revision !== backup.lifecycle_revision ||
      seed.manifest_sha256 !== backup.manifest_digest ||
      seed.target_activation_generation !== publication.activation_generation ||
      seed.docker_node_record_id !== publication.docker_node_record_id ||
      seed.node_incarnation !== publication.node_incarnation ||
      publication.backup_id !== backup.id ||
      publication.backup_manifest_sha256 !== backup.manifest_digest
    ) {
      conflict("Final restore chain differs from source, seed, or activation publication");
    }
    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, seed.lease_id),
          eq(agentBackupRestoreLeases.organization_id, seed.organization_id),
          eq(agentBackupRestoreLeases.agent_id, seed.agent_id),
          eq(agentBackupRestoreLeases.backup_id, seed.backup_id),
          eq(agentBackupRestoreLeases.restore_attempt_id, seed.restore_attempt_id),
          eq(agentBackupRestoreLeases.owner_id, seed.lease_owner_id),
          eq(agentBackupRestoreLeases.generation, seed.lease_fencing_token),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !lease ||
      lease.released_at !== null ||
      lease.operation_id !== seed.operation_id ||
      lease.activation_generation !== seed.source_activation_generation ||
      lease.lifecycle_revision !== seed.source_lifecycle_revision ||
      lease.expected_manifest_sha256 !== seed.manifest_sha256
    ) {
      conflict("Final restore lost its exact live restore lease");
    }
    const [sandbox] = await tx
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, input.agentId),
          eq(agentSandboxes.organization_id, input.organizationId),
          eq(agentSandboxes.activation_generation, input.targetActivationGeneration),
          eq(agentSandboxes.activation_purpose, "restore"),
          eq(agentSandboxes.activation_phase, "active"),
          eq(agentSandboxes.activation_backup_id, input.backupId),
          eq(agentSandboxes.activation_backup_hash, backup.manifest_digest),
          eq(agentSandboxes.activation_receipt_hash, input.expectedActivationReceiptSha256),
          eq(agentSandboxes.activation_boot_id, publication.node_incarnation),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !sandbox ||
      sandbox.activation_container_id !== publication.container_id ||
      sandbox.activation_node_id !== publication.node_id ||
      sandbox.activation_image_digest !== publication.image_digest ||
      sandbox.activation_token_hash !== publication.token_sha256 ||
      sandbox.activation_lifecycle_revision !== publication.lifecycle_revision
    ) {
      conflict("Final restore lost exact current sandbox activation authority");
    }
    // The permanent receipt attests a restore onto a specific boot. Row-lock the
    // node and re-prove that boot is still the live one, exactly as the seed
    // writer does before its own append-only write: a target that reboots
    // between publication and commit otherwise earns a receipt naming an
    // incarnation that no longer exists, which authorizeAgentActivationDispatch
    // already refuses to dispatch onto.
    await lockCurrentNodeHistory(tx, {
      nodeRecordId: publication.docker_node_record_id,
      nodeId: publication.node_id,
      nodeIncarnation: publication.node_incarnation,
    });
    // Match every sandbox-bearing backup writer: sandbox and node authority
    // precede catalogue authority. Writers without a sandbox still serialize
    // on the already-locked backup row before reaching this authority.
    const [authority] = await tx
      .select()
      .from(agentBackupCatalogAuthorities)
      .where(
        and(
          eq(agentBackupCatalogAuthorities.organization_id, input.organizationId),
          eq(agentBackupCatalogAuthorities.agent_id, input.agentId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !authority ||
      authority.restore_generation >= MAX_SIGNED_BIGINT ||
      lease.catalog_epoch !== authority.catalog_revision
    ) {
      conflict("Restore generation authority is absent, stale, or exhausted");
    }
    const verifiedAt = await readPostLockDatabaseNow(tx);
    if (lease.expires_at.getTime() <= verifiedAt.getTime()) {
      conflict("Final restore lease expired while mutable authorities were revalidated");
    }
    const nextGeneration = authority.restore_generation + 1n;
    const [receipt] = await tx
      .insert(agentBackupRestoreReceipts)
      .values({
        id: input.receiptId,
        organization_id: input.organizationId,
        agent_id: input.agentId,
        restore_attempt_id: input.restoreAttemptId,
        backup_id: backup.id,
        operation_id: backup.backup_operation_id,
        source_activation_generation: backup.lifecycle_generation,
        source_lifecycle_revision: backup.lifecycle_revision,
        manifest_sha256: backup.manifest_digest,
        seed_receipt_id: seed.id,
        seed_receipt_digest: seed.receipt_digest,
        target_activation_generation: publication.activation_generation,
        activation_purpose: "restore",
        activation_publication_id: publication.id,
        activation_receipt_sha256: publication.activation_receipt_sha256,
        restore_generation: nextGeneration,
        receipt_digest: input.receiptDigest,
        verified_at: verifiedAt,
      })
      .returning();
    if (!receipt) conflict("Final restore receipt insert returned no row");
    const updatedAuthority = await tx
      .update(agentBackupCatalogAuthorities)
      .set({ restore_generation: nextGeneration, updated_at: verifiedAt })
      .where(
        and(
          eq(agentBackupCatalogAuthorities.organization_id, input.organizationId),
          eq(agentBackupCatalogAuthorities.agent_id, input.agentId),
          eq(agentBackupCatalogAuthorities.restore_generation, authority.restore_generation),
        ),
      )
      .returning({ generation: agentBackupCatalogAuthorities.restore_generation });
    const updatedBackup = await tx
      .update(agentSandboxBackups)
      .set({
        catalog_state: "restore_verified",
        restore_generation: nextGeneration,
        restore_receipt_digest: input.receiptDigest,
        restore_verified_at: verifiedAt,
        catalog_updated_at: verifiedAt,
      })
      .where(
        and(
          eq(agentSandboxBackups.id, backup.id),
          eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
          eq(agentSandboxBackups.catalog_agent_id, input.agentId),
          eq(agentSandboxBackups.catalog_state, backup.catalog_state),
        ),
      )
      .returning({ id: agentSandboxBackups.id });
    if (updatedAuthority.length !== 1 || updatedBackup.length !== 1) {
      conflict("Final restore compare-and-swap lost authority");
    }
    return { receipt, replayed: false };
  });
}
