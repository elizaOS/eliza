/** Appends and replays immutable restore authorities without wiring a production coordinator. */

import { Buffer } from "node:buffer";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  assertAgentBackupCatalogTransition,
  requireBoundedIdentity,
  requireSha256Hex,
} from "../../lib/services/agent-backup-catalog-state";
import {
  AGENT_BACKUP_RESTORE_VAULT_PASSPHRASE_BYTES,
  buildRestoreVolumeVaultSeedReceiptV1,
} from "../../lib/services/agent-backup-restore-vault-seed";
import { isValidUUID } from "../../lib/utils/validation";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  type AgentBackupRestoreLease,
  type AgentBackupRestoreOperation,
  agentBackupCatalogAuthorities,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
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
import {
  type AgentSandboxReplacementAttempt,
  agentSandboxReplacementAttempts,
} from "../schemas/agent-sandbox-replacement-attempts";
import { type AgentSandbox, agentSandboxBackups, agentSandboxes } from "../schemas/agent-sandboxes";
import { agentVaultKeyBackupBindings } from "../schemas/agent-vault-key-authority";
import { type DockerNode, dockerNodes } from "../schemas/docker-nodes";
import {
  AgentBackupCatalogConflictError,
  lockAgentBackupCatalogAuthority,
} from "./agent-backup-catalog";
import { parseAgentBackupManifestV3Authority } from "./agent-backup-restore";
import { hasAgentBackupRestoreAuthority } from "./agent-backup-restore-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const MAX_ACTIVATION_TOKEN_CIPHERTEXT_BYTES = 16_384;

