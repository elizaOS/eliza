/** Durable begin/stage/finish/abort repository for one restore-v3 candidate. */

import { randomBytes, randomUUID } from "node:crypto";
import {
  AgentBackupRestoreV3ComponentReceiptSchema,
  type AgentBackupRestoreV3IsolatedCandidateStaging,
  type AgentBackupRestoreV3OperationControl,
  type AgentBackupRestoreV3SourceAuthority,
  type AgentBackupRestoreV3StagedRecord,
  AgentBackupRestoreV3StageRecordReceiptSchema,
  type AgentBackupRestoreV3StagingSession,
  canonicalizeAgentBackupRestoreV3SourceAuthority,
  parseAgentBackupManifestV3,
  parseAgentBackupRestoreV3AuthorityFence,
  parseAgentBackupRestoreV3SourceAuthority,
  parseAgentBackupRestoreV3StagingSession,
} from "@elizaos/shared";
import { and, eq } from "drizzle-orm";
import { dbWrite } from "../helpers";
import { agentBackupRestoreOperations } from "../schemas/agent-backup-catalog";
import {
  type AgentBackupRestoreV3Candidate,
  type AgentBackupRestoreV3CandidateStageEntry,
  agentBackupRestoreV3CandidateCleanupOutbox,
  agentBackupRestoreV3CandidateStageLedger,
  agentBackupRestoreV3Candidates,
  agentBackupRestoreV3CandidateTerminalCommands,
} from "../schemas/agent-backup-restore-v3-candidates";
import {
  canonicalAgentBackupRestoreV3ComponentReceipt,
  canonicalAgentBackupRestoreV3Descriptor,
  canonicalAgentBackupRestoreV3EntryMetadata,
  canonicalAgentBackupRestoreV3StageRecordReceipt,
  computeAgentBackupRestoreV3AbortCommandSha256,
  computeAgentBackupRestoreV3AbortReasonSha256,
  computeAgentBackupRestoreV3CleanupCommandSha256,
  computeAgentBackupRestoreV3FinishCommandSha256,
  computeAgentBackupRestoreV3RecordCommandSha256,
  exactDigestMatches,
  sha256Bytes,
  sha256Utf8,
} from "./agent-backup-restore-v3-candidate-codec";
import {
  applyAgentBackupRestoreV3TransactionDeadline,
  assertAgentBackupRestoreV3OperationControl,
  isAgentBackupRestoreV3AmbiguousCommitResponse,
  throwIfAgentBackupRestoreV3DatabaseDeadline,
} from "./agent-backup-restore-v3-candidate-database-control";

type CandidateBeginRequest = Parameters<AgentBackupRestoreV3IsolatedCandidateStaging["begin"]>[0];
type CandidateRecordReceipt = Awaited<
  ReturnType<AgentBackupRestoreV3IsolatedCandidateStaging["stageRecord"]>
>;
type CandidateComponentReceipt = Awaited<
  ReturnType<AgentBackupRestoreV3IsolatedCandidateStaging["finishComponent"]>
>;

export type AgentBackupRestoreV3CandidateExecution = Pick<
  AgentBackupRestoreV3IsolatedCandidateStaging,
  "begin" | "stageRecord" | "finishComponent" | "abort"
>;

export class AgentBackupRestoreV3CandidateExecutionConflictError extends Error {
  readonly code = "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CONFLICT";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentBackupRestoreV3CandidateExecutionConflictError";
  }
}

interface CandidateExecutionIdentity {
  readonly candidateId: string;
  readonly cleanupOutboxId: string;
  readonly organizationId: string;
  readonly agentId: string;
  readonly backupId: string;
  readonly restoreAttemptId: string;
  readonly operationId: string;
  readonly executionTokenSha256: string;
}

interface BoundCandidateExecution extends CandidateExecutionIdentity {
  readonly executionToken: string;
  readonly sourceAuthority: AgentBackupRestoreV3SourceAuthority;
  readonly sourceAuthorityCanonical: string;
  readonly sourceAuthoritySha256: string;
}

function conflict(
  message: string,
  cause?: unknown,
): AgentBackupRestoreV3CandidateExecutionConflictError {
  return new AgentBackupRestoreV3CandidateExecutionConflictError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw conflict("Database returned an invalid timestamp");
  return date;
}

function asSafeInteger(value: number | string | bigint, field: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw conflict(`Database returned an invalid ${field}`);
  }
  return number;
}

function freezeRecordReceipt(receipt: CandidateRecordReceipt): CandidateRecordReceipt {
  if (receipt.entry !== null) Object.freeze(receipt.entry);
  return Object.freeze(receipt);
}

function freezeComponentReceipt(receipt: CandidateComponentReceipt): CandidateComponentReceipt {
  Object.freeze(receipt.descriptor);
  return Object.freeze(receipt);
}

