/**
 * Exercises the durable schema-v2 commit protocol with injected storage and
 * repository boundaries, including crash residue and adversarial object keys.
 */
import { describe, expect, test } from "bun:test";
import type {
  AgentBackupChunkCompleteDescriptor,
  AgentBackupChunkStagingDescriptor,
  AgentBackupSnapshotType,
  StoredAgentSandboxBackup,
} from "../../db/schemas/agent-sandboxes";
import type {
  AgentBackupChunkDescriptor,
  AgentBackupChunkIdentity,
  AgentBackupPlannedChunk,
} from "./agent-backup-chunks";
import {
  type AgentBackupV2StorageDependencies,
  AgentBackupV2StorageService,
} from "./agent-backup-v2-storage";

const organizationId = "00000000-0000-4000-8000-000000000001";
const sandboxRecordId = "00000000-0000-4000-8000-000000000002";
const backupId = "00000000-0000-4000-8000-000000000003";
const objectSetId = "00000000-0000-4000-8000-000000000004";
const createdAt = new Date("2026-07-26T12:00:00.000Z");
const contentHash = "a".repeat(64);
const objectKey =
  `agent-sandbox-backups/${organizationId}/2026-07-26/` +
  `${backupId}.${objectSetId}/chunk-000000.bin`;

function stagingDescriptor(
  overrides: Partial<AgentBackupChunkStagingDescriptor> = {},
): AgentBackupChunkStagingDescriptor {
  return {
    format: "elizaos.agent-backup-chunks",
    descriptorVersion: 1,
    backupSchemaVersion: 2,
    commitState: "staging",
    organizationId,
    sandboxRecordId,
    backupId,
    createdAt: createdAt.toISOString(),
    plannedObjectKeys: [],
    failure: null,
    ...overrides,
  };
}

function completeDescriptor(): AgentBackupChunkDescriptor {
  return {
    format: "elizaos.agent-backup-chunks",
    descriptorVersion: 1,
    backupSchemaVersion: 2,
    commitState: "complete",
    organizationId,
    sandboxRecordId,
    backupId,
    objectSetId,
    createdAt: createdAt.toISOString(),
    chunkBytes: 4,
    totalPlaintextBytes: 4,
    totalPlaintextSha256: "b".repeat(64),
    chunks: [
      {
        index: 0,
        objectKey,
        plaintextBytes: 4,
        ciphertextBytes: 4,
        plaintextSha256: "c".repeat(64),
        ciphertextSha256: "d".repeat(64),
        nonceBase64: "AAAAAAAAAAAAAAAA",
        authTagBase64: "AAAAAAAAAAAAAAAAAAAAAA==",
        kmsKeyId: `org:${organizationId}:dek`,
        kmsKeyVersion: 1,
      },
    ],
  };
}

function row(params: {
  descriptor: AgentBackupChunkStagingDescriptor | AgentBackupChunkCompleteDescriptor;
  state?: "staging" | "complete" | "failed";
}): StoredAgentSandboxBackup {
  return {
    id: backupId,
    sandbox_record_id: sandboxRecordId,
    snapshot_type: "pre-upgrade",
    snapshot_schema_version: 2,
    state_data: { memories: [], config: {}, workspaceFiles: {} },
    state_data_storage: "chunked-v2",
    state_data_key: null,
    state_data_descriptor: params.descriptor,
    storage_commit_state: params.state ?? "staging",
    storage_commit_error: null,
    storage_commit_updated_at: createdAt,
    size_bytes: null,
    backup_kind: "full",
    parent_backup_id: null,
    content_hash: null,
    verification_status: null,
    verified_at: null,
    verification_error: null,
    created_at: createdAt,
  };
}

class FakeRepository {
  events: string[] = [];
  incomplete: StoredAgentSandboxBackup[] = [];
  prunable: StoredAgentSandboxBackup[] = [];
  deleted = false;
  latestDescriptor = stagingDescriptor();

