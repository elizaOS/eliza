/**
 * Durable commit boundary for chunked schema-v2 agent backups.
 *
 * A database staging row records every deterministic object key before its
 * upload begins. The row becomes visible to restore readers only after a
 * read-after-write validation of the complete encrypted stream; interrupted
 * attempts remain hidden and are reclaimed by the reconciler.
 */
import { randomUUID } from "node:crypto";
import {
  type AgentSandboxBackupCleanupReconcileCandidate,
  type AgentSandboxBackupReconcileCandidate,
  agentSandboxesRepository,
} from "../../db/repositories/agent-sandboxes";
import type {
  AgentBackupChunkCompleteDescriptor,
  AgentBackupChunkStagingDescriptor,
  AgentBackupSnapshotType,
  StoredAgentSandboxBackup,
  StoredAgentSandboxBackupCleanupIntent,
} from "../../db/schemas/agent-sandboxes";
import { deleteObject, deleteObjectsExact } from "../storage/object-store";
import { logger } from "../utils/logger";
import {
  type AgentBackupChunkDescriptor,
  type AgentBackupChunkIdentity,
  AgentBackupWriteEpochUnquiescedError,
  readEncryptedAgentBackupChunks,
  stageEncryptedAgentBackupChunks,
} from "./agent-backup-chunks";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_RECONCILE_BATCH_SIZE = 25;
const MAX_RECONCILE_BATCH_SIZE = 100;
const MAX_RECONCILE_OBJECT_KEYS = 5_632;
const EXACT_DELETE_PAGE_SIZE = 1_000;
export const AGENT_BACKUP_WRITE_LEASE_MAX_MS = 24 * 60 * 60 * 1_000;

export interface AgentBackupStreamVerification {
  contentHash: string;
}

interface AgentBackupV2StorageRepository {
  createChunkedBackupStaging(params: {
    descriptor: AgentBackupChunkStagingDescriptor;
    snapshotType: AgentBackupSnapshotType;
  }): Promise<StoredAgentSandboxBackup>;
  updateChunkedBackupStaging(
    backupId: string,
    writeEpoch: string,
    descriptor: AgentBackupChunkStagingDescriptor,
  ): Promise<void>;
  commitChunkedBackup(params: {
    backupId: string;
    writeEpoch: string;
    contentHash: string;
    descriptor: AgentBackupChunkCompleteDescriptor;
    verifiedAt: Date;
  }): Promise<StoredAgentSandboxBackup>;
  getChunkedBackupById(backupId: string): Promise<StoredAgentSandboxBackup | undefined>;
  assertChunkedBackupTenant(params: {
    backupId: string;
    organizationId: string;
    sandboxRecordId: string;
  }): Promise<void>;
  failChunkedBackup(
    backupId: string,
    writeEpoch: string,
    descriptor: AgentBackupChunkStagingDescriptor,
    error: string,
  ): Promise<StoredAgentSandboxBackup | undefined>;
  quiesceExpiredEmptyChunkedBackup(
    backupId: string,
    writeEpoch: string,
    error: string,
  ): Promise<StoredAgentSandboxBackup | undefined>;
  listIncompleteChunkedBackupsBefore(
    before: Date,
    limit: number,
  ): Promise<AgentSandboxBackupReconcileCandidate[]>;
  listBackupObjectCleanupIntentsBefore(
    before: Date,
    limit: number,
  ): Promise<AgentSandboxBackupCleanupReconcileCandidate[]>;
  rescheduleIncompleteChunkedBackup(backupId: string, expectedVersion: string): Promise<boolean>;
  rescheduleBackupObjectCleanupIntent(backupId: string, expectedVersion: string): Promise<boolean>;
  deleteBackupObjectCleanupIntent(backupId: string): Promise<boolean>;
  claimPrunableChunkedBackups(
    sandboxRecordId: string,
    organizationId: string,
    keep: number,
  ): Promise<StoredAgentSandboxBackup[]>;
  deleteIncompleteChunkedBackup(backupId: string): Promise<boolean>;
  pruneBackups(sandboxRecordId: string, keep: number): Promise<number>;
}

