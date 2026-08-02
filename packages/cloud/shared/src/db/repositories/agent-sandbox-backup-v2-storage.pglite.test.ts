/**
 * Drives the schema-v2 backup visibility and cleanup transitions through the
 * real Drizzle repository on isolated PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import {
  readEncryptedAgentBackupChunks,
  stageEncryptedAgentBackupChunks,
} from "../../lib/services/agent-backup-chunks";
import { AgentBackupV2StorageService } from "../../lib/services/agent-backup-v2-storage";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { ensureAgentSandboxBackupCleanupIntentSchema } from "../ensure-agent-sandbox-schema";
import {
  type AgentBackupChunkCompleteDescriptor,
  type AgentBackupChunkStagingDescriptor,
  agentSandboxBackupCleanupIntents,
  agentSandboxBackups,
  agentSandboxes,
} from "../schemas/agent-sandboxes";
import { organizations } from "../schemas/organizations";
import { userCharacters } from "../schemas/user-characters";
import { users } from "../schemas/users";
import { AgentSandboxesRepository } from "./agent-sandboxes";

const PGLITE_TIMEOUT = 60_000;
const repository = new AgentSandboxesRepository();
let pgliteReady = true;
let sequence = 0;
const OBJECT_SET_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_OBJECT_SET_ID = "00000000-0000-4000-8000-000000000020";
const WRITE_LEASE_EXPIRES_AT = "2099-07-26T12:00:00.000Z";
const WRITE_EPOCH_MIGRATION_URL = new URL(
  "../migrations/0192_agent_backup_write_epochs.sql",
  import.meta.url,
);

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

async function applyWriteEpochMigration(): Promise<void> {
  const migration = readFileSync(fileURLToPath(WRITE_EPOCH_MIGRATION_URL), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) await dbWrite.execute(trimmed);
  }
}

async function seedSandbox(): Promise<{ organizationId: string; sandboxRecordId: string }> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Chunked Backup Org", slug: unique("chunked-backup") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: unique("steward"),
      organization_id: organization.id,
    })
    .returning();
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organization.id,
      user_id: user.id,
      agent_name: unique("agent"),
      status: "running",
    })
    .returning();
  return { organizationId: organization.id, sandboxRecordId: sandbox.id };
}

async function seedOrganization(): Promise<string> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Other Chunked Backup Org", slug: unique("other-chunked-backup") })
    .returning();
  return organization.id;
}

function stagingDescriptor(params: {
  organizationId: string;
  sandboxRecordId: string;
  backupId: string;
}): AgentBackupChunkStagingDescriptor {
  return {
    format: "elizaos.agent-backup-chunks",
    descriptorVersion: 1,
    backupSchemaVersion: 2,
    commitState: "staging",
    organizationId: params.organizationId,
    sandboxRecordId: params.sandboxRecordId,
    backupId: params.backupId,
    objectSetId: OBJECT_SET_ID,
    createdAt: "2026-07-26T12:00:00.000Z",
    writeLeaseExpiresAt: WRITE_LEASE_EXPIRES_AT,
    writeQuiescedAt: null,
    plannedObjectKeys: [],
    failure: null,
  };
}

function completeDescriptor(
  descriptor: AgentBackupChunkStagingDescriptor,
): AgentBackupChunkCompleteDescriptor {
  return {
    format: descriptor.format,
    descriptorVersion: descriptor.descriptorVersion,
    backupSchemaVersion: descriptor.backupSchemaVersion,
    commitState: "complete",
    organizationId: descriptor.organizationId,
    sandboxRecordId: descriptor.sandboxRecordId,
    backupId: descriptor.backupId,
    objectSetId: descriptor.objectSetId,
    createdAt: descriptor.createdAt,
    chunkBytes: 4 * 1024 * 1024,
    totalPlaintextBytes: 4,
    totalPlaintextSha256: "a".repeat(64),
    chunks: [
      {
        index: 0,
        objectKey:
          `agent-sandbox-backups/${descriptor.organizationId}/2026-07-26/` +
          `${descriptor.backupId}.${descriptor.objectSetId}/` +
          "chunk-000000.bin",
        plaintextBytes: 4,
        ciphertextBytes: 4,
        plaintextSha256: "b".repeat(64),
        ciphertextSha256: "c".repeat(64),
        nonceBase64: "AAAAAAAAAAAAAAAA",
        authTagBase64: "AAAAAAAAAAAAAAAAAAAAAA==",
        kmsKeyId: `org:${descriptor.organizationId}:dek`,
        kmsKeyVersion: 1,
      },
    ],
  };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const schema = {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      agentSandboxBackups,
      agentSandboxBackupCleanupIntents,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    await ensureAgentSandboxBackupCleanupIntentSchema();
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(agentSandboxBackupCleanupIntents);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("schema-v2 backup repository transitions", () => {
  test("staging is hidden, verified commit is visible, and cleanup claim is atomic", async () => {
    const { organizationId, sandboxRecordId } = await seedSandbox();
    const backupId = "00000000-0000-4000-8000-000000000011";
    const staging = stagingDescriptor({ organizationId, sandboxRecordId, backupId });

    await repository.createChunkedBackupStaging({
      descriptor: staging,
      snapshotType: "pre-upgrade",
    });
    expect(await repository.getStoredBackupById(backupId)).toBeUndefined();

    const [rawStaging] = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, backupId));
    expect(rawStaging?.storage_commit_state).toBe("staging");

    await repository.commitChunkedBackup({
      backupId,
      writeEpoch: staging.objectSetId,
      contentHash: "d".repeat(64),
      descriptor: completeDescriptor(staging),
      verifiedAt: new Date("2026-07-26T12:01:00.000Z"),
    });
    expect((await repository.getStoredBackupById(backupId))?.storage_commit_state).toBe("complete");

    const [firstClaim, secondClaim] = await Promise.all([
      repository.claimPrunableChunkedBackups(sandboxRecordId, organizationId, 0),
      repository.claimPrunableChunkedBackups(sandboxRecordId, organizationId, 0),
    ]);
    expect(firstClaim.length + secondClaim.length).toBe(1);
    expect(await repository.getStoredBackupById(backupId)).toBeUndefined();

    const incomplete = await repository.listIncompleteChunkedBackupsBefore(
      new Date("2100-01-01T00:00:00.000Z"),
      10,
    );
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.storage_commit_state).toBe("cleanup-pending");
    expect(await repository.deleteIncompleteChunkedBackup(backupId)).toBe(true);
    expect(
      await dbWrite.select().from(agentSandboxBackups).where(eq(agentSandboxBackups.id, backupId)),
    ).toHaveLength(0);
  });

  test("denies cross-tenant staging, lookup binding, and prune claims", async () => {
    const { organizationId, sandboxRecordId } = await seedSandbox();
    const otherOrganizationId = await seedOrganization();
    const backupId = "00000000-0000-4000-8000-000000000012";

    await expect(
      repository.createChunkedBackupStaging({
        descriptor: stagingDescriptor({
          organizationId: otherOrganizationId,
          sandboxRecordId,
          backupId,
        }),
        snapshotType: "pre-upgrade",
      }),
    ).rejects.toThrow("does not belong");

    const staging = stagingDescriptor({ organizationId, sandboxRecordId, backupId });
    await repository.createChunkedBackupStaging({
      descriptor: staging,
      snapshotType: "pre-upgrade",
    });
    await expect(
      repository.assertChunkedBackupTenant({
        backupId,
        organizationId: otherOrganizationId,
        sandboxRecordId,
      }),
    ).rejects.toThrow("not bound");
    await expect(
      repository.claimPrunableChunkedBackups(sandboxRecordId, otherOrganizationId, 0),
    ).rejects.toThrow("does not belong");
  });

  test("fences wrong, expired, and superseded write epochs at the database boundary", async () => {
    const { organizationId, sandboxRecordId } = await seedSandbox();
    const backupId = "00000000-0000-4000-8000-000000000014";
    const staging = stagingDescriptor({ organizationId, sandboxRecordId, backupId });
    await repository.createChunkedBackupStaging({
      descriptor: staging,
      snapshotType: "pre-upgrade",
    });

    const wrongEpochStaging = {
      ...staging,
      objectSetId: OTHER_OBJECT_SET_ID,
    };
    await expect(
      repository.updateChunkedBackupStaging(backupId, OTHER_OBJECT_SET_ID, wrongEpochStaging),
    ).rejects.toThrow("no longer writable");
    await expect(
      repository.commitChunkedBackup({
        backupId,
        writeEpoch: OTHER_OBJECT_SET_ID,
        contentHash: "d".repeat(64),
        descriptor: completeDescriptor(wrongEpochStaging),
        verifiedAt: new Date(),
      }),
    ).rejects.toThrow("was not committed");

    const superseding = { ...staging, objectSetId: OTHER_OBJECT_SET_ID };
    await dbWrite
      .update(agentSandboxBackups)
      .set({ state_data_descriptor: superseding })
      .where(eq(agentSandboxBackups.id, backupId));
    const oldEpochFailure: AgentBackupChunkStagingDescriptor = {
      ...staging,
      commitState: "failed",
      failure: "old writer failed",
      writeQuiescedAt: new Date().toISOString(),
    };
    await expect(
      repository.failChunkedBackup(
        backupId,
        staging.objectSetId,
        oldEpochFailure,
        "old writer failed",
      ),
    ).resolves.toBeUndefined();
    expect((await repository.getChunkedBackupById(backupId))?.state_data_descriptor).toMatchObject({
      objectSetId: OTHER_OBJECT_SET_ID,
      commitState: "staging",
    });

    const expiredBackupId = "00000000-0000-4000-8000-000000000015";
    const expired = {
      ...stagingDescriptor({
        organizationId,
        sandboxRecordId,
        backupId: expiredBackupId,
      }),
      writeLeaseExpiresAt: "2020-01-01T00:00:00.000Z",
    };
    await repository.createChunkedBackupStaging({
      descriptor: expired,
      snapshotType: "pre-upgrade",
    });
    await expect(
      repository.updateChunkedBackupStaging(expiredBackupId, expired.objectSetId, expired),
    ).rejects.toThrow("no longer writable");
    await expect(
      repository.commitChunkedBackup({
        backupId: expiredBackupId,
        writeEpoch: expired.objectSetId,
        contentHash: "d".repeat(64),
        descriptor: completeDescriptor(expired),
        verifiedAt: new Date(),
      }),
    ).rejects.toThrow("was not committed");
    expect(
      (
        await repository.listIncompleteChunkedBackupsBefore(
          new Date("2100-01-01T00:00:00.000Z"),
          10,
        )
      ).map((row) => row.id),
    ).toEqual([expiredBackupId]);
  });

  test("blocks sandbox deletion until the exact backup write epoch is quiesced", async () => {
    const { organizationId, sandboxRecordId } = await seedSandbox();
    const backupId = "00000000-0000-4000-8000-000000000016";
    const staging = stagingDescriptor({ organizationId, sandboxRecordId, backupId });
    await repository.createChunkedBackupStaging({
      descriptor: staging,
      snapshotType: "pre-upgrade",
    });

    expect(await repository.deleteIncompleteChunkedBackup(backupId)).toBe(false);
    const deletionError = await repository.delete(sandboxRecordId, organizationId).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(deletionError).toBeInstanceOf(Error);
    expect((deletionError as Error & { cause?: unknown }).cause).toMatchObject({
      code: "55000",
      message: "Agent sandbox has an unquiesced backup write epoch",
    });
    expect(await repository.findByIdAndOrg(sandboxRecordId, organizationId)).toBeDefined();
    expect(await repository.getChunkedBackupById(backupId)).toBeDefined();
    expect(await dbWrite.select().from(agentSandboxBackupCleanupIntents)).toHaveLength(0);

    const quiesced: AgentBackupChunkStagingDescriptor = {
      ...staging,
      commitState: "failed",
      failure: "injected determinate failure",
      writeQuiescedAt: new Date().toISOString(),
    };
    await expect(
      repository.failChunkedBackup(
        backupId,
        staging.objectSetId,
        quiesced,
        "injected determinate failure",
      ),
    ).resolves.toMatchObject({ storage_commit_state: "failed" });
    expect(await repository.delete(sandboxRecordId, organizationId)).toBe(true);
    expect(
      await dbWrite
        .select()
        .from(agentSandboxBackupCleanupIntents)
        .where(eq(agentSandboxBackupCleanupIntents.backup_id, backupId)),
    ).toHaveLength(1);
  });

  test("rejects JSON-null and absent epoch fields in schema-created tables", async () => {
    const { organizationId, sandboxRecordId } = await seedSandbox();
    const backupId = "00000000-0000-4000-8000-000000000019";
    const staging = stagingDescriptor({ organizationId, sandboxRecordId, backupId });
    await repository.createChunkedBackupStaging({
      descriptor: staging,
      snapshotType: "pre-upgrade",
    });

    const nullEpochFailure = await dbWrite
      .execute(sql`
        UPDATE "agent_sandbox_backups"
        SET "state_data_descriptor" =
          jsonb_set("state_data_descriptor", '{objectSetId}', 'null'::jsonb)
        WHERE "id" = ${backupId}
      `)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((nullEpochFailure as Error & { cause?: unknown }).cause).toMatchObject({
      code: "23514",
    });

    const quiesced: AgentBackupChunkStagingDescriptor = {
      ...staging,
      commitState: "failed",
      failure: "injected determinate failure",
      writeQuiescedAt: new Date().toISOString(),
    };
    await repository.failChunkedBackup(
      backupId,
      staging.objectSetId,
      quiesced,
      "injected determinate failure",
    );
    expect(await repository.delete(sandboxRecordId, organizationId)).toBe(true);

    const absentLeaseFailure = await dbWrite
      .execute(sql`
        UPDATE "agent_sandbox_backup_cleanup_intents"
        SET "descriptor" = "descriptor" - 'writeLeaseExpiresAt'
        WHERE "backup_id" = ${backupId}
      `)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((absentLeaseFailure as Error & { cause?: unknown }).cause).toMatchObject({
      code: "23514",
    });
  });

  test("atomically refuses to quiesce a stale empty descriptor after a writer plans key zero", async () => {
    const { organizationId, sandboxRecordId } = await seedSandbox();
    const backupId = "00000000-0000-4000-8000-000000000017";
    const staging: AgentBackupChunkStagingDescriptor = {
      ...stagingDescriptor({ organizationId, sandboxRecordId, backupId }),
      writeLeaseExpiresAt: "2020-01-01T00:00:00.000Z",
    };
    await repository.createChunkedBackupStaging({
      descriptor: staging,
      snapshotType: "pre-upgrade",
    });
    const planned: AgentBackupChunkStagingDescriptor = {
      ...staging,
      plannedObjectKeys: [
        `agent-sandbox-backups/${organizationId}/2026-07-26/` +
          `${backupId}.${staging.objectSetId}/chunk-000000.bin`,
      ],
    };
    let interleaved = false;
    const racingRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "listIncompleteChunkedBackupsBefore") {
          return async (before: Date, limit: number) => {
            const staleRows = await target.listIncompleteChunkedBackupsBefore(before, limit);
            await dbWrite
              .update(agentSandboxBackups)
              .set({ state_data_descriptor: planned })
              .where(eq(agentSandboxBackups.id, backupId));
            interleaved = true;
            return staleRows;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const deletedObjects: string[] = [];
    const service = new AgentBackupV2StorageService({
      repository: racingRepository,
      stageChunks: stageEncryptedAgentBackupChunks,
      readChunks: readEncryptedAgentBackupChunks,
      deleteObject: async (key) => {
        deletedObjects.push(key);
      },
    });

    const reconciliation = await service.reconcileIncomplete({
      before: new Date("2100-01-01T00:00:00.000Z"),
    });
    expect(reconciliation).toEqual({ deleted: 0, retained: 1 });
    expect(interleaved).toBe(true);
    expect(deletedObjects).toEqual([]);
    expect(await repository.getChunkedBackupById(backupId)).toMatchObject({
      storage_commit_state: "staging",
      state_data_descriptor: {
        objectSetId: staging.objectSetId,
        plannedObjectKeys: planned.plannedObjectKeys,
        writeQuiescedAt: null,
      },
    });
  });

  test("allows a pruned complete descriptor to outlive its sandbox through the cleanup outbox", async () => {
    const { organizationId, sandboxRecordId } = await seedSandbox();
    const backupId = "00000000-0000-4000-8000-000000000018";
    const staging = stagingDescriptor({ organizationId, sandboxRecordId, backupId });
    const complete = completeDescriptor(staging);
    await repository.createChunkedBackupStaging({
      descriptor: staging,
      snapshotType: "pre-upgrade",
    });
    await repository.commitChunkedBackup({
      backupId,
      writeEpoch: staging.objectSetId,
      contentHash: "d".repeat(64),
      descriptor: complete,
      verifiedAt: new Date("2026-07-26T12:01:00.000Z"),
    });
    await expect(
      repository.claimPrunableChunkedBackups(sandboxRecordId, organizationId, 0),
    ).resolves.toHaveLength(1);

    expect(await repository.delete(sandboxRecordId, organizationId)).toBe(true);
    expect(await repository.getChunkedBackupById(backupId)).toBeUndefined();
    expect(
      await dbWrite
        .select()
        .from(agentSandboxBackupCleanupIntents)
        .where(eq(agentSandboxBackupCleanupIntents.backup_id, backupId)),
    ).toEqual([
      expect.objectContaining({
        backup_id: backupId,
        descriptor: complete,
        storage_commit_state: "cleanup-pending",
      }),
    ]);
  });

  test("preserves and reconciles chunk cleanup after sandbox deletion cascades backup rows", async () => {
    const { organizationId, sandboxRecordId } = await seedSandbox();
    const backupId = "00000000-0000-4000-8000-000000000013";
    const staging = stagingDescriptor({ organizationId, sandboxRecordId, backupId });
    const complete = completeDescriptor(staging);
    await repository.createChunkedBackupStaging({
      descriptor: staging,
      snapshotType: "pre-upgrade",
    });
    await repository.commitChunkedBackup({
      backupId,
      writeEpoch: staging.objectSetId,
      contentHash: "d".repeat(64),
      descriptor: complete,
      verifiedAt: new Date("2026-07-26T12:01:00.000Z"),
    });

    expect(await repository.delete(sandboxRecordId, organizationId)).toBe(true);
    expect(
      await dbWrite.select().from(agentSandboxBackups).where(eq(agentSandboxBackups.id, backupId)),
    ).toHaveLength(0);
    expect(
      await dbWrite
        .select()
        .from(agentSandboxBackupCleanupIntents)
        .where(eq(agentSandboxBackupCleanupIntents.backup_id, backupId)),
    ).toHaveLength(1);

    const deletedObjects: string[] = [];
    const service = new AgentBackupV2StorageService({
      repository,
      stageChunks: stageEncryptedAgentBackupChunks,
      readChunks: readEncryptedAgentBackupChunks,
      deleteObject: async (key) => {
        deletedObjects.push(key);
      },
    });
    await expect(
      service.reconcileIncomplete({ before: new Date("2100-01-01T00:00:00.000Z") }),
    ).resolves.toEqual({ deleted: 1, retained: 0 });
    expect(deletedObjects).toEqual([complete.chunks[0]?.objectKey]);
    expect(await dbWrite.select().from(agentSandboxBackupCleanupIntents)).toHaveLength(0);
  });

  test("migrates, quiesces, and removes an empty legacy epoch before sandbox deletion", async () => {
    const { organizationId, sandboxRecordId } = await seedSandbox();
    const backupId = "00000000-0000-4000-8000-000000000021";
    const legacyDescriptor = {
      format: "elizaos.agent-backup-chunks",
      descriptorVersion: 1,
      backupSchemaVersion: 2,
      commitState: "staging",
      organizationId,
      sandboxRecordId,
      backupId,
      createdAt: "2026-07-26T12:00:00.000Z",
      plannedObjectKeys: [],
      failure: null,
    };

    await dbWrite.execute(
      sql`ALTER TABLE "agent_sandbox_backups"
          DROP CONSTRAINT IF EXISTS "agent_sandbox_backups_write_epoch_check"`,
    );
    await dbWrite.execute(sql`
      INSERT INTO "agent_sandbox_backups" (
        "id",
        "sandbox_record_id",
        "snapshot_type",
        "state_data",
        "snapshot_schema_version",
        "state_data_storage",
        "state_data_descriptor",
        "storage_commit_state",
        "storage_commit_updated_at"
      ) VALUES (
        ${backupId}::uuid,
        ${sandboxRecordId}::uuid,
        'pre-upgrade',
        '{}'::jsonb,
        2,
        'chunked-v2',
        ${JSON.stringify(legacyDescriptor)}::jsonb,
        'staging',
        '2026-07-26T12:00:00.000Z'::timestamptz
      )
    `);

    await applyWriteEpochMigration();
    expect(await repository.getChunkedBackupById(backupId)).toMatchObject({
      storage_commit_state: "failed",
      state_data_descriptor: {
        objectSetId: backupId,
        plannedObjectKeys: [],
        writeQuiescedAt: null,
      },
    });

    const blockedDeletion = await repository.delete(sandboxRecordId, organizationId).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((blockedDeletion as Error & { cause?: unknown }).cause).toMatchObject({
      code: "55000",
      message: "Agent sandbox has an unquiesced backup write epoch",
    });

    const deletedObjects: string[] = [];
    const service = new AgentBackupV2StorageService({
      repository,
      stageChunks: stageEncryptedAgentBackupChunks,
      readChunks: readEncryptedAgentBackupChunks,
      deleteObject: async (key) => {
        deletedObjects.push(key);
      },
    });
    await expect(
      service.reconcileIncomplete({ before: new Date("2100-01-01T00:00:00.000Z") }),
    ).resolves.toEqual({ deleted: 1, retained: 0 });
    expect(deletedObjects).toEqual([]);
    expect(await repository.getChunkedBackupById(backupId)).toBeUndefined();
    expect(await repository.delete(sandboxRecordId, organizationId)).toBe(true);
  });

  test("reschedules live rows and cleanup intents with exact microsecond CAS fairness", async () => {
    const { organizationId, sandboxRecordId } = await seedSandbox();
    const firstBackupId = "00000000-0000-4000-8000-000000000022";
    const secondBackupId = "00000000-0000-4000-8000-000000000023";
    const firstStaging: AgentBackupChunkStagingDescriptor = {
      ...stagingDescriptor({
        organizationId,
        sandboxRecordId,
        backupId: firstBackupId,
      }),
      writeLeaseExpiresAt: "2020-01-01T00:00:00.000Z",
    };
    const secondStaging: AgentBackupChunkStagingDescriptor = {
      ...stagingDescriptor({
        organizationId,
        sandboxRecordId,
        backupId: secondBackupId,
      }),
      writeLeaseExpiresAt: "2020-01-01T00:00:00.000Z",
    };
    await repository.createChunkedBackupStaging({
      descriptor: firstStaging,
      snapshotType: "pre-upgrade",
    });
    await repository.createChunkedBackupStaging({
      descriptor: secondStaging,
      snapshotType: "pre-upgrade",
    });
    await dbWrite.execute(sql`
      UPDATE "agent_sandbox_backups"
      SET "storage_commit_updated_at" = CASE "id"
        WHEN ${firstBackupId}::uuid THEN '2026-07-26T12:00:00.123456Z'::timestamptz
        WHEN ${secondBackupId}::uuid THEN '2026-07-26T12:00:00.124456Z'::timestamptz
        ELSE "storage_commit_updated_at"
      END
      WHERE "id" IN (${firstBackupId}::uuid, ${secondBackupId}::uuid)
    `);

    const [firstBackup] = await repository.listIncompleteChunkedBackupsBefore(
      new Date("2100-01-01T00:00:00.000Z"),
      1,
    );
    expect(firstBackup).toMatchObject({
      id: firstBackupId,
      reconcileVersion: "2026-07-26T12:00:00.123456Z",
    });
    if (!firstBackup) throw new Error("expected first backup reconciliation candidate");
    expect(
      await repository.rescheduleIncompleteChunkedBackup(
        firstBackup.id,
        firstBackup.reconcileVersion,
      ),
    ).toBe(true);
    expect(
      await repository.rescheduleIncompleteChunkedBackup(
        firstBackup.id,
        firstBackup.reconcileVersion,
      ),
    ).toBe(false);
    const [secondBackup] = await repository.listIncompleteChunkedBackupsBefore(
      new Date("2100-01-01T00:00:00.000Z"),
      1,
    );
    expect(secondBackup).toMatchObject({ id: secondBackupId });
    if (!secondBackup) throw new Error("expected second backup reconciliation candidate");
    expect(
      await repository.rescheduleIncompleteChunkedBackup(
        secondBackup.id,
        secondBackup.reconcileVersion,
      ),
    ).toBe(true);
    const [reselectedBackup] = await repository.listIncompleteChunkedBackupsBefore(
      new Date("2100-01-01T00:00:00.000Z"),
      1,
    );
    expect(reselectedBackup?.id).toBe(firstBackupId);
    expect(reselectedBackup?.reconcileVersion).toMatch(
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$/,
    );
    expect(reselectedBackup?.reconcileVersion).not.toBe(firstBackup.reconcileVersion);
    if (!reselectedBackup) throw new Error("expected rescheduled backup candidate");
    expect(
      await repository.rescheduleIncompleteChunkedBackup(
        reselectedBackup.id,
        reselectedBackup.reconcileVersion,
      ),
    ).toBe(true);

    await dbWrite.insert(agentSandboxBackupCleanupIntents).values([
      {
        backup_id: firstBackupId,
        organization_id: organizationId,
        sandbox_record_id: sandboxRecordId,
        descriptor: completeDescriptor(firstStaging),
        storage_commit_state: "cleanup-pending",
      },
      {
        backup_id: secondBackupId,
        organization_id: organizationId,
        sandbox_record_id: sandboxRecordId,
        descriptor: completeDescriptor(secondStaging),
        storage_commit_state: "cleanup-pending",
      },
    ]);
    await dbWrite.execute(sql`
      UPDATE "agent_sandbox_backup_cleanup_intents"
      SET "updated_at" = CASE "backup_id"
        WHEN ${firstBackupId}::uuid THEN '2026-07-26T12:00:00.123456Z'::timestamptz
        WHEN ${secondBackupId}::uuid THEN '2026-07-26T12:00:00.124456Z'::timestamptz
        ELSE "updated_at"
      END
      WHERE "backup_id" IN (${firstBackupId}::uuid, ${secondBackupId}::uuid)
    `);

    const [firstIntent] = await repository.listBackupObjectCleanupIntentsBefore(
      new Date("2100-01-01T00:00:00.000Z"),
      1,
    );
    expect(firstIntent).toMatchObject({
      backup_id: firstBackupId,
      reconcileVersion: "2026-07-26T12:00:00.123456Z",
    });
    if (!firstIntent) throw new Error("expected first cleanup-intent reconciliation candidate");
    expect(
      await repository.rescheduleBackupObjectCleanupIntent(
        firstIntent.backup_id,
        firstIntent.reconcileVersion,
      ),
    ).toBe(true);
    expect(
      await repository.rescheduleBackupObjectCleanupIntent(
        firstIntent.backup_id,
        firstIntent.reconcileVersion,
      ),
    ).toBe(false);
    const [secondIntent] = await repository.listBackupObjectCleanupIntentsBefore(
      new Date("2100-01-01T00:00:00.000Z"),
      1,
    );
    expect(secondIntent).toMatchObject({ backup_id: secondBackupId });
    if (!secondIntent) throw new Error("expected second cleanup-intent candidate");
    expect(
      await repository.rescheduleBackupObjectCleanupIntent(
        secondIntent.backup_id,
        secondIntent.reconcileVersion,
      ),
    ).toBe(true);
    const [reselectedIntent] = await repository.listBackupObjectCleanupIntentsBefore(
      new Date("2100-01-01T00:00:00.000Z"),
      1,
    );
    expect(reselectedIntent?.backup_id).toBe(firstBackupId);
    expect(reselectedIntent?.reconcileVersion).toMatch(
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$/,
    );
    expect(reselectedIntent?.reconcileVersion).not.toBe(firstIntent.reconcileVersion);
    if (!reselectedIntent) throw new Error("expected rescheduled cleanup-intent candidate");
    expect(
      await repository.rescheduleBackupObjectCleanupIntent(
        reselectedIntent.backup_id,
        reselectedIntent.reconcileVersion,
      ),
    ).toBe(true);
  });
});
