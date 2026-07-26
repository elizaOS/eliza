/**
 * Durable commit boundary for chunked schema-v2 agent backups.
 *
 * A database staging row records every deterministic object key before its
 * upload begins. The row becomes visible to restore readers only after a
 * read-after-write validation of the complete encrypted stream; interrupted
 * attempts remain hidden and are reclaimed by the reconciler.
 */
import { randomUUID } from "node:crypto";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import type {
  AgentBackupChunkCompleteDescriptor,
  AgentBackupChunkStagingDescriptor,
  AgentBackupSnapshotType,
  StoredAgentSandboxBackup,
} from "../../db/schemas/agent-sandboxes";
import { deleteObject } from "../storage/object-store";
import { logger } from "../utils/logger";
import {
  type AgentBackupChunkDescriptor,
  type AgentBackupChunkIdentity,
  readEncryptedAgentBackupChunks,
  stageEncryptedAgentBackupChunks,
} from "./agent-backup-chunks";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_RECONCILE_BATCH_SIZE = 25;
const MAX_RECONCILE_BATCH_SIZE = 100;

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
    descriptor: AgentBackupChunkStagingDescriptor,
  ): Promise<void>;
  commitChunkedBackup(params: {
    backupId: string;
    contentHash: string;
    descriptor: AgentBackupChunkCompleteDescriptor;
    verifiedAt: Date;
  }): Promise<StoredAgentSandboxBackup>;
  failChunkedBackup(
    backupId: string,
    descriptor: AgentBackupChunkStagingDescriptor,
    error: string,
  ): Promise<void>;
  listIncompleteChunkedBackupsBefore(
    before: Date,
    limit: number,
  ): Promise<StoredAgentSandboxBackup[]>;
  claimPrunableChunkedBackups(
    sandboxRecordId: string,
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
}

const defaultDependencies: AgentBackupV2StorageDependencies = {
  repository: agentSandboxesRepository,
  stageChunks: stageEncryptedAgentBackupChunks,
  readChunks: readEncryptedAgentBackupChunks,
  deleteObject,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
): AgentBackupChunkStagingDescriptor {
  return {
    ...descriptor,
    commitState: "failed",
    failure: failure.slice(0, 2_000),
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
    !Array.isArray(descriptor.plannedObjectKeys)
  ) {
    throw new Error(`Incomplete backup ${row.id} has an invalid staging descriptor`);
  }
  return descriptor;
}

function assertPlannedObjectKeys(descriptor: AgentBackupChunkStagingDescriptor): void {
  const namespace = "agent-sandbox-backups";
  const organizationSegment = descriptor.organizationId;
  const backupPrefix = `${descriptor.backupId}.`;
  let objectSetId: string | null = null;
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
    if (!UUID_PATTERN.test(candidateSetId) || (objectSetId && candidateSetId !== objectSetId)) {
      throw new Error(`Incomplete backup ${descriptor.backupId} mixes object sets`);
    }
    objectSetId = candidateSetId;
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
  descriptor: AgentBackupChunkStagingDescriptor,
  dependencies: AgentBackupV2StorageDependencies,
): Promise<void> {
  assertPlannedObjectKeys(descriptor);
  const failures: string[] = [];
  for (const key of [...descriptor.plannedObjectKeys].reverse()) {
    try {
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
  descriptor: AgentBackupChunkCompleteDescriptor,
  dependencies: AgentBackupV2StorageDependencies,
): Promise<void> {
  assertCompleteObjectKeys(descriptor);
  const failures: string[] = [];
  for (const chunk of [...descriptor.chunks].reverse()) {
    try {
      await dependencies.deleteObject(chunk.objectKey);
    } catch (error) {
      failures.push(`${chunk.objectKey}: ${errorMessage(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to remove pruned backup objects: ${failures.join("; ")}`);
  }
}

export class AgentBackupV2StorageService {
  constructor(private readonly dependencies = defaultDependencies) {}

  async create(params: {
    identity: Omit<AgentBackupChunkIdentity, "backupId"> & { backupId?: string };
    snapshotType: AgentBackupSnapshotType;
    source: AsyncIterable<Uint8Array>;
    verify: (source: AsyncIterable<Uint8Array>) => Promise<AgentBackupStreamVerification>;
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
    const createdAt = params.createdAt ?? new Date();
    if (!Number.isFinite(createdAt.getTime())) {
      throw new Error("Chunked backup creation time is invalid");
    }

    let stagingDescriptor: AgentBackupChunkStagingDescriptor = {
      format: "elizaos.agent-backup-chunks",
      descriptorVersion: 1,
      backupSchemaVersion: 2,
      commitState: "staging",
      organizationId: identity.organizationId,
      sandboxRecordId: identity.sandboxRecordId,
      backupId: identity.backupId,
      createdAt: createdAt.toISOString(),
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
        source: params.source,
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
            stagingDescriptor,
          );
        },
      });
      const verification = await params.verify(
        this.dependencies.readChunks({ identity, descriptor }),
      );
      if (!DIGEST_PATTERN.test(verification.contentHash)) {
        throw new Error("Snapshot stream verifier did not return a SHA-256 content hash");
      }
      return await this.dependencies.repository.commitChunkedBackup({
        backupId: identity.backupId,
        contentHash: verification.contentHash,
        descriptor: descriptor as AgentBackupChunkCompleteDescriptor,
        verifiedAt: new Date(),
      });
    } catch (error) {
      const message = errorMessage(error);
      const failed = failedDescriptor(stagingDescriptor, message);
      await this.dependencies.repository.failChunkedBackup(identity.backupId, failed, message);
      try {
        await removePlannedObjects(failed, this.dependencies);
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
      try {
        const descriptor = row.state_data_descriptor;
        if (
          row.storage_commit_state === "cleanup-pending" &&
          descriptor?.commitState === "complete"
        ) {
          await removeCompleteObjects(descriptor, this.dependencies);
        } else {
          await removePlannedObjects(requireStagingDescriptor(row), this.dependencies);
        }
        if (await this.dependencies.repository.deleteIncompleteChunkedBackup(row.id)) {
          deleted += 1;
        } else {
          retained += 1;
        }
      } catch (error) {
        // error-policy:J7 the durable row remains visible to the next
        // reconciliation cycle; its stored error is the operator signal.
        logger.warn("[AgentBackupV2StorageService] Incomplete backup cleanup remains pending", {
          backupId: row.id,
          error: errorMessage(error),
        });
        retained += 1;
      }
    }
    return { deleted, retained };
  }

  async prune(params: {
    sandboxRecordId: string;
    keep: number;
  }): Promise<{ legacyDeleted: number; chunkedDeleted: number; chunkedPending: number }> {
    const legacyDeleted = await this.dependencies.repository.pruneBackups(
      params.sandboxRecordId,
      params.keep,
    );
    const rows = await this.dependencies.repository.claimPrunableChunkedBackups(
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
        await removeCompleteObjects(descriptor, this.dependencies);
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

export function readStoredChunkedBackup(params: {
  organizationId: string;
  row: StoredAgentSandboxBackup;
}): AsyncIterable<Uint8Array> {
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
  const identity: AgentBackupChunkIdentity = {
    organizationId: params.organizationId,
    sandboxRecordId: params.row.sandbox_record_id,
    backupId: params.row.id,
    backupSchemaVersion: 2,
  };
  return readEncryptedAgentBackupChunks({
    identity,
    descriptor: descriptor as AgentBackupChunkDescriptor,
  });
}
