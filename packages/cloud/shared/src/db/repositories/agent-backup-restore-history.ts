/** Appends and replays immutable restore authorities without wiring a production coordinator. */

import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import {
  agentActivationEndpointEnvelopesEqual,
  parseAgentActivationEndpointAuthority,
} from "../../lib/services/agent-activation-endpoint-authority";
import {
  assertAgentBackupCatalogTransition,
  requireBoundedIdentity,
  requireSha256Hex,
} from "../../lib/services/agent-backup-catalog-state";
import { isValidUUID } from "../../lib/utils/validation";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
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
  type AgentActivationEndpointEnvelopeV1,
  type AgentSandbox,
  agentSandboxBackups,
  agentSandboxes,
} from "../schemas/agent-sandboxes";
import { agentVaultKeyBackupBindings } from "../schemas/agent-vault-key-authority";
import { type DockerNode, dockerNodes } from "../schemas/docker-nodes";
import {
  AgentBackupCatalogConflictError,
  lockAgentBackupCatalogAuthority,
} from "./agent-backup-catalog";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

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

function operationMatchesPublicationEndpoint(
  operation: Readonly<AgentBackupRestoreOperation>,
  input: Readonly<RecordAgentActivationPublicationInput>,
): boolean {
  return requiredEndpointAuthoritiesMatch(
    operation.restore_attempt_id,
    operation.expected_endpoint_envelope,
    operation.expected_endpoint_sha256,
    input.expectedEndpointEnvelope,
    input.expectedEndpointSha256,
  );
}

const RESTORE_PUBLICATION_REPLAY_PHASES = new Set<AgentBackupRestoreOperation["phase"]>([
  "probed",
  "published",
  "finalized",
]);
const LIVE_RESTORE_PUBLICATION_BACKUP_STATES = new Set([
  "protected",
  "retained",
  "restore_verified",
]);

function requireRestorePublicationPhase(
  operation: Readonly<AgentBackupRestoreOperation>,
  replay: boolean,
): void {
  if (
    replay ? RESTORE_PUBLICATION_REPLAY_PHASES.has(operation.phase) : operation.phase === "probed"
  ) {
    return;
  }
  conflict(
    replay
      ? "Restore activation publication replay is not in a legitimate published phase"
      : "Restore activation publication requires a probed restore operation",
  );
}

interface ActivationPublicationChainRow {
  generation: string;
  previousGeneration: string | null;
  lifecycleRevision: bigint;
}

async function readActivationPublicationChain(
  tx: DbTransaction,
  input: Readonly<RecordAgentActivationPublicationInput>,
): Promise<ActivationPublicationChainRow[]> {
  return tx
    .select({
      generation: agentActivationPublications.activation_generation,
      previousGeneration: agentActivationPublications.previous_activation_generation,
      lifecycleRevision: agentActivationPublications.lifecycle_revision,
    })
    .from(agentActivationPublications)
    .where(
      and(
        eq(agentActivationPublications.organization_id, input.organizationId),
        eq(agentActivationPublications.agent_id, input.agentId),
      ),
    );
}

function proveLinearActivationPublicationHistory(
  history: readonly ActivationPublicationChainRow[],
  expectedHeadGeneration: string,
  expectedHeadLifecycleRevision: bigint,
): void {
  const byGeneration = new Map(history.map((publication) => [publication.generation, publication]));
  const expectedHead = byGeneration.get(expectedHeadGeneration);
  if (!expectedHead || expectedHead.lifecycleRevision !== expectedHeadLifecycleRevision) {
    conflict("Activation publication database head is missing or divergent");
  }

  let head = expectedHead;
  for (const publication of history) {
    if (publication.lifecycleRevision > head.lifecycleRevision) {
      head = publication;
    } else if (
      publication.lifecycleRevision === head.lifecycleRevision &&
      publication.generation !== head.generation
    ) {
      conflict("Activation publication database history has divergent lifecycle heads");
    }
  }
  if (head.generation !== expectedHeadGeneration) {
    conflict("Activation publication does not name the current database history head");
  }

  const seen = new Set<string>();
  let cursor: ActivationPublicationChainRow | undefined = head;
  let childRevision: bigint | null = null;
  while (cursor) {
    if (
      seen.has(cursor.generation) ||
      (childRevision !== null && cursor.lifecycleRevision >= childRevision)
    ) {
      conflict("Activation publication database history contains an ABA or revision cycle");
    }
    seen.add(cursor.generation);
    childRevision = cursor.lifecycleRevision;
    if (cursor.previousGeneration === null) {
      cursor = undefined;
      break;
    }
    cursor = byGeneration.get(cursor.previousGeneration);
    if (!cursor) {
      conflict("Activation publication ancestry is incomplete");
    }
  }
  if (seen.size !== history.length) {
    conflict("Activation publication database history is forked or disconnected");
  }
}

