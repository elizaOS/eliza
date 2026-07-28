/**
 * Exercises verified restore-point authorization against the real Drizzle
 * schema on in-process PGlite, including tenant drift, candidate identity
 * drift, backup-state drift, and transaction-local visibility.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import {
  agentSandboxBackups,
  agentSandboxes,
  agentSnapshotRestoreValidations,
} from "../../db/schemas/agent-sandboxes";
import { organizations } from "../../db/schemas/organizations";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";
import { PostgresVerifiedRestorePointReader } from "./verified-restore-point-reader";

const PGLITE_TIMEOUT = 60_000;
const AGGREGATE_SHA256 = "a".repeat(64);
const TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const SOURCE_DIGEST = `sha256:${"c".repeat(64)}`;
const NOW = new Date("2026-07-26T16:00:00.000Z");
const RETIRED_AT = new Date("2026-07-26T16:00:01.000Z");

let pgliteReady = true;
let sequence = 0;

function uniqueSlug(): string {
  sequence += 1;
  return `restore-reader-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

interface Fixture {
  organizationId: string;
  ownerUserId: string;
  sandboxRecordId: string;
  agentId: string;
  backupId: string;
  restoreValidationId: string;
  validationJobId: string;
  sourceJobId: string;
  rolloutId: string;
  standbyGeneration: string;
  targetProviderSandboxId: string;
  targetReplacementAttemptId: string;
  targetImage: string;
}

async function seedBackup(): Promise<Fixture> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Restore Reader", slug: uniqueSlug() })
    .returning();
  const [owner] = await dbWrite
    .insert(users)
    .values({
      organization_id: organization.id,
      steward_user_id: `restore-reader-${randomUUID()}`,
    })
    .returning();
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organization.id,
      user_id: owner.id,
      agent_name: "Restore Reader Agent",
      status: "running",
    })
    .returning();
  const backupId = randomUUID();
  await dbWrite.insert(agentSandboxBackups).values({
    id: backupId,
    sandbox_record_id: sandbox.id,
    snapshot_type: "pre-upgrade",
    state_data: { memories: [], config: {}, workspaceFiles: {} },
    snapshot_schema_version: 2,
    storage_commit_state: "complete",
    size_bytes: 1024,
    backup_kind: "full",
    content_hash: AGGREGATE_SHA256,
    verification_status: "verified",
    verified_at: NOW,
    verification_error: null,
    created_at: NOW,
  });
  return {
    organizationId: organization.id,
    ownerUserId: owner.id,
    sandboxRecordId: sandbox.id,
    agentId: sandbox.id,
    backupId,
    restoreValidationId: randomUUID(),
    validationJobId: randomUUID(),
    sourceJobId: randomUUID(),
    rolloutId: randomUUID(),
    standbyGeneration: randomUUID(),
    targetProviderSandboxId: `candidate-${randomUUID()}`,
    targetReplacementAttemptId: randomUUID(),
    targetImage: `ghcr.io/elizaos/eliza-demo@${TARGET_DIGEST}`,
  };
}

function validationValues(fixture: Fixture) {
  return {
    restore_validation_id: fixture.restoreValidationId,
    validation_job_id: fixture.validationJobId,
    source_job_id: fixture.sourceJobId,
    rollout_id: fixture.rolloutId,
    standby_generation: fixture.standbyGeneration,
    organization_id: fixture.organizationId,
    sandbox_record_id: fixture.sandboxRecordId,
    agent_id: fixture.agentId,
    target_owner_user_id: fixture.ownerUserId,
    backup_id: fixture.backupId,
    aggregate_sha256: AGGREGATE_SHA256,
    capture_nonce: "d".repeat(64),
    source_environment_revision: 7,
    source_image_digest: SOURCE_DIGEST,
    source_sandbox_id: randomUUID(),
    target_image: fixture.targetImage,
    target_digest: TARGET_DIGEST,
    candidate_route_mode: "restore_validation_private_control" as const,
    validation_state: "never_routed_retired" as const,
    target_provider_sandbox_id: fixture.targetProviderSandboxId,
    target_replacement_attempt_id: fixture.targetReplacementAttemptId,
    target_provider_node_id: "node-candidate",
    target_provider_container_name: "agent-candidate",
    target_provider_container_id: `container-${randomUUID()}`,
    target_provider_volume_path: `/var/lib/eliza/restore-validation/${fixture.restoreValidationId}`,
    target_provider_bridge_url: "http://127.0.0.1:18190",
    target_provider_health_url: "http://127.0.0.1:18190/health",
    target_provider_bridge_port: 18190,
    target_provider_web_ui_port: 12138,
    target_provider_vpn_node_id: "vpn-node-candidate",
    target_provider_vpn_node_name: `restore-validation-${fixture.restoreValidationId}`,
    target_provider_vpn_registration_started_at: NOW,
    target_provider_allocation_counted: false,
    receipt_state: "committed" as const,
    receipt_schema_version: 2,
    receipt_transfer: "chunked-v1",
    receipt_file_count: 8,
    receipt_total_bytes: 4096,
    receipt_requires_restart: true,
    receipt_success: true,
    receipt_committed_at: NOW,
    route_exposed_at: null,
    candidate_container_absent_at: RETIRED_AT,
    candidate_vpn_absent_at: RETIRED_AT,
    candidate_volume_absent_at: RETIRED_AT,
    candidate_retired_at: RETIRED_AT,
    created_at: RETIRED_AT,
  };
}

function readerParams(fixture: Fixture) {
  return {
    sourceJobId: fixture.sourceJobId,
    standbyGeneration: fixture.standbyGeneration,
    rolloutId: fixture.rolloutId,
    organizationId: fixture.organizationId,
    sandboxRecordId: fixture.sandboxRecordId,
    agentId: fixture.agentId,
    targetOwnerUserId: fixture.ownerUserId,
    targetImage: fixture.targetImage,
    targetDigest: TARGET_DIGEST,
  };
}

async function insertValidation(fixture: Fixture): Promise<void> {
  await dbWrite.insert(agentSnapshotRestoreValidations).values(validationValues(fixture));
}

async function assertRejected(
  fixture: Fixture,
  overrides: Partial<ReturnType<typeof readerParams>>,
  mismatch: string,
): Promise<void> {
  const reader = new PostgresVerifiedRestorePointReader();
  let thrown: unknown;
  try {
    await dbWrite.transaction((tx) =>
      reader.readVerifiedV2CandidateRestoreInTx(tx, {
        ...readerParams(fixture),
        ...overrides,
      }),
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ElizaError);
  expect(thrown).toMatchObject({
    code: "ADMIN_CANARY_VERIFIED_RESTORE_POINT_INVALID",
    context: { mismatch },
    severity: "fatal",
  });
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
      agentSnapshotRestoreValidations,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(agentSnapshotRestoreValidations);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("PostgresVerifiedRestorePointReader", () => {
  test("accepts one exact committed, never-routed v2 restore point", async () => {
    const fixture = await seedBackup();
    await insertValidation(fixture);
    const reader = new PostgresVerifiedRestorePointReader();

    await expect(
      dbWrite.transaction((tx) =>
        reader.readVerifiedV2CandidateRestoreInTx(tx, readerParams(fixture)),
      ),
    ).resolves.toEqual({
      verifiedBackupId: fixture.backupId,
      restoreValidationId: fixture.restoreValidationId,
      restoreValidationAggregateSha256: AGGREGATE_SHA256,
      restoreValidatedCandidateProviderSandboxId: fixture.targetProviderSandboxId,
      restoreValidatedCandidateReplacementAttemptId: fixture.targetReplacementAttemptId,
      receiptCommittedAt: NOW,
      candidateContainerAbsentAt: RETIRED_AT,
      candidateVpnAbsentAt: RETIRED_AT,
      candidateVolumeAbsentAt: RETIRED_AT,
      candidateRetiredAt: RETIRED_AT,
    });
  });

  test("reads a receipt written in the same transaction and cannot outlive rollback", async () => {
    const fixture = await seedBackup();
    const reader = new PostgresVerifiedRestorePointReader();
    const rollbackMarker = new Error("rollback proof");

    await expect(
      dbWrite.transaction(async (tx) => {
        await tx.insert(agentSnapshotRestoreValidations).values(validationValues(fixture));
        await reader.readVerifiedV2CandidateRestoreInTx(tx, readerParams(fixture));
        throw rollbackMarker;
      }),
    ).rejects.toBe(rollbackMarker);

    const persisted = await dbWrite
      .select({ id: agentSnapshotRestoreValidations.restore_validation_id })
      .from(agentSnapshotRestoreValidations)
      .where(
        eq(agentSnapshotRestoreValidations.restore_validation_id, fixture.restoreValidationId),
      );
    expect(persisted).toEqual([]);
  });

  test.each([
    ["restore_validation_cardinality", { sourceJobId: randomUUID() }],
    ["restore_validation_cardinality", { standbyGeneration: randomUUID() }],
    ["rollout_id", { rolloutId: randomUUID() }],
    ["restore_validation_cardinality", { organizationId: randomUUID() }],
    ["restore_validation_cardinality", { sandboxRecordId: randomUUID() }],
    ["agent_id", { agentId: randomUUID() }],
    ["target_owner_user_id", { targetOwnerUserId: randomUUID() }],
    ["target_image", { targetImage: "ghcr.io/elizaos/eliza-demo:other" }],
    ["target_digest", { targetDigest: `sha256:${"e".repeat(64)}` }],
  ] as const)("rejects caller drift at %s", async (mismatch, overrides) => {
    const fixture = await seedBackup();
    await insertValidation(fixture);
    await assertRejected(fixture, overrides, mismatch);
  });

  test("rejects a missing receipt or a receipt whose joined backup was removed", async () => {
    const fixture = await seedBackup();
    await assertRejected(fixture, {}, "restore_validation_cardinality");

    await insertValidation(fixture);
    await dbWrite.delete(agentSandboxBackups).where(eq(agentSandboxBackups.id, fixture.backupId));
    await assertRejected(fixture, {}, "restore_validation_cardinality");
  });

  test.each([
    ["snapshot_type", { snapshot_type: "manual" as const }],
    ["snapshot_schema_version", { snapshot_schema_version: 1 as const }],
    ["verification_status", { verification_status: "failed" as const }],
    ["verified_at", { verified_at: null }],
    ["verification_error", { verification_error: "integrity drift" }],
    ["storage_commit_state", { storage_commit_state: "staging" as const }],
    ["backup_content_hash", { content_hash: "f".repeat(64) }],
  ] as const)("rejects backup drift at %s", async (mismatch, update) => {
    const fixture = await seedBackup();
    await insertValidation(fixture);
    await dbWrite
      .update(agentSandboxBackups)
      .set(update)
      .where(eq(agentSandboxBackups.id, fixture.backupId));
    await assertRejected(fixture, {}, mismatch);
  });

  test("the database rejects a receipt that claims it was routed or not committed", async () => {
    const fixture = await seedBackup();

    await expect(
      (async () => {
        await dbWrite.insert(agentSnapshotRestoreValidations).values({
          ...validationValues(fixture),
          route_exposed_at: NOW,
        });
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.insert(agentSnapshotRestoreValidations).values({
          ...validationValues(fixture),
          receipt_success: false,
        });
      })(),
    ).rejects.toThrow();
  });
});
