/**
 * Database-only authority for a restore container that is not yet routable.
 *
 * These writers deliberately stop before Docker, SSH, registry, Redis, or
 * route publication.  The restore attempt id is the target activation
 * generation; callers cannot substitute the source generation or mint a
 * second identity for the same attempt.
 */

import { Buffer } from "node:buffer";
import { and, eq, isNull, sql } from "drizzle-orm";
import { requireBoundedIdentity } from "../../lib/services/agent-backup-catalog-state";
import { isValidUUID } from "../../lib/utils/validation";
import { dbWrite } from "../helpers";
import {
  type AgentBackupRestoreOperation,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "../schemas/agent-backup-catalog";
import { type AgentSandbox, agentSandboxBackups, agentSandboxes } from "../schemas/agent-sandboxes";
import { dockerNodes, PLACEABLE_NODE_STATE } from "../schemas/docker-nodes";
import {
  AgentBackupCatalogConflictError,
  lockAgentBackupCatalogAuthority,
} from "./agent-backup-catalog";
import { hasAgentBackupRestoreAuthority } from "./agent-backup-restore-authority";
import { proveExactAgentNodeOccurrenceForLockedNode } from "./agent-backup-restore-history";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const MAX_TOKEN_CIPHERTEXT_BYTES = 16_384;

export interface OpenAgentBackupRestoreQuarantineInput {
  operationId: string;
  ownerId: string;
  claimGeneration: string;
  activationTokenSha256: string;
  activationTokenCiphertext: string;
}

export interface RecordAgentBackupRestoreQuarantinedContainerInput {
  operationId: string;
  ownerId: string;
  claimGeneration: string;
  containerId: string;
  expectedActivationTokenSha256: string;
}

export interface AgentBackupRestoreQuarantineResult {
  operation: Readonly<AgentBackupRestoreOperation>;
  sandbox: Readonly<AgentSandbox>;
  replayed: boolean;
}

function conflict(message: string): never {
  throw new AgentBackupCatalogConflictError(message);
}

function requireUuid(value: string, field: string): string {
  if (!isValidUUID(value) || value !== value.toLowerCase()) {
    throw new AgentBackupCatalogConflictError(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function requireSha256(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new AgentBackupCatalogConflictError(`${field} must be a lowercase sha256 digest`);
  }
  return value;
}

function requireContainerId(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new AgentBackupCatalogConflictError(
      "containerId must be a lowercase 64-character Docker ID",
    );
  }
  return value;
}

function requireTokenCiphertext(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > MAX_TOKEN_CIPHERTEXT_BYTES || value.includes("\0")) {
    throw new AgentBackupCatalogConflictError(
      `activationTokenCiphertext must contain between 1 and ${MAX_TOKEN_CIPHERTEXT_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

function immutableOperationAuthorityMatches(
  operation: AgentBackupRestoreOperation,
  authority: AgentBackupRestoreOperation,
): boolean {
  return (
    operation.organization_id === authority.organization_id &&
    operation.agent_id === authority.agent_id &&
    operation.backup_id === authority.backup_id &&
    operation.restore_attempt_id === authority.restore_attempt_id &&
    operation.lease_id === authority.lease_id &&
    operation.lease_generation === authority.lease_generation &&
    operation.lease_owner_id === authority.lease_owner_id &&
    operation.catalog_epoch === authority.catalog_epoch &&
    operation.copy_role === authority.copy_role &&
    operation.expected_operation_id === authority.expected_operation_id &&
    operation.expected_manifest_sha256 === authority.expected_manifest_sha256 &&
    operation.expected_activation_generation === authority.expected_activation_generation &&
    operation.expected_lifecycle_revision === authority.expected_lifecycle_revision &&
    operation.expected_node_history_id === authority.expected_node_history_id &&
    operation.expected_node_record_id === authority.expected_node_record_id &&
    operation.expected_node_incarnation === authority.expected_node_incarnation &&
    operation.expected_image_digest === authority.expected_image_digest
  );
}

function hasCompleteTargetAuthority(
  operation: AgentBackupRestoreOperation,
): operation is AgentBackupRestoreOperation & {
  expected_node_history_id: string;
  expected_node_record_id: string;
  expected_node_incarnation: string;
  expected_image_digest: string;
} {
  return (
    operation.expected_node_history_id !== null &&
    operation.expected_node_record_id !== null &&
    operation.expected_node_incarnation !== null &&
    operation.expected_image_digest !== null
  );
}

function isEligibleForFirstRestorePlacement(node: typeof dockerNodes.$inferSelect): boolean {
  return (
    node.enabled &&
    node.status === "healthy" &&
    node.placement_state === PLACEABLE_NODE_STATE &&
    node.metadata.capacityProvisional !== true
  );
}

function hasCurrentActivationLifecycle(sandbox: AgentSandbox): boolean {
  return (
    sandbox.activation_lifecycle_revision !== null &&
    sandbox.activation_lifecycle_revision === BigInt(sandbox.lifecycle_revision)
  );
}

function hasCommonRestoreQuarantineAuthority(params: {
  sandbox: AgentSandbox;
  operation: AgentBackupRestoreOperation;
  tokenSha256: string;
}): boolean {
  const { sandbox, operation } = params;
  return (
    sandbox.activation_generation === operation.restore_attempt_id &&
    hasCurrentActivationLifecycle(sandbox) &&
    sandbox.activation_purpose === "restore" &&
    sandbox.activation_backup_id === operation.backup_id &&
    sandbox.activation_backup_hash === operation.expected_manifest_sha256 &&
    sandbox.activation_token_hash === params.tokenSha256 &&
    typeof sandbox.activation_token_ciphertext === "string" &&
    Buffer.byteLength(sandbox.activation_token_ciphertext, "utf8") >= 1 &&
    Buffer.byteLength(sandbox.activation_token_ciphertext, "utf8") <= MAX_TOKEN_CIPHERTEXT_BYTES &&
    sandbox.activation_receipt === null &&
    sandbox.activation_receipt_hash === null &&
    sandbox.activation_authority_published_at === null &&
    sandbox.activation_funding_revision === null &&
    sandbox.activation_dispatched_at === null &&
    sandbox.activation_completed_at === null &&
    sandbox.activation_consent_lifecycle_revision === null &&
    sandbox.activation_consent_head_backup_id === null &&
    sandbox.activation_consent_head_backup_hash === null
  );
}

function isExactOpenReplay(params: {
  sandbox: AgentSandbox;
  operation: AgentBackupRestoreOperation;
  tokenSha256: string;
  tokenCiphertext: string;
}): boolean {
  return (
    hasCommonRestoreQuarantineAuthority(params) &&
    params.sandbox.activation_phase === "container_pending" &&
    params.sandbox.activation_token_ciphertext === params.tokenCiphertext &&
    params.sandbox.activation_container_id === null &&
    params.sandbox.activation_node_id === null &&
    params.sandbox.activation_image_digest === null &&
    params.sandbox.activation_boot_id === null
  );
}

function isExactContainerReplay(params: {
  sandbox: AgentSandbox;
  operation: AgentBackupRestoreOperation;
  tokenSha256: string;
  containerId: string;
  nodeId: string;
}): boolean {
  const { sandbox, operation } = params;
  return (
    hasCompleteTargetAuthority(operation) &&
    hasCommonRestoreQuarantineAuthority(params) &&
    sandbox.activation_phase === "restore_pending" &&
    sandbox.activation_container_id === params.containerId &&
    sandbox.activation_node_id === params.nodeId &&
    sandbox.activation_image_digest === operation.expected_image_digest &&
    sandbox.activation_boot_id === operation.expected_node_incarnation
  );
}

/**
 * Open the mutable activation quarantine for a reserved restore target.
 *
 * The canonical route (`sandbox_id`, `node_id`, `image_digest`, and `status`)
 * is intentionally untouched. Definition-only: no production caller may use
 * this until restore allocation ownership has a durable settlement path.
 */
export async function openAgentBackupRestoreQuarantine(
  input: Readonly<OpenAgentBackupRestoreQuarantineInput>,
): Promise<AgentBackupRestoreQuarantineResult> {
  const operationId = requireUuid(input.operationId, "operationId");
  const claimGeneration = requireUuid(input.claimGeneration, "claimGeneration");
  requireBoundedIdentity(input.ownerId, "ownerId");
  const tokenSha256 = requireSha256(input.activationTokenSha256, "activationTokenSha256");
  const tokenCiphertext = requireTokenCiphertext(input.activationTokenCiphertext);

  // Immutable pre-read supplies keys for the global backup -> operation ->
  // lease -> sandbox -> node -> catalogue lock order. It is compared again
  // after locking and never authorizes a write by itself.
  const [operationAuthority] = await dbWrite
    .select()
    .from(agentBackupRestoreOperations)
    .where(eq(agentBackupRestoreOperations.id, operationId))
    .limit(1);
  if (!operationAuthority) conflict("Restore operation is missing");
  if (!hasCompleteTargetAuthority(operationAuthority)) {
    conflict("Restore quarantine requires complete reserved target authority");
  }

  return dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, operationAuthority.backup_id),
          eq(agentSandboxBackups.catalog_organization_id, operationAuthority.organization_id),
          eq(agentSandboxBackups.catalog_agent_id, operationAuthority.agent_id),
          eq(agentSandboxBackups.backup_operation_id, operationAuthority.expected_operation_id),
          eq(
            agentSandboxBackups.lifecycle_generation,
            operationAuthority.expected_activation_generation,
          ),
          eq(
            agentSandboxBackups.lifecycle_revision,
            operationAuthority.expected_lifecycle_revision,
          ),
          eq(agentSandboxBackups.manifest_digest, operationAuthority.expected_manifest_sha256),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !backup ||
      !hasAgentBackupRestoreAuthority(backup.catalog_state) ||
      backup.manifest_version !== 3 ||
      !backup.manifest_canonical_draft ||
      backup.image_digest !== operationAuthority.expected_image_digest
    ) {
      conflict("Restore quarantine source lost exact manifest-v3 authority");
    }

    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (!operation || !immutableOperationAuthorityMatches(operation, operationAuthority)) {
      conflict("Restore operation authority changed before quarantine lock");
    }
    if (!hasCompleteTargetAuthority(operation)) {
      conflict("Restore quarantine requires complete reserved target authority");
    }
    if (operation.phase !== "reserved") {
      conflict(`Restore quarantine cannot open while operation is in ${operation.phase}`);
    }
    if (operation.expected_container_id !== null) {
      conflict("Restore quarantine cannot open with pre-existing container authority");
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
          eq(agentBackupRestoreLeases.operation_id, operation.expected_operation_id),
          eq(
            agentBackupRestoreLeases.activation_generation,
            operation.expected_activation_generation,
          ),
          eq(agentBackupRestoreLeases.lifecycle_revision, operation.expected_lifecycle_revision),
          eq(agentBackupRestoreLeases.expected_manifest_sha256, operation.expected_manifest_sha256),
          eq(agentBackupRestoreLeases.copy_role, operation.copy_role),
          eq(agentBackupRestoreLeases.restore_attempt_id, operation.restore_attempt_id),
          eq(agentBackupRestoreLeases.owner_id, operation.lease_owner_id),
          eq(agentBackupRestoreLeases.generation, operation.lease_generation),
          eq(agentBackupRestoreLeases.catalog_epoch, operation.catalog_epoch),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) conflict("Restore quarantine lease fence was lost");

    const [sandbox] = await tx
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, operation.agent_id),
          eq(agentSandboxes.organization_id, operation.organization_id),
          isNull(agentSandboxes.deleted_at),
        ),
      )
      .for("update")
      .limit(1);
    if (!sandbox) conflict("Restore quarantine sandbox is missing or deleted");

    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, operation.expected_node_record_id))
      .for("update")
      .limit(1);
    if (
      !node ||
      node.node_incarnation !== operation.expected_node_incarnation ||
      node.current_node_history_id !== operation.expected_node_history_id ||
      !node.node_id
    ) {
      conflict("Restore quarantine target node occurrence changed");
    }
    await proveExactAgentNodeOccurrenceForLockedNode(
      tx,
      node,
      operation.expected_node_incarnation,
      operation.expected_node_history_id,
    );

    // Every sandbox-bearing backup writer takes the mutable sandbox and node
    // before the per-agent catalogue authority. Reversing this pair deadlocks
    // against capture, vault seeding, or restore finalization on another
    // backup in the same agent catalogue.
    const catalogAuthority = await lockAgentBackupCatalogAuthority(
      tx,
      operation.organization_id,
      operation.agent_id,
    );
    if (catalogAuthority.catalog_revision !== operation.catalog_epoch) {
      conflict("Restore quarantine authority was invalidated by a catalogue revision");
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      conflict("Restore quarantine lease is expired or released");
    }
    if (
      operation.lease_owner_id !== input.ownerId ||
      operation.claim_owner !== input.ownerId ||
      operation.claim_generation !== claimGeneration ||
      operation.claim_expires_at === null ||
      operation.claim_expires_at <= databaseNow
    ) {
      conflict("Restore quarantine operation claim is not live");
    }

    if (sandbox.activation_generation === operation.restore_attempt_id) {
      if (
        !isExactOpenReplay({
          sandbox,
          operation,
          tokenSha256,
          tokenCiphertext,
        })
      ) {
        conflict("Restore quarantine replay authority mismatch");
      }
      return {
        operation: Object.freeze(operation),
        sandbox: Object.freeze(sandbox),
        replayed: true,
      };
    }
    if (!isEligibleForFirstRestorePlacement(node)) {
      conflict("Restore quarantine target is no longer eligible for first placement");
    }
    if (
      sandbox.activation_generation !== null &&
      (sandbox.activation_phase !== "active" ||
        sandbox.activation_purpose === null ||
        !hasCurrentActivationLifecycle(sandbox))
    ) {
      conflict("Restore quarantine cannot replace a non-current activation authority");
    }

    const previousGeneration = sandbox.activation_generation;
    const [opened] = await tx
      .update(agentSandboxes)
      .set({
        activation_generation: operation.restore_attempt_id,
        activation_previous_generation: previousGeneration,
        // Activation fields participate in the lifecycle trigger. Stamp the
        // post-update generation, never the stale pre-update generation.
        activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
        activation_purpose: "restore",
        activation_phase: "container_pending",
        activation_backup_id: operation.backup_id,
        activation_backup_hash: operation.expected_manifest_sha256,
        activation_receipt: null,
        activation_receipt_hash: null,
        activation_container_id: null,
        activation_node_id: null,
        activation_image_digest: null,
        activation_token_hash: tokenSha256,
        activation_token_ciphertext: tokenCiphertext,
        activation_boot_id: null,
        activation_authority_published_at: null,
        activation_funding_revision: null,
        activation_dispatched_at: null,
        activation_completed_at: null,
        activation_consent_lifecycle_revision: null,
        activation_consent_head_backup_id: null,
        activation_consent_head_backup_hash: null,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentSandboxes.id, sandbox.id),
          eq(agentSandboxes.organization_id, operation.organization_id),
          eq(agentSandboxes.lifecycle_revision, sandbox.lifecycle_revision),
          previousGeneration === null
            ? isNull(agentSandboxes.activation_generation)
            : eq(agentSandboxes.activation_generation, previousGeneration),
          isNull(agentSandboxes.deleted_at),
          sql`${agentSandboxes.lifecycle_revision} < 9223372036854775807`,
        ),
      )
      .returning();
    if (
      !opened ||
      !isExactOpenReplay({
        sandbox: opened,
        operation,
        tokenSha256,
        tokenCiphertext,
      })
    ) {
      conflict("Restore quarantine open lost its lifecycle CAS");
    }
    return {
      operation: Object.freeze(operation),
      sandbox: Object.freeze(opened),
      replayed: false,
    };
  });
}

/**
 * Bind an already-created immutable Docker container to the quarantine and
 * atomically advance `vault_seeded -> container_created`.
 *
 * This function does not create, inspect, start, or publish the container.
 * It remains definition-only under the same allocation and node-occurrence
 * prerequisites as the quarantine opener.
 */
export async function recordAgentBackupRestoreQuarantinedContainer(
  input: Readonly<RecordAgentBackupRestoreQuarantinedContainerInput>,
): Promise<AgentBackupRestoreQuarantineResult> {
  const operationId = requireUuid(input.operationId, "operationId");
  const claimGeneration = requireUuid(input.claimGeneration, "claimGeneration");
  requireBoundedIdentity(input.ownerId, "ownerId");
  const containerId = requireContainerId(input.containerId);
  const tokenSha256 = requireSha256(
    input.expectedActivationTokenSha256,
    "expectedActivationTokenSha256",
  );

  const [operationAuthority] = await dbWrite
    .select()
    .from(agentBackupRestoreOperations)
    .where(eq(agentBackupRestoreOperations.id, operationId))
    .limit(1);
  if (!operationAuthority) conflict("Restore operation is missing");
  if (!hasCompleteTargetAuthority(operationAuthority)) {
    conflict("Quarantined container requires complete reserved target authority");
  }

  return dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, operationAuthority.backup_id),
          eq(agentSandboxBackups.catalog_organization_id, operationAuthority.organization_id),
          eq(agentSandboxBackups.catalog_agent_id, operationAuthority.agent_id),
          eq(agentSandboxBackups.backup_operation_id, operationAuthority.expected_operation_id),
          eq(
            agentSandboxBackups.lifecycle_generation,
            operationAuthority.expected_activation_generation,
          ),
          eq(
            agentSandboxBackups.lifecycle_revision,
            operationAuthority.expected_lifecycle_revision,
          ),
          eq(agentSandboxBackups.manifest_digest, operationAuthority.expected_manifest_sha256),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !backup ||
      !hasAgentBackupRestoreAuthority(backup.catalog_state) ||
      backup.manifest_version !== 3 ||
      !backup.manifest_canonical_draft ||
      backup.image_digest !== operationAuthority.expected_image_digest
    ) {
      conflict("Quarantined container source lost exact manifest-v3 authority");
    }

    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, operationId))
      .for("update")
      .limit(1);
    if (!operation || !immutableOperationAuthorityMatches(operation, operationAuthority)) {
      conflict("Restore operation authority changed before container lock");
    }
    if (!hasCompleteTargetAuthority(operation)) {
      conflict("Quarantined container requires complete reserved target authority");
    }
    if (operation.phase !== "vault_seeded" && operation.phase !== "container_created") {
      conflict(`Quarantined container cannot be recorded while operation is in ${operation.phase}`);
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
          eq(agentBackupRestoreLeases.operation_id, operation.expected_operation_id),
          eq(
            agentBackupRestoreLeases.activation_generation,
            operation.expected_activation_generation,
          ),
          eq(agentBackupRestoreLeases.lifecycle_revision, operation.expected_lifecycle_revision),
          eq(agentBackupRestoreLeases.expected_manifest_sha256, operation.expected_manifest_sha256),
          eq(agentBackupRestoreLeases.copy_role, operation.copy_role),
          eq(agentBackupRestoreLeases.restore_attempt_id, operation.restore_attempt_id),
          eq(agentBackupRestoreLeases.owner_id, operation.lease_owner_id),
          eq(agentBackupRestoreLeases.generation, operation.lease_generation),
          eq(agentBackupRestoreLeases.catalog_epoch, operation.catalog_epoch),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) conflict("Quarantined container lease fence was lost");

    const [sandbox] = await tx
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, operation.agent_id),
          eq(agentSandboxes.organization_id, operation.organization_id),
          isNull(agentSandboxes.deleted_at),
        ),
      )
      .for("update")
      .limit(1);
    if (!sandbox) conflict("Quarantined container sandbox is missing or deleted");

    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, operation.expected_node_record_id))
      .for("update")
      .limit(1);
    if (
      !node ||
      node.node_incarnation !== operation.expected_node_incarnation ||
      node.current_node_history_id !== operation.expected_node_history_id ||
      !node.node_id
    ) {
      conflict("Quarantined container target node occurrence changed");
    }
    await proveExactAgentNodeOccurrenceForLockedNode(
      tx,
      node,
      operation.expected_node_incarnation,
      operation.expected_node_history_id,
    );

    const catalogAuthority = await lockAgentBackupCatalogAuthority(
      tx,
      operation.organization_id,
      operation.agent_id,
    );
    if (catalogAuthority.catalog_revision !== operation.catalog_epoch) {
      conflict("Quarantined container authority was invalidated by a catalogue revision");
    }

    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      conflict("Quarantined container lease is expired or released");
    }
    if (operation.lease_owner_id !== input.ownerId) {
      conflict("Quarantined container owner differs from lease authority");
    }

    if (operation.phase === "container_created") {
      if (
        operation.expected_container_id !== containerId ||
        operation.claim_owner !== null ||
        operation.claim_generation !== null ||
        operation.claim_expires_at !== null ||
        !isExactContainerReplay({
          sandbox,
          operation,
          tokenSha256,
          containerId,
          nodeId: node.node_id,
        })
      ) {
        conflict("Quarantined container replay authority mismatch");
      }
      return {
        operation: Object.freeze(operation),
        sandbox: Object.freeze(sandbox),
        replayed: true,
      };
    }

    if (!isEligibleForFirstRestorePlacement(node)) {
      conflict("Quarantined container target is no longer eligible for first placement");
    }

    if (
      operation.expected_container_id !== null ||
      operation.claim_owner !== input.ownerId ||
      operation.claim_generation !== claimGeneration ||
      operation.claim_expires_at === null ||
      operation.claim_expires_at <= databaseNow
    ) {
      conflict("Quarantined container operation claim is not live");
    }
    if (
      !hasCommonRestoreQuarantineAuthority({ sandbox, operation, tokenSha256 }) ||
      sandbox.activation_phase !== "container_pending" ||
      sandbox.activation_container_id !== null ||
      sandbox.activation_node_id !== null ||
      sandbox.activation_image_digest !== null ||
      sandbox.activation_boot_id !== null
    ) {
      conflict("Quarantined container mutable activation authority diverged");
    }

    const [recordedSandbox] = await tx
      .update(agentSandboxes)
      .set({
        activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
        activation_phase: "restore_pending",
        activation_container_id: containerId,
        activation_node_id: node.node_id,
        activation_image_digest: operation.expected_image_digest,
        activation_boot_id: operation.expected_node_incarnation,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentSandboxes.id, sandbox.id),
          eq(agentSandboxes.organization_id, operation.organization_id),
          eq(agentSandboxes.lifecycle_revision, sandbox.lifecycle_revision),
          eq(agentSandboxes.activation_generation, operation.restore_attempt_id),
          eq(agentSandboxes.activation_phase, "container_pending"),
          eq(agentSandboxes.activation_backup_id, operation.backup_id),
          eq(agentSandboxes.activation_backup_hash, operation.expected_manifest_sha256),
          eq(agentSandboxes.activation_token_hash, tokenSha256),
          isNull(agentSandboxes.activation_container_id),
          isNull(agentSandboxes.activation_node_id),
          isNull(agentSandboxes.activation_image_digest),
          isNull(agentSandboxes.activation_boot_id),
          isNull(agentSandboxes.deleted_at),
          sql`${agentSandboxes.lifecycle_revision} < 9223372036854775807`,
        ),
      )
      .returning();
    if (!recordedSandbox) conflict("Quarantined container sandbox CAS was lost");

    const [advancedOperation] = await tx
      .update(agentBackupRestoreOperations)
      .set({
        phase: "container_created",
        resume_phase: null,
        expected_container_id: containerId,
        claim_owner: null,
        claim_generation: null,
        claim_expires_at: null,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(agentBackupRestoreOperations.id, operation.id),
          eq(agentBackupRestoreOperations.phase, "vault_seeded"),
          eq(agentBackupRestoreOperations.claim_owner, input.ownerId),
          eq(agentBackupRestoreOperations.claim_generation, claimGeneration),
          isNull(agentBackupRestoreOperations.expected_container_id),
          eq(
            agentBackupRestoreOperations.expected_node_history_id,
            operation.expected_node_history_id,
          ),
          eq(
            agentBackupRestoreOperations.expected_node_record_id,
            operation.expected_node_record_id,
          ),
          eq(
            agentBackupRestoreOperations.expected_node_incarnation,
            operation.expected_node_incarnation,
          ),
          eq(agentBackupRestoreOperations.expected_image_digest, operation.expected_image_digest),
        ),
      )
      .returning();
    if (
      !advancedOperation ||
      !isExactContainerReplay({
        sandbox: recordedSandbox,
        operation: advancedOperation,
        tokenSha256,
        containerId,
        nodeId: node.node_id,
      })
    ) {
      conflict("Quarantined container operation CAS was lost");
    }

    return {
      operation: Object.freeze(advancedOperation),
      sandbox: Object.freeze(recordedSandbox),
      replayed: false,
    };
  });
}