/** Prove that a new immutable publication extends the one unambiguous DB head. */
async function proveNewActivationPublicationChain(
  tx: DbTransaction,
  input: Readonly<RecordAgentActivationPublicationInput>,
  previousGeneration: string | null,
  lifecycleRevision: bigint,
): Promise<void> {
  const history = await readActivationPublicationChain(tx, input);

  if (previousGeneration === null) {
    if (history.length !== 0) {
      conflict("Activation publication cannot bootstrap over existing database history");
    }
    return;
  }
  if (previousGeneration === input.activationGeneration) {
    conflict("Activation publication cannot reuse its generation as its predecessor");
  }

  const byGeneration = new Map(history.map((publication) => [publication.generation, publication]));
  if (byGeneration.has(input.activationGeneration)) {
    conflict("Activation publication cannot reintroduce an ancestor generation");
  }
  const previous = byGeneration.get(previousGeneration);
  if (!previous) {
    conflict("Activation publication predecessor is missing from immutable database history");
  }
  proveLinearActivationPublicationHistory(history, previous.generation, previous.lifecycleRevision);
  if (lifecycleRevision <= previous.lifecycleRevision) {
    conflict("Activation publication must monotonically extend the exact database history head");
  }
}

async function proveActivationPublicationReplayIsCurrentHead(
  tx: DbTransaction,
  input: Readonly<RecordAgentActivationPublicationInput>,
  publication: Readonly<AgentActivationPublication>,
): Promise<void> {
  const history = await readActivationPublicationChain(tx, input);
  proveLinearActivationPublicationHistory(
    history,
    publication.activation_generation,
    publication.lifecycle_revision,
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
  expectedEndpointEnvelope?: Readonly<AgentActivationEndpointEnvelopeV1> | null;
  expectedEndpointSha256?: string | null;
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
  const hasEndpointEnvelope = input.expectedEndpointEnvelope != null;
  const hasEndpointSha256 = input.expectedEndpointSha256 != null;
  if (
    hasEndpointEnvelope !== hasEndpointSha256 ||
    (hasEndpointEnvelope &&
      !parseAgentActivationEndpointAuthority(
        input.expectedEndpointEnvelope,
        input.expectedEndpointSha256,
        input.activationGeneration,
      ))
  ) {
    conflict("Activation publication endpoint authority is incomplete or invalid");
  }
}

function inputEndpointAuthority(
  input: Readonly<RecordAgentActivationPublicationInput>,
): Readonly<AgentActivationEndpointEnvelopeV1> | null {
  return parseAgentActivationEndpointAuthority(
    input.expectedEndpointEnvelope,
    input.expectedEndpointSha256,
    input.activationGeneration,
  );
}

function requiredEndpointAuthoritiesMatch(
  generation: string,
  leftEnvelope: unknown,
  leftSha256: unknown,
  rightEnvelope: unknown,
  rightSha256: unknown,
): boolean {
  const left = parseAgentActivationEndpointAuthority(leftEnvelope, leftSha256, generation);
  const right = parseAgentActivationEndpointAuthority(rightEnvelope, rightSha256, generation);
  return (
    left !== null &&
    right !== null &&
    leftSha256 === rightSha256 &&
    agentActivationEndpointEnvelopesEqual(left, right)
  );
}

function publicationMatchesInput(
  publication: AgentActivationPublication,
  input: RecordAgentActivationPublicationInput,
): boolean {
  const endpointMatches =
    publication.purpose === "restore"
      ? requiredEndpointAuthoritiesMatch(
          publication.activation_generation,
          publication.endpoint_envelope,
          publication.endpoint_sha256,
          input.expectedEndpointEnvelope,
          input.expectedEndpointSha256,
        )
      : publication.endpoint_envelope === null &&
        publication.endpoint_sha256 === null &&
        input.expectedEndpointEnvelope == null &&
        input.expectedEndpointSha256 == null;
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
    publication.token_sha256 === input.expectedTokenSha256 &&
    endpointMatches
  );
}