function requireUuid(value: string, field: string): string {
  if (!isValidUUID(value) || value !== value.toLowerCase()) {
    throw new AgentBackupCatalogConflictError(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function conflict(message: string): never {
  throw new AgentBackupCatalogConflictError(message);
}

interface ExactRestoreOperationTarget {
  organizationId: string;
  agentId: string;
  backupId: string;
  restoreAttemptId: string;
  targetActivationGeneration: string;
  expectedOperationId: string;
  expectedManifestSha256: string;
  expectedSourceActivationGeneration: string;
  expectedSourceLifecycleRevision: bigint;
  expectedNodeRecordId: string;
  expectedNodeIncarnation: string;
  expectedNodeHistoryId: string;
}

/** Lock and prove the write-once target selected for one restore attempt. */
async function lockExactRestoreOperationTarget(
  tx: DbTransaction,
  target: Readonly<ExactRestoreOperationTarget>,
): Promise<AgentBackupRestoreOperation> {
  const [operation] = await tx
    .select()
    .from(agentBackupRestoreOperations)
    .where(
      and(
        eq(agentBackupRestoreOperations.organization_id, target.organizationId),
        eq(agentBackupRestoreOperations.restore_attempt_id, target.restoreAttemptId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !operation ||
    target.targetActivationGeneration !== target.restoreAttemptId ||
    operation.agent_id !== target.agentId ||
    operation.backup_id !== target.backupId ||
    operation.expected_operation_id !== target.expectedOperationId ||
    operation.expected_manifest_sha256 !== target.expectedManifestSha256 ||
    operation.expected_activation_generation !== target.expectedSourceActivationGeneration ||
    operation.expected_lifecycle_revision !== target.expectedSourceLifecycleRevision ||
    operation.expected_node_record_id !== target.expectedNodeRecordId ||
    operation.expected_node_incarnation !== target.expectedNodeIncarnation ||
    operation.expected_node_history_id !== target.expectedNodeHistoryId
  ) {
    conflict("Restore writer differs from its durable operation target");
  }
  return operation;
}

function operationMatchesRuntimeTarget(
  operation: Readonly<AgentBackupRestoreOperation>,
  containerId: string,
  imageDigest: string,
): boolean {
  return (
    operation.expected_container_id === containerId &&
    operation.expected_image_digest === imageDigest
  );
}

/**
 * Prove that an already row-locked mutable node still names one exact,
 * append-only occurrence authority for that record and boot.
 *
 * The history reads deliberately stay MVCC reads. The caller owns the node's
 * `FOR UPDATE` lock, so no concurrent attestation can change that node while
 * this proof runs; locking append-only history rows would only add an
 * unnecessary lock class. The trigger-owned pointer is the causal ordinal:
 * A1 -> B -> A2 has two different history ids even though the Linux boot UUID
 * is A both times. No timestamp, transaction id, or scan of unrelated older
 * histories participates in the decision.
 */
export async function proveExactAgentNodeOccurrenceForLockedNode(
  tx: DbTransaction,
  node: Readonly<DockerNode>,
  expectedIncarnation: string,
  expectedNodeHistoryId: string,
): Promise<AgentNodeIncarnationHistory> {
  if (
    node.node_incarnation !== expectedIncarnation ||
    node.current_node_history_id !== expectedNodeHistoryId ||
    (node.fleet_kind !== "robot" && node.fleet_kind !== "cloud") ||
    node.infrastructure_provider !== "hetzner" ||
    !node.host_key_fingerprint
  ) {
    conflict("Restore target lacks exact current node-occurrence authority");
  }

  const [history] = await tx
    .select()
    .from(agentNodeIncarnationHistories)
    .where(
      and(
        eq(agentNodeIncarnationHistories.id, expectedNodeHistoryId),
        eq(agentNodeIncarnationHistories.docker_node_record_id, node.id),
        eq(agentNodeIncarnationHistories.node_incarnation, expectedIncarnation),
      ),
    )
    .limit(1);
  if (
    !history ||
    history.docker_node_record_id !== node.id ||
    history.node_incarnation !== expectedIncarnation ||
    history.node_id !== node.node_id ||
    history.fleet_kind !== node.fleet_kind ||
    history.infrastructure_provider !== node.infrastructure_provider ||
    history.provider_server_id !== node.provider_server_id ||
    history.host_key_fingerprint !== node.host_key_fingerprint
  ) {
    conflict("Restore target lacks exact current node-occurrence authority");
  }
  return history;
}

async function lockCurrentNodeHistory(
  tx: DbTransaction,
  input: {
    nodeRecordId: string;
    nodeId?: string;
    nodeIncarnation: string;
    nodeHistoryId: string;
  },
): Promise<AgentNodeIncarnationHistory> {
  const [node] = await tx
    .select()
    .from(dockerNodes)
    .where(
      and(
        eq(dockerNodes.id, input.nodeRecordId),
        input.nodeId ? eq(dockerNodes.node_id, input.nodeId) : undefined,
        eq(dockerNodes.node_incarnation, input.nodeIncarnation),
        eq(dockerNodes.current_node_history_id, input.nodeHistoryId),
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
    conflict("Restore target lacks exact current node-occurrence authority");
  }
  return proveExactAgentNodeOccurrenceForLockedNode(
    tx,
    node,
    input.nodeIncarnation,
    input.nodeHistoryId,
  );
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
  expectedNodeHistoryId: string;
  expectedTokenSha256: string;
}

function validatePublicationInput(input: RecordAgentActivationPublicationInput): void {
  requireUuid(input.publicationId, "publicationId");
  requireUuid(input.organizationId, "organizationId");
  requireUuid(input.agentId, "agentId");
  requireUuid(input.activationGeneration, "activationGeneration");
  requireUuid(input.expectedNodeRecordId, "expectedNodeRecordId");
  requireUuid(input.expectedNodeIncarnation, "expectedNodeIncarnation");
  requireUuid(input.expectedNodeHistoryId, "expectedNodeHistoryId");
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
    publication.node_history_id === input.expectedNodeHistoryId &&
    publication.token_sha256 === input.expectedTokenSha256
  );
}

async function recordRestoreActivationPublication(
  tx: DbTransaction,
  input: Readonly<RecordAgentActivationPublicationInput>,
  authority: Readonly<{ backupId: string; manifestSha256: string; imageDigest: string }>,
): Promise<{ publication: AgentActivationPublication; replayed: boolean }> {
  const [backup] = await tx
    .select()
    .from(agentSandboxBackups)
    .where(
      and(
        eq(agentSandboxBackups.id, authority.backupId),
        eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
        eq(agentSandboxBackups.catalog_agent_id, input.agentId),
        eq(agentSandboxBackups.manifest_digest, authority.manifestSha256),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !backup?.backup_operation_id ||
    !backup.lifecycle_generation ||
    backup.lifecycle_revision === null ||
    !backup.manifest_digest ||
    !["protected", "retained", "restore_verified"].includes(backup.catalog_state ?? "")
  ) {
    conflict("Restore publication source lacks exact restorable backup authority");
  }

  const operation = await lockExactRestoreOperationTarget(tx, {
    organizationId: input.organizationId,
    agentId: input.agentId,
    backupId: backup.id,
    restoreAttemptId: input.activationGeneration,
    targetActivationGeneration: input.activationGeneration,
    expectedOperationId: backup.backup_operation_id,
    expectedManifestSha256: backup.manifest_digest,
    expectedSourceActivationGeneration: backup.lifecycle_generation,
    expectedSourceLifecycleRevision: backup.lifecycle_revision,
    expectedNodeRecordId: input.expectedNodeRecordId,
    expectedNodeIncarnation: input.expectedNodeIncarnation,
    expectedNodeHistoryId: input.expectedNodeHistoryId,
  });
  if (!operationMatchesRuntimeTarget(operation, input.expectedContainerId, authority.imageDigest)) {
    conflict("Restore publication differs from its durable operation target");
  }

  const [lease] = await tx
    .select()
    .from(agentBackupRestoreLeases)
    .where(
      and(
        eq(agentBackupRestoreLeases.id, operation.lease_id),
        eq(agentBackupRestoreLeases.organization_id, operation.organization_id),
        eq(agentBackupRestoreLeases.agent_id, operation.agent_id),
        eq(agentBackupRestoreLeases.backup_id, operation.backup_id),
        eq(agentBackupRestoreLeases.restore_attempt_id, operation.restore_attempt_id),
        eq(agentBackupRestoreLeases.owner_id, operation.lease_owner_id),
        eq(agentBackupRestoreLeases.generation, operation.lease_generation),
        eq(agentBackupRestoreLeases.catalog_epoch, operation.catalog_epoch),
        eq(agentBackupRestoreLeases.copy_role, operation.copy_role),
        eq(agentBackupRestoreLeases.operation_id, operation.expected_operation_id),
        eq(
          agentBackupRestoreLeases.activation_generation,
          operation.expected_activation_generation,
        ),
        eq(agentBackupRestoreLeases.lifecycle_revision, operation.expected_lifecycle_revision),
        eq(agentBackupRestoreLeases.expected_manifest_sha256, operation.expected_manifest_sha256),
      ),
    )
    .for("update")
    .limit(1);
  if (!lease) conflict("Restore publication lost its exact lease authority");

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
  if (concurrentPublication && !publicationMatchesInput(concurrentPublication, input)) {
    conflict("Activation publication replay mismatch");
  }
  if (
    !sandbox?.activation_receipt ||
    !sandbox.activation_receipt_hash ||
    !sandbox.activation_container_id ||
    !sandbox.activation_node_id ||
    !sandbox.activation_boot_id ||
    !sandbox.activation_image_digest ||
    !sandbox.activation_token_hash ||
    sandbox.activation_funding_revision === null ||
    sandbox.activation_lifecycle_revision === null ||
    sandbox.activation_purpose !== "restore" ||
    sandbox.activation_backup_id !== backup.id ||
    sandbox.activation_backup_hash !== backup.manifest_digest ||
    sandbox.activation_receipt_hash !== input.expectedActivationReceiptSha256 ||
    sandbox.activation_container_id !== input.expectedContainerId ||
    sandbox.activation_boot_id !== input.expectedNodeIncarnation ||
    sandbox.activation_token_hash !== input.expectedTokenSha256 ||
    !operationMatchesRuntimeTarget(
      operation,
      sandbox.activation_container_id,
      sandbox.activation_image_digest,
    )
  ) {
    conflict("Restore publication differs from mutable or durable operation authority");
  }

  const history = await lockCurrentNodeHistory(tx, {
    nodeRecordId: input.expectedNodeRecordId,
    nodeId: sandbox.activation_node_id,
    nodeIncarnation: input.expectedNodeIncarnation,
    nodeHistoryId: input.expectedNodeHistoryId,
  });
  const catalogAuthority = await lockAgentBackupCatalogAuthority(
    tx,
    input.organizationId,
    input.agentId,
  );
  const databaseNow = await readPostLockDatabaseNow(tx);
  if (
    lease.released_at !== null ||
    lease.expires_at <= databaseNow ||
    lease.catalog_epoch !== catalogAuthority.catalog_revision
  ) {
    conflict("Restore publication lost its exact live restore lease");
  }
  if (concurrentPublication) {
    return { publication: concurrentPublication, replayed: true };
  }

  const [publication] = await tx
    .insert(agentActivationPublications)
    .values({
      id: input.publicationId,
      organization_id: input.organizationId,
      agent_id: input.agentId,
      activation_generation: input.activationGeneration,
      previous_activation_generation: sandbox.activation_previous_generation,
      lifecycle_revision: sandbox.activation_lifecycle_revision,
      purpose: "restore",
      backup_id: backup.id,
      backup_manifest_sha256: backup.manifest_digest,
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
    if (existing?.purpose === "restore") {
      if (
        !existing.backup_id ||
        !existing.backup_manifest_sha256 ||
        !publicationMatchesInput(existing, input)
      ) {
        conflict("Activation publication replay mismatch");
      }
      return recordRestoreActivationPublication(tx, input, {
        backupId: existing.backup_id,
        manifestSha256: existing.backup_manifest_sha256,
        imageDigest: existing.image_digest,
      });
    }
    if (existing) {
      if (!publicationMatchesInput(existing, input))
        conflict("Activation publication replay mismatch");
      await lockCurrentNodeHistory(tx, {
        nodeRecordId: existing.docker_node_record_id,
        nodeId: existing.node_id,
        nodeIncarnation: existing.node_incarnation,
        nodeHistoryId: existing.node_history_id,
      });
      return { publication: existing, replayed: true };
    }

    const [activationAuthority] = await tx
      .select({
        purpose: agentSandboxes.activation_purpose,
        backupId: agentSandboxes.activation_backup_id,
        manifestSha256: agentSandboxes.activation_backup_hash,
        imageDigest: agentSandboxes.activation_image_digest,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, input.agentId),
          eq(agentSandboxes.organization_id, input.organizationId),
          eq(agentSandboxes.activation_generation, input.activationGeneration),
        ),
      )
      .limit(1);
    if (activationAuthority?.purpose === "restore") {
      if (
        !activationAuthority.backupId ||
        !activationAuthority.manifestSha256 ||
        !activationAuthority.imageDigest
      ) {
        conflict("Restore activation lacks an exact backup authority");
      }
      return recordRestoreActivationPublication(tx, input, {
        backupId: activationAuthority.backupId,
        manifestSha256: activationAuthority.manifestSha256,
        imageDigest: activationAuthority.imageDigest,
      });
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
    if (sandbox?.activation_purpose === "restore") {
      conflict("Restore activation changed before durable operation authority was locked");
    }
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
      await lockCurrentNodeHistory(tx, {
        nodeRecordId: concurrentPublication.docker_node_record_id,
        nodeId: concurrentPublication.node_id,
        nodeIncarnation: concurrentPublication.node_incarnation,
        nodeHistoryId: concurrentPublication.node_history_id,
      });
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
    const history = await lockCurrentNodeHistory(tx, {
      nodeRecordId: input.expectedNodeRecordId,
      nodeId: sandbox.activation_node_id,
      nodeIncarnation: input.expectedNodeIncarnation,
      nodeHistoryId: input.expectedNodeHistoryId,
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
      nodeHistoryId: publication.node_history_id,
    });
    return publication;
  });
}

export interface RecordAgentVaultKeySeedReceiptInput {
  receiptId: string;
  /** Canonical V1 transport receipt digest recomputed from the exact staging volume. */
  receiptDigest: string;
  organizationId: string;
  agentId: string;
  backupId: string;
  restoreAttemptId: string;
  /** Canonical one-shot provider-attempt identity bound into the receipt digest. */
  replacementAttemptId: string;
  leaseId: string;
  leaseOwnerId: string;
  leaseFencingToken: string;
  restoreOperationId: string;
  restoreClaimGeneration: string;
  targetActivationGeneration: string;
  targetNodeRecordId: string;
  targetNodeIncarnation: string;
  targetNodeHistoryId: string;
  targetImageDigest: string;
  expectedActivationTokenSha256: string;
}

function validateSeedInput(input: RecordAgentVaultKeySeedReceiptInput): void {
  for (const [field, value] of [
    ["receiptId", input.receiptId],
    ["organizationId", input.organizationId],
    ["agentId", input.agentId],
    ["backupId", input.backupId],
    ["restoreAttemptId", input.restoreAttemptId],
    ["replacementAttemptId", input.replacementAttemptId],
    ["leaseId", input.leaseId],
    ["leaseFencingToken", input.leaseFencingToken],
    ["restoreOperationId", input.restoreOperationId],
    ["restoreClaimGeneration", input.restoreClaimGeneration],
    ["targetActivationGeneration", input.targetActivationGeneration],
    ["targetNodeRecordId", input.targetNodeRecordId],
    ["targetNodeIncarnation", input.targetNodeIncarnation],
    ["targetNodeHistoryId", input.targetNodeHistoryId],
  ] as const) {
    requireUuid(value, field);
  }
  requireSha256Hex(input.receiptDigest, "receiptDigest");
  requireSha256Hex(input.expectedActivationTokenSha256, "expectedActivationTokenSha256");
  if (!/^sha256:[0-9a-f]{64}$/.test(input.targetImageDigest)) {
    conflict("targetImageDigest must be a lowercase sha256 image digest");
  }
  requireBoundedIdentity(input.leaseOwnerId, "leaseOwnerId");
  if (Buffer.byteLength(input.leaseOwnerId, "utf8") > 255) {
    conflict("leaseOwnerId must contain at most 255 UTF-8 bytes");
  }
  if (input.targetActivationGeneration !== input.restoreAttemptId) {
    conflict("Vault seed target activation generation must equal the restore attempt");
  }
}

function exactRestoreContainerName(agentId: string, restoreAttemptId: string): string {
  return `agent-restore-${agentId}-${restoreAttemptId}`;
}

/**
 * Lock and prove the attempt-scoped, pre-provider restore intent retained by
 * the disabled-first create transaction. This lock follows the catalogue lock
 * in the shared restore order, so seed cannot race provider start or locator
 * enrichment.
 */
async function lockExactVaultSeedReplacementIntent(
  tx: DbTransaction,
  input: Readonly<RecordAgentVaultKeySeedReceiptInput>,
  operation: Readonly<AgentBackupRestoreOperation>,
  lease: Readonly<AgentBackupRestoreLease>,
  sandbox: Readonly<AgentSandbox>,
  node: Readonly<DockerNode>,
  mode: "strict_pre_provider" | "enriched_replay",
): Promise<AgentSandboxReplacementAttempt> {
  const [attempt] = await tx
    .select()
    .from(agentSandboxReplacementAttempts)
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, input.replacementAttemptId),
        eq(agentSandboxReplacementAttempts.organization_id, input.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, input.agentId),
      ),
    )
    .for("update")
    .limit(1);
  const containerName = exactRestoreContainerName(input.agentId, input.restoreAttemptId);
  if (
    !attempt ||
    attempt.operation_kind !== "provision" ||
    attempt.activation_generation !== input.restoreAttemptId ||
    attempt.restore_lease_id !== lease.id ||
    attempt.restore_backup_id !== input.backupId ||
    attempt.restore_attempt_id !== input.restoreAttemptId ||
    attempt.restore_lease_owner_id !== input.leaseOwnerId ||
    attempt.restore_lease_generation !== input.leaseFencingToken ||
    attempt.restore_catalog_epoch !== operation.catalog_epoch ||
    attempt.restore_copy_role !== operation.copy_role ||
    attempt.restore_operation_id !== operation.expected_operation_id ||
    attempt.restore_source_activation_generation !== operation.expected_activation_generation ||
    attempt.restore_source_lifecycle_revision !== operation.expected_lifecycle_revision ||
    attempt.restore_manifest_sha256 !== operation.expected_manifest_sha256 ||
    attempt.restore_lease_expires_at?.getTime() !== lease.expires_at.getTime() ||
    attempt.locator_sandbox_id !== containerName ||
    attempt.locator_container_name !== containerName ||
    attempt.locator_node_id !== node.node_id ||
    attempt.locator_node_record_id !== input.targetNodeRecordId ||
    attempt.locator_node_incarnation !== input.targetNodeIncarnation ||
    attempt.locator_node_history_id !== input.targetNodeHistoryId ||
    attempt.locator_node_hostname !== node.hostname ||
    attempt.locator_node_ssh_port !== node.ssh_port ||
    attempt.locator_node_ssh_user !== node.ssh_user ||
    attempt.locator_node_host_key_fingerprint !== node.host_key_fingerprint ||
    attempt.locator_secret_cleanup_version !== 1 ||
    attempt.locator_allocation_counted !== true ||
    attempt.locator_recorded_at === null ||
    attempt.locator_vpn_node_name !== null ||
    attempt.locator_vpn_registration_started_at !== null ||
    attempt.locator_previous_vpn_node_id !== null ||
    attempt.locator_vpn_node_id !== null ||
    attempt.locator_vpn_recorded_at !== null ||
    node.allocated_count < 1
  ) {
    conflict("Vault seed replacement attempt differs from its exact pre-provider intent");
  }
  if (
    mode === "strict_pre_provider" &&
    (attempt.lifecycle_revision !== BigInt(sandbox.lifecycle_revision) ||
      attempt.lifecycle_job_id !== sandbox.lifecycle_job_id ||
      attempt.lifecycle_execution_generation !== sandbox.lifecycle_execution_generation ||
      attempt.state !== "in_flight_unresolved" ||
      attempt.provider_started_at !== null ||
      attempt.provider_succeeded_at !== null ||
      attempt.provider_receipt_digest !== null ||
      attempt.lifecycle_committed_at !== null ||
      attempt.lifecycle_receipt_digest !== null ||
      attempt.cleanup_proven_at !== null ||
      attempt.cleanup_receipt_digest !== null ||
      attempt.locator_container_id !== null ||
      attempt.locator_container_recorded_at !== null)
  ) {
    conflict("Vault seed replacement attempt differs from its exact pre-provider intent");
  }
  if (
    mode === "enriched_replay" &&
    (operation.expected_container_id === null ||
      attempt.provider_started_at === null ||
      attempt.locator_container_id !== operation.expected_container_id ||
      attempt.locator_container_recorded_at === null ||
      attempt.state === "cleanup_proven")
  ) {
    conflict("Vault-seed receipt replay lost its phase-compatible replacement attempt");
  }
  return attempt;
}

function hasCommonAgentBackupRestoreQuarantineAuthority(params: {
  sandbox: Readonly<AgentSandbox>;
  restoreAttemptId: string;
  backupId: string;
  manifestSha256: string;
  expectedActivationTokenSha256: string;
}): boolean {
  const { sandbox } = params;
  return (
    sandbox.deleted_at === null &&
    sandbox.activation_generation === params.restoreAttemptId &&
    sandbox.activation_lifecycle_revision !== null &&
    sandbox.activation_lifecycle_revision === BigInt(sandbox.lifecycle_revision) &&
    sandbox.activation_purpose === "restore" &&
    sandbox.activation_backup_id === params.backupId &&
    sandbox.activation_backup_hash === params.manifestSha256 &&
    sandbox.activation_token_hash === params.expectedActivationTokenSha256 &&
    typeof sandbox.activation_token_ciphertext === "string" &&
    Buffer.byteLength(sandbox.activation_token_ciphertext, "utf8") >= 1 &&
    Buffer.byteLength(sandbox.activation_token_ciphertext, "utf8") <=
      MAX_ACTIVATION_TOKEN_CIPHERTEXT_BYTES &&
    !sandbox.activation_token_ciphertext.includes("\0") &&
    sandbox.activation_consent_lifecycle_revision === null &&
    sandbox.activation_consent_head_backup_id === null &&
    sandbox.activation_consent_head_backup_hash === null
  );
}

/** Exact mutable quarantine required before restore vault material leaves KMS authority. */
export function hasExactAgentBackupRestorePrecreateQuarantine(params: {
  sandbox: Readonly<AgentSandbox>;
  restoreAttemptId: string;
  backupId: string;
  manifestSha256: string;
  expectedActivationTokenSha256: string;
}): boolean {
  const { sandbox } = params;
  return (
    hasCommonAgentBackupRestoreQuarantineAuthority(params) &&
    sandbox.activation_phase === "container_pending" &&
    sandbox.activation_receipt === null &&
    sandbox.activation_receipt_hash === null &&
    sandbox.activation_container_id === null &&
    sandbox.activation_node_id === null &&
    sandbox.activation_image_digest === null &&
    sandbox.activation_boot_id === null &&
    sandbox.activation_authority_published_at === null &&
    sandbox.activation_funding_revision === null &&
    sandbox.activation_dispatched_at === null &&
    sandbox.activation_completed_at === null
  );
}

function hasCompatibleAgentBackupRestoreSeedReplay(params: {
  sandbox: Readonly<AgentSandbox>;
  operation: Readonly<AgentBackupRestoreOperation>;
  nodeId: string;
  expectedActivationTokenSha256: string;
}): boolean {
  const { sandbox, operation } = params;
  const common = {
    sandbox,
    restoreAttemptId: operation.restore_attempt_id,
    backupId: operation.backup_id,
    manifestSha256: operation.expected_manifest_sha256,
    expectedActivationTokenSha256: params.expectedActivationTokenSha256,
  } as const;
  const effectivePhase =
    operation.phase === "failed_retryable" ? operation.resume_phase : operation.phase;
  if (effectivePhase === "vault_seeded") {
    return (
      operation.expected_container_id === null &&
      hasExactAgentBackupRestorePrecreateQuarantine(common)
    );
  }
  if (
    !effectivePhase ||
    ![
      "container_created",
      "restoring",
      "committed",
      "restart_attested",
      "probed",
      "published",
      "finalized",
    ].includes(effectivePhase)
  ) {
    return false;
  }
  return (
    hasCommonAgentBackupRestoreQuarantineAuthority(common) &&
    sandbox.activation_phase !== "container_pending" &&
    sandbox.activation_phase !== "blocked" &&
    operation.expected_container_id !== null &&
    typeof sandbox.activation_container_id === "string" &&
    /^[0-9a-f]{64}$/.test(sandbox.activation_container_id) &&
    sandbox.activation_container_id === operation.expected_container_id &&
    sandbox.activation_node_id === params.nodeId &&
    sandbox.activation_image_digest === operation.expected_image_digest &&
    sandbox.activation_boot_id === operation.expected_node_incarnation
  );
}

function seedMatchesInput(
  receipt: AgentVaultKeySeedReceipt,
  input: RecordAgentVaultKeySeedReceiptInput,
): boolean {
  return (
    receipt.receipt_digest === input.receiptDigest &&
    receipt.organization_id === input.organizationId &&
    receipt.agent_id === input.agentId &&
    receipt.backup_id === input.backupId &&
    receipt.restore_attempt_id === input.restoreAttemptId &&
    receipt.replacement_attempt_id === input.replacementAttemptId &&
    receipt.lease_id === input.leaseId &&
    receipt.lease_owner_id === input.leaseOwnerId &&
    receipt.lease_fencing_token === input.leaseFencingToken &&
    receipt.target_activation_generation === input.targetActivationGeneration &&
    receipt.docker_node_record_id === input.targetNodeRecordId &&
    receipt.node_incarnation === input.targetNodeIncarnation &&
    receipt.node_history_id === input.targetNodeHistoryId
  );
}

async function hasPriorCleanedVaultSeedReplacement(
  tx: DbTransaction,
  input: Readonly<RecordAgentVaultKeySeedReceiptInput>,
  operation: Readonly<AgentBackupRestoreOperation>,
): Promise<boolean> {
  const [prior] = await tx
    .select({ id: agentVaultKeySeedReceipts.id })
    .from(agentVaultKeySeedReceipts)
    .innerJoin(
      agentSandboxReplacementAttempts,
      and(
        eq(agentSandboxReplacementAttempts.id, agentVaultKeySeedReceipts.replacement_attempt_id),
        eq(
          agentSandboxReplacementAttempts.organization_id,
          agentVaultKeySeedReceipts.organization_id,
        ),
        eq(agentSandboxReplacementAttempts.agent_id, agentVaultKeySeedReceipts.agent_id),
        eq(
          agentSandboxReplacementAttempts.restore_attempt_id,
          agentVaultKeySeedReceipts.restore_attempt_id,
        ),
      ),
    )
    .where(
      and(
        eq(agentVaultKeySeedReceipts.organization_id, input.organizationId),
        eq(agentVaultKeySeedReceipts.agent_id, input.agentId),
        eq(agentVaultKeySeedReceipts.backup_id, input.backupId),
        eq(agentVaultKeySeedReceipts.restore_attempt_id, input.restoreAttemptId),
        ne(agentVaultKeySeedReceipts.replacement_attempt_id, input.replacementAttemptId),
        eq(agentVaultKeySeedReceipts.lease_id, input.leaseId),
        eq(agentVaultKeySeedReceipts.lease_owner_id, input.leaseOwnerId),
        eq(agentVaultKeySeedReceipts.lease_fencing_token, input.leaseFencingToken),
        eq(
          agentVaultKeySeedReceipts.target_activation_generation,
          input.targetActivationGeneration,
        ),
        eq(agentVaultKeySeedReceipts.docker_node_record_id, input.targetNodeRecordId),
        eq(agentVaultKeySeedReceipts.node_incarnation, input.targetNodeIncarnation),
        eq(agentVaultKeySeedReceipts.node_history_id, input.targetNodeHistoryId),
        eq(agentSandboxReplacementAttempts.state, "cleanup_proven"),
        eq(agentSandboxReplacementAttempts.restore_lease_id, input.leaseId),
        eq(agentSandboxReplacementAttempts.restore_backup_id, input.backupId),
        eq(agentSandboxReplacementAttempts.restore_lease_owner_id, input.leaseOwnerId),
        eq(agentSandboxReplacementAttempts.restore_lease_generation, input.leaseFencingToken),
        eq(agentSandboxReplacementAttempts.restore_catalog_epoch, operation.catalog_epoch),
        eq(agentSandboxReplacementAttempts.restore_copy_role, operation.copy_role),
        eq(agentSandboxReplacementAttempts.restore_operation_id, operation.expected_operation_id),
        eq(
          agentSandboxReplacementAttempts.restore_source_activation_generation,
          operation.expected_activation_generation,
        ),
        eq(
          agentSandboxReplacementAttempts.restore_source_lifecycle_revision,
          operation.expected_lifecycle_revision,
        ),
        eq(
          agentSandboxReplacementAttempts.restore_manifest_sha256,
          operation.expected_manifest_sha256,
        ),
        eq(agentSandboxReplacementAttempts.locator_node_record_id, input.targetNodeRecordId),
        eq(agentSandboxReplacementAttempts.locator_node_incarnation, input.targetNodeIncarnation),
        eq(agentSandboxReplacementAttempts.locator_node_history_id, input.targetNodeHistoryId),
        eq(agentSandboxReplacementAttempts.locator_allocation_counted, true),
      ),
    )
    .limit(1);
  return prior !== undefined;
}

/**
 * Append the exact post-seed receipt and atomically consume the pre-create
 * claim. This is the only database writer allowed to advance
 * `reserved -> vault_seeded`; it never performs the remote seed itself.
 */
export async function recordAgentVaultKeySeedReceipt(
  input: Readonly<RecordAgentVaultKeySeedReceiptInput>,
): Promise<{
  receipt: AgentVaultKeySeedReceipt;
  operation: Readonly<AgentBackupRestoreOperation>;
  replayed: boolean;
}> {
  validateSeedInput(input);
  const expectedReceipt = buildRestoreVolumeVaultSeedReceiptV1({
    agentId: input.agentId,
    restoreAttemptId: input.restoreAttemptId,
    replacementAttemptId: input.replacementAttemptId,
    passphraseByteLength: AGENT_BACKUP_RESTORE_VAULT_PASSPHRASE_BYTES,
  });
  if (input.receiptDigest !== expectedReceipt.receiptDigest) {
    conflict("Vault-seed receipt digest differs from the canonical V1 transport receipt");
  }
  return dbWrite.transaction(async (tx) => {
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
    if (
      !backup?.backup_operation_id ||
      !backup.lifecycle_generation ||
      backup.lifecycle_revision === null ||
      !backup.manifest_digest ||
      backup.manifest_version !== 3 ||
      !backup.manifest_canonical_draft ||
      backup.image_digest !== input.targetImageDigest ||
      !backup.vault_key_generation_id ||
      !backup.vault_key_authority_receipt_digest ||
      !hasAgentBackupRestoreAuthority(backup.catalog_state)
    ) {
      conflict("Vault seed source is absent or lacks restorable manifest-v3 authority");
    }
    const parsedManifest = await parseAgentBackupManifestV3Authority({
      canonicalManifestDraft: backup.manifest_canonical_draft,
      expectedManifestSha256: backup.manifest_digest,
    });
    if (
      parsedManifest.manifest.operationId !== backup.backup_operation_id ||
      parsedManifest.manifest.identity.organizationId !== input.organizationId ||
      parsedManifest.manifest.identity.agentId !== input.agentId ||
      parsedManifest.manifest.identity.activationGeneration !== backup.lifecycle_generation ||
      parsedManifest.manifest.identity.lifecycleRevision !== backup.lifecycle_revision.toString() ||
      parsedManifest.manifest.runtime.imageDigest !== input.targetImageDigest ||
      parsedManifest.manifest.vaultKeyAuthority.generationId !== backup.vault_key_generation_id ||
      parsedManifest.manifest.vaultKeyAuthority.receiptDigest !==
        backup.vault_key_authority_receipt_digest
    ) {
      conflict("Vault seed source differs from its exact manifest-v3 authority");
    }

    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, input.restoreOperationId))
      .for("update")
      .limit(1);
    if (
      !operation ||
      operation.organization_id !== input.organizationId ||
      operation.agent_id !== input.agentId ||
      operation.backup_id !== input.backupId ||
      operation.restore_attempt_id !== input.restoreAttemptId ||
      operation.lease_id !== input.leaseId ||
      operation.lease_owner_id !== input.leaseOwnerId ||
      operation.lease_generation !== input.leaseFencingToken ||
      operation.expected_operation_id !== backup.backup_operation_id ||
      operation.expected_activation_generation !== backup.lifecycle_generation ||
      operation.expected_lifecycle_revision !== backup.lifecycle_revision ||
      operation.expected_manifest_sha256 !== backup.manifest_digest ||
      operation.expected_node_record_id !== input.targetNodeRecordId ||
      operation.expected_node_incarnation !== input.targetNodeIncarnation ||
      operation.expected_node_history_id !== input.targetNodeHistoryId ||
      operation.expected_image_digest !== input.targetImageDigest
    ) {
      conflict("Vault seed operation differs from its exact source, lease, or target authority");
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
          eq(agentBackupRestoreLeases.operation_id, backup.backup_operation_id),
          eq(agentBackupRestoreLeases.activation_generation, backup.lifecycle_generation),
          eq(agentBackupRestoreLeases.lifecycle_revision, backup.lifecycle_revision),
          eq(agentBackupRestoreLeases.expected_manifest_sha256, backup.manifest_digest),
          eq(agentBackupRestoreLeases.copy_role, operation.copy_role),
          eq(agentBackupRestoreLeases.restore_attempt_id, input.restoreAttemptId),
          eq(agentBackupRestoreLeases.owner_id, input.leaseOwnerId),
          eq(agentBackupRestoreLeases.generation, input.leaseFencingToken),
          eq(agentBackupRestoreLeases.catalog_epoch, operation.catalog_epoch),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) conflict("Vault seed lost its exact restore lease fence");
    const [binding] = await tx
      .select()
      .from(agentVaultKeyBackupBindings)
      .where(
        and(
          eq(agentVaultKeyBackupBindings.organization_id, input.organizationId),
          eq(agentVaultKeyBackupBindings.agent_id, input.agentId),
          eq(agentVaultKeyBackupBindings.backup_id, input.backupId),
          eq(agentVaultKeyBackupBindings.operation_id, backup.backup_operation_id),
          eq(agentVaultKeyBackupBindings.source_activation_generation, backup.lifecycle_generation),
          eq(agentVaultKeyBackupBindings.source_lifecycle_revision, backup.lifecycle_revision),
          eq(agentVaultKeyBackupBindings.manifest_sha256, backup.manifest_digest),
          eq(agentVaultKeyBackupBindings.vault_key_generation_id, backup.vault_key_generation_id),
          eq(
            agentVaultKeyBackupBindings.vault_key_authority_receipt_digest,
            backup.vault_key_authority_receipt_digest,
          ),
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
          isNull(agentSandboxes.deleted_at),
        ),
      )
      .for("update")
      .limit(1);
    if (!sandbox) conflict("Vault seed restore quarantine is missing or deleted");

    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, input.targetNodeRecordId))
      .for("update")
      .limit(1);
    if (
      !node ||
      node.node_incarnation !== input.targetNodeIncarnation ||
      node.current_node_history_id !== input.targetNodeHistoryId ||
      !node.node_id
    ) {
      conflict("Vault seed target node occurrence was lost");
    }
    const history = await proveExactAgentNodeOccurrenceForLockedNode(
      tx,
      node,
      input.targetNodeIncarnation,
      input.targetNodeHistoryId,
    );

    const catalogAuthority = await lockAgentBackupCatalogAuthority(
      tx,
      input.organizationId,
      input.agentId,
    );
    if (
      catalogAuthority.catalog_revision !== operation.catalog_epoch ||
      lease.catalog_epoch !== operation.catalog_epoch
    ) {
      conflict("Vault seed was invalidated by a catalogue revision");
    }

    const [existing] = await tx
      .select()
      .from(agentVaultKeySeedReceipts)
      .where(
        and(
          eq(agentVaultKeySeedReceipts.organization_id, input.organizationId),
          eq(agentVaultKeySeedReceipts.restore_attempt_id, input.restoreAttemptId),
          eq(agentVaultKeySeedReceipts.replacement_attempt_id, input.replacementAttemptId),
        ),
      )
      .limit(1);
    if (existing && !seedMatchesInput(existing, input)) {
      conflict("Vault-seed receipt replay mismatch");
    }
    const effectivePhase =
      operation.phase === "failed_retryable" ? operation.resume_phase : operation.phase;
    const enrichedReplay =
      existing !== undefined &&
      effectivePhase !== null &&
      [
        "container_created",
        "restoring",
        "committed",
        "restart_attested",
        "probed",
        "published",
        "finalized",
      ].includes(effectivePhase);
    await lockExactVaultSeedReplacementIntent(
      tx,
      input,
      operation,
      lease,
      sandbox,
      node,
      enrichedReplay ? "enriched_replay" : "strict_pre_provider",
    );
    const reseedingAfterCleanup =
      existing === undefined &&
      operation.phase === "vault_seeded" &&
      (await hasPriorCleanedVaultSeedReplacement(tx, input, operation));

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      conflict("Vault seed restore lease is expired or released");
    }

    if (existing) {
      const compatibleReplay = hasCompatibleAgentBackupRestoreSeedReplay({
        sandbox,
        operation,
        nodeId: node.node_id,
        expectedActivationTokenSha256: input.expectedActivationTokenSha256,
      });
      if (operation.phase === "reserved" || !compatibleReplay) {
        conflict("Vault-seed receipt replay lost compatible operation or quarantine authority");
      }
      if (operation.phase === "failed_retryable") {
        if (
          operation.resume_phase !== "vault_seeded" ||
          operation.claim_owner !== input.leaseOwnerId ||
          operation.claim_generation !== input.restoreClaimGeneration ||
          operation.claim_expires_at === null ||
          operation.claim_expires_at <= databaseNow
        ) {
          conflict("Vault-seed receipt resume claim is not live or exact");
        }
        const [resumedOperation] = await tx
          .update(agentBackupRestoreOperations)
          .set({
            phase: "vault_seeded",
            resume_phase: null,
            claim_owner: null,
            claim_generation: null,
            claim_expires_at: null,
            updated_at: databaseNow,
          })
          .where(
            and(
              eq(agentBackupRestoreOperations.id, operation.id),
              eq(agentBackupRestoreOperations.phase, "failed_retryable"),
              eq(agentBackupRestoreOperations.resume_phase, "vault_seeded"),
              eq(agentBackupRestoreOperations.claim_owner, input.leaseOwnerId),
              eq(agentBackupRestoreOperations.claim_generation, input.restoreClaimGeneration),
              eq(agentBackupRestoreOperations.expected_node_record_id, input.targetNodeRecordId),
              eq(
                agentBackupRestoreOperations.expected_node_incarnation,
                input.targetNodeIncarnation,
              ),
              eq(agentBackupRestoreOperations.expected_node_history_id, input.targetNodeHistoryId),
              eq(agentBackupRestoreOperations.expected_image_digest, input.targetImageDigest),
              isNull(agentBackupRestoreOperations.expected_container_id),
            ),
          )
          .returning();
        if (!resumedOperation) conflict("Vault-seed receipt resume lost its exact CAS");
        return {
          receipt: existing,
          operation: Object.freeze(resumedOperation),
          replayed: true,
        };
      }
      return { receipt: existing, operation: Object.freeze(operation), replayed: true };
    }

    if (operation.phase !== "reserved" && !reseedingAfterCleanup) {
      conflict("Vault seed operation advanced without its immutable receipt");
    }
    if (operation.expected_container_id !== null) {
      conflict("Vault seed cannot authorize a pre-existing restore container");
    }
    if (
      operation.claim_owner !== input.leaseOwnerId ||
      operation.claim_generation !== input.restoreClaimGeneration ||
      operation.claim_expires_at === null ||
      operation.claim_expires_at <= databaseNow
    ) {
      conflict("Vault seed restore operation claim is not live");
    }
    if (
      !hasExactAgentBackupRestorePrecreateQuarantine({
        sandbox,
        restoreAttemptId: input.restoreAttemptId,
        backupId: input.backupId,
        manifestSha256: backup.manifest_digest,
        expectedActivationTokenSha256: input.expectedActivationTokenSha256,
      })
    ) {
      conflict("Vault seed lacks exact container-pending restore quarantine authority");
    }
    const [receipt] = await tx
      .insert(agentVaultKeySeedReceipts)
      .values({
        id: input.receiptId,
        organization_id: input.organizationId,
        agent_id: input.agentId,
        restore_attempt_id: input.restoreAttemptId,
        replacement_attempt_id: input.replacementAttemptId,
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

    const [advancedOperation] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        phase: "vault_seeded",
        resume_phase: null,
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operation.id),
          eq(agentBackupRestoreOperations.phase, operation.phase),
          eq(agentBackupRestoreOperations.claim_owner, input.leaseOwnerId),
          eq(agentBackupRestoreOperations.claim_generation, input.restoreClaimGeneration),
          eq(agentBackupRestoreOperations.expected_node_record_id, input.targetNodeRecordId),
          eq(agentBackupRestoreOperations.expected_node_incarnation, input.targetNodeIncarnation),
          eq(agentBackupRestoreOperations.expected_node_history_id, input.targetNodeHistoryId),
          eq(agentBackupRestoreOperations.expected_image_digest, input.targetImageDigest),
          isNull(agentBackupRestoreOperations.expected_container_id),
        ),
      )
      .returning();
    if (!advancedOperation) conflict("Vault seed operation transition lost its exact CAS");
    return {
      receipt,
      operation: Object.freeze(advancedOperation),
      replayed: false,
    };
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
  replacementAttemptId: string;
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
    receipt.replacement_attempt_id === input.replacementAttemptId &&
    receipt.seed_receipt_id === input.seedReceiptId &&
    receipt.seed_receipt_digest === input.seedReceiptDigest &&
    receipt.activation_publication_id === input.activationPublicationId &&
    receipt.target_activation_generation === input.targetActivationGeneration &&
    receipt.activation_receipt_sha256 === input.expectedActivationReceiptSha256
  );
}