  async createChunkedBackupStaging(params: {
    descriptor: AgentBackupChunkStagingDescriptor;
    snapshotType: AgentBackupSnapshotType;
  }): Promise<StoredAgentSandboxBackup> {
    this.events.push(`row:${params.snapshotType}`);
    this.latestDescriptor = params.descriptor;
    return row({ descriptor: params.descriptor });
  }

  async updateChunkedBackupStaging(
    _backupId: string,
    descriptor: AgentBackupChunkStagingDescriptor,
  ): Promise<void> {
    this.events.push(`plan:${descriptor.plannedObjectKeys.length}`);
    this.latestDescriptor = descriptor;
  }

  async commitChunkedBackup(params: {
    backupId: string;
    contentHash: string;
    descriptor: AgentBackupChunkCompleteDescriptor;
    verifiedAt: Date;
  }): Promise<StoredAgentSandboxBackup> {
    this.events.push(`commit:${params.contentHash}`);
    return row({ descriptor: params.descriptor, state: "complete" });
  }

  async failChunkedBackup(
    _backupId: string,
    descriptor: AgentBackupChunkStagingDescriptor,
    _error: string,
  ): Promise<void> {
    this.events.push("fail");
    this.latestDescriptor = descriptor;
  }

  async listIncompleteChunkedBackupsBefore(
    _before: Date,
    _limit: number,
  ): Promise<StoredAgentSandboxBackup[]> {
    return this.incomplete;
  }

  async claimPrunableChunkedBackups(
    _sandboxRecordId: string,
    _keep: number,
  ): Promise<StoredAgentSandboxBackup[]> {
    this.events.push("claim-prunable");
    return this.prunable;
  }

  async deleteIncompleteChunkedBackup(_backupId: string): Promise<boolean> {
    this.events.push("delete-row");
    this.deleted = true;
    return true;
  }

  async pruneBackups(_sandboxRecordId: string, _keep: number): Promise<number> {
    this.events.push("prune-legacy");
    return 1;
  }
}

async function* bytes(value = "demo"): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(value);
}

function dependencies(params?: {
  deleteFails?: boolean;
  stageFails?: boolean;
  repository?: FakeRepository;
}): { dependencies: AgentBackupV2StorageDependencies; repository: FakeRepository } {
  const repository = params?.repository ?? new FakeRepository();
  return {
    repository,
    dependencies: {
      repository,
      stageChunks: async (input) => {
        const planned: AgentBackupPlannedChunk = { index: 0, objectKey };
        await input.onObjectPlanned?.(planned);
        repository.events.push("put");
        if (params?.stageFails) throw new Error("injected stage failure");
        for await (const _chunk of input.source) {
          repository.events.push("source");
        }
        return completeDescriptor();
      },
      readChunks: async function* (_params: {
        identity: AgentBackupChunkIdentity;
        descriptor: AgentBackupChunkDescriptor;
      }) {
        repository.events.push("read-after-write");
        yield* bytes();
      },
      deleteObject: async (key) => {
        repository.events.push(`delete-object:${key}`);
        if (params?.deleteFails) throw new Error("injected delete failure");
      },
    },
  };
}