function publicationMatchesMutableSandbox(
  publication: Readonly<AgentActivationPublication>,
  sandbox: Readonly<AgentSandbox>,
): boolean {
  const endpointMatches =
    publication.purpose === "restore"
      ? requiredEndpointAuthoritiesMatch(
          publication.activation_generation,
          publication.endpoint_envelope,
          publication.endpoint_sha256,
          sandbox.activation_endpoint_envelope,
          sandbox.activation_endpoint_sha256,
        )
      : publication.endpoint_envelope === null &&
        publication.endpoint_sha256 === null &&
        sandbox.activation_endpoint_envelope === null &&
        sandbox.activation_endpoint_sha256 === null;
  return (
    publication.previous_activation_generation === sandbox.activation_previous_generation &&
    publication.lifecycle_revision === sandbox.activation_lifecycle_revision &&
    publication.purpose === sandbox.activation_purpose &&
    publication.backup_id === sandbox.activation_backup_id &&
    publication.backup_manifest_sha256 === sandbox.activation_backup_hash &&
    isDeepStrictEqual(publication.activation_receipt, sandbox.activation_receipt) &&
    publication.activation_receipt_sha256 === sandbox.activation_receipt_hash &&
    publication.container_id === sandbox.activation_container_id &&
    publication.node_id === sandbox.activation_node_id &&
    publication.node_incarnation === sandbox.activation_boot_id &&
    publication.image_digest === sandbox.activation_image_digest &&
    publication.token_sha256 === sandbox.activation_token_hash &&
    publication.funding_revision === sandbox.activation_funding_revision &&
    endpointMatches
  );
}

/**
 * A finalized operation no longer needs a live lease to replay its already
 * published activation. Its immutable final receipt replaces lease/catalogue
 * liveness, but only when it closes the exact operation and publication chain.
 */