function exactCandidateMatches(
  row: AgentBackupRestoreV3Candidate,
  expected: BoundCandidateExecution,
  input: {
    readonly restoreOperationId: string;
    readonly leaseId: string;
    readonly leaseOwnerId: string;
    readonly leaseGeneration: string;
    readonly leaseExpiresAt: Date;
    readonly catalogEpoch: bigint;
    readonly sourceCopyRole: "primary" | "secondary";
    readonly sourceActivationGeneration: string;
    readonly sourceLifecycleRevision: bigint;
    readonly expectedManifestSha256: string;
    readonly keyBundleGenerationId: string;
  },
): boolean {
  return (
    row.id === expected.candidateId &&
    row.organization_id === expected.organizationId &&
    row.agent_id === expected.agentId &&
    row.backup_id === expected.backupId &&
    row.restore_attempt_id === expected.restoreAttemptId &&
    row.operation_id === expected.operationId &&
    row.restore_operation_id === input.restoreOperationId &&
    row.lease_id === input.leaseId &&
    row.lease_owner_id === input.leaseOwnerId &&
    row.lease_generation === input.leaseGeneration &&
    asDate(row.lease_expires_at).getTime() === input.leaseExpiresAt.getTime() &&
    BigInt(row.catalog_epoch) === input.catalogEpoch &&
    row.source_copy_role === input.sourceCopyRole &&
    row.source_activation_generation === input.sourceActivationGeneration &&
    BigInt(row.source_lifecycle_revision) === input.sourceLifecycleRevision &&
    row.expected_manifest_sha256 === input.expectedManifestSha256 &&
    row.key_bundle_generation_id === input.keyBundleGenerationId &&
    row.source_authority_canonical === expected.sourceAuthorityCanonical &&
    exactDigestMatches(row.source_authority_sha256, expected.sourceAuthoritySha256) &&
    row.object_count === expected.sourceAuthority.objects.length &&
    row.cleanup_outbox_id === expected.cleanupOutboxId &&
    exactDigestMatches(row.execution_token_sha256, expected.executionTokenSha256)
  );
}

function exactStageIdentityMatches(
  row: AgentBackupRestoreV3CandidateStageEntry,
  expected: CandidateExecutionIdentity,
): boolean {
  return (
    row.candidate_id === expected.candidateId &&
    row.organization_id === expected.organizationId &&
    row.agent_id === expected.agentId &&
    row.backup_id === expected.backupId &&
    row.restore_attempt_id === expected.restoreAttemptId &&
    row.operation_id === expected.operationId &&
    exactDigestMatches(row.execution_token_sha256, expected.executionTokenSha256)
  );
}

function exactRecordMatches(
  row: AgentBackupRestoreV3CandidateStageEntry,
  expected: CandidateExecutionIdentity,
  receipt: CandidateRecordReceipt,
  entryMetadataSha256: string,
  commandSha256: string,
  receiptSha256: string,
): boolean {
  const entry = receipt.entry;
  return (
    exactStageIdentityMatches(row, expected) &&
    row.command_kind === "record" &&
    row.component_index === receipt.componentIndex &&
    row.component_name === receipt.componentName &&
    row.data_index === receipt.dataIndex &&
    asSafeInteger(row.offset_bytes ?? -1, "record offset") === receipt.offsetBytes &&
    row.entry_path === (entry?.path ?? null) &&
    (entry === null ||
      (asSafeInteger(row.entry_file_offset_bytes ?? -1, "entry file offset") ===
        entry.fileOffsetBytes &&
        asSafeInteger(row.entry_file_size_bytes ?? -1, "entry file size") === entry.fileSizeBytes &&
        row.entry_mode === entry.mode &&
        asSafeInteger(row.entry_mtime_ms ?? -1, "entry mtime") === entry.mtimeMs)) &&
    exactDigestMatches(row.entry_metadata_sha256 ?? "", entryMetadataSha256) &&
    asSafeInteger(row.payload_bytes, "record payload bytes") === receipt.payloadBytes &&
    exactDigestMatches(row.payload_sha256, receipt.payloadSha256) &&
    row.data_frame_count === null &&
    row.descriptor_format === null &&
    row.descriptor_compression === null &&
    row.descriptor_content_kind === null &&
    row.descriptor_consistency === null &&
    row.descriptor_sha256 === null &&
    row.record_stream_content_hmac_sha256 === null &&
    exactDigestMatches(row.command_sha256, commandSha256) &&
    exactDigestMatches(row.receipt_sha256, receiptSha256)
  );
}