describe("AgentBackupV2StorageService", () => {
  test("records planned keys before PUT and exposes only read-after-write verified backups", async () => {
    const fixture = dependencies();
    const service = new AgentBackupV2StorageService(fixture.dependencies);
    const result = await service.create({
      identity: { organizationId, sandboxRecordId, backupId, backupSchemaVersion: 2 },
      snapshotType: "pre-upgrade",
      source: bytes(),
      createdAt,
      verify: async (source) => {
        for await (const _chunk of source) {
          fixture.repository.events.push("verify");
        }
        return { contentHash };
      },
    });

    expect(result.storage_commit_state).toBe("complete");
    expect(fixture.repository.events).toEqual([
      "row:pre-upgrade",
      "plan:1",
      "put",
      "source",
      "read-after-write",
      "verify",
      `commit:${contentHash}`,
    ]);
  });

  test("marks a failed stage before idempotently deleting planned residue", async () => {
    const fixture = dependencies({ stageFails: true });
    const service = new AgentBackupV2StorageService(fixture.dependencies);
    await expect(
      service.create({
        identity: { organizationId, sandboxRecordId, backupId, backupSchemaVersion: 2 },
        snapshotType: "pre-upgrade",
        source: bytes(),
        createdAt,
        verify: async () => ({ contentHash }),
      }),
    ).rejects.toThrow("injected stage failure");

    expect(fixture.repository.events).toEqual([
      "row:pre-upgrade",
      "plan:1",
      "put",
      "fail",
      `delete-object:${objectKey}`,
      "delete-row",
    ]);
  });

  test("retains a failed row when object cleanup cannot complete", async () => {
    const fixture = dependencies({ stageFails: true, deleteFails: true });
    const service = new AgentBackupV2StorageService(fixture.dependencies);
    await expect(
      service.create({
        identity: { organizationId, sandboxRecordId, backupId, backupSchemaVersion: 2 },
        snapshotType: "pre-upgrade",
        source: bytes(),
        createdAt,
        verify: async () => ({ contentHash }),
      }),
    ).rejects.toThrow("durable cleanup remains pending");
    expect(fixture.repository.deleted).toBe(false);
  });

  test("reconciles interrupted rows and refuses arbitrary stored object keys", async () => {
    const repository = new FakeRepository();
    repository.incomplete = [
      row({
        descriptor: stagingDescriptor({ plannedObjectKeys: [objectKey] }),
        state: "failed",
      }),
      {
        ...row({
          descriptor: stagingDescriptor({
            backupId: "00000000-0000-4000-8000-000000000005",
            plannedObjectKeys: ["unrelated/tenant/object.bin"],
          }),
          state: "failed",
        }),
        id: "00000000-0000-4000-8000-000000000005",
      },
    ];
    const fixture = dependencies({ repository });
    const service = new AgentBackupV2StorageService(fixture.dependencies);
    const result = await service.reconcileIncomplete({
      before: new Date("2026-07-27T00:00:00.000Z"),
    });

    expect(result).toEqual({ deleted: 1, retained: 1 });
    expect(repository.events).toContain(`delete-object:${objectKey}`);
    expect(repository.events).not.toContain("delete-object:unrelated/tenant/object.bin");
  });

  test("hides pruned chunked rows before removing their objects", async () => {
    const repository = new FakeRepository();
    repository.prunable = [
      row({
        descriptor: completeDescriptor(),
        state: "cleanup-pending",
      }),
    ];
    const fixture = dependencies({ repository });
    const service = new AgentBackupV2StorageService(fixture.dependencies);

    await expect(service.prune({ sandboxRecordId, keep: 1 })).resolves.toEqual({
      legacyDeleted: 1,
      chunkedDeleted: 1,
      chunkedPending: 0,
    });
    expect(repository.events).toEqual([
      "prune-legacy",
      "claim-prunable",
      `delete-object:${objectKey}`,
      "delete-row",
    ]);
  });

  test("keeps failed prune cleanup durable for reconciliation", async () => {
    const repository = new FakeRepository();
    const cleanupRow = row({
      descriptor: completeDescriptor(),
      state: "cleanup-pending",
    });
    repository.prunable = [cleanupRow];
    const fixture = dependencies({ repository, deleteFails: true });
    const service = new AgentBackupV2StorageService(fixture.dependencies);

    await expect(service.prune({ sandboxRecordId, keep: 1 })).resolves.toEqual({
      legacyDeleted: 1,
      chunkedDeleted: 0,
      chunkedPending: 1,
    });
    expect(repository.deleted).toBe(false);

    repository.incomplete = [cleanupRow];
    fixture.dependencies.deleteObject = async () => {};
    await expect(
      service.reconcileIncomplete({ before: new Date("2026-07-27T00:00:00.000Z") }),
    ).resolves.toEqual({ deleted: 1, retained: 0 });
  });
});