async function proveFinalizedRestorePublicationReceipt(
  tx: DbTransaction,
  operation: Readonly<AgentBackupRestoreOperation>,
  publication: Readonly<AgentActivationPublication>,
  backup: Readonly<{
    receiptDigest: string | null;
    restoreGeneration: bigint | null;
    verifiedAt: Date | null;
  }>,
): Promise<void> {
  const receiptDigest = operation.receipt_digest;
  if (
    !receiptDigest ||
    backup.receiptDigest !== receiptDigest ||
    backup.restoreGeneration === null ||
    backup.verifiedAt === null
  ) {
    conflict("Finalized restore publication replay lacks its operation receipt digest");
  }
  const [receipt] = await tx
    .select({ id: agentBackupRestoreReceipts.id })
    .from(agentBackupRestoreReceipts)
    .where(
      and(
        eq(agentBackupRestoreReceipts.organization_id, operation.organization_id),
        eq(agentBackupRestoreReceipts.agent_id, operation.agent_id),
        eq(agentBackupRestoreReceipts.restore_attempt_id, operation.restore_attempt_id),
        eq(agentBackupRestoreReceipts.backup_id, operation.backup_id),
        eq(agentBackupRestoreReceipts.operation_id, operation.expected_operation_id),
        eq(
          agentBackupRestoreReceipts.source_activation_generation,
          operation.expected_activation_generation,
        ),
        eq(
          agentBackupRestoreReceipts.source_lifecycle_revision,
          operation.expected_lifecycle_revision,
        ),
        eq(agentBackupRestoreReceipts.manifest_sha256, operation.expected_manifest_sha256),
        eq(
          agentBackupRestoreReceipts.target_activation_generation,
          publication.activation_generation,
        ),
        eq(agentBackupRestoreReceipts.activation_purpose, "restore"),
        eq(agentBackupRestoreReceipts.activation_publication_id, publication.id),
        eq(
          agentBackupRestoreReceipts.activation_receipt_sha256,
          publication.activation_receipt_sha256,
        ),
        eq(agentBackupRestoreReceipts.restore_generation, backup.restoreGeneration),
        eq(agentBackupRestoreReceipts.receipt_digest, receiptDigest),
        eq(agentBackupRestoreReceipts.verified_at, backup.verifiedAt),
      ),
    )
    .limit(1);
  if (!receipt) {
    conflict("Finalized restore publication replay lacks its exact immutable final receipt");
  }
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
    !backup.manifest_digest
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
  const endpointAuthority = inputEndpointAuthority(input);
  const endpointSha256 = input.expectedEndpointSha256;
  if (
    !endpointAuthority ||
    typeof endpointSha256 !== "string" ||
    !operationMatchesPublicationEndpoint(operation, input)
  ) {
    conflict("Restore publication differs from its durable endpoint authority");
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
  if (concurrentPublication && !publicationMatchesInput(concurrentPublication, input)) {
    conflict("Activation publication replay mismatch");
  }
  requireRestorePublicationPhase(operation, concurrentPublication !== undefined);
  const finalizedReplayPublication =
    operation.phase === "finalized" ? concurrentPublication : undefined;
  if (
    !finalizedReplayPublication &&
    !LIVE_RESTORE_PUBLICATION_BACKUP_STATES.has(backup.catalog_state ?? "")
  ) {
    conflict("Restore publication source lacks exact restorable backup authority");
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
    !requiredEndpointAuthoritiesMatch(
      operation.restore_attempt_id,
      operation.expected_endpoint_envelope,
      operation.expected_endpoint_sha256,
      sandbox.activation_endpoint_envelope,
      sandbox.activation_endpoint_sha256,
    ) ||
    !operationMatchesRuntimeTarget(
      operation,
      sandbox.activation_container_id,
      sandbox.activation_image_digest,
    )
  ) {
    conflict("Restore publication differs from mutable or durable operation authority");
  }
  if (concurrentPublication && !publicationMatchesMutableSandbox(concurrentPublication, sandbox)) {
    conflict("Activation publication replay lost exact current mutable authority");
  }
  if (!concurrentPublication) {
    await proveNewActivationPublicationChain(
      tx,
      input,
      sandbox.activation_previous_generation,
      sandbox.activation_lifecycle_revision,
    );
  } else {
    await proveActivationPublicationReplayIsCurrentHead(tx, input, concurrentPublication);
  }

  const history = await lockCurrentNodeHistory(tx, {
    nodeRecordId: input.expectedNodeRecordId,
    nodeId: sandbox.activation_node_id,
    nodeIncarnation: input.expectedNodeIncarnation,
    nodeHistoryId: input.expectedNodeHistoryId,
  });
  if (finalizedReplayPublication) {
    await proveFinalizedRestorePublicationReceipt(tx, operation, finalizedReplayPublication, {
      receiptDigest: backup.restore_receipt_digest,
      restoreGeneration: backup.restore_generation,
      verifiedAt: backup.restore_verified_at,
    });
  } else {
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
      endpoint_envelope: endpointAuthority,
      endpoint_sha256: endpointSha256,
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
      if (existing) {
        conflict("Activation generation changed purpose after immutable publication");
      }
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
    if (input.expectedEndpointEnvelope != null || input.expectedEndpointSha256 != null) {
      conflict("Non-restore activation publication cannot carry endpoint authority");
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
    if (concurrentPublication) {
      if (!publicationMatchesMutableSandbox(concurrentPublication, sandbox)) {
        conflict("Activation publication replay lost exact current mutable authority");
      }
      await proveActivationPublicationReplayIsCurrentHead(tx, input, concurrentPublication);
      await lockCurrentNodeHistory(tx, {
        nodeRecordId: concurrentPublication.docker_node_record_id,
        nodeId: concurrentPublication.node_id,
        nodeIncarnation: concurrentPublication.node_incarnation,
        nodeHistoryId: concurrentPublication.node_history_id,
      });
      return { publication: concurrentPublication, replayed: true };
    }
    await proveNewActivationPublicationChain(
      tx,
      input,
      sandbox.activation_previous_generation,
      sandbox.activation_lifecycle_revision,
    );
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
        endpoint_envelope: null,
        endpoint_sha256: null,
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
      .select()
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
      sandbox.activation_generation !== publication.activation_generation ||
      (sandbox.activation_phase !== "restart_attested" && sandbox.activation_phase !== "active") ||
      !publicationMatchesMutableSandbox(publication, sandbox)
    ) {
      conflict("Activation dispatch lost current mutable authority");
    }
    await proveActivationPublicationReplayIsCurrentHead(tx, input, publication);
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
  targetNodeHistoryId: string;
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
    receipt.node_incarnation === input.targetNodeIncarnation &&
    receipt.node_history_id === input.targetNodeHistoryId
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
      await lockCurrentNodeHistory(tx, {
        nodeRecordId: existing.docker_node_record_id,
        nodeIncarnation: existing.node_incarnation,
        nodeHistoryId: existing.node_history_id,
      });
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
      await lockCurrentNodeHistory(tx, {
        nodeRecordId: concurrentReceipt.docker_node_record_id,
        nodeIncarnation: concurrentReceipt.node_incarnation,
        nodeHistoryId: concurrentReceipt.node_history_id,
      });
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
      expectedNodeRecordId: input.targetNodeRecordId,
      expectedNodeIncarnation: input.targetNodeIncarnation,
      expectedNodeHistoryId: input.targetNodeHistoryId,
    });
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
      !sandbox.activation_container_id ||
      !sandbox.activation_image_digest ||
      sandbox.activation_boot_id !== input.targetNodeIncarnation ||
      !operationMatchesRuntimeTarget(
        operation,
        sandbox.activation_container_id,
        sandbox.activation_image_digest,
      )
    ) {
      conflict(
        "Vault seed target activation is absent, unattested, changed, or blocked by its durable operation target",
      );
    }
    const history = await lockCurrentNodeHistory(tx, {
      nodeRecordId: input.targetNodeRecordId,
      nodeId: sandbox.activation_node_id,
      nodeIncarnation: input.targetNodeIncarnation,
      nodeHistoryId: input.targetNodeHistoryId,
    });
    // Backup writers that also fence a live sandbox take sandbox and node
    // authority before the per-agent catalogue authority. Keeping this global
    // order aligned with reservation/capture and vault-key rotation prevents
    // sandbox <-> catalogue-authority AB-BA deadlocks.
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      input.organizationId,
      input.agentId,
    );
    if (lease.catalog_epoch !== authority.catalog_revision) {
      conflict("Vault seed lost its exact live restore lease");
    }
    const finalDatabaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at.getTime() <= finalDatabaseNow.getTime()) {
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
      !operationMatchesRuntimeTarget(
        operation,
        publication.container_id,
        publication.image_digest,
      ) ||
      !requiredEndpointAuthoritiesMatch(
        operation.restore_attempt_id,
        operation.expected_endpoint_envelope,
        operation.expected_endpoint_sha256,
        publication.endpoint_envelope,
        publication.endpoint_sha256,
      )
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
      sandbox.activation_lifecycle_revision !== publication.lifecycle_revision ||
      !requiredEndpointAuthoritiesMatch(
        publication.activation_generation,
        publication.endpoint_envelope,
        publication.endpoint_sha256,
        sandbox.activation_endpoint_envelope,
        sandbox.activation_endpoint_sha256,
      )
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
