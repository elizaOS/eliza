/**
 * PGlite functional proofs for restartable periodic-backup cohort enrollment.
 *
 * The harness executes the migration stack and source-occurrence trigger, then
 * exercises concurrent repository calls and replay idempotence in one embedded
 * database runtime. The sibling PostgreSQL integration test owns independent-
 * session row-lock and `SKIP LOCKED` evidence.
 */

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
import { sqlRows } from "../../execute-helpers";
import {
  agentBackupAdmissionEnrollmentShards,
  agentBackupAdmissionWork,
  agentBackupNodeAdmissionCursors,
  agentBackupOrganizationAdmissionCursors,
} from "../../schemas/agent-backup-admission";
import {
  agentBackupCatalogAuthorities,
  agentBackupGcOutbox,
  agentBackupObjects,
  agentBackupRestoreLeases,
} from "../../schemas/agent-backup-catalog";
import { agentNodeIncarnationHistories } from "../../schemas/agent-node-incarnation-histories";
import { agentSandboxBackups, agentSandboxes } from "../../schemas/agent-sandboxes";
import { dockerNodes } from "../../schemas/docker-nodes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import {
  enrollDueAgentBackupScheduleAdmissionCohort,
  requireAgentBackupAdmissionEnrollmentLeaseOwner,
} from "../agent-backup-admission-enrollment";

const TIMEOUT = 60_000;
const ORGANIZATION_ID = "70000000-0000-4000-8000-00000000e001";
const USER_ID = "70000000-0000-4000-8000-00000000e002";
const NODE_RECORD_ID = "70000000-0000-4000-8000-00000000e003";
const NODE_INCARNATION = "70000000-0000-4000-8000-00000000e004";
const ROTATED_NODE_INCARNATION = "70000000-0000-4000-8000-00000000e005";
const IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
const RECEIPT_HASH = "a".repeat(64);
const ACTIVATION_COMPLETED_AT = new Date("2026-08-16T00:00:02.000Z");

const COHORT_MIGRATIONS = [
  "0346_agent_backup_admission_sandbox_source_stamp",
  "0347_agent_backup_admission_node_source_stamp",
  "0348_agent_backup_admission_snapshot_visibility",
  "0349_agent_backup_admission_cohort_authority",
  "0350_agent_backup_admission_cohort_seed",
  "0351_agent_backup_admission_work_table",
  "0352_agent_backup_admission_work_shapes",
  "0353_agent_backup_admission_work_state_shapes",
  "0354_agent_backup_admission_work_stage_policy",
  "0355_agent_backup_admission_work_indexes",
  "0356_agent_backup_admission_work_identity_guard",
  "0357_agent_backup_admission_work_state_guard",
  "0358_agent_backup_admission_work_delete_guard",
  "0359_agent_backup_admission_shard_guard",
] as const;

let schemaFailure = "";

function uuidForShard(shardId: number, suffix: number): string {
  const firstByte = shardId.toString(16).padStart(2, "0");
  const tail = suffix.toString(16).padStart(12, "0");
  return `${firstByte}000000-0000-4000-8000-${tail}`;
}