export interface AgentBackupV2StorageDependencies {
  repository: AgentBackupV2StorageRepository;
  stageChunks: typeof stageEncryptedAgentBackupChunks;
  readChunks: typeof readEncryptedAgentBackupChunks;
  deleteObject: typeof deleteObject;
  deleteObjectsExact?: typeof deleteObjectsExact;
}

const defaultDependencies: AgentBackupV2StorageDependencies = {
  repository: agentSandboxesRepository,
  stageChunks: stageEncryptedAgentBackupChunks,
  readChunks: readEncryptedAgentBackupChunks,
  deleteObject,
  deleteObjectsExact,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Chunked backup write aborted");
}

function raceWithAbort<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const promise = Promise.resolve(operation);
  if (signal.aborted) {
    // error-policy:J5 the caller observes the primary abort; this observes only
    // a late rejection from work that was already dispatched.
    void promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function assertIdentity(identity: AgentBackupChunkIdentity): void {
  if (
    !UUID_PATTERN.test(identity.organizationId) ||
    !UUID_PATTERN.test(identity.sandboxRecordId) ||
    !UUID_PATTERN.test(identity.backupId) ||
    identity.backupSchemaVersion !== 2
  ) {
    throw new Error("Chunked backup identity must contain canonical UUIDs and schema version 2");
  }
}

function failedDescriptor(
  descriptor: AgentBackupChunkStagingDescriptor,
  failure: string,
  quiescedAt: Date,
): AgentBackupChunkStagingDescriptor {
  return {
    ...descriptor,
    commitState: "failed",
    failure: failure.slice(0, 2_000),
    writeQuiescedAt: quiescedAt.toISOString(),
  };
}

function requireStagingDescriptor(
  row: StoredAgentSandboxBackup,
): AgentBackupChunkStagingDescriptor {
  const descriptor = row.state_data_descriptor;
  if (
    row.snapshot_schema_version !== 2 ||
    row.state_data_storage !== "chunked-v2" ||
    row.storage_commit_state === "complete" ||
    !descriptor ||
    descriptor.format !== "elizaos.agent-backup-chunks" ||
    descriptor.descriptorVersion !== 1 ||
    descriptor.backupSchemaVersion !== 2 ||
    descriptor.commitState === "complete" ||
    descriptor.backupId !== row.id ||
    descriptor.sandboxRecordId !== row.sandbox_record_id ||
    !UUID_PATTERN.test(descriptor.objectSetId) ||
    !isCanonicalDate(descriptor.writeLeaseExpiresAt) ||
    (descriptor.writeQuiescedAt !== null && !isCanonicalDate(descriptor.writeQuiescedAt)) ||
    !Array.isArray(descriptor.plannedObjectKeys)
  ) {
    throw new Error(`Incomplete backup ${row.id} has an invalid staging descriptor`);
  }
  return descriptor;
}

function isCanonicalDate(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isMatchingCompleteBackup(
  row: StoredAgentSandboxBackup | undefined,
  identity: AgentBackupChunkIdentity,
  writeEpoch: string,
): row is StoredAgentSandboxBackup {
  const descriptor = row?.state_data_descriptor;
  return (
    row?.id === identity.backupId &&
    row.sandbox_record_id === identity.sandboxRecordId &&
    row.snapshot_schema_version === 2 &&
    row.state_data_storage === "chunked-v2" &&
    row.storage_commit_state === "complete" &&
    descriptor?.commitState === "complete" &&
    descriptor.organizationId === identity.organizationId &&
    descriptor.sandboxRecordId === identity.sandboxRecordId &&
    descriptor.backupId === identity.backupId &&
    descriptor.objectSetId === writeEpoch
  );
}

function assertPlannedObjectKeys(descriptor: AgentBackupChunkStagingDescriptor): void {
  const namespace = "agent-sandbox-backups";
  const organizationSegment = descriptor.organizationId;
  const backupPrefix = `${descriptor.backupId}.`;
  for (const [index, key] of descriptor.plannedObjectKeys.entries()) {
    const segments = key.split("/");
    if (segments.length !== 5 || segments[0] !== namespace || segments[1] !== organizationSegment) {
      throw new Error(`Incomplete backup ${descriptor.backupId} has an invalid object key`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(segments[2] ?? "")) {
      throw new Error(`Incomplete backup ${descriptor.backupId} has an invalid object date`);
    }
    const objectId = segments[3] ?? "";
    if (!objectId.startsWith(backupPrefix)) {
      throw new Error(`Incomplete backup ${descriptor.backupId} has an invalid object identity`);
    }
    const candidateSetId = objectId.slice(backupPrefix.length);
    if (candidateSetId !== descriptor.objectSetId) {
      throw new Error(`Incomplete backup ${descriptor.backupId} mixes object sets`);
    }
    const expectedField = `chunk-${String(index).padStart(6, "0")}.bin`;
    if (segments[4] !== expectedField) {
      throw new Error(`Incomplete backup ${descriptor.backupId} has reordered object keys`);
    }
  }
}

function assertCompleteObjectKeys(descriptor: AgentBackupChunkCompleteDescriptor): void {
  if (
    !UUID_PATTERN.test(descriptor.organizationId) ||
    !UUID_PATTERN.test(descriptor.sandboxRecordId) ||
    !UUID_PATTERN.test(descriptor.backupId) ||
    !UUID_PATTERN.test(descriptor.objectSetId)
  ) {
    throw new Error(`Complete backup ${descriptor.backupId} has an invalid identity`);
  }
  const createdAt = new Date(descriptor.createdAt);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== descriptor.createdAt) {
    throw new Error(`Complete backup ${descriptor.backupId} has an invalid creation time`);
  }
  const date = descriptor.createdAt.slice(0, 10);
  const objectId = `${descriptor.backupId}.${descriptor.objectSetId}`;
  for (const [index, chunk] of descriptor.chunks.entries()) {
    const expectedKey =
      `agent-sandbox-backups/${descriptor.organizationId}/${date}/${objectId}/` +
      `chunk-${String(index).padStart(6, "0")}.bin`;
    if (chunk.index !== index || chunk.objectKey !== expectedKey) {
      throw new Error(`Complete backup ${descriptor.backupId} has an invalid object key`);
    }
  }
}

async function removePlannedObjects(
  row: StoredAgentSandboxBackup,
  descriptor: AgentBackupChunkStagingDescriptor,
  dependencies: AgentBackupV2StorageDependencies,
  signal?: AbortSignal,
): Promise<void> {
  await assertTenantBoundDescriptor(row, descriptor, dependencies);
  await deletePlannedObjectKeys(descriptor, dependencies, signal);
}

async function deletePlannedObjectKeys(
  descriptor: AgentBackupChunkStagingDescriptor,
  dependencies: AgentBackupV2StorageDependencies,
  signal?: AbortSignal,
): Promise<void> {
  assertPlannedObjectKeys(descriptor);
  if (descriptor.plannedObjectKeys.length > MAX_RECONCILE_OBJECT_KEYS) {
    throw new Error(
      `Incomplete backup ${descriptor.backupId} exceeds the ${MAX_RECONCILE_OBJECT_KEYS}-key cleanup budget`,
    );
  }
  if (dependencies.deleteObjectsExact && descriptor.plannedObjectKeys.length > 0) {
    const keys = [...descriptor.plannedObjectKeys].reverse();
    for (let offset = 0; offset < keys.length; offset += EXACT_DELETE_PAGE_SIZE) {
      await dependencies.deleteObjectsExact(
        keys.slice(offset, offset + EXACT_DELETE_PAGE_SIZE),
        signal,
      );
    }
    return;
  }
  const failures: string[] = [];
  for (const key of [...descriptor.plannedObjectKeys].reverse()) {
    try {
      if (signal?.aborted) throw abortReason(signal);
      await dependencies.deleteObject(key);
    } catch (error) {
      failures.push(`${key}: ${errorMessage(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to remove incomplete backup objects: ${failures.join("; ")}`);
  }
}

async function removeCompleteObjects(
  row: StoredAgentSandboxBackup,
  descriptor: AgentBackupChunkCompleteDescriptor,
  dependencies: AgentBackupV2StorageDependencies,
  signal?: AbortSignal,
): Promise<void> {
  await assertTenantBoundDescriptor(row, descriptor, dependencies);
  await deleteCompleteObjectKeys(descriptor, dependencies, signal);
}

async function deleteCompleteObjectKeys(
  descriptor: AgentBackupChunkCompleteDescriptor,
  dependencies: AgentBackupV2StorageDependencies,
  signal?: AbortSignal,
): Promise<void> {
  assertCompleteObjectKeys(descriptor);
  if (descriptor.chunks.length > MAX_RECONCILE_OBJECT_KEYS) {
    throw new Error(
      `Complete backup ${descriptor.backupId} exceeds the ${MAX_RECONCILE_OBJECT_KEYS}-key cleanup budget`,
    );
  }
  if (dependencies.deleteObjectsExact && descriptor.chunks.length > 0) {
    const keys = descriptor.chunks.map((chunk) => chunk.objectKey).reverse();
    for (let offset = 0; offset < keys.length; offset += EXACT_DELETE_PAGE_SIZE) {
      await dependencies.deleteObjectsExact(
        keys.slice(offset, offset + EXACT_DELETE_PAGE_SIZE),
        signal,
      );
    }
    return;
  }
  const failures: string[] = [];
  for (const chunk of [...descriptor.chunks].reverse()) {
    try {
      if (signal?.aborted) throw abortReason(signal);
      await dependencies.deleteObject(chunk.objectKey);
    } catch (error) {
      failures.push(`${chunk.objectKey}: ${errorMessage(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to remove pruned backup objects: ${failures.join("; ")}`);
  }
}

async function removeCleanupIntentObjects(
  intent: StoredAgentSandboxBackupCleanupIntent,
  dependencies: AgentBackupV2StorageDependencies,
  signal?: AbortSignal,
): Promise<void> {
  const descriptor = intent.descriptor;
  if (
    descriptor.backupId !== intent.backup_id ||
    descriptor.sandboxRecordId !== intent.sandbox_record_id ||
    descriptor.organizationId !== intent.organization_id
  ) {
    throw new Error(`Backup cleanup intent ${intent.backup_id} is not self-consistent`);
  }
  if (descriptor.commitState === "complete") {
    await deleteCompleteObjectKeys(descriptor, dependencies, signal);
    return;
  }
  await deletePlannedObjectKeys(descriptor, dependencies, signal);
  if (descriptor.writeQuiescedAt === null) {
    throw new Error(`Backup cleanup intent ${intent.backup_id} retains an unquiesced write epoch`);
  }
}

async function assertTenantBoundDescriptor(
  row: StoredAgentSandboxBackup,
  descriptor: AgentBackupChunkStagingDescriptor | AgentBackupChunkCompleteDescriptor,
  dependencies: AgentBackupV2StorageDependencies,
): Promise<void> {
  if (descriptor.backupId !== row.id || descriptor.sandboxRecordId !== row.sandbox_record_id) {
    throw new Error(`Backup ${row.id} descriptor is not bound to its database row`);
  }
  await dependencies.repository.assertChunkedBackupTenant({
    backupId: row.id,
    organizationId: descriptor.organizationId,
    sandboxRecordId: row.sandbox_record_id,
  });
}

export class AgentBackupV2StorageService {
  constructor(private readonly dependencies = defaultDependencies) {}

  async create(params: {
    identity: Omit<AgentBackupChunkIdentity, "backupId"> & { backupId?: string };
    snapshotType: AgentBackupSnapshotType;
    source: AsyncIterable<Uint8Array>;
    verify: (source: AsyncIterable<Uint8Array>) => Promise<AgentBackupStreamVerification>;
    signal: AbortSignal;
    writeLeaseExpiresAt: Date;
    createdAt?: Date;
    maxTotalBytes?: number;
  }): Promise<StoredAgentSandboxBackup> {
    if (params.snapshotType !== "pre-upgrade") {
      throw new Error("Schema-v2 chunked storage is reserved for pre-upgrade restore points");
    }
    const identity: AgentBackupChunkIdentity = {
      ...params.identity,
      backupId: params.identity.backupId ?? randomUUID(),
    };
    assertIdentity(identity);
    if (params.signal.aborted) throw abortReason(params.signal);
    const createdAt = params.createdAt ?? new Date();
    if (!Number.isFinite(createdAt.getTime())) {
      throw new Error("Chunked backup creation time is invalid");
    }
    const leaseDurationMs = params.writeLeaseExpiresAt.getTime() - Date.now();
    if (
      !Number.isFinite(leaseDurationMs) ||
      leaseDurationMs <= 0 ||
      leaseDurationMs > AGENT_BACKUP_WRITE_LEASE_MAX_MS
    ) {
      throw new Error(
        `Chunked backup write lease must expire within ${AGENT_BACKUP_WRITE_LEASE_MAX_MS}ms`,
      );
    }
    const objectSetId = randomUUID();

    let stagingDescriptor: AgentBackupChunkStagingDescriptor = {
      format: "elizaos.agent-backup-chunks",
      descriptorVersion: 1,
      backupSchemaVersion: 2,
      commitState: "staging",
      organizationId: identity.organizationId,
      sandboxRecordId: identity.sandboxRecordId,
      backupId: identity.backupId,
      objectSetId,
      createdAt: createdAt.toISOString(),
      writeLeaseExpiresAt: params.writeLeaseExpiresAt.toISOString(),
      writeQuiescedAt: null,
      plannedObjectKeys: [],
      failure: null,
    };
    await this.dependencies.repository.createChunkedBackupStaging({
      descriptor: stagingDescriptor,
      snapshotType: params.snapshotType,
    });

    try {
      const descriptor = await this.dependencies.stageChunks({
        identity,
        objectSetId,
        source: params.source,
        signal: params.signal,
        createdAt,
        maxTotalBytes: params.maxTotalBytes,
        onObjectPlanned: async ({ index, objectKey }) => {
          if (index !== stagingDescriptor.plannedObjectKeys.length) {
            throw new Error("Chunk planner emitted a reordered object index");
          }
          stagingDescriptor = {
            ...stagingDescriptor,
            plannedObjectKeys: [...stagingDescriptor.plannedObjectKeys, objectKey],
          };
          await this.dependencies.repository.updateChunkedBackupStaging(
            identity.backupId,
            objectSetId,
            stagingDescriptor,
          );
        },
      });
      const verification = await raceWithAbort(
        params.verify(
          this.dependencies.readChunks({
            identity,
            descriptor,
            signal: params.signal,
          }),
        ),
        params.signal,
      );
      if (!DIGEST_PATTERN.test(verification.contentHash)) {
        throw new Error("Snapshot stream verifier did not return a SHA-256 content hash");
      }
      return await this.dependencies.repository.commitChunkedBackup({
        backupId: identity.backupId,
        writeEpoch: objectSetId,
        contentHash: verification.contentHash,
        descriptor: descriptor as AgentBackupChunkCompleteDescriptor,
        verifiedAt: new Date(),
      });
    } catch (error) {
      const message = errorMessage(error);
      if (error instanceof AgentBackupWriteEpochUnquiescedError) {
        throw new Error(
          `Chunked backup write outcome is unknown; durable epoch ${objectSetId} remains fenced for repeated reconciliation`,
          { cause: error },
        );
      }
      const failed = failedDescriptor(stagingDescriptor, message, new Date());
      const failedRow = await this.dependencies.repository.failChunkedBackup(
        identity.backupId,
        objectSetId,
        failed,
        message,
      );
      if (!failedRow) {
        const resolved = await this.dependencies.repository.getChunkedBackupById(identity.backupId);
        if (isMatchingCompleteBackup(resolved, identity, objectSetId)) {
          return resolved;
        }
        throw new Error(
          `Chunked backup failed (${message}) but its durable commit outcome could not be resolved; cleanup remains pending`,
          { cause: error },
        );
      }
      try {
        await removePlannedObjects(failedRow, failed, this.dependencies, params.signal);
        await this.dependencies.repository.deleteIncompleteChunkedBackup(identity.backupId);
      } catch (cleanupError) {
        throw new Error(
          `Chunked backup failed (${message}) and durable cleanup remains pending: ${errorMessage(cleanupError)}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async reconcileIncomplete(params: {
    before: Date;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<{ deleted: number; retained: number }> {
    const limit = params.limit ?? DEFAULT_RECONCILE_BATCH_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECONCILE_BATCH_SIZE) {
      throw new Error(
        `Chunked backup reconcile limit must be between 1 and ${MAX_RECONCILE_BATCH_SIZE}`,
      );
    }
    const rows = await this.dependencies.repository.listIncompleteChunkedBackupsBefore(
      params.before,
      limit,
    );
    let deleted = 0;
    let retained = 0;
    for (const row of rows) {
      if (params.signal?.aborted) throw abortReason(params.signal);
      try {
        const descriptor = row.state_data_descriptor;
        if (
          row.storage_commit_state === "cleanup-pending" &&
          descriptor?.commitState === "complete"
        ) {
          await removeCompleteObjects(row, descriptor, this.dependencies, params.signal);
        } else {
          const staging = requireStagingDescriptor(row);
          if (staging.writeQuiescedAt === null) {
            if (
              (row.storage_commit_state === "staging" || row.storage_commit_state === "failed") &&
              staging.plannedObjectKeys.length === 0
            ) {
              const failure = "Backup write lease expired before any object was planned";
              const quiescedRow =
                await this.dependencies.repository.quiesceExpiredEmptyChunkedBackup(
                  row.id,
                  staging.objectSetId,
                  failure,
                );
              if (
                quiescedRow &&
                (await this.dependencies.repository.deleteIncompleteChunkedBackup(row.id))
              ) {
                deleted += 1;
                continue;
              }
            } else {
              await removePlannedObjects(row, staging, this.dependencies, params.signal);
            }
            await this.dependencies.repository.rescheduleIncompleteChunkedBackup(
              row.id,
              row.reconcileVersion,
            );
            retained += 1;
            continue;
          }
          await removePlannedObjects(row, staging, this.dependencies, params.signal);
        }
        if (await this.dependencies.repository.deleteIncompleteChunkedBackup(row.id)) {
          deleted += 1;
        } else {
          await this.dependencies.repository.rescheduleIncompleteChunkedBackup(
            row.id,
            row.reconcileVersion,
          );
          retained += 1;
        }
      } catch (error) {
        // error-policy:J7 the durable row remains visible to the next
        // reconciliation cycle; its stored error is the operator signal.
        logger.warn("[AgentBackupV2StorageService] Incomplete backup cleanup remains pending", {
          backupId: row.id,
          error: errorMessage(error),
        });
        await this.dependencies.repository.rescheduleIncompleteChunkedBackup(
          row.id,
          row.reconcileVersion,
        );
        retained += 1;
        if (params.signal?.aborted) throw abortReason(params.signal);
      }
    }
    if (params.signal?.aborted) throw abortReason(params.signal);
    const intents = await this.dependencies.repository.listBackupObjectCleanupIntentsBefore(
      params.before,
      limit,
    );
    for (const intent of intents) {
      if (params.signal?.aborted) throw abortReason(params.signal);
      try {
        await removeCleanupIntentObjects(intent, this.dependencies, params.signal);
        if (await this.dependencies.repository.deleteBackupObjectCleanupIntent(intent.backup_id)) {
          deleted += 1;
        } else {
          await this.dependencies.repository.rescheduleBackupObjectCleanupIntent(
            intent.backup_id,
            intent.reconcileVersion,
          );
          retained += 1;
        }
      } catch (error) {
        // error-policy:J7 the outbox row survives the deleted sandbox and
        // remains visible to the next reconciliation cycle.
        logger.warn("[AgentBackupV2StorageService] Deleted-sandbox cleanup remains pending", {
          backupId: intent.backup_id,
          error: errorMessage(error),
        });
        await this.dependencies.repository.rescheduleBackupObjectCleanupIntent(
          intent.backup_id,
          intent.reconcileVersion,
        );
        retained += 1;
        if (params.signal?.aborted) throw abortReason(params.signal);
      }
    }
    return { deleted, retained };
  }

  async prune(params: {
    organizationId: string;
    sandboxRecordId: string;
    keep: number;
  }): Promise<{ legacyDeleted: number; chunkedDeleted: number; chunkedPending: number }> {
    const rows = await this.dependencies.repository.claimPrunableChunkedBackups(
      params.sandboxRecordId,
      params.organizationId,
      params.keep,
    );
    const legacyDeleted = await this.dependencies.repository.pruneBackups(
      params.sandboxRecordId,
      params.keep,
    );
    let chunkedDeleted = 0;
    let chunkedPending = 0;
    for (const row of rows) {
      const descriptor = row.state_data_descriptor;
      try {
        if (!descriptor || descriptor.commitState !== "complete") {
          throw new Error(`Prunable backup ${row.id} has an invalid complete descriptor`);
        }
        await removeCompleteObjects(row, descriptor, this.dependencies);
        if (await this.dependencies.repository.deleteIncompleteChunkedBackup(row.id)) {
          chunkedDeleted += 1;
        } else {
          chunkedPending += 1;
        }
      } catch (error) {
        // error-policy:J7 durable cleanup state remains available to the
        // reconciler and operator when object deletion cannot complete.
        logger.warn("[AgentBackupV2StorageService] Pruned backup cleanup remains pending", {
          backupId: row.id,
          error: errorMessage(error),
        });
        chunkedPending += 1;
      }
    }
    return { legacyDeleted, chunkedDeleted, chunkedPending };
  }
}

export const agentBackupV2StorageService = new AgentBackupV2StorageService();

export async function readStoredChunkedBackup(params: {
  organizationId: string;
  row: StoredAgentSandboxBackup;
  signal?: AbortSignal;
}): Promise<AsyncIterable<Uint8Array>> {
  const descriptor = params.row.state_data_descriptor;
  if (
    params.row.snapshot_schema_version !== 2 ||
    params.row.state_data_storage !== "chunked-v2" ||
    params.row.storage_commit_state !== "complete" ||
    !descriptor ||
    descriptor.commitState !== "complete" ||
    descriptor.organizationId !== params.organizationId
  ) {
    throw new Error(`Backup ${params.row.id} is not a complete schema-v2 restore point`);
  }
  await agentSandboxesRepository.assertChunkedBackupTenant({
    backupId: params.row.id,
    organizationId: params.organizationId,
    sandboxRecordId: params.row.sandbox_record_id,
  });
  const identity: AgentBackupChunkIdentity = {
    organizationId: params.organizationId,
    sandboxRecordId: params.row.sandbox_record_id,
    backupId: params.row.id,
    backupSchemaVersion: 2,
  };
  return readEncryptedAgentBackupChunks({
    identity,
    descriptor: descriptor as AgentBackupChunkDescriptor,
    signal: params.signal,
  });
}
