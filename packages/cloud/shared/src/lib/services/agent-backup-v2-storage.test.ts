/**
 * Exercises the durable schema-v2 commit protocol with injected storage and
 * repository boundaries, including crash residue and adversarial object keys.
 */
import { describe, expect, test } from "bun:test";
import type {
  AgentSandboxBackupCleanupReconcileCandidate,
  AgentSandboxBackupReconcileCandidate,
} from "../../db/repositories/agent-sandboxes";
import type {
  AgentBackupChunkCompleteDescriptor,
  AgentBackupChunkStagingDescriptor,
  AgentBackupSnapshotType,
  StoredAgentSandboxBackup,
} from "../../db/schemas/agent-sandboxes";
import { ObjectWriteOutcomeUnknownError } from "../storage/object-store";
import type {
  AgentBackupChunkDescriptor,
  AgentBackupChunkIdentity,
  AgentBackupPlannedChunk,
} from "./agent-backup-chunks";
import { AgentBackupWriteEpochUnquiescedError } from "./agent-backup-chunks";
import {
  AGENT_BACKUP_WRITE_LEASE_MAX_MS,
  type AgentBackupV2StorageDependencies,
  AgentBackupV2StorageService,
} from "./agent-backup-v2-storage";

const organizationId = "00000000-0000-4000-8000-000000000001";
const sandboxRecordId = "00000000-0000-4000-8000-000000000002";
const backupId = "00000000-0000-4000-8000-000000000003";
const objectSetId = "00000000-0000-4000-8000-000000000004";
const createdAt = new Date("2026-07-26T12:00:00.000Z");
const writeLeaseExpiresAt = new Date(Date.now() + 60 * 60 * 1_000);
const contentHash = "a".repeat(64);

function objectKeyFor(writeEpoch: string, index = 0): string {
  return (
    `agent-sandbox-backups/${organizationId}/2026-07-26/` +
    `${backupId}.${writeEpoch}/chunk-${String(index).padStart(6, "0")}.bin`
  );
}
const objectKey = objectKeyFor(objectSetId);

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
    objectSetId,
    createdAt: createdAt.toISOString(),
    writeLeaseExpiresAt: writeLeaseExpiresAt.toISOString(),
    writeQuiescedAt: null,
    plannedObjectKeys: [],
    failure: null,
    ...overrides,
  };
}

