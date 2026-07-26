/**
 * Drives the schema-v2 backup visibility and cleanup transitions through the
 * real Drizzle repository on isolated PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import {
  type AgentBackupChunkCompleteDescriptor,
  type AgentBackupChunkStagingDescriptor,
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

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
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
    createdAt: "2026-07-26T12:00:00.000Z",
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
    objectSetId: "00000000-0000-4000-8000-000000000010",
    createdAt: descriptor.createdAt,
    chunkBytes: 4 * 1024 * 1024,
    totalPlaintextBytes: 4,
    totalPlaintextSha256: "a".repeat(64),
    chunks: [
      {
        index: 0,
        objectKey:
          `agent-sandbox-backups/${descriptor.organizationId}/2026-07-26/` +
          `${descriptor.backupId}.00000000-0000-4000-8000-000000000010/` +
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
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
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
      new Date("2026-07-27T00:00:00.000Z"),
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
});