async function applyMigration(tag: string): Promise<void> {
  const source = readFileSync(new URL(`../../migrations/${tag}.sql`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(statement);
  }
}

async function prioritizeShardZero(): Promise<void> {
  await dbWrite
    .update(agentBackupAdmissionEnrollmentShards)
    .set({ updated_at: new Date("2100-01-01T00:00:00.000Z") })
    .where(sql`${agentBackupAdmissionEnrollmentShards.work_kind} = 'schedule_capture'`);
  await dbWrite
    .update(agentBackupAdmissionEnrollmentShards)
    .set({ updated_at: new Date(0) })
    .where(
      sql`${agentBackupAdmissionEnrollmentShards.work_kind} = 'schedule_capture'
        AND ${agentBackupAdmissionEnrollmentShards.shard_id} = 0`,
    );
}

async function insertAgent(params: {
  id: string;
  generation: string;
  index: number;
  activationCompletedAt?: Date;
}): Promise<void> {
  const hex = (params.index % 16).toString(16);
  await dbWrite.insert(agentSandboxes).values({
    id: params.id,
    organization_id: ORGANIZATION_ID,
    user_id: USER_ID,
    agent_name: `cohort-agent-${params.index}`,
    status: "running",
    execution_tier: "dedicated-always",
    sandbox_id: `cohort-agent-${params.index}`,
    node_id: "cohort-node",
    container_name: `cohort-agent-${params.index}`,
    image_digest: IMAGE_DIGEST,
    lifecycle_revision: 7,
    activation_generation: params.generation,
    activation_lifecycle_revision: 7n,
    activation_phase: "active",
    activation_receipt_hash: RECEIPT_HASH,
    activation_container_id: hex.repeat(64),
    activation_node_id: "cohort-node",
    activation_image_digest: IMAGE_DIGEST,
    activation_boot_id: NODE_INCARNATION,
    activation_authority_published_at: new Date("2026-08-16T00:00:00.000Z"),
    activation_dispatched_at: new Date("2026-08-16T00:00:01.000Z"),
    activation_completed_at: params.activationCompletedAt ?? ACTIVATION_COMPLETED_AT,
  });
}

async function enroll(ownerId: string, limit: number, rpoMs = 60_000) {
  return enrollDueAgentBackupScheduleAdmissionCohort({
    ownerId,
    limit,
    leaseMs: 60_000,
    rpoMs,
  });
}

beforeAll(async () => {
  try {
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
    await installAgentNodeOccurrenceTriggerForTests((statement) =>
      dbWrite.execute(sql.raw(statement)),
    );
    await applyMigration("0189_agent_sandbox_lifecycle_revision_scope");
    await applyMigration("0235_agent_backup_rpo_scheduler");
    for (const migration of COHORT_MIGRATIONS) await applyMigration(migration);
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  await dbWrite.execute(sql`
    UPDATE ${agentBackupAdmissionEnrollmentShards}
    SET lease_owner = 'enrollment-test-reset',
      lease_generation = '70000000-0000-4000-8000-00000000efff',
      lease_expires_at = clock_timestamp() + INTERVAL '1 minute'
    WHERE active_cohort IS NOT NULL
      AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
  `);
  await dbWrite.execute(sql`
    UPDATE ${agentBackupAdmissionWork}
    SET state = 'settled', deferred_reason = NULL,
      lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL,
      settled_at = clock_timestamp(), settled_reason = 'TEST_RESET',
      updated_at = clock_timestamp()
    WHERE state <> 'settled'
  `);
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
  await dbWrite.update(agentBackupAdmissionEnrollmentShards).set({
    scan_cutoff_at: null,
    scan_cursor_due_at: null,
    scan_cursor_id: null,
    scan_cursor_ordinal: null,
    scan_snapshot: null,
    scan_schedule_rpo_ms: null,
    active_cohort: null,
    lease_owner: null,
    lease_generation: null,
    lease_expires_at: null,
    updated_at: new Date(0),
  });
  await dbWrite.execute(sql`ALTER SEQUENCE agent_backup_admission_cohort_seq RESTART WITH 1`);
  await dbWrite.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "Backup admission cohort",
    slug: "backup-admission-cohort",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    steward_user_id: "backup-admission-cohort-user",
    organization_id: ORGANIZATION_ID,
  });
  await dbWrite.insert(dockerNodes).values({
    id: NODE_RECORD_ID,
    node_id: "cohort-node",
    hostname: "cohort-node.internal",
    host_key_fingerprint: "cohort-node-host-key",
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    node_incarnation: NODE_INCARNATION,
    metadata: { provider: "operator-onboarded" },
  });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("agent backup admission enrollment", () => {
  test("bounds enrollment lease owners by the database UTF-8 contract", () => {
    expect(requireAgentBackupAdmissionEnrollmentLeaseOwner("a".repeat(128))).toHaveLength(128);
    expect(() => requireAgentBackupAdmissionEnrollmentLeaseOwner("a".repeat(129))).toThrow(
      "at most 128 UTF-8 bytes",
    );
    expect(() => requireAgentBackupAdmissionEnrollmentLeaseOwner("🙂".repeat(33))).toThrow(
      "at most 128 UTF-8 bytes",
    );
    expect(() => requireAgentBackupAdmissionEnrollmentLeaseOwner("cohort\u0085worker")).toThrow(
      "no control characters",
    );
  });

  test("resumes strictly after the committed keyset cursor with one frozen RPO", async () => {
    await prioritizeShardZero();
    for (let index = 1; index <= 3; index += 1) {
      await insertAgent({
        id: uuidForShard(0, 0xe000 + index),
        generation: uuidForShard(32, 0xf000 + index),
        index,
      });
    }

    expect(await enroll("cohort-worker-a", 1, 60_000)).toMatchObject({
      shardId: 0,
      cohortId: "1",
      enrolled: 1,
      queued: 1,
      cohortComplete: false,
    });
    expect(await enroll("cohort-worker-after-restart", 1, 15 * 60_000)).toMatchObject({
      shardId: 0,
      cohortId: "1",
      enrolled: 1,
      queued: 1,
      cohortComplete: false,
    });
    expect(await enroll("cohort-worker-after-restart", 1, 15 * 60_000)).toMatchObject({
      shardId: 0,
      cohortId: "1",
      enrolled: 1,
      queued: 1,
      cohortComplete: true,
    });

    const work = await sqlRows<{
      sandbox_id: string;
      node_history_id: string;
      source_rpo_ms: number;
      priority_class: string;
      cohort_ordinal: number;
      deadline_seconds: number;
    }>(
      dbWrite,
      sql`
        SELECT sandbox_id, node_history_id, source_rpo_ms, priority_class,
          cohort_ordinal,
          EXTRACT(EPOCH FROM (rpo_deadline_at - source_due_at))::integer AS deadline_seconds
        FROM ${agentBackupAdmissionWork}
        ORDER BY cohort_ordinal
      `,
    );
    expect(work.map(({ cohort_ordinal }) => cohort_ordinal)).toEqual([0, 1, 2]);
    expect(work.every(({ source_rpo_ms }) => source_rpo_ms === 60_000)).toBe(true);
    expect(work.every(({ deadline_seconds }) => deadline_seconds === 60)).toBe(true);
    expect(work.every(({ priority_class }) => priority_class === "active_rpo")).toBe(true);
    expect(new Set(work.map(({ sandbox_id }) => sandbox_id)).size).toBe(3);
    expect(new Set(work.map(({ node_history_id }) => node_history_id)).size).toBe(1);
  });

  test("keeps concurrent calls on distinct stable shards duplicate-free", async () => {
    for (let shardId = 0; shardId < 8; shardId += 1) {
      await insertAgent({
        id: uuidForShard(shardId, 0xe100 + shardId),
        generation: uuidForShard(32 + shardId, 0xf100 + shardId),
        index: shardId + 1,
      });
    }

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => enroll(`parallel-cohort-worker-${index}`, 100)),
    );
    expect(new Set(results.map((result) => result?.shardId))).toEqual(
      new Set(Array.from({ length: 8 }, (_, shardId) => shardId)),
    );
    const work = await sqlRows<{ sandbox_id: string }>(
      dbWrite,
      sql`SELECT sandbox_id FROM ${agentBackupAdmissionWork}`,
    );
    expect(work).toHaveLength(8);
    expect(new Set(work.map(({ sandbox_id }) => sandbox_id)).size).toBe(8);
  });

  test("excludes a source occurrence rotated after the frozen snapshot", async () => {
    await prioritizeShardZero();
    for (let index = 1; index <= 3; index += 1) {
      await insertAgent({
        id: uuidForShard(0, 0xe200 + index),
        generation: uuidForShard(32, 0xf200 + index),
        index,
      });
    }
    expect(await enroll("source-snapshot-worker", 1)).toMatchObject({
      cohortId: "1",
      cohortComplete: false,
    });
    const [before] = await sqlRows<{ history_id: string }>(
      dbWrite,
      sql`SELECT current_node_history_id AS history_id FROM ${dockerNodes}`,
    );

    await dbWrite.update(dockerNodes).set({
      node_incarnation: ROTATED_NODE_INCARNATION,
      host_key_fingerprint: "cohort-node-host-key-rotated",
    });
    const [after] = await sqlRows<{ history_id: string }>(
      dbWrite,
      sql`SELECT current_node_history_id AS history_id FROM ${dockerNodes}`,
    );
    expect(after?.history_id).not.toBe(before?.history_id);
    expect(await enroll("source-snapshot-resume", 100)).toMatchObject({
      cohortId: "1",
      enrolled: 0,
      queued: 0,
      cohortComplete: true,
    });

    const work = await sqlRows<{ node_history_id: string }>(
      dbWrite,
      sql`SELECT node_history_id FROM ${agentBackupAdmissionWork}`,
    );
    expect(work).toEqual([{ node_history_id: before?.history_id }]);
  });

  test("defers a post-snapshot newcomer until the next cohort", async () => {
    await prioritizeShardZero();
    await insertAgent({
      id: uuidForShard(0, 0xe301),
      generation: uuidForShard(32, 0xf301),
      index: 1,
    });
    await insertAgent({
      id: uuidForShard(0, 0xe302),
      generation: uuidForShard(32, 0xf302),
      index: 2,
    });
    expect(await enroll("newcomer-cutoff-worker", 1)).toMatchObject({
      cohortId: "1",
      cohortComplete: false,
    });

    const newcomerId = uuidForShard(0, 0xe303);
    await insertAgent({
      id: newcomerId,
      generation: uuidForShard(32, 0xf303),
      index: 3,
    });
    expect(await enroll("newcomer-frozen-resume", 100)).toMatchObject({
      cohortId: "1",
      enrolled: 1,
      cohortComplete: true,
    });
    const firstCohort = await sqlRows<{ sandbox_id: string }>(
      dbWrite,
      sql`
        SELECT sandbox_id FROM ${agentBackupAdmissionWork}
        WHERE ready_cohort = 1
      `,
    );
    expect(firstCohort.map(({ sandbox_id }) => sandbox_id)).not.toContain(newcomerId);

    expect(await enroll("newcomer-next-cohort", 100)).toMatchObject({
      shardId: 0,
      cohortId: "2",
      enrolled: 1,
      queued: 1,
      cohortComplete: true,
    });
    const [newcomer] = await sqlRows<{ ready_cohort: string }>(
      dbWrite,
      sql`
        SELECT ready_cohort::text AS ready_cohort
        FROM ${agentBackupAdmissionWork}
        WHERE sandbox_id = ${newcomerId}
      `,
    );
    expect(newcomer?.ready_cohort).toBe("2");
  });

  test("keeps repeated enrollment idempotent with immutable due and deadline", async () => {
    await prioritizeShardZero();
    const sandboxId = uuidForShard(0, 0xe401);
    await insertAgent({
      id: sandboxId,
      generation: uuidForShard(32, 0xf401),
      index: 1,
      activationCompletedAt: new Date(Date.now() - 1_000),
    });
    expect(await enroll("idempotent-cohort-worker", 100, 15 * 60_000)).toMatchObject({
      enrolled: 1,
      queued: 1,
      cohortComplete: true,
    });
    const [first] = await sqlRows<{
      id: string;
      source_due_at: string;
      rpo_deadline_at: string;
      priority_class: string;
    }>(
      dbWrite,
      sql`
        SELECT id, source_due_at::text AS source_due_at,
          rpo_deadline_at::text AS rpo_deadline_at, priority_class
        FROM ${agentBackupAdmissionWork}
      `,
    );
    expect(first?.priority_class).toBe("periodic_capture");

    const repeats = await Promise.all(
      Array.from({ length: 4 }, (_, index) => enroll(`idempotent-repeat-${index}`, 100)),
    );
    expect(repeats.every((result) => result?.queued === 0)).toBe(true);
    const rows = await sqlRows<{
      id: string;
      source_due_at: string;
      rpo_deadline_at: string;
    }>(
      dbWrite,
      sql`
        SELECT id, source_due_at::text AS source_due_at,
          rpo_deadline_at::text AS rpo_deadline_at
        FROM ${agentBackupAdmissionWork}
        WHERE sandbox_id = ${sandboxId}
      `,
    );
    expect(rows).toEqual([
      {
        id: first?.id,
        source_due_at: first?.source_due_at,
        rpo_deadline_at: first?.rpo_deadline_at,
      },
    ]);
  });

  test("does not enroll backup work after account lifecycle leaves active", async () => {
    await prioritizeShardZero();
    const sandboxId = uuidForShard(0, 0xe501);
    await insertAgent({
      id: sandboxId,
      generation: uuidForShard(32, 0xf501),
      index: 1,
    });
    await dbWrite
      .update(organizations)
      .set({
        account_lifecycle_state: "deletion_recovery",
        account_lifecycle_revision: 1,
        is_active: false,
      })
      .where(sql`${organizations.id} = ${ORGANIZATION_ID}`);

    expect(await enroll("fenced-deletion-worker", 100)).toMatchObject({
      shardId: 0,
      enrolled: 0,
      queued: 0,
      cohortComplete: true,
    });
    const rows = await sqlRows<{ count: number; next_backup_at: string | null }>(
      dbWrite,
      sql`SELECT count(work.id)::int AS count, max(sandbox.next_backup_at)::text AS next_backup_at
        FROM ${agentSandboxes} AS sandbox
        LEFT JOIN ${agentBackupAdmissionWork} AS work ON work.sandbox_id = sandbox.id
        WHERE sandbox.id = ${sandboxId}`,
    );
    expect(rows).toEqual([{ count: 0, next_backup_at: null }]);
  });
});
