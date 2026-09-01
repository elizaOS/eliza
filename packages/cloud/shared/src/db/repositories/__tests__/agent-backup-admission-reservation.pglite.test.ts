/** PGlite proofs for atomic admission-work to catalogue reservation handoff. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const { closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } = await import(
  "../../client"
);
const {
  agentBackupAdmissionWork,
  agentBackupNodeAdmissionCursors,
  agentBackupOrganizationAdmissionCursors,
} = await import("../../schemas/agent-backup-admission");
const {
  agentBackupCatalogAuthorities,
  agentBackupGcOutbox,
  agentBackupObjects,
  agentBackupRestoreLeases,
} = await import("../../schemas/agent-backup-catalog");
const { agentNodeIncarnationHistories } = await import(
  "../../schemas/agent-node-incarnation-histories"
);
const { agentSandboxBackups, agentSandboxes } = await import("../../schemas/agent-sandboxes");
const { dockerNodes } = await import("../../schemas/docker-nodes");
const { organizations } = await import("../../schemas/organizations");
const { userCharacters } = await import("../../schemas/user-characters");
const { users } = await import("../../schemas/users");
const { reserveAndSettleAgentBackupAdmissionClaim } = await import(
  "../agent-backup-admission-reservation"
);

const TIMEOUT = 60_000;
const ORGANIZATION_ID = "00000000-0000-4000-8000-00000000d001";
const USER_ID = "00000000-0000-4000-8000-00000000d002";
const SANDBOX_ID = "00000000-0000-4000-8000-00000000d003";
const WORK_ID = "00000000-0000-4000-8000-00000000d004";
const NODE_RECORD_ID = "00000000-0000-4000-8000-00000000d005";
const NODE_HISTORY_ID = "00000000-0000-4000-8000-00000000d006";
const REARMED_NODE_HISTORY_ID = "00000000-0000-4000-8000-00000000d00b";
const NODE_INCARNATION = "00000000-0000-4000-8000-00000000d007";
const ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000d008";
const CLAIM_GENERATION = "00000000-0000-4000-8000-00000000d009";
const STALE_CLAIM_GENERATION = "00000000-0000-4000-8000-00000000d00a";
const NODE_ID = "reservation-node-1";
const PROVIDER_HANDLE = "reservation-provider-handle";
const CONTAINER_ID = "d".repeat(64);
const IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
const STALE_IMAGE_DIGEST = `sha256:${"8".repeat(64)}`;
const RECEIPT_HASH = "a".repeat(64);
const RECEIPT_MAC = "b".repeat(64);

let schemaFailure = "";

type ReservationClaim = Parameters<typeof reserveAndSettleAgentBackupAdmissionClaim>[0]["claim"];

async function seedClaim(): Promise<ReservationClaim> {
  const sourceDueAt = new Date(Date.now() - 60_000);
  const rpoDeadlineAt = new Date(sourceDueAt.getTime() + 900_000);
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  await dbWrite.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "Backup admission reservation org",
    slug: "backup-admission-reservation-org",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    steward_user_id: "backup-admission-reservation-user",
    organization_id: ORGANIZATION_ID,
  });
  await dbWrite.insert(agentNodeIncarnationHistories).values({
    id: NODE_HISTORY_ID,
    docker_node_record_id: NODE_RECORD_ID,
    node_id: NODE_ID,
    node_incarnation: NODE_INCARNATION,
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    provider_server_id: null,
    host_key_fingerprint: "sha256:reservation-host-key",
  });
  await dbWrite.insert(dockerNodes).values({
    id: NODE_RECORD_ID,
    node_id: NODE_ID,
    hostname: "reservation-node-1.example.test",
    host_key_fingerprint: "sha256:reservation-host-key",
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    provider_server_id: null,
    node_incarnation: NODE_INCARNATION,
    current_node_history_id: NODE_HISTORY_ID,
    status: "healthy",
    enabled: true,
    allocated_count: 2,
  });
  await dbWrite.insert(agentSandboxes).values({
    id: SANDBOX_ID,
    organization_id: ORGANIZATION_ID,
    user_id: USER_ID,
    agent_name: "Backup admission reservation agent",
    status: "running",
    execution_tier: "dedicated-always",
    sandbox_id: PROVIDER_HANDLE,
    node_id: NODE_ID,
    container_name: "backup-admission-reservation-agent",
    image_digest: IMAGE_DIGEST,
    lifecycle_revision: 0,
    activation_generation: ACTIVATION_GENERATION,
    activation_lifecycle_revision: 0n,
    activation_purpose: "provision",
    activation_phase: "active",
    activation_receipt: {
      schemaVersion: 1,
      generation: ACTIVATION_GENERATION,
      purpose: "provision",
      agentId: SANDBOX_ID,
      organizationId: ORGANIZATION_ID,
      lifecycleRevision: "0",
      backupId: null,
      backupHash: null,
      manifestHash: null,
      componentHashes: null,
      freshAuthorization: null,
      containerId: CONTAINER_ID,
      imageDigest: IMAGE_DIGEST,
      receiptId: NODE_INCARNATION,
      receiptHash: RECEIPT_HASH,
      receiptMac: RECEIPT_MAC,
      appliedAt: new Date().toISOString(),
      restored: true,
      requiresRestart: false,
    },
    activation_receipt_hash: RECEIPT_HASH,
    activation_container_id: CONTAINER_ID,
    activation_node_id: NODE_ID,
    activation_image_digest: IMAGE_DIGEST,
    activation_boot_id: NODE_INCARNATION,
    activation_token_hash: RECEIPT_HASH,
    activation_token_ciphertext: "sealed-activation-token",
    activation_funding_revision: 0n,
    activation_authority_published_at: new Date(Date.now() - 3_000),
    activation_dispatched_at: new Date(Date.now() - 2_000),
    activation_completed_at: new Date(Date.now() - 1_000),
  });
  await dbWrite.insert(agentBackupAdmissionWork).values({
    id: WORK_ID,
    work_kind: "schedule_capture",
    work_stage: "reserve_capture",
    organization_id: ORGANIZATION_ID,
    sandbox_id: SANDBOX_ID,
    node_history_id: NODE_HISTORY_ID,
    source_activation_generation: ACTIVATION_GENERATION,
    source_lifecycle_revision: 0n,
    source_provider_handle: PROVIDER_HANDLE,
    source_container_id: CONTAINER_ID,
    source_image_digest: IMAGE_DIGEST,
    source_rpo_ms: 900_000,
    requires_node_lane: true,
    priority_class: "periodic_capture",
    base_priority: 3,
    source_due_at: sourceDueAt,
    rpo_deadline_at: rpoDeadlineAt,
    state: "leased",
    not_before: sourceDueAt,
    ready_cohort: 1n,
    cohort_ordinal: 0,
    shard_id: 0,
    lease_owner: "reservation-worker",
    lease_generation: CLAIM_GENERATION,
    lease_expires_at: expiresAt,
    attempts: 1,
    claim_cycle_start_turn: 10n,
    claim_proof_turn: 11n,
    claim_proof_xid: "42",
    claim_proof_priority_pass: 3,
    claim_proof_attempt: 1,
  });
  return {
    workId: WORK_ID,
    organizationId: ORGANIZATION_ID,
    sandboxId: SANDBOX_ID,
    nodeHistoryId: NODE_HISTORY_ID,
    sourceActivationGeneration: ACTIVATION_GENERATION,
    sourceLifecycleRevision: "0",
    sourceProviderHandle: PROVIDER_HANDLE,
    sourceContainerId: CONTAINER_ID,
    sourceImageDigest: IMAGE_DIGEST,
    sourceRpoMs: 900_000,
    sourceDueAt,
    rpoDeadlineAt,
    firstEligibleAt: sourceDueAt,
    effectivePriority: 3,
    ownerId: "reservation-worker",
    generation: CLAIM_GENERATION,
    expiresAt,
    workAttempt: 1,
    claimCycleStartTurn: "10",
    claimProofTurn: "11",
    claimProofXid: "42",
    claimProofPriorityPass: 3,
  };
}

async function expectNoPartialReservation(): Promise<void> {
  expect(await dbWrite.select().from(agentSandboxBackups)).toEqual([]);
  const [work] = await dbWrite
    .select({
      state: agentBackupAdmissionWork.state,
      leaseOwner: agentBackupAdmissionWork.lease_owner,
      settledReason: agentBackupAdmissionWork.settled_reason,
    })
    .from(agentBackupAdmissionWork)
    .where(eq(agentBackupAdmissionWork.id, WORK_ID));
  expect(work).toEqual({
    state: "leased",
    leaseOwner: "reservation-worker",
    settledReason: null,
  });
}

beforeAll(async () => {
  try {
    getPgliteClientForTests();
    await dbWrite.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION agent_backup_admission_expected_shard(source_id uuid)
      RETURNS smallint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
      AS $$ SELECT (get_byte(uuid_send(source_id), 0) % 64)::smallint $$
    `),
    );
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        agentNodeIncarnationHistories,
        agentBackupOrganizationAdmissionCursors,
        agentBackupNodeAdmissionCursors,
        dockerNodes,
        agentSandboxes,
        agentSandboxBackups,
        agentBackupCatalogAuthorities,
        agentBackupObjects,
        agentBackupGcOutbox,
        agentBackupRestoreLeases,
      } as never,
      dbWrite as never,
    );
    await apply();
    await dbWrite.execute(
      sql.raw(`
        CREATE TABLE agent_backup_admission_work (
          id uuid PRIMARY KEY, work_kind text NOT NULL, work_stage text NOT NULL,
          organization_id uuid NOT NULL, sandbox_id uuid, backup_id uuid, gc_object_id uuid,
          node_history_id uuid, source_activation_generation uuid,
          source_lifecycle_revision bigint, source_provider_handle text,
          source_container_id text, source_image_digest text, source_rpo_ms integer,
          requires_node_lane boolean NOT NULL, priority_class text NOT NULL,
          base_priority smallint NOT NULL, source_due_at timestamptz NOT NULL,
          rpo_deadline_at timestamptz,
          first_eligible_at timestamptz GENERATED ALWAYS AS (source_due_at) STORED,
          state text NOT NULL DEFAULT 'queued', not_before timestamptz NOT NULL DEFAULT now(),
          deferred_reason text, ready_cohort bigint NOT NULL, cohort_ordinal integer NOT NULL,
          shard_id smallint NOT NULL, lease_owner text, lease_generation uuid,
          lease_expires_at timestamptz, attempts integer NOT NULL DEFAULT 0,
          claim_cycle_start_turn bigint, claim_proof_turn bigint, claim_proof_xid xid8,
          claim_proof_priority_pass smallint, claim_proof_attempt integer,
          settled_at timestamptz, settled_reason text,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
        )
      `),
    );
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  await dbWrite.delete(agentBackupAdmissionWork);
  await dbWrite.delete(agentBackupRestoreLeases);
  await dbWrite.delete(agentBackupGcOutbox);
  await dbWrite.delete(agentBackupObjects);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentBackupNodeAdmissionCursors);
  await dbWrite.delete(agentBackupOrganizationAdmissionCursors);
  await dbWrite.delete(agentBackupCatalogAuthorities);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(dockerNodes);
  await dbWrite.delete(agentNodeIncarnationHistories);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("agent backup admission reservation on primary PGlite", () => {
  test("atomically reserves operationId=workId and settles the exact lease", async () => {
    const claim = await seedClaim();

    const result = await reserveAndSettleAgentBackupAdmissionClaim({ claim });

    expect(result).toEqual({
      workId: WORK_ID,
      operationId: WORK_ID,
      backupId: expect.any(String),
      replayed: false,
    });
    const [backup] = await dbWrite.select().from(agentSandboxBackups);
    expect(backup).toMatchObject({
      id: result.backupId,
      backup_operation_id: WORK_ID,
      catalog_organization_id: ORGANIZATION_ID,
      catalog_agent_id: SANDBOX_ID,
      catalog_state: "scheduled",
      backup_kind: "full",
      source_node_history_id: NODE_HISTORY_ID,
      source_provider_handle: PROVIDER_HANDLE,
      source_container_id: CONTAINER_ID,
      retention_reason: "schedule",
    });
    const [work] = await dbWrite
      .select({
        state: agentBackupAdmissionWork.state,
        leaseOwner: agentBackupAdmissionWork.lease_owner,
        leaseGeneration: agentBackupAdmissionWork.lease_generation,
        leaseExpiresAt: agentBackupAdmissionWork.lease_expires_at,
        settledReason: agentBackupAdmissionWork.settled_reason,
      })
      .from(agentBackupAdmissionWork);
    expect(work).toEqual({
      state: "settled",
      leaseOwner: null,
      leaseGeneration: null,
      leaseExpiresAt: null,
      settledReason: "CAPTURE_RESERVED",
    });
    const [authority] = await dbWrite.select().from(agentBackupCatalogAuthorities);
    expect(authority?.catalog_revision).toBe(1n);
    const [node] = await dbWrite
      .select({ allocatedCount: dockerNodes.allocated_count })
      .from(dockerNodes);
    expect(node?.allocatedCount).toBe(2);
  });

  test("returns the same durable reservation after a paid-work fence for an exact settled replay", async () => {
    const claim = await seedClaim();
    const first = await reserveAndSettleAgentBackupAdmissionClaim({ claim });
    await dbWrite
      .update(organizations)
      .set({
        account_lifecycle_state: "deletion_recovery",
        account_deletion_request_id: STALE_CLAIM_GENERATION,
        paid_work_fenced_at: new Date(),
        is_active: false,
      })
      .where(eq(organizations.id, ORGANIZATION_ID));

    const replay = await reserveAndSettleAgentBackupAdmissionClaim({ claim });

    expect(replay).toEqual({ ...first, replayed: true });
    expect(await dbWrite.select().from(agentSandboxBackups)).toHaveLength(1);
    const [authority] = await dbWrite.select().from(agentBackupCatalogAuthorities);
    expect(authority?.catalog_revision).toBe(1n);
  });

  test("fails closed when settled replay catalogue version, digest, or retention is altered", async () => {
    const claim = await seedClaim();
    await reserveAndSettleAgentBackupAdmissionClaim({ claim });
    const [original] = await dbWrite.select().from(agentSandboxBackups);
    if (!original?.catalog_payload_digest || !(original.retention_until instanceof Date)) {
      throw new Error("Seeded reservation is missing its canonical payload authority");
    }

    await dbWrite
      .update(agentSandboxBackups)
      .set({ catalog_payload_digest: "f".repeat(64) })
      .where(eq(agentSandboxBackups.id, original.id));
    await expect(reserveAndSettleAgentBackupAdmissionClaim({ claim })).rejects.toThrow(
      /already reserved with a different payload/i,
    );

    await dbWrite
      .update(agentSandboxBackups)
      .set({
        catalog_payload_digest: original.catalog_payload_digest,
        retention_until: new Date(original.retention_until.getTime() + 1_000),
      })
      .where(eq(agentSandboxBackups.id, original.id));
    await expect(reserveAndSettleAgentBackupAdmissionClaim({ claim })).rejects.toThrow(
      /already reserved with a different payload/i,
    );

    await dbWrite
      .update(agentSandboxBackups)
      .set({
        catalog_version: 1,
        catalog_state: "legacy_unmigrated",
        retention_until: original.retention_until,
      })
      .where(eq(agentSandboxBackups.id, original.id));
    await expect(reserveAndSettleAgentBackupAdmissionClaim({ claim })).rejects.toThrow(
      /already reserved with a different payload/i,
    );
  });

  test("rolls back without a backup or settlement for a stale complete fence", async () => {
    const claim = await seedClaim();

    await expect(
      reserveAndSettleAgentBackupAdmissionClaim({
        claim: { ...claim, generation: STALE_CLAIM_GENERATION },
      }),
    ).rejects.toThrow(/fence is stale/i);
    await expectNoPartialReservation();
  });

  test("rolls back after the organization publishes its paid-work fence", async () => {
    const claim = await seedClaim();
    await dbWrite
      .update(organizations)
      .set({
        account_lifecycle_state: "deletion_recovery",
        account_deletion_request_id: STALE_CLAIM_GENERATION,
        paid_work_fenced_at: new Date(),
        is_active: false,
      })
      .where(eq(organizations.id, ORGANIZATION_ID));

    await expect(reserveAndSettleAgentBackupAdmissionClaim({ claim })).rejects.toThrow(
      /organization no longer permits paid work/i,
    );
    await expectNoPartialReservation();
  });

  test("rolls back without a backup or settlement for stale source authority", async () => {
    const claim = await seedClaim();
    await dbWrite
      .update(agentSandboxes)
      .set({ sandbox_id: "stale-reservation-provider-handle" })
      .where(eq(agentSandboxes.id, SANDBOX_ID));

    await expect(reserveAndSettleAgentBackupAdmissionClaim({ claim })).rejects.toThrow(
      /source generation no longer matches/i,
    );
    await expectNoPartialReservation();
  });

  test("rolls back without a backup or settlement for stale source image", async () => {
    const claim = await seedClaim();
    await dbWrite
      .update(agentSandboxes)
      .set({ image_digest: STALE_IMAGE_DIGEST, activation_image_digest: STALE_IMAGE_DIGEST })
      .where(eq(agentSandboxes.id, SANDBOX_ID));

    await expect(reserveAndSettleAgentBackupAdmissionClaim({ claim })).rejects.toThrow(
      /source image no longer matches/i,
    );
    await expectNoPartialReservation();
  });

  test("rolls back when the same node incarnation points at a new occurrence", async () => {
    const claim = await seedClaim();
    await dbWrite.insert(agentNodeIncarnationHistories).values({
      id: REARMED_NODE_HISTORY_ID,
      docker_node_record_id: NODE_RECORD_ID,
      node_id: NODE_ID,
      node_incarnation: NODE_INCARNATION,
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      provider_server_id: null,
      host_key_fingerprint: "sha256:reservation-host-key",
    });
    await dbWrite
      .update(dockerNodes)
      .set({ current_node_history_id: REARMED_NODE_HISTORY_ID })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));

    await expect(reserveAndSettleAgentBackupAdmissionClaim({ claim })).rejects.toThrow(
      /already reserved with a different payload/i,
    );
    await expectNoPartialReservation();
  });
});