function completeDescriptor(writeEpoch = objectSetId): AgentBackupChunkDescriptor {
  return {
    format: "elizaos.agent-backup-chunks",
    descriptorVersion: 1,
    backupSchemaVersion: 2,
    commitState: "complete",
    organizationId,
    sandboxRecordId,
    backupId,
    objectSetId: writeEpoch,
    createdAt: createdAt.toISOString(),
    chunkBytes: 4,
    totalPlaintextBytes: 4,
    totalPlaintextSha256: "b".repeat(64),
    chunks: [
      {
        index: 0,
        objectKey: objectKeyFor(writeEpoch),
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
}): AgentSandboxBackupReconcileCandidate {
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
    reconcileVersion: "2026-07-26T12:00:00.000000Z",
  };
}

class FakeRepository {
  events: string[] = [];
  incomplete: AgentSandboxBackupReconcileCandidate[] = [];
  cleanupIntents: AgentSandboxBackupCleanupReconcileCandidate[] = [];
  prunable: StoredAgentSandboxBackup[] = [];
  deleted = false;
  committedRow: StoredAgentSandboxBackup | undefined;
  commitThrowsAfterWrite = false;
  rescheduledBackups = 0;
  rescheduledIntents = 0;
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
    writeEpoch: string,
    descriptor: AgentBackupChunkStagingDescriptor,
  ): Promise<void> {
    expect(descriptor.objectSetId).toBe(writeEpoch);
    this.events.push(`plan:${descriptor.plannedObjectKeys.length}`);
    this.latestDescriptor = descriptor;
  }

  async commitChunkedBackup(params: {
    backupId: string;
    writeEpoch: string;
    contentHash: string;
    descriptor: AgentBackupChunkCompleteDescriptor;
    verifiedAt: Date;
  }): Promise<StoredAgentSandboxBackup> {
    expect(params.descriptor.objectSetId).toBe(params.writeEpoch);
    this.events.push(`commit:${params.contentHash}`);
    this.committedRow = row({ descriptor: params.descriptor, state: "complete" });
    if (this.commitThrowsAfterWrite) {
      throw new Error("injected lost commit response");
    }
    return this.committedRow;
  }

  async getChunkedBackupById(_backupId: string): Promise<StoredAgentSandboxBackup | undefined> {
    this.events.push("read-commit-state");
    return this.committedRow;
  }

  async assertChunkedBackupTenant(_params: {
    backupId: string;
    organizationId: string;
    sandboxRecordId: string;
  }): Promise<void> {
    this.events.push("assert-tenant");
  }

  async failChunkedBackup(
    _backupId: string,
    writeEpoch: string,
    descriptor: AgentBackupChunkStagingDescriptor,
    _error: string,
  ): Promise<StoredAgentSandboxBackup | undefined> {
    expect(descriptor.objectSetId).toBe(writeEpoch);
    this.events.push("fail");
    if (this.committedRow) return undefined;
    this.latestDescriptor = descriptor;
    return row({ descriptor, state: "failed" });
  }

  async quiesceExpiredEmptyChunkedBackup(
    _backupId: string,
    writeEpoch: string,
    error: string,
  ): Promise<StoredAgentSandboxBackup | undefined> {
    this.events.push("quiesce-empty");
    if (
      this.latestDescriptor.objectSetId !== writeEpoch ||
      this.latestDescriptor.plannedObjectKeys.length !== 0
    ) {
      return undefined;
    }
    this.latestDescriptor = {
      ...this.latestDescriptor,
      commitState: "failed",
      failure: error,
      writeQuiescedAt: new Date().toISOString(),
    };
    return row({ descriptor: this.latestDescriptor, state: "failed" });
  }

  async listIncompleteChunkedBackupsBefore(
    _before: Date,
    _limit: number,
  ): Promise<AgentSandboxBackupReconcileCandidate[]> {
    return this.incomplete;
  }

  async listBackupObjectCleanupIntentsBefore(
    _before: Date,
    _limit: number,
  ): Promise<AgentSandboxBackupCleanupReconcileCandidate[]> {
    return this.cleanupIntents;
  }

  async rescheduleIncompleteChunkedBackup(
    _backupId: string,
    _expectedVersion: string,
  ): Promise<boolean> {
    this.rescheduledBackups += 1;
    return true;
  }

  async rescheduleBackupObjectCleanupIntent(
    _backupId: string,
    _expectedVersion: string,
  ): Promise<boolean> {
    this.rescheduledIntents += 1;
    return true;
  }

  async deleteBackupObjectCleanupIntent(_backupId: string): Promise<boolean> {
    this.events.push("delete-cleanup-intent");
    return true;
  }

  async claimPrunableChunkedBackups(
    _sandboxRecordId: string,
    _organizationId: string,
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
  stageOutcomeUnknown?: boolean;
  repository?: FakeRepository;
  deleteObjectsExact?: (keys: readonly string[], signal?: AbortSignal) => Promise<void>;
}): { dependencies: AgentBackupV2StorageDependencies; repository: FakeRepository } {
  const repository = params?.repository ?? new FakeRepository();
  return {
    repository,
    dependencies: {
      repository,
      stageChunks: async (input) => {
        const planned: AgentBackupPlannedChunk = {
          index: 0,
          objectKey: objectKeyFor(input.objectSetId),
        };
        await input.onObjectPlanned?.(planned);
        repository.events.push("put");
        if (params?.stageOutcomeUnknown) {
          const cause = new ObjectWriteOutcomeUnknownError(
            planned.objectKey,
            new Error("injected ambiguous object write"),
          );
          throw new AgentBackupWriteEpochUnquiescedError({
            objectSetId: input.objectSetId,
            objectKey: planned.objectKey,
            cleanupFailures: [],
            cause,
          });
        }
        if (params?.stageFails) throw new Error("injected stage failure");
        for await (const _chunk of input.source) {
          repository.events.push("source");
        }
        return completeDescriptor(input.objectSetId);
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
      ...(params?.deleteObjectsExact ? { deleteObjectsExact: params.deleteObjectsExact } : {}),
    },
  };
}

describe("AgentBackupV2StorageService", () => {
  test("rejects a lease horizon that could hide a stranded write epoch indefinitely", async () => {
    const fixture = dependencies();
    const service = new AgentBackupV2StorageService(fixture.dependencies);

    await expect(
      service.create({
        identity: { organizationId, sandboxRecordId, backupId, backupSchemaVersion: 2 },
        snapshotType: "pre-upgrade",
        source: bytes(),
        signal: new AbortController().signal,
        writeLeaseExpiresAt: new Date(Date.now() + AGENT_BACKUP_WRITE_LEASE_MAX_MS + 60_000),
        verify: async () => ({ contentHash }),
      }),
    ).rejects.toThrow("must expire within");
    expect(fixture.repository.events).toEqual([]);
  });

  test("records planned keys before PUT and exposes only read-after-write verified backups", async () => {
    const fixture = dependencies();
    const service = new AgentBackupV2StorageService(fixture.dependencies);
    const result = await service.create({
      identity: { organizationId, sandboxRecordId, backupId, backupSchemaVersion: 2 },
      snapshotType: "pre-upgrade",
      source: bytes(),
      signal: new AbortController().signal,
      writeLeaseExpiresAt,
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
        signal: new AbortController().signal,
        writeLeaseExpiresAt,
        createdAt,
        verify: async () => ({ contentHash }),
      }),
    ).rejects.toThrow("injected stage failure");

    const plannedKey = fixture.repository.latestDescriptor.plannedObjectKeys[0];
    if (!plannedKey) throw new Error("expected one planned object key");
    expect(fixture.repository.events).toEqual([
      "row:pre-upgrade",
      "plan:1",
      "put",
      "fail",
      "assert-tenant",
      `delete-object:${plannedKey}`,
      "delete-row",
    ]);
  });

  test("resolves a committed row after the database response is lost without deleting objects", async () => {
    const repository = new FakeRepository();
    repository.commitThrowsAfterWrite = true;
    const fixture = dependencies({ repository });
    const service = new AgentBackupV2StorageService(fixture.dependencies);

    const result = await service.create({
      identity: { organizationId, sandboxRecordId, backupId, backupSchemaVersion: 2 },
      snapshotType: "pre-upgrade",
      source: bytes(),
      signal: new AbortController().signal,
      writeLeaseExpiresAt,
      createdAt,
      verify: async (source) => {
        for await (const _chunk of source) {
          repository.events.push("verify");
        }
        return { contentHash };
      },
    });

    expect(result.storage_commit_state).toBe("complete");
    expect(repository.events).toContain("read-commit-state");
    expect(repository.events.some((event) => event.startsWith("delete-object:"))).toBe(false);
    expect(repository.events).not.toContain("delete-row");
  });

  test("retains a failed row when object cleanup cannot complete", async () => {
    const fixture = dependencies({ stageFails: true, deleteFails: true });
    const service = new AgentBackupV2StorageService(fixture.dependencies);
    await expect(
      service.create({
        identity: { organizationId, sandboxRecordId, backupId, backupSchemaVersion: 2 },
        snapshotType: "pre-upgrade",
        source: bytes(),
        signal: new AbortController().signal,
        writeLeaseExpiresAt,
        createdAt,
        verify: async () => ({ contentHash }),
      }),
    ).rejects.toThrow("durable cleanup remains pending");
    expect(fixture.repository.deleted).toBe(false);
  });

  test("stops inline cleanup at the capture deadline and leaves the quiesced row durable", async () => {
    const controller = new AbortController();
    const fixture = dependencies();
    fixture.dependencies.stageChunks = async (input) => {
      await input.onObjectPlanned?.({
        index: 0,
        objectKey: objectKeyFor(input.objectSetId),
      });
      controller.abort(new Error("capture watchdog fired"));
      throw new Error("capture watchdog fired");
    };
    const service = new AgentBackupV2StorageService(fixture.dependencies);

    await expect(
      service.create({
        identity: { organizationId, sandboxRecordId, backupId, backupSchemaVersion: 2 },
        snapshotType: "pre-upgrade",
        source: bytes(),
        signal: controller.signal,
        writeLeaseExpiresAt,
        createdAt,
        verify: async () => ({ contentHash }),
      }),
    ).rejects.toThrow("durable cleanup remains pending");

    expect(fixture.repository.latestDescriptor.writeQuiescedAt).not.toBeNull();
    expect(fixture.repository.events).toContain("fail");
    expect(fixture.repository.events.some((event) => event.startsWith("delete-object:"))).toBe(
      false,
    );
    expect(fixture.repository.events).not.toContain("delete-row");
  });

  test("retains an unknown remote write epoch for repeated exact-key reconciliation", async () => {
    const fixture = dependencies({ stageOutcomeUnknown: true });
    const service = new AgentBackupV2StorageService(fixture.dependencies);
    await expect(
      service.create({
        identity: { organizationId, sandboxRecordId, backupId, backupSchemaVersion: 2 },
        snapshotType: "pre-upgrade",
        source: bytes(),
        signal: new AbortController().signal,
        writeLeaseExpiresAt,
        createdAt,
        verify: async () => ({ contentHash }),
      }),
    ).rejects.toThrow("durable epoch");

    expect(fixture.repository.events).not.toContain("fail");
    expect(fixture.repository.events).not.toContain("delete-row");
    expect(fixture.repository.latestDescriptor.writeQuiescedAt).toBeNull();
    const plannedKey = fixture.repository.latestDescriptor.plannedObjectKeys[0];
    if (!plannedKey) throw new Error("expected the ambiguous write key to remain planned");
    fixture.repository.incomplete = [
      row({ descriptor: fixture.repository.latestDescriptor, state: "staging" }),
    ];

    await expect(
      service.reconcileIncomplete({ before: new Date("2100-01-01T00:00:00.000Z") }),
    ).resolves.toEqual({ deleted: 0, retained: 1 });
    await expect(
      service.reconcileIncomplete({ before: new Date("2100-01-01T00:00:00.000Z") }),
    ).resolves.toEqual({ deleted: 0, retained: 1 });
    expect(
      fixture.repository.events.filter((event) => event === `delete-object:${plannedKey}`),
    ).toHaveLength(2);
    expect(fixture.repository.events).not.toContain("delete-row");
  });

  test("bounds a maximum-size reconciliation to six exact bulk deletes", async () => {
    const repository = new FakeRepository();
    const plannedObjectKeys = Array.from({ length: 5_632 }, (_, index) =>
      objectKeyFor(objectSetId, index),
    );
    const unknown = stagingDescriptor({
      commitState: "failed",
      failure: "remote PUT outcome unknown",
      plannedObjectKeys,
      writeQuiescedAt: null,
    });
    repository.incomplete = [row({ descriptor: unknown, state: "failed" })];
    const pages: string[][] = [];
    const fixture = dependencies({
      repository,
      deleteObjectsExact: async (keys) => {
        pages.push([...keys]);
      },
    });
    const service = new AgentBackupV2StorageService(fixture.dependencies);

    await expect(
      service.reconcileIncomplete({ before: new Date("2100-01-01T00:00:00.000Z"), limit: 1 }),
    ).resolves.toEqual({ deleted: 0, retained: 1 });
    expect(pages.map((page) => page.length)).toEqual([1_000, 1_000, 1_000, 1_000, 1_000, 632]);
    expect(repository.rescheduledBackups).toBe(1);
    expect(repository.deleted).toBe(false);

    repository.incomplete = [
      row({
        descriptor: {
          ...unknown,
          writeQuiescedAt: "2026-07-26T12:05:00.000Z",
        },
        state: "failed",
      }),
    ];
    await expect(
      service.reconcileIncomplete({ before: new Date("2100-01-01T00:00:00.000Z"), limit: 1 }),
    ).resolves.toEqual({ deleted: 1, retained: 0 });
    expect(pages).toHaveLength(12);
    expect(repository.deleted).toBe(true);
  });

  test("quiesces an expired write lease when no object was ever planned", async () => {
    const repository = new FakeRepository();
    repository.incomplete = [
      row({
        descriptor: stagingDescriptor({
          objectSetId,
          writeLeaseExpiresAt: "2020-01-01T00:00:00.000Z",
        }),
        state: "staging",
      }),
    ];
    const service = new AgentBackupV2StorageService(dependencies({ repository }).dependencies);

    await expect(
      service.reconcileIncomplete({ before: new Date("2100-01-01T00:00:00.000Z") }),
    ).resolves.toEqual({ deleted: 1, retained: 0 });
    expect(repository.events).toContain("quiesce-empty");
    expect(repository.events).toContain("delete-row");
    expect(repository.latestDescriptor.writeQuiescedAt).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
  });

  test("reconciles interrupted rows and refuses arbitrary stored object keys", async () => {
    const repository = new FakeRepository();
    repository.incomplete = [
      row({
        descriptor: stagingDescriptor({
          commitState: "failed",
          plannedObjectKeys: [objectKey],
          failure: "injected determinate failure",
          writeQuiescedAt: "2026-07-26T12:05:00.000Z",
        }),
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

  test("reconciles object cleanup intents after the sandbox backup rows are gone", async () => {
    const repository = new FakeRepository();
    repository.cleanupIntents = [
      {
        backup_id: backupId,
        organization_id: organizationId,
        sandbox_record_id: sandboxRecordId,
        descriptor: completeDescriptor(),
        storage_commit_state: "complete",
        created_at: createdAt,
        updated_at: createdAt,
        reconcileVersion: "2026-07-26T12:00:00.000000Z",
      },
    ];
    const fixture = dependencies({ repository });
    const service = new AgentBackupV2StorageService(fixture.dependencies);

    await expect(
      service.reconcileIncomplete({ before: new Date("2026-07-27T00:00:00.000Z") }),
    ).resolves.toEqual({ deleted: 1, retained: 0 });
    expect(repository.events).toEqual([`delete-object:${objectKey}`, "delete-cleanup-intent"]);
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

    await expect(service.prune({ organizationId, sandboxRecordId, keep: 1 })).resolves.toEqual({
      legacyDeleted: 1,
      chunkedDeleted: 1,
      chunkedPending: 0,
    });
    expect(repository.events).toEqual([
      "claim-prunable",
      "prune-legacy",
      "assert-tenant",
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

    await expect(service.prune({ organizationId, sandboxRecordId, keep: 1 })).resolves.toEqual({
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
