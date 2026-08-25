/** Real-PGlite proofs for fair, DB-clock periodic backup admission. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { installAgentNodeOccurrenceTriggerForTests } from "../../agent-node-occurrence-test-support";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { agentBackupCatalogAuthorities } from "../../schemas/agent-backup-catalog";
import { agentNodeIncarnationHistories } from "../../schemas/agent-node-incarnation-histories";
import { agentSandboxBackups, agentSandboxes } from "../../schemas/agent-sandboxes";
import { dockerNodes } from "../../schemas/docker-nodes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import {
  AgentBackupScheduleFenceError,
  claimDueAgentBackupSchedules,
  countOverdueAgentBackupSchedules,
  deferClaimedAgentBackupSchedule,
  enrollEligibleAgentBackupSchedules,
  reconcileAgentBackupSchedules,
  reserveClaimedAgentBackupSchedule,
} from "../agent-backup-scheduler";

const TIMEOUT = 60_000;
const ORG_A = "00000000-0000-4000-8000-00000000d001";
const ORG_B = "00000000-0000-4000-8000-00000000d002";
const USER_A = "00000000-0000-4000-8000-00000000d003";
const USER_B = "00000000-0000-4000-8000-00000000d004";
const AGENT_A = "00000000-0000-4000-8000-00000000d005";
const AGENT_B = "00000000-0000-4000-8000-00000000d006";
const AGENT_C = "00000000-0000-4000-8000-00000000d007";
const NODE_A = "00000000-0000-4000-8000-00000000d008";
const NODE_B = "00000000-0000-4000-8000-00000000d009";
const INCARNATION_A = "00000000-0000-4000-8000-00000000d010";
const INCARNATION_B = "00000000-0000-4000-8000-00000000d011";
const GENERATION_A = "00000000-0000-4000-8000-00000000d012";
const GENERATION_B = "00000000-0000-4000-8000-00000000d013";
const GENERATION_C = "00000000-0000-4000-8000-00000000d014";
const BOOT_ID = "00000000-0000-4000-8000-00000000d015";
const CONCURRENT_OPERATION = "00000000-0000-4000-8000-00000000d016";
const CONCURRENT_CLAIM_GENERATION = "00000000-0000-4000-8000-00000000d017";
const GENERATION_D = "00000000-0000-4000-8000-00000000d018";
const IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
const OTHER_IMAGE_DIGEST = `sha256:${"8".repeat(64)}`;
const CONTAINER_A = "a".repeat(64);
const CONTAINER_B = "b".repeat(64);
const CONTAINER_C = "c".repeat(64);
const CONTAINER_D = "d".repeat(64);
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const WRAPPED_KEY_BUNDLE = `${"A".repeat(123)}=`;

let schemaFailure = "";

async function insertAgent(params: {
  id: string;
  organizationId: string;
  userId: string;
  generation: string;
  nodeId: string;
  providerHandle: string;
  containerId: string;
}) {
  await dbWrite.insert(agentSandboxes).values({
    id: params.id,
    organization_id: params.organizationId,
    user_id: params.userId,
    agent_name: `scheduled-${params.id}`,
    status: "running",
    execution_tier: "dedicated-always",
    sandbox_id: params.providerHandle,
    node_id: params.nodeId,
    container_name: params.providerHandle,
    image_digest: IMAGE_DIGEST,
    lifecycle_revision: 7,
    activation_generation: params.generation,
    activation_lifecycle_revision: 7n,
    activation_phase: "active",
    activation_receipt_hash: SHA_A,
    activation_container_id: params.containerId,
    activation_node_id: params.nodeId,
    activation_image_digest: IMAGE_DIGEST,
    activation_boot_id: BOOT_ID,
    activation_authority_published_at: new Date("2026-08-16T00:00:00.000Z"),
    activation_dispatched_at: new Date("2026-08-16T00:00:01.000Z"),
    activation_completed_at: new Date("2026-08-16T00:00:02.000Z"),
  });
}

async function markProtectedManifestV3(backupId: string) {
  const [backup] = await dbWrite
    .select({ operationId: agentSandboxBackups.backup_operation_id })
    .from(agentSandboxBackups)
    .where(sql`${agentSandboxBackups.id} = ${backupId}`);
  if (!backup?.operationId) throw new Error("Scheduled backup operation is missing");
  const protectedAt = new Date();
  await dbWrite
    .update(agentSandboxBackups)
    .set({
      catalog_state: "protected",
      catalog_next_attempt_at: null,
      manifest_format: "elizaos.agent-backup",
      manifest_version: 3,
      manifest_digest: SHA_A,
      manifest_canonical_draft: "{}",
      manifest_object_count: 1,
      object_inventory_digest: SHA_B,
      image_digest: IMAGE_DIGEST,
      database_schema_version: "scheduler-test-v1",
      plugin_set_digest: SHA_A,
      watermark_digest: SHA_B,
      raw_size_bytes: 1,
      compressed_size_bytes: 1,
      encrypted_size_bytes: 1,
      kms_key_id: "org:scheduler/dek/v1",
      kms_key_version: 1,
      operation_key_bundle_generation_id: GENERATION_C,
      operation_key_bundle_format: "kms-aead-operation-key-bundle-v1",
      operation_key_bundle_ref: `backup-key-bundle:${backup.operationId}`,
      operation_key_bundle_ciphertext_base64: WRAPPED_KEY_BUNDLE,
      operation_key_bundle_sha256: SHA_A,
      operation_key_bundle_size_bytes: 92,
      operation_key_bundle_context: "scheduler-test-context",
      operation_key_bundle_context_derivation:
        "elizaos.agent-backup.operation-key-bundle-context.v1",
      operation_key_bundle_local_receipt_derivation:
        "elizaos.kms-aead-operation-key-bundle.local-receipt.v1",
      operation_key_bundle_local_receipt_digest: SHA_B,
      vault_key_generation_id: GENERATION_D,
      vault_key_authority_receipt_digest: SHA_A,
      primary_verified_at: protectedAt,
      secondary_verified_at: protectedAt,
      catalog_updated_at: protectedAt,
    })
    .where(sql`${agentSandboxBackups.id} = ${backupId}`);
  return protectedAt;
}

beforeAll(async () => {
  try {
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        agentNodeIncarnationHistories,
        dockerNodes,
        agentSandboxes,
        agentSandboxBackups,
        agentBackupCatalogAuthorities,
      } as never,
      dbWrite as never,
    );
    await apply();
    await installAgentNodeOccurrenceTriggerForTests((statement) =>
      dbWrite.execute(sql.raw(statement)),
    );
    for (const migration of [
      "../../migrations/0189_agent_sandbox_lifecycle_revision_scope.sql",
      "../../migrations/0235_agent_backup_rpo_scheduler.sql",
    ]) {
      const source = readFileSync(new URL(migration, import.meta.url), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await dbWrite.execute(statement);
      }
    }
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentBackupCatalogAuthorities);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(dockerNodes);
  await dbWrite.delete(agentNodeIncarnationHistories);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
  await dbWrite.insert(organizations).values([
    { id: ORG_A, name: "Schedule A", slug: "schedule-a" },
    { id: ORG_B, name: "Schedule B", slug: "schedule-b" },
  ]);
  await dbWrite.insert(users).values([
    { id: USER_A, steward_user_id: "schedule-user-a", organization_id: ORG_A },
    { id: USER_B, steward_user_id: "schedule-user-b", organization_id: ORG_B },
  ]);
  await dbWrite.insert(dockerNodes).values([
    {
      id: NODE_A,
      node_id: "robot-schedule-a",
      hostname: "robot-schedule-a.internal",
      host_key_fingerprint: "robot-schedule-a-host-key",
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      node_incarnation: INCARNATION_A,
      metadata: { provider: "operator-onboarded" },
    },
    {
      id: NODE_B,
      node_id: "cloud-schedule-b",
      hostname: "cloud-schedule-b.internal",
      host_key_fingerprint: "cloud-schedule-b-host-key",
      fleet_kind: "cloud",
      infrastructure_provider: "hetzner",
      provider_server_id: "42",
      node_incarnation: INCARNATION_B,
      metadata: { provider: "hetzner-cloud", autoscaled: true },
    },
  ]);
  await insertAgent({
    id: AGENT_A,
    organizationId: ORG_A,
    userId: USER_A,
    generation: GENERATION_A,
    nodeId: "robot-schedule-a",
    providerHandle: "agent-schedule-a",
    containerId: CONTAINER_A,
  });
  await insertAgent({
    id: AGENT_B,
    organizationId: ORG_B,
    userId: USER_B,
    generation: GENERATION_B,
    nodeId: "cloud-schedule-b",
    providerHandle: "agent-schedule-b",
    containerId: CONTAINER_B,
  });
  await insertAgent({
    id: AGENT_C,
    organizationId: ORG_A,
    userId: USER_A,
    generation: GENERATION_C,
    nodeId: "robot-schedule-a",
    providerHandle: "agent-schedule-c",
    containerId: CONTAINER_C,
  });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("agent backup RPO scheduler", () => {
  test("enrolls and claims fairly with one capture per organization and node", async () => {
    expect(await enrollEligibleAgentBackupSchedules({ limit: 100 })).toBe(3);

    const claims = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-a",
      limit: 100,
      leaseMs: 60_000,
    });
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((claim) => claim.organizationId)).size).toBe(2);
    expect(
      claims.filter((claim) => claim.agentId === AGENT_A || claim.agentId === AGENT_C),
    ).toHaveLength(1);
  });

  test("rotates bounded enrollment across organizations before taking a second row", async () => {
    expect(await enrollEligibleAgentBackupSchedules({ limit: 1 })).toBe(1);
    const firstWave = (await dbWrite.select().from(agentSandboxes)).filter(
      (sandbox) => sandbox.next_backup_at !== null,
    );
    expect(firstWave).toHaveLength(1);

    expect(await enrollEligibleAgentBackupSchedules({ limit: 1 })).toBe(1);
    const secondWave = (await dbWrite.select().from(agentSandboxes)).filter(
      (sandbox) => sandbox.next_backup_at !== null,
    );
    expect(secondWave).toHaveLength(2);
    expect(new Set(secondWave.map((sandbox) => sandbox.organization_id))).toEqual(
      new Set([ORG_A, ORG_B]),
    );

    expect(await enrollEligibleAgentBackupSchedules({ limit: 1 })).toBe(1);
    expect(
      (await dbWrite.select().from(agentSandboxes)).filter(
        (sandbox) => sandbox.next_backup_at !== null,
      ),
    ).toHaveLength(3);
  });

  test("concurrent claimers never own the same due sandbox, organization, or node", async () => {
    expect(await enrollEligibleAgentBackupSchedules({ limit: 100 })).toBe(3);
    const batches = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        claimDueAgentBackupSchedules({
          ownerId: `schedule-worker-${index}`,
          limit: 1,
          leaseMs: 60_000,
        }),
      ),
    );
    const all = batches.flat();
    expect(new Set(all.map((claim) => claim.agentId)).size).toBe(all.length);
    expect(new Set(all.map((claim) => claim.operationId)).size).toBe(all.length);
    expect(new Set(all.map((claim) => claim.organizationId)).size).toBe(all.length);
    expect(all).toHaveLength(2);
  });

  test("counts only exact DB-clock RPO breaches without manifest-v3 protection", async () => {
    await dbWrite.update(agentSandboxes).set({
      backup_schedule_last_protected_at: sql`NOW()`,
      next_backup_at: null,
    });
    expect(await countOverdueAgentBackupSchedules()).toBe(0);
    await dbWrite
      .update(agentSandboxes)
      .set({
        activation_lifecycle_revision: 8n,
        activation_completed_at: sql`NOW()`,
        backup_schedule_last_protected_at: sql`NOW() - INTERVAL '1 day'`,
      })
      .where(sql`${agentSandboxes.id} = ${AGENT_A}`);
    expect(await countOverdueAgentBackupSchedules()).toBe(0);
    await dbWrite
      .update(agentSandboxes)
      .set({
        activation_lifecycle_revision: 9n,
        activation_completed_at: sql`NOW() - INTERVAL '16 minutes'`,
      })
      .where(sql`${agentSandboxes.id} = ${AGENT_A}`);
    expect(await countOverdueAgentBackupSchedules()).toBe(1);

    await enrollEligibleAgentBackupSchedules({ limit: 100 });
    await dbWrite.update(agentSandboxes).set({
      next_backup_at: sql`NOW() - INTERVAL '1 minute'`,
      backup_schedule_last_protected_at: sql`NOW()`,
    });
    expect(await countOverdueAgentBackupSchedules()).toBe(0);

    await dbWrite
      .update(agentSandboxes)
      .set({ backup_schedule_last_protected_at: sql`NOW() - INTERVAL '16 minutes'` })
      .where(sql`${agentSandboxes.id} = ${AGENT_A}`);
    expect(await countOverdueAgentBackupSchedules()).toBe(1);

    const [claim] = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-a",
      limit: 1,
      leaseMs: 60_000,
    });
    const receipt = await reserveClaimedAgentBackupSchedule({
      claim: claim as NonNullable<typeof claim>,
    });
    await markProtectedManifestV3(receipt.backupId);
    expect(await countOverdueAgentBackupSchedules()).toBe(0);

    await dbWrite
      .update(agentSandboxBackups)
      .set({ image_digest: OTHER_IMAGE_DIGEST })
      .where(sql`${agentSandboxBackups.id} = ${receipt.backupId}`);
    expect(await countOverdueAgentBackupSchedules()).toBe(1);
    await dbWrite
      .update(agentSandboxBackups)
      .set({ image_digest: IMAGE_DIGEST })
      .where(sql`${agentSandboxBackups.id} = ${receipt.backupId}`);
    expect(await countOverdueAgentBackupSchedules()).toBe(0);

    await dbWrite
      .update(agentSandboxBackups)
      .set({
        primary_verified_at: sql`NOW() - INTERVAL '16 minutes'`,
        secondary_verified_at: sql`NOW() - INTERVAL '16 minutes'`,
      })
      .where(sql`${agentSandboxBackups.id} = ${receipt.backupId}`);
    expect(await countOverdueAgentBackupSchedules()).toBe(1);

    await dbWrite
      .update(agentSandboxBackups)
      .set({ secondary_verified_at: null })
      .where(sql`${agentSandboxBackups.id} = ${receipt.backupId}`);
    expect(await countOverdueAgentBackupSchedules()).toBe(1);
  });

  test("counts a running dedicated sandbox with missing activation authority", async () => {
    await dbWrite.update(agentSandboxes).set({
      backup_schedule_last_protected_at: sql`NOW()`,
      next_backup_at: null,
    });
    await dbWrite
      .update(agentSandboxes)
      .set({
        activation_generation: null,
        activation_lifecycle_revision: null,
        activation_phase: null,
        activation_receipt_hash: null,
        activation_container_id: null,
        activation_node_id: null,
        activation_image_digest: null,
        activation_boot_id: null,
        activation_authority_published_at: null,
        activation_dispatched_at: null,
        activation_completed_at: null,
      })
      .where(sql`${agentSandboxes.id} = ${AGENT_A}`);

    expect(await countOverdueAgentBackupSchedules()).toBe(1);
  });

  test("reservation rechecks fair-lane authority after the scheduler lease", async () => {
    await enrollEligibleAgentBackupSchedules({ limit: 100 });
    const [claim] = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-a",
      limit: 1,
      leaseMs: 60_000,
    });
    expect(claim?.agentId).toBe(AGENT_A);
    await dbWrite
      .update(agentSandboxes)
      .set({
        backup_schedule_operation_id: CONCURRENT_OPERATION,
        backup_schedule_claim_owner: "schedule-worker-b",
        backup_schedule_claim_generation: CONCURRENT_CLAIM_GENERATION,
        backup_schedule_claim_expires_at: sql`clock_timestamp() + INTERVAL '1 minute'`,
      })
      .where(sql`${agentSandboxes.id} = ${AGENT_C}`);

    await expect(
      reserveClaimedAgentBackupSchedule({ claim: claim as NonNullable<typeof claim> }),
    ).rejects.toBeInstanceOf(AgentBackupScheduleFenceError);
    expect(await dbWrite.select().from(agentSandboxBackups)).toHaveLength(0);
  });

  test("an active reservation globally closes its source-node lane", async () => {
    await dbWrite.delete(agentSandboxes).where(sql`${agentSandboxes.id} = ${AGENT_B}`);
    await insertAgent({
      id: AGENT_B,
      organizationId: ORG_B,
      userId: USER_B,
      generation: GENERATION_B,
      nodeId: "robot-schedule-a",
      providerHandle: "agent-schedule-b",
      containerId: CONTAINER_B,
    });
    await enrollEligibleAgentBackupSchedules({ limit: 100 });
    const [claim] = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-a",
      limit: 1,
      leaseMs: 60_000,
    });
    expect(claim?.agentId).toBe(AGENT_A);
    await reserveClaimedAgentBackupSchedule({ claim: claim as NonNullable<typeof claim> });

    const nextClaims = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-b",
      limit: 100,
      leaseMs: 60_000,
    });
    expect(nextClaims).toHaveLength(0);
  });

  test("advances the DB-clock RPO only after exact manifest-v3 protection proof", async () => {
    await enrollEligibleAgentBackupSchedules({ limit: 100 });
    const claims = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-a",
      limit: 100,
      leaseMs: 60_000,
    });
    const receipts = await Promise.all(
      claims.map((claim) => reserveClaimedAgentBackupSchedule({ claim })),
    );
    expect(receipts).toHaveLength(2);
    const backups = await dbWrite.select().from(agentSandboxBackups);
    expect(backups).toHaveLength(2);
    expect(backups.every((backup) => backup.snapshot_type === "auto")).toBe(true);
    expect(backups.every((backup) => backup.backup_kind === "full")).toBe(true);
    expect(new Set(backups.map((backup) => backup.source_provider))).toEqual(
      new Set(["operator-onboarded", "hetzner-cloud"]),
    );
    expect(backups.every((backup) => backup.catalog_state === "scheduled")).toBe(true);
    const sandboxes = await dbWrite.select().from(agentSandboxes);
    for (const sandbox of sandboxes.filter((row) =>
      receipts.some((item) => item.agentId === row.id),
    )) {
      const receipt = receipts.find((item) => item.agentId === sandbox.id);
      if (!receipt || sandbox.activation_lifecycle_revision === null || !sandbox.next_backup_at) {
        throw new Error("Expected a complete reserved scheduler receipt fixture");
      }
      expect(sandbox.backup_schedule_operation_id).toBe(receipt.operationId);
      expect(sandbox.backup_schedule_claim_owner).toBeNull();
      expect(sandbox.backup_schedule_retry_at).toBeNull();
      expect(sandbox.backup_schedule_last_protected_at).toBeNull();
      expect(BigInt(sandbox.lifecycle_revision)).toBe(sandbox.activation_lifecycle_revision);
      expect(sandbox.next_backup_at.getTime()).toBe(receipt.dueAt.getTime());
    }

    expect(await reconcileAgentBackupSchedules({ limit: 100 })).toEqual({
      protected: 0,
      recycled: 0,
    });
    const protectedAtByAgent = new Map<string, Date>();
    for (const receipt of receipts) {
      protectedAtByAgent.set(receipt.agentId, await markProtectedManifestV3(receipt.backupId));
    }
    expect(await reconcileAgentBackupSchedules({ limit: 100 })).toEqual({
      protected: 2,
      recycled: 0,
    });
    const settled = await dbWrite.select().from(agentSandboxes);
    for (const sandbox of settled.filter((row) => protectedAtByAgent.has(row.id))) {
      const protectedAt = protectedAtByAgent.get(sandbox.id) as Date;
      expect(sandbox.backup_schedule_operation_id).toBeNull();
      expect(sandbox.backup_schedule_attempts).toBe(0);
      expect(sandbox.backup_schedule_last_protected_at?.getTime()).toBe(protectedAt.getTime());
      const nextDelayMs = (sandbox.next_backup_at as Date).getTime() - protectedAt.getTime();
      expect(nextDelayMs).toBeGreaterThanOrEqual(10 * 60_000);
      expect(nextDelayMs).toBeLessThanOrEqual(15 * 60_000);
    }
  });

  test("recycles malformed protected evidence without moving the RPO deadline", async () => {
    await enrollEligibleAgentBackupSchedules({ limit: 100 });
    const [claim] = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-a",
      limit: 1,
      leaseMs: 60_000,
    });
    const receipt = await reserveClaimedAgentBackupSchedule({
      claim: claim as NonNullable<typeof claim>,
    });
    await markProtectedManifestV3(receipt.backupId);
    await dbWrite
      .update(agentSandboxBackups)
      .set({ secondary_verified_at: null })
      .where(sql`${agentSandboxBackups.id} = ${receipt.backupId}`);

    expect(await reconcileAgentBackupSchedules({ limit: 100 })).toEqual({
      protected: 0,
      recycled: 1,
    });
    const [sandbox] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(sql`${agentSandboxes.id} = ${receipt.agentId}`);
    expect(sandbox?.next_backup_at?.getTime()).toBe(receipt.dueAt.getTime());
    expect(sandbox?.backup_schedule_operation_id).toBeNull();
    expect(sandbox?.backup_schedule_retry_at).toBeInstanceOf(Date);
    expect(sandbox?.backup_schedule_last_protected_at).toBeNull();
    expect(sandbox?.backup_schedule_last_error_code).toBe(
      "BACKUP_SCHEDULE_PROTECTION_PROOF_INVALID",
    );
  });

  test("rejects protected evidence for a different activation image", async () => {
    await enrollEligibleAgentBackupSchedules({ limit: 100 });
    const [claim] = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-a",
      limit: 1,
      leaseMs: 60_000,
    });
    const receipt = await reserveClaimedAgentBackupSchedule({
      claim: claim as NonNullable<typeof claim>,
    });
    await markProtectedManifestV3(receipt.backupId);
    await dbWrite
      .update(agentSandboxBackups)
      .set({ image_digest: OTHER_IMAGE_DIGEST })
      .where(sql`${agentSandboxBackups.id} = ${receipt.backupId}`);

    expect(await reconcileAgentBackupSchedules({ limit: 100 })).toEqual({
      protected: 0,
      recycled: 1,
    });
    const [sandbox] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(sql`${agentSandboxes.id} = ${receipt.agentId}`);
    expect(sandbox?.next_backup_at?.getTime()).toBe(receipt.dueAt.getTime());
    expect(sandbox?.backup_schedule_last_protected_at).toBeNull();
    expect(sandbox?.backup_schedule_last_error_code).toBe(
      "BACKUP_SCHEDULE_PROTECTION_PROOF_INVALID",
    );
  });

  test("rejects protection proof from a superseded activation vector", async () => {
    await dbWrite.update(agentSandboxes).set({ backup_schedule_last_protected_at: sql`NOW()` });
    await enrollEligibleAgentBackupSchedules({ limit: 100 });
    const [claim] = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-a",
      limit: 1,
      leaseMs: 60_000,
    });
    const receipt = await reserveClaimedAgentBackupSchedule({
      claim: claim as NonNullable<typeof claim>,
    });
    await dbWrite
      .update(agentSandboxes)
      .set({
        activation_generation: GENERATION_D,
        activation_lifecycle_revision: 8n,
        activation_container_id: CONTAINER_D,
        activation_completed_at: sql`NOW() - INTERVAL '16 minutes'`,
        backup_schedule_last_protected_at: null,
      })
      .where(sql`${agentSandboxes.id} = ${receipt.agentId}`);
    await markProtectedManifestV3(receipt.backupId);

    const [reactivated] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(sql`${agentSandboxes.id} = ${receipt.agentId}`);
    expect(reactivated?.lifecycle_revision).toBe(8);
    expect(reactivated?.activation_lifecycle_revision).toBe(8n);
    expect(await countOverdueAgentBackupSchedules()).toBe(1);
    expect(await reconcileAgentBackupSchedules({ limit: 100 })).toEqual({
      protected: 0,
      recycled: 1,
    });

    const [recycled] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(sql`${agentSandboxes.id} = ${receipt.agentId}`);
    expect(recycled?.next_backup_at?.getTime()).toBe(receipt.dueAt.getTime());
    expect(recycled?.backup_schedule_operation_id).toBeNull();
    expect(recycled?.backup_schedule_last_protected_at).toBeNull();
    expect(recycled?.backup_schedule_last_error_code).toBe(
      "BACKUP_SCHEDULE_PROTECTION_PROOF_INVALID",
    );
    expect(await countOverdueAgentBackupSchedules()).toBe(1);
  });

  test("keeps a superseded active lane closed until durable terminal settlement", async () => {
    await enrollEligibleAgentBackupSchedules({ limit: 100 });
    const [claim] = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-a",
      limit: 1,
      leaseMs: 60_000,
    });
    const original = await reserveClaimedAgentBackupSchedule({
      claim: claim as NonNullable<typeof claim>,
    });
    await dbWrite
      .update(agentSandboxes)
      .set({
        activation_generation: GENERATION_D,
        activation_lifecycle_revision: 8n,
        activation_container_id: CONTAINER_D,
      })
      .where(sql`${agentSandboxes.id} = ${original.agentId}`);
    await dbWrite
      .update(agentSandboxBackups)
      .set({
        catalog_state: "failed_retryable",
        catalog_resume_state: "scheduled",
        catalog_last_error_code: "BACKUP_SOURCE_RETRY",
        catalog_last_error: "The old source remains retryable",
        catalog_next_attempt_at: sql`NOW() + INTERVAL '1 hour'`,
      })
      .where(sql`${agentSandboxBackups.id} = ${original.backupId}`);

    expect(await reconcileAgentBackupSchedules({ limit: 100 })).toEqual({
      protected: 0,
      recycled: 0,
    });
    const [blocked] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(sql`${agentSandboxes.id} = ${original.agentId}`);
    expect(blocked?.next_backup_at?.getTime()).toBe(original.dueAt.getTime());
    expect(blocked?.backup_schedule_operation_id).toBe(original.operationId);
    const whileActive = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-b",
      limit: 100,
      leaseMs: 60_000,
    });
    expect(whileActive.some((item) => item.agentId === original.agentId)).toBe(false);

    await dbWrite
      .update(agentSandboxBackups)
      .set({
        catalog_state: "failed_terminal",
        catalog_resume_state: "scheduled",
        catalog_last_error_code: "BACKUP_SOURCE_SUPERSEDED",
        catalog_last_error: "The reserved source activation was superseded",
        catalog_next_attempt_at: null,
      })
      .where(sql`${agentSandboxBackups.id} = ${original.backupId}`);
    expect(await reconcileAgentBackupSchedules({ limit: 100 })).toEqual({
      protected: 0,
      recycled: 1,
    });
    const [recycled] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(sql`${agentSandboxes.id} = ${original.agentId}`);
    expect(recycled?.next_backup_at?.getTime()).toBe(original.dueAt.getTime());
    expect(recycled?.backup_schedule_operation_id).toBeNull();
    expect(recycled?.backup_schedule_last_error_code).toBe(
      "BACKUP_SCHEDULE_RESERVATION_SUPERSEDED",
    );

    await dbWrite
      .update(agentSandboxes)
      .set({ backup_schedule_retry_at: sql`NOW() - INTERVAL '1 second'` })
      .where(sql`${agentSandboxes.id} = ${original.agentId}`);
    const claims = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-c",
      limit: 100,
      leaseMs: 60_000,
    });
    const replacementClaim = claims.find((item) => item.agentId === original.agentId);
    expect(replacementClaim).toBeDefined();
    const replacement = await reserveClaimedAgentBackupSchedule({
      claim: replacementClaim as NonNullable<typeof replacementClaim>,
    });
    expect(replacement.operationId).not.toBe(original.operationId);
    expect(
      (await dbWrite.select().from(agentSandboxBackups)).filter(
        (backup) => backup.catalog_agent_id === original.agentId,
      ),
    ).toHaveLength(2);
    expect(
      (await dbWrite.select().from(agentSandboxBackups)).filter(
        (backup) =>
          backup.catalog_agent_id === original.agentId &&
          backup.catalog_state !== "failed_terminal",
      ),
    ).toHaveLength(1);
  });

  test("source authority loss after claim fails closed and exact defer releases the lease", async () => {
    await enrollEligibleAgentBackupSchedules({ limit: 100 });
    const [claim] = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-a",
      limit: 1,
      leaseMs: 60_000,
    });
    expect(claim).toBeDefined();
    const originalDueAt = (claim as NonNullable<typeof claim>).dueAt.getTime();
    const operationId = (claim as NonNullable<typeof claim>).operationId;
    await dbWrite
      .update(dockerNodes)
      .set({ node_incarnation: null })
      .where(
        sql`${dockerNodes.node_id} = ${
          claim?.agentId === AGENT_B ? "cloud-schedule-b" : "robot-schedule-a"
        }`,
      );
    await expect(
      reserveClaimedAgentBackupSchedule({ claim: claim as NonNullable<typeof claim> }),
    ).rejects.toBeInstanceOf(AgentBackupScheduleFenceError);
    expect(await dbWrite.select().from(agentSandboxBackups)).toHaveLength(0);
    expect(
      await deferClaimedAgentBackupSchedule({
        claim: claim as NonNullable<typeof claim>,
        retryDelayMs: 30_000,
        errorCode: "BACKUP_SOURCE_REATTEST_REQUIRED",
      }),
    ).toBe(true);
    const [deferred] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(sql`${agentSandboxes.id} = ${(claim as NonNullable<typeof claim>).agentId}`);
    expect(deferred?.next_backup_at?.getTime()).toBe(originalDueAt);
    expect(deferred?.backup_schedule_operation_id).toBe(operationId);
    expect(deferred?.backup_schedule_retry_at).toBeInstanceOf(Date);
    expect(deferred?.backup_schedule_claim_owner).toBeNull();
    expect(deferred?.backup_schedule_last_error_code).toBe("BACKUP_SOURCE_REATTEST_REQUIRED");
    const immediate = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-b",
      limit: 100,
      leaseMs: 60_000,
    });
    expect(immediate.some((item) => item.agentId === deferred?.id)).toBe(false);
  });

  test("a successful reservation response loss cannot create a second logical backup", async () => {
    await enrollEligibleAgentBackupSchedules({ limit: 100 });
    const [claim] = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-a",
      limit: 1,
      leaseMs: 60_000,
    });
    const receipt = await reserveClaimedAgentBackupSchedule({
      claim: claim as NonNullable<typeof claim>,
    });
    await expect(
      reserveClaimedAgentBackupSchedule({ claim: claim as NonNullable<typeof claim> }),
    ).rejects.toBeInstanceOf(AgentBackupScheduleFenceError);
    const backups = await dbWrite.select().from(agentSandboxBackups);
    expect(backups).toHaveLength(1);
    expect(backups[0]?.id).toBe(receipt.backupId);
    const [sandbox] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(sql`${agentSandboxes.id} = ${receipt.agentId}`);
    expect(sandbox?.backup_schedule_operation_id).toBe(receipt.operationId);
    expect(sandbox?.next_backup_at?.getTime()).toBe(receipt.dueAt.getTime());
    const nextClaims = await claimDueAgentBackupSchedules({
      ownerId: "schedule-worker-b",
      limit: 100,
      leaseMs: 60_000,
    });
    expect(nextClaims.some((item) => item.agentId === receipt.agentId)).toBe(false);
  });
});