function exactFinishMatches(
  row: AgentBackupRestoreV3CandidateStageEntry,
  expected: CandidateExecutionIdentity,
  receipt: CandidateComponentReceipt,
  descriptorSha256: string,
  commandSha256: string,
  receiptSha256: string,
): boolean {
  return (
    exactStageIdentityMatches(row, expected) &&
    row.command_kind === "finish" &&
    row.component_index === receipt.componentIndex &&
    row.component_name === receipt.componentName &&
    row.data_index === null &&
    row.offset_bytes === null &&
    row.entry_path === null &&
    row.entry_file_offset_bytes === null &&
    row.entry_file_size_bytes === null &&
    row.entry_mode === null &&
    row.entry_mtime_ms === null &&
    row.entry_metadata_sha256 === null &&
    asSafeInteger(row.payload_bytes, "component payload bytes") === receipt.payloadBytes &&
    row.data_frame_count === receipt.dataFrameCount &&
    row.descriptor_format === receipt.descriptor.format &&
    row.descriptor_compression === receipt.descriptor.compression &&
    row.descriptor_content_kind === receipt.descriptor.contentKind &&
    row.descriptor_consistency === receipt.descriptor.consistency &&
    exactDigestMatches(row.descriptor_sha256 ?? "", descriptorSha256) &&
    exactDigestMatches(
      row.record_stream_content_hmac_sha256 ?? "",
      receipt.recordStreamContentHmacSha256,
    ) &&
    exactDigestMatches(row.payload_sha256, receipt.payloadSha256) &&
    exactDigestMatches(row.command_sha256, commandSha256) &&
    exactDigestMatches(row.receipt_sha256, receiptSha256)
  );
}

class CandidateExecutionRepository implements AgentBackupRestoreV3CandidateExecution {
  readonly #bound: BoundCandidateExecution;

  constructor(bound: BoundCandidateExecution) {
    this.#bound = bound;
  }