/**
 * Lock the replacement ledger last in the shared restore authority order and
 * prove that the final publication consumed the same replacement as its seed.
 * `lifecycle_committed` is immutable, so the proof remains durable after this
 * transaction releases its row lock.
 */
async function lockExactAdoptedRestoreReplacement(
  tx: DbTransaction,
  input: Readonly<CommitAgentBackupRestoreInput>,
  operation: Readonly<AgentBackupRestoreOperation>,
  seed: Readonly<AgentVaultKeySeedReceipt>,
  publication: Readonly<AgentActivationPublication>,
): Promise<AgentSandboxReplacementAttempt> {
  const [replacement] = await tx
    .select()
    .from(agentSandboxReplacementAttempts)
    .where(
      and(
        eq(agentSandboxReplacementAttempts.id, input.replacementAttemptId),
        eq(agentSandboxReplacementAttempts.organization_id, input.organizationId),
        eq(agentSandboxReplacementAttempts.agent_id, input.agentId),
      ),
    )
    .for("update")
    .limit(1);
  const containerName = exactRestoreContainerName(input.agentId, input.restoreAttemptId);
  if (
    !replacement ||
    seed.replacement_attempt_id !== input.replacementAttemptId ||
    replacement.operation_kind !== "provision" ||
    replacement.activation_generation !== input.targetActivationGeneration ||
    replacement.restore_lease_id !== operation.lease_id ||
    replacement.restore_backup_id !== input.backupId ||
    replacement.restore_attempt_id !== input.restoreAttemptId ||
    replacement.restore_lease_owner_id !== operation.lease_owner_id ||
    replacement.restore_lease_generation !== operation.lease_generation ||
    replacement.restore_catalog_epoch !== operation.catalog_epoch ||
    replacement.restore_copy_role !== operation.copy_role ||
    replacement.restore_operation_id !== operation.expected_operation_id ||
    replacement.restore_source_activation_generation !== operation.expected_activation_generation ||
    replacement.restore_source_lifecycle_revision !== operation.expected_lifecycle_revision ||
    replacement.restore_manifest_sha256 !== operation.expected_manifest_sha256 ||
    replacement.state !== "lifecycle_committed" ||
    replacement.locator_sandbox_id !== containerName ||
    replacement.locator_container_name !== containerName ||
    replacement.locator_container_id !== publication.container_id ||
    replacement.locator_node_id !== publication.node_id ||
    replacement.locator_node_record_id !== publication.docker_node_record_id ||
    replacement.locator_node_incarnation !== publication.node_incarnation ||
    replacement.locator_node_history_id !== publication.node_history_id ||
    replacement.locator_secret_cleanup_version !== 1 ||
    replacement.locator_allocation_counted !== true
  ) {
    conflict("Final restore chain lacks its exact adopted replacement authority");
  }
  return replacement;
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
          eq(agentVaultKeySeedReceipts.replacement_attempt_id, input.replacementAttemptId),
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
      seed.node_history_id !== publication.node_history_id ||
      seed.docker_node_record_id !== publication.docker_node_record_id ||
      seed.node_incarnation !== publication.node_incarnation ||
      publication.backup_id !== backup.id ||
      publication.backup_manifest_sha256 !== backup.manifest_digest
    ) {
      conflict("Final restore chain differs from source, seed, or activation publication");
    }
    const operation = await lockExactRestoreOperationTarget(tx, {
      organizationId: input.organizationId,
      agentId: input.agentId,
      backupId: input.backupId,
      restoreAttemptId: input.restoreAttemptId,
      targetActivationGeneration: input.targetActivationGeneration,
      expectedOperationId: backup.backup_operation_id,
      expectedManifestSha256: backup.manifest_digest,
      expectedSourceActivationGeneration: backup.lifecycle_generation,
      expectedSourceLifecycleRevision: backup.lifecycle_revision,
      expectedNodeRecordId: publication.docker_node_record_id,
      expectedNodeIncarnation: publication.node_incarnation,
      expectedNodeHistoryId: publication.node_history_id,
    });
    if (
      !operationMatchesRuntimeTarget(operation, publication.container_id, publication.image_digest)
    ) {
      conflict("Final restore chain differs from its durable operation target");
    }
    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, operation.lease_id),
          eq(agentBackupRestoreLeases.organization_id, seed.organization_id),
          eq(agentBackupRestoreLeases.agent_id, seed.agent_id),
          eq(agentBackupRestoreLeases.backup_id, seed.backup_id),
          eq(agentBackupRestoreLeases.restore_attempt_id, seed.restore_attempt_id),
          eq(agentBackupRestoreLeases.owner_id, seed.lease_owner_id),
          eq(agentBackupRestoreLeases.generation, seed.lease_fencing_token),
          eq(agentBackupRestoreLeases.catalog_epoch, operation.catalog_epoch),
          eq(agentBackupRestoreLeases.copy_role, operation.copy_role),
          eq(agentBackupRestoreLeases.operation_id, operation.expected_operation_id),
          eq(
            agentBackupRestoreLeases.activation_generation,
            operation.expected_activation_generation,
          ),
          eq(agentBackupRestoreLeases.lifecycle_revision, operation.expected_lifecycle_revision),
          eq(agentBackupRestoreLeases.expected_manifest_sha256, operation.expected_manifest_sha256),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !lease ||
      lease.released_at !== null ||
      seed.lease_id !== operation.lease_id ||
      seed.lease_owner_id !== operation.lease_owner_id ||
      seed.lease_fencing_token !== operation.lease_generation ||
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
      nodeHistoryId: publication.node_history_id,
    });
    // Match every sandbox-bearing backup writer: sandbox and node authority
    // precede catalogue authority. Writers without a sandbox still serialize
    // on the already-locked backup row before reaching this authority.
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      input.organizationId,
      input.agentId,
    );
    if (
      authority.restore_generation >= MAX_SIGNED_BIGINT ||
      lease.catalog_epoch !== authority.catalog_revision
    ) {
      conflict("Restore generation authority is absent, stale, or exhausted");
    }
    await lockExactAdoptedRestoreReplacement(tx, input, operation, seed, publication);
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
        replacement_attempt_id: input.replacementAttemptId,
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