  async begin(
    request: CandidateBeginRequest,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<AgentBackupRestoreV3StagingSession> {
    assertAgentBackupRestoreV3OperationControl(control, "Restore-v3 candidate begin");
    const authority = parseAgentBackupRestoreV3AuthorityFence(request.authority);
    const manifest = await parseAgentBackupManifestV3(request.manifest);
    assertAgentBackupRestoreV3OperationControl(control, "Restore-v3 candidate begin");
    const source = this.#bound.sourceAuthority;
    if (
      authority.organizationId !== this.#bound.organizationId ||
      authority.agentId !== this.#bound.agentId ||
      authority.backupId !== this.#bound.backupId ||
      authority.restoreAttemptId !== this.#bound.restoreAttemptId ||
      authority.operationId !== this.#bound.operationId ||
      source.organizationId !== authority.organizationId ||
      source.agentId !== authority.agentId ||
      source.backupId !== authority.backupId ||
      source.operationId !== authority.operationId ||
      source.sourceActivationGeneration !== authority.sourceActivationGeneration ||
      source.sourceLifecycleRevision !== authority.sourceLifecycleRevision ||
      source.expectedManifestSha256 !== authority.expectedManifestSha256 ||
      source.copyRole !== authority.copyRole ||
      source.catalogEpoch !== authority.catalogEpoch ||
      manifest.identity.organizationId !== authority.organizationId ||
      manifest.identity.agentId !== authority.agentId ||
      manifest.identity.activationGeneration !== authority.sourceActivationGeneration ||
      manifest.identity.lifecycleRevision !== authority.sourceLifecycleRevision ||
      manifest.operationId !== authority.operationId ||
      manifest.integrity.manifestSha256 !== authority.expectedManifestSha256
    ) {
      throw conflict("Restore-v3 begin differs from its pre-bound source authority");
    }

    const leaseExpiresAt = new Date(authority.leaseExpiresAtEpochMs);
    const cleanupCommandSha256 = computeAgentBackupRestoreV3CleanupCommandSha256(this.#bound);
    const keyBundleGenerationId = manifest.encryption.operationKeyBundle.generationId;
    let restoreOperationId: string | undefined;
    try {
      const created = await dbWrite.transaction(async (tx) => {
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 candidate begin",
        );
        // This is deliberately the first durable write. No repository lock is
        // taken: the candidate INSERT trigger alone owns authority lock order.
        await tx.insert(agentBackupRestoreV3CandidateCleanupOutbox).values({
          id: this.#bound.cleanupOutboxId,
          organization_id: authority.organizationId,
          agent_id: authority.agentId,
          backup_id: authority.backupId,
          restore_attempt_id: authority.restoreAttemptId,
          operation_id: authority.operationId,
          cleanup_command_sha256: cleanupCommandSha256,
        });
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 candidate begin",
        );
        const [operation] = await tx
          .select({ id: agentBackupRestoreOperations.id })
          .from(agentBackupRestoreOperations)
          .where(
            and(
              eq(agentBackupRestoreOperations.organization_id, authority.organizationId),
              eq(agentBackupRestoreOperations.restore_attempt_id, authority.restoreAttemptId),
            ),
          )
          .limit(1);
        if (!operation) throw conflict("Restore-v3 operation authority is missing");
        restoreOperationId = operation.id;
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 candidate begin",
        );
        const [candidate] = await tx
          .insert(agentBackupRestoreV3Candidates)
          .values({
            id: this.#bound.candidateId,
            organization_id: authority.organizationId,
            agent_id: authority.agentId,
            backup_id: authority.backupId,
            restore_attempt_id: authority.restoreAttemptId,
            operation_id: authority.operationId,
            restore_operation_id: operation.id,
            lease_id: authority.leaseId,
            lease_owner_id: authority.ownerId,
            lease_generation: authority.fencingToken,
            lease_expires_at: leaseExpiresAt,
            catalog_epoch: BigInt(authority.catalogEpoch),
            source_copy_role: authority.copyRole,
            source_activation_generation: authority.sourceActivationGeneration,
            source_lifecycle_revision: BigInt(authority.sourceLifecycleRevision),
            expected_manifest_sha256: authority.expectedManifestSha256,
            key_bundle_generation_id: keyBundleGenerationId,
            source_authority_canonical: this.#bound.sourceAuthorityCanonical,
            source_authority_sha256: this.#bound.sourceAuthoritySha256,
            object_count: source.objects.length,
            cleanup_outbox_id: this.#bound.cleanupOutboxId,
            execution_token_sha256: this.#bound.executionTokenSha256,
          })
          .returning();
        if (!candidate) throw conflict("Restore-v3 candidate insert returned no authority");
        assertAgentBackupRestoreV3OperationControl(control, "Restore-v3 candidate begin");
        return candidate;
      });
      if (!restoreOperationId) throw conflict("Restore-v3 operation identity was not resolved");
      if (
        !exactCandidateMatches(created, this.#bound, {
          restoreOperationId,
          leaseId: authority.leaseId,
          leaseOwnerId: authority.ownerId,
          leaseGeneration: authority.fencingToken,
          leaseExpiresAt,
          catalogEpoch: BigInt(authority.catalogEpoch),
          sourceCopyRole: authority.copyRole,
          sourceActivationGeneration: authority.sourceActivationGeneration,
          sourceLifecycleRevision: BigInt(authority.sourceLifecycleRevision),
          expectedManifestSha256: authority.expectedManifestSha256,
          keyBundleGenerationId,
        })
      ) {
        throw conflict("Restore-v3 candidate insert returned divergent authority");
      }
    } catch (cause) {
      throwIfAgentBackupRestoreV3DatabaseDeadline(cause, "Restore-v3 candidate begin");
      // Primary-only post-error recovery covers uniqueness races and a commit
      // whose response was lost. It never repeats or relaxes trigger authority.
      await dbWrite.transaction(async (tx) => {
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 candidate begin recovery",
        );
        const [existing] = await tx
          .select()
          .from(agentBackupRestoreV3Candidates)
          .where(
            and(
              eq(agentBackupRestoreV3Candidates.organization_id, authority.organizationId),
              eq(agentBackupRestoreV3Candidates.restore_attempt_id, authority.restoreAttemptId),
            ),
          )
          .limit(1);
        if (!existing) throw cause;
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 candidate begin recovery",
        );
        const [currentOperation] = await tx
          .select({ id: agentBackupRestoreOperations.id })
          .from(agentBackupRestoreOperations)
          .where(
            and(
              eq(agentBackupRestoreOperations.organization_id, authority.organizationId),
              eq(agentBackupRestoreOperations.restore_attempt_id, authority.restoreAttemptId),
            ),
          )
          .limit(1);
        if (!currentOperation || currentOperation.id !== existing.restore_operation_id) {
          throw conflict("Restore-v3 begin replay lacks its exact operation authority", cause);
        }
        const resolvedOperationId = restoreOperationId ?? currentOperation.id;
        if (
          !exactCandidateMatches(existing, this.#bound, {
            restoreOperationId: resolvedOperationId,
            leaseId: authority.leaseId,
            leaseOwnerId: authority.ownerId,
            leaseGeneration: authority.fencingToken,
            leaseExpiresAt,
            catalogEpoch: BigInt(authority.catalogEpoch),
            sourceCopyRole: authority.copyRole,
            sourceActivationGeneration: authority.sourceActivationGeneration,
            sourceLifecycleRevision: BigInt(authority.sourceLifecycleRevision),
            expectedManifestSha256: authority.expectedManifestSha256,
            keyBundleGenerationId,
          })
        ) {
          throw conflict("Restore-v3 begin replay differs from durable candidate authority", cause);
        }
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 candidate begin recovery",
        );
        const [cleanup] = await tx
          .select()
          .from(agentBackupRestoreV3CandidateCleanupOutbox)
          .where(eq(agentBackupRestoreV3CandidateCleanupOutbox.id, this.#bound.cleanupOutboxId))
          .limit(1);
        if (
          !cleanup ||
          cleanup.organization_id !== this.#bound.organizationId ||
          cleanup.agent_id !== this.#bound.agentId ||
          cleanup.backup_id !== this.#bound.backupId ||
          cleanup.restore_attempt_id !== this.#bound.restoreAttemptId ||
          cleanup.operation_id !== this.#bound.operationId ||
          !exactDigestMatches(cleanup.cleanup_command_sha256, cleanupCommandSha256)
        ) {
          throw conflict("Restore-v3 begin replay lacks its exact cleanup authority", cause);
        }
        assertAgentBackupRestoreV3OperationControl(control, "Restore-v3 candidate begin recovery");
      });
    }

    return Object.freeze({
      restoreAttemptId: authority.restoreAttemptId,
      operationId: authority.operationId,
      expectedManifestSha256: authority.expectedManifestSha256,
      stagingHandle: this.#bound.candidateId,
      cleanupHandle: this.#bound.cleanupOutboxId,
      executionToken: this.#bound.executionToken,
      cleanupRegistered: true as const,
      isolatedCandidate: true as const,
    });
  }

  stageRecord(
    sessionInput: Readonly<AgentBackupRestoreV3StagingSession>,
    recordInput: Readonly<AgentBackupRestoreV3StagedRecord>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<CandidateRecordReceipt> {
    // Copy all caller-owned fields, especially payload bytes, before the first yield.
    const payload = Uint8Array.from(recordInput.payload);
    const entry =
      recordInput.entry === null
        ? null
        : {
            path: recordInput.entry.path,
            fileOffsetBytes: recordInput.entry.fileOffsetBytes,
            fileSizeBytes: recordInput.entry.fileSizeBytes,
            mode: recordInput.entry.mode,
            mtimeMs: recordInput.entry.mtimeMs,
          };
    const copied = {
      componentIndex: recordInput.componentIndex,
      componentName: recordInput.componentName,
      dataIndex: recordInput.dataIndex,
      offsetBytes: recordInput.offsetBytes,
      entry,
      payload,
    };
    return this.#stageRecord(sessionInput, copied, control).finally(() => {
      payload.fill(0);
    });
  }

  async #stageRecord(
    sessionInput: Readonly<AgentBackupRestoreV3StagingSession>,
    record: Readonly<AgentBackupRestoreV3StagedRecord>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<CandidateRecordReceipt> {
    assertAgentBackupRestoreV3OperationControl(control, "Restore-v3 record stage");
    this.#requireExactSession(sessionInput);
    const receipt = freezeRecordReceipt(
      AgentBackupRestoreV3StageRecordReceiptSchema.parse({
        componentIndex: record.componentIndex,
        componentName: record.componentName,
        dataIndex: record.dataIndex,
        offsetBytes: record.offsetBytes,
        entry: record.entry,
        payloadBytes: record.payload.byteLength,
        payloadSha256: sha256Bytes(record.payload),
      }),
    );
    const entryMetadataSha256 = sha256Utf8(
      canonicalAgentBackupRestoreV3EntryMetadata(receipt.entry),
    );
    const receiptSha256 = sha256Utf8(canonicalAgentBackupRestoreV3StageRecordReceipt(receipt));
    const commandSha256 = computeAgentBackupRestoreV3RecordCommandSha256(this.#bound, receipt);
    try {
      await dbWrite.transaction(async (tx) => {
        await applyAgentBackupRestoreV3TransactionDeadline(tx, control, "Restore-v3 record stage");
        await tx.insert(agentBackupRestoreV3CandidateStageLedger).values({
          candidate_id: this.#bound.candidateId,
          organization_id: this.#bound.organizationId,
          agent_id: this.#bound.agentId,
          backup_id: this.#bound.backupId,
          restore_attempt_id: this.#bound.restoreAttemptId,
          operation_id: this.#bound.operationId,
          execution_token_sha256: this.#bound.executionTokenSha256,
          command_kind: "record",
          component_index: receipt.componentIndex,
          component_name: receipt.componentName,
          data_index: receipt.dataIndex,
          offset_bytes: receipt.offsetBytes,
          entry_path: receipt.entry?.path ?? null,
          entry_file_offset_bytes: receipt.entry?.fileOffsetBytes ?? null,
          entry_file_size_bytes: receipt.entry?.fileSizeBytes ?? null,
          entry_mode: receipt.entry?.mode ?? null,
          entry_mtime_ms: receipt.entry?.mtimeMs ?? null,
          entry_metadata_sha256: entryMetadataSha256,
          payload_bytes: receipt.payloadBytes,
          payload_sha256: receipt.payloadSha256,
          command_sha256: commandSha256,
          receipt_sha256: receiptSha256,
        });
        assertAgentBackupRestoreV3OperationControl(control, "Restore-v3 record stage");
      });
      return receipt;
    } catch (cause) {
      throwIfAgentBackupRestoreV3DatabaseDeadline(cause, "Restore-v3 record stage");
      const recovered = await dbWrite.transaction(async (tx) => {
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 record stage recovery",
        );
        const [candidateState] = await tx
          .select({ state: agentBackupRestoreV3Candidates.state })
          .from(agentBackupRestoreV3Candidates)
          .where(eq(agentBackupRestoreV3Candidates.id, this.#bound.candidateId))
          .for("update")
          .limit(1);
        if (candidateState?.state !== "active") return false;
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 record stage recovery",
        );
        const [existing] = await tx
          .select()
          .from(agentBackupRestoreV3CandidateStageLedger)
          .where(
            and(
              eq(agentBackupRestoreV3CandidateStageLedger.candidate_id, this.#bound.candidateId),
              eq(agentBackupRestoreV3CandidateStageLedger.command_kind, "record"),
              eq(agentBackupRestoreV3CandidateStageLedger.component_index, receipt.componentIndex),
              eq(agentBackupRestoreV3CandidateStageLedger.data_index, receipt.dataIndex),
            ),
          )
          .limit(1);
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 record stage recovery",
        );
        const [finished] = await tx
          .select({ id: agentBackupRestoreV3CandidateStageLedger.id })
          .from(agentBackupRestoreV3CandidateStageLedger)
          .where(
            and(
              eq(agentBackupRestoreV3CandidateStageLedger.candidate_id, this.#bound.candidateId),
              eq(agentBackupRestoreV3CandidateStageLedger.command_kind, "finish"),
              eq(agentBackupRestoreV3CandidateStageLedger.component_index, receipt.componentIndex),
            ),
          )
          .limit(1);
        if (!existing || finished) return false;
        if (
          !exactRecordMatches(
            existing,
            this.#bound,
            receipt,
            entryMetadataSha256,
            commandSha256,
            receiptSha256,
          )
        ) {
          throw conflict("Restore-v3 stage-record replay differs from its durable slot", cause);
        }
        assertAgentBackupRestoreV3OperationControl(control, "Restore-v3 record stage recovery");
        return true;
      });
      if (!recovered) throw cause;
      return receipt;
    }
  }

  finishComponent(
    sessionInput: Readonly<AgentBackupRestoreV3StagingSession>,
    receiptInput: Readonly<CandidateComponentReceipt>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<CandidateComponentReceipt> {
    const copied = {
      componentIndex: receiptInput.componentIndex,
      componentName: receiptInput.componentName,
      descriptor: {
        name: receiptInput.descriptor.name,
        format: receiptInput.descriptor.format,
        compression: receiptInput.descriptor.compression,
        contentKind: receiptInput.descriptor.contentKind,
        consistency: receiptInput.descriptor.consistency,
      },
      dataFrameCount: receiptInput.dataFrameCount,
      payloadBytes: receiptInput.payloadBytes,
      payloadSha256: receiptInput.payloadSha256,
      recordStreamContentHmacSha256: receiptInput.recordStreamContentHmacSha256,
    };
    return this.#finishComponent(sessionInput, copied, control);
  }

  async #finishComponent(
    sessionInput: Readonly<AgentBackupRestoreV3StagingSession>,
    receiptInput: Readonly<CandidateComponentReceipt>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<CandidateComponentReceipt> {
    assertAgentBackupRestoreV3OperationControl(control, "Restore-v3 component finish");
    this.#requireExactSession(sessionInput);
    const receipt = freezeComponentReceipt(
      AgentBackupRestoreV3ComponentReceiptSchema.parse(receiptInput),
    );
    const descriptorSha256 = sha256Utf8(
      canonicalAgentBackupRestoreV3Descriptor(receipt.descriptor),
    );
    const receiptSha256 = sha256Utf8(canonicalAgentBackupRestoreV3ComponentReceipt(receipt));
    const commandSha256 = computeAgentBackupRestoreV3FinishCommandSha256(this.#bound, receipt);
    try {
      await dbWrite.transaction(async (tx) => {
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 component finish",
        );
        await tx.insert(agentBackupRestoreV3CandidateStageLedger).values({
          candidate_id: this.#bound.candidateId,
          organization_id: this.#bound.organizationId,
          agent_id: this.#bound.agentId,
          backup_id: this.#bound.backupId,
          restore_attempt_id: this.#bound.restoreAttemptId,
          operation_id: this.#bound.operationId,
          execution_token_sha256: this.#bound.executionTokenSha256,
          command_kind: "finish",
          component_index: receipt.componentIndex,
          component_name: receipt.componentName,
          payload_bytes: receipt.payloadBytes,
          payload_sha256: receipt.payloadSha256,
          data_frame_count: receipt.dataFrameCount,
          descriptor_format: receipt.descriptor.format,
          descriptor_compression: receipt.descriptor.compression,
          descriptor_content_kind: receipt.descriptor.contentKind,
          descriptor_consistency: receipt.descriptor.consistency,
          descriptor_sha256: descriptorSha256,
          record_stream_content_hmac_sha256: receipt.recordStreamContentHmacSha256,
          command_sha256: commandSha256,
          receipt_sha256: receiptSha256,
        });
        assertAgentBackupRestoreV3OperationControl(control, "Restore-v3 component finish");
      });
      return receipt;
    } catch (cause) {
      throwIfAgentBackupRestoreV3DatabaseDeadline(cause, "Restore-v3 component finish");
      // A deterministic trigger/constraint rejection means this was a later
      // closed-component call, not an ambiguous response after a committed
      // first finish. Only transport/admin acknowledgement ambiguity may
      // recover the exact durable receipt from PRIMARY.
      if (!isAgentBackupRestoreV3AmbiguousCommitResponse(cause)) throw cause;
      const recovered = await dbWrite.transaction(async (tx) => {
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 component finish recovery",
        );
        const [candidateState] = await tx
          .select({ state: agentBackupRestoreV3Candidates.state })
          .from(agentBackupRestoreV3Candidates)
          .where(eq(agentBackupRestoreV3Candidates.id, this.#bound.candidateId))
          .for("update")
          .limit(1);
        if (candidateState?.state !== "active") return false;
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 component finish recovery",
        );
        const [existing] = await tx
          .select()
          .from(agentBackupRestoreV3CandidateStageLedger)
          .where(
            and(
              eq(agentBackupRestoreV3CandidateStageLedger.candidate_id, this.#bound.candidateId),
              eq(agentBackupRestoreV3CandidateStageLedger.command_kind, "finish"),
              eq(agentBackupRestoreV3CandidateStageLedger.component_index, receipt.componentIndex),
            ),
          )
          .limit(1);
        if (!existing) return false;
        if (
          !exactFinishMatches(
            existing,
            this.#bound,
            receipt,
            descriptorSha256,
            commandSha256,
            receiptSha256,
          )
        ) {
          throw conflict("Restore-v3 finish replay differs from its durable slot", cause);
        }
        assertAgentBackupRestoreV3OperationControl(control, "Restore-v3 component finish recovery");
        return true;
      });
      if (!recovered) throw cause;
      return receipt;
    }
  }

  async abort(
    sessionInput: Readonly<AgentBackupRestoreV3StagingSession>,
    reason: "staging-failed",
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<true> {
    assertAgentBackupRestoreV3OperationControl(control, "Restore-v3 candidate abort");
    const session = parseAgentBackupRestoreV3StagingSession(sessionInput);
    const suppliedTokenSha256 = sha256Utf8(session.executionToken);
    if (
      session.restoreAttemptId !== this.#bound.restoreAttemptId ||
      session.operationId !== this.#bound.operationId ||
      session.stagingHandle !== this.#bound.candidateId ||
      session.cleanupHandle !== this.#bound.cleanupOutboxId ||
      !exactDigestMatches(suppliedTokenSha256, this.#bound.executionTokenSha256)
    ) {
      // A stale execution is an acknowledged no-op; it cannot target this row.
      return true;
    }
    const abortReasonSha256 = computeAgentBackupRestoreV3AbortReasonSha256(reason);
    const commandSha256 = computeAgentBackupRestoreV3AbortCommandSha256(
      this.#bound,
      abortReasonSha256,
    );
    try {
      await dbWrite.transaction(async (tx) => {
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 candidate abort",
        );
        await tx.insert(agentBackupRestoreV3CandidateTerminalCommands).values({
          id: randomUUID(),
          candidate_id: this.#bound.candidateId,
          organization_id: this.#bound.organizationId,
          agent_id: this.#bound.agentId,
          backup_id: this.#bound.backupId,
          restore_attempt_id: this.#bound.restoreAttemptId,
          operation_id: this.#bound.operationId,
          execution_token_sha256: suppliedTokenSha256,
          command_kind: "abort",
          abort_reason_sha256: abortReasonSha256,
          command_sha256: commandSha256,
        });
        assertAgentBackupRestoreV3OperationControl(control, "Restore-v3 candidate abort");
      });
      return true;
    } catch (cause) {
      throwIfAgentBackupRestoreV3DatabaseDeadline(cause, "Restore-v3 candidate abort");
      return dbWrite.transaction(async (tx) => {
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          control,
          "Restore-v3 candidate abort recovery",
        );
        const [candidate] = await tx
          .select({
            state: agentBackupRestoreV3Candidates.state,
            executionTokenSha256: agentBackupRestoreV3Candidates.execution_token_sha256,
          })
          .from(agentBackupRestoreV3Candidates)
          .where(eq(agentBackupRestoreV3Candidates.id, this.#bound.candidateId))
          .limit(1);
        if (
          !candidate ||
          !exactDigestMatches(candidate.executionTokenSha256, suppliedTokenSha256)
        ) {
          return true as const;
        }
        if (candidate.state === "sealed") return true as const;
        if (candidate.state === "aborted") {
          await applyAgentBackupRestoreV3TransactionDeadline(
            tx,
            control,
            "Restore-v3 candidate abort recovery",
          );
          const [terminal] = await tx
            .select()
            .from(agentBackupRestoreV3CandidateTerminalCommands)
            .where(
              eq(
                agentBackupRestoreV3CandidateTerminalCommands.candidate_id,
                this.#bound.candidateId,
              ),
            )
            .limit(1);
          if (
            terminal?.command_kind === "abort" &&
            exactDigestMatches(terminal.execution_token_sha256, suppliedTokenSha256) &&
            exactDigestMatches(terminal.abort_reason_sha256 ?? "", abortReasonSha256) &&
            exactDigestMatches(terminal.command_sha256, commandSha256)
          ) {
            assertAgentBackupRestoreV3OperationControl(
              control,
              "Restore-v3 candidate abort recovery",
            );
            return true as const;
          }
          throw conflict("Restore-v3 abort replay differs from its terminal command", cause);
        }
        throw cause;
      });
    }
  }

  #requireExactSession(
    input: Readonly<AgentBackupRestoreV3StagingSession>,
  ): AgentBackupRestoreV3StagingSession {
    const session = parseAgentBackupRestoreV3StagingSession(input);
    if (
      session.restoreAttemptId !== this.#bound.restoreAttemptId ||
      session.operationId !== this.#bound.operationId ||
      session.stagingHandle !== this.#bound.candidateId ||
      session.cleanupHandle !== this.#bound.cleanupOutboxId ||
      !exactDigestMatches(sha256Utf8(session.executionToken), this.#bound.executionTokenSha256)
    ) {
      throw conflict("Restore-v3 staging session differs from this exact execution");
    }
    return session;
  }
}

/**
 * Pre-bind one exact source generation and one process-held CSPRNG bearer.
 * Retrying `begin` on this same adapter reuses the exact token and handles;
 * constructing another adapter can never silently adopt their bearer authority.
 */
export function createAgentBackupRestoreV3CandidateExecution(
  sourceAuthorityInput: Readonly<AgentBackupRestoreV3SourceAuthority>,
): AgentBackupRestoreV3CandidateExecution {
  const sourceAuthority = parseAgentBackupRestoreV3SourceAuthority(sourceAuthorityInput);
  const sourceAuthorityCanonical = canonicalizeAgentBackupRestoreV3SourceAuthority(sourceAuthority);
  const executionToken = randomBytes(32).toString("base64url");
  const bound: BoundCandidateExecution = Object.freeze({
    candidateId: randomUUID(),
    cleanupOutboxId: randomUUID(),
    organizationId: sourceAuthority.organizationId,
    agentId: sourceAuthority.agentId,
    backupId: sourceAuthority.backupId,
    restoreAttemptId: "",
    operationId: sourceAuthority.operationId,
    executionToken,
    executionTokenSha256: sha256Utf8(executionToken),
    sourceAuthority,
    sourceAuthorityCanonical,
    sourceAuthoritySha256: sha256Utf8(sourceAuthorityCanonical),
  });
  // The restore attempt is supplied only by the validated authority at begin.
  // A tiny wrapper binds it once without changing the shared staging contract.
  let repository: CandidateExecutionRepository | undefined;
  return {
    begin(request, control) {
      const authority = parseAgentBackupRestoreV3AuthorityFence(request.authority);
      const selected =
        repository ??
        new CandidateExecutionRepository(
          Object.freeze({ ...bound, restoreAttemptId: authority.restoreAttemptId }),
        );
      return Promise.resolve(selected.begin(request, control)).then((session) => {
        // Bind only after a successful durable begin/replay. Malformed first
        // calls cannot poison this process-held adapter for the valid attempt.
        repository ??= selected;
        return session;
      });
    },
    stageRecord(session, record, control) {
      if (!repository) throw conflict("Restore-v3 candidate begin has not completed");
      return repository.stageRecord(session, record, control);
    },
    finishComponent(session, receipt, control) {
      if (!repository) throw conflict("Restore-v3 candidate begin has not completed");
      return repository.finishComponent(session, receipt, control);
    },
    abort(session, reason, control) {
      if (!repository) return Promise.resolve(true);
      return repository.abort(session, reason, control);
    },
  };
}
