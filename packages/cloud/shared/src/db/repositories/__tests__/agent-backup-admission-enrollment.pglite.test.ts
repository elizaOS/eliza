/**
 * PGlite functional proofs for restartable periodic-backup cohort enrollment.
 *
 * The harness executes the migration stack and source-occurrence trigger, then
 * exercises concurrent repository calls and replay idempotence in one embedded
 * database runtime. The sibling PostgreSQL integration test owns independent-
 * session row-lock and `SKIP LOCKED` evidence.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";

const PGLITE_DATABASE_URL = "pglite://memory";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  MOCK_REDIS: process.env.MOCK_REDIS,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
};

// The client is imported dynamically below. Force both selectors first so an
// ambient integration-test DSN can never receive this suite's destructive DDL.
process.env.DATABASE_URL = PGLITE_DATABASE_URL;
process.env.TEST_DATABASE_URL = PGLITE_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { installAgentNodeOccurrenceTriggerForTests } from "../../agent-node-occurrence-test-support";
import { sqlRows } from "../../execute-helpers";
import {
  agentBackupAdmissionClaimShards,
  agentBackupAdmissionEnrollmentShards,
  agentBackupAdmissionWork,
  agentBackupNodeAdmissionCursors,
  agentBackupOrganizationAdmissionCursors,
  MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS,
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
  "0360_agent_backup_admission_claim_authority",
  "0361_agent_backup_admission_claim_seed",
  "0362_agent_backup_admission_claim_indexes",
  "0363_agent_backup_admission_claim_guard",
  "0364_agent_backup_admission_claim_eligibility",
  "0365_agent_backup_admission_unsettled_schedule_index",
  "0366_agent_backup_admission_enrollment_source_indexes",
  "0367_agent_backup_admission_enrollment_watermark_guard",
  "0368_agent_backup_admission_enrollment_source_stamp",
] as const;

type ClientModule = typeof import("../../client");
type EnrollmentRepository = typeof import("../agent-backup-admission-enrollment");

let schemaFailure = "";
let dbWrite: ClientModule["dbWrite"];
let closeDatabaseConnectionsForTests: ClientModule["closeDatabaseConnectionsForTests"] | undefined;
let getPgliteClientForTests: ClientModule["getPgliteClientForTests"] | undefined;
let enrollDueAgentBackupScheduleAdmissionCohort: EnrollmentRepository["enrollDueAgentBackupScheduleAdmissionCohort"];
let requireAgentBackupAdmissionEnrollmentLeaseOwner: EnrollmentRepository["requireAgentBackupAdmissionEnrollmentLeaseOwner"];

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function requirePGliteHarness(): ReturnType<ClientModule["getPgliteClientForTests"]> {
  if (
    process.env.DATABASE_URL !== PGLITE_DATABASE_URL ||
    process.env.TEST_DATABASE_URL !== PGLITE_DATABASE_URL
  ) {
    throw new Error("Backup admission enrollment cleanup requires isolated PGlite URLs");
  }
  if (!getPgliteClientForTests) {
    throw new Error("Backup admission enrollment PGlite client was not initialized");
  }
  return getPgliteClientForTests();
}

function uuidForShard(shardId: number, suffix: number): string {
  const firstByte = shardId.toString(16).padStart(2, "0");
  const tail = suffix.toString(16).padStart(12, "0");
  return `${firstByte}000000-0000-4000-8000-${tail}`;
}

function errorChainText(error: unknown): string {
  const details: string[] = [];
  let current = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof Error) details.push(current.message);
    if (typeof current !== "object") break;
    const record = current as { cause?: unknown; constraint?: unknown };
    if (typeof record.constraint === "string") details.push(record.constraint);
    current = record.cause;
  }
  return details.join("\n");
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

async function startClaimCycleForWork(workId: string): Promise<void> {
  await dbWrite.execute(sql`
    UPDATE ${agentBackupAdmissionClaimShards} AS shard
    SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
      cycle_observed_at = clock_timestamp(),
      cycle_max_cohort = 9223372036854775807,
      cycle_max_ordinal = 2147483647,
      cycle_max_id = work.id,
      cycle_aging_interval_ms = 900000,
      priority_pass = 0,
      updated_at = clock_timestamp()
    FROM ${agentBackupAdmissionWork} AS work
    WHERE work.id = ${workId}::uuid
      AND shard.work_kind = work.work_kind
      AND shard.shard_id = work.shard_id
  `);
}

async function exhaustRetryEpoch(workId: string, ownerPrefix: string): Promise<void> {
  let forgedExhaustionError: unknown;
  try {
    await dbWrite.execute(sql`
      UPDATE ${agentBackupAdmissionWork}
      SET state = 'settled', settled_at = clock_timestamp(),
        settled_reason = 'RETRY_EXHAUSTED', updated_at = clock_timestamp()
      WHERE id = ${workId}::uuid
    `);
  } catch (error) {
    forgedExhaustionError = error;
  }
  expect(errorChainText(forgedExhaustionError)).toMatch(/retry_exhaustion_check/i);

  await startClaimCycleForWork(workId);
  for (let attempt = 1; attempt <= MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS; attempt += 1) {
    await dbWrite.execute(sql`
      UPDATE ${agentBackupAdmissionWork}
      SET state = 'leased', lease_owner = ${`${ownerPrefix}-${attempt}`},
        lease_generation = ${randomUUID()}::uuid,
        lease_expires_at = clock_timestamp() + INTERVAL '1 hour',
        attempts = attempts + 1, updated_at = clock_timestamp()
      WHERE id = ${workId}::uuid
    `);
    if (attempt < MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS) {
      await dbWrite.execute(sql`
        UPDATE ${agentBackupAdmissionWork}
        SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
          lease_expires_at = NULL, ready_cohort = ready_cohort + 1,
          updated_at = clock_timestamp()
        WHERE id = ${workId}::uuid
      `);
    }
  }
  await dbWrite.execute(sql`
    UPDATE ${agentBackupAdmissionWork}
    SET state = 'settled', lease_owner = NULL, lease_generation = NULL,
      lease_expires_at = NULL, settled_at = clock_timestamp(),
      settled_reason = 'RETRY_EXHAUSTED', updated_at = clock_timestamp()
    WHERE id = ${workId}::uuid
  `);
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
    const [clientModule, repositoryModule] = await Promise.all([
      import("../../client"),
      import("../agent-backup-admission-enrollment"),
    ]);
    dbWrite = clientModule.dbWrite;
    closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
    getPgliteClientForTests = clientModule.getPgliteClientForTests;
    enrollDueAgentBackupScheduleAdmissionCohort =
      repositoryModule.enrollDueAgentBackupScheduleAdmissionCohort;
    requireAgentBackupAdmissionEnrollmentLeaseOwner =
      repositoryModule.requireAgentBackupAdmissionEnrollmentLeaseOwner;
    requirePGliteHarness();

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
  requirePGliteHarness();
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
  try {
    await closeDatabaseConnectionsForTests?.();
  } finally {
    restoreEnvironment();
  }
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
      cohortComplete: false,
    });
    // Earlier initial rows now have next_backup_at. The complementary raw RPO
    // probe must durably cross those residual keys before declaring the frozen
    // global merge complete, without assigning them duplicate work ordinals.
    expect(await enroll("cohort-worker-after-restart", 1, 15 * 60_000)).toMatchObject({
      shardId: 0,
      cohortId: "1",
      enrolled: 0,
      queued: 0,
      cohortComplete: false,
    });
    expect(await enroll("cohort-worker-after-restart", 1, 15 * 60_000)).toMatchObject({
      shardId: 0,
      cohortId: "1",
      enrolled: 0,
      queued: 0,
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

  test("defers repaired tier and deletion guards beyond the frozen cohort", async () => {
    await prioritizeShardZero();
    const futureTierId = uuidForShard(0, 0xe680);
    const softDeletedId = uuidForShard(0, 0xe681);
    const deletionOwnedId = uuidForShard(0, 0xe682);
    const admittedAId = uuidForShard(0, 0xe690);
    const admittedBId = uuidForShard(0, 0xe691);
    const invalidIds = [futureTierId, softDeletedId, deletionOwnedId];

    for (const [index, id] of invalidIds.entries()) {
      await insertAgent({
        id,
        generation: uuidForShard(32, 0xf680 + index),
        index: index + 1,
      });
    }
    for (const [index, id] of [admittedAId, admittedBId].entries()) {
      await insertAgent({
        id,
        generation: uuidForShard(32, 0xf690 + index),
        index: index + 4,
        activationCompletedAt: new Date("2026-08-16T00:00:03.000Z"),
      });
    }
    let firstEnrollment: Awaited<ReturnType<typeof enroll>> | undefined;
    let initiallyRejected: Array<{
      id: string;
      next_backup_at: string | null;
      work_count: number;
      xid: string;
    }> = [];
    try {
      // Model a tier added by a later schema revision while retaining this
      // enrollment repository. The canonical allowlist must fail closed.
      await dbWrite.execute(sql`
        UPDATE ${agentSandboxes}
        SET execution_tier = 'dedicated-future',
          activation_lifecycle_revision = lifecycle_revision + 1
        WHERE id = ${futureTierId}::uuid
      `);
      await dbWrite
        .update(agentSandboxes)
        .set({
          deleted_at: new Date("2026-08-16T00:00:04.000Z"),
          activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
        })
        .where(sql`${agentSandboxes.id} = ${softDeletedId}::uuid`);
      await dbWrite
        .update(agentSandboxes)
        .set({
          deletion_attempt_id: "70000000-0000-4000-8000-00000000e680",
          deletion_started_at: new Date("2026-08-16T00:00:04.000Z"),
          activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
        })
        .where(sql`${agentSandboxes.id} = ${deletionOwnedId}::uuid`);

      firstEnrollment = await enroll("eligibility-snapshot-a", 1);
      initiallyRejected = await sqlRows<{
        id: string;
        next_backup_at: string | null;
        work_count: number;
        xid: string;
      }>(
        dbWrite,
        sql`SELECT sandbox.id::text AS id, sandbox.next_backup_at::text AS next_backup_at,
            sandbox.backup_admission_xid::text AS xid,
            (SELECT count(*)::integer FROM ${agentBackupAdmissionWork} AS work
              WHERE work.sandbox_id = sandbox.id) AS work_count
          FROM ${agentSandboxes} AS sandbox
          WHERE sandbox.id IN (${futureTierId}::uuid, ${softDeletedId}::uuid,
            ${deletionOwnedId}::uuid)
          ORDER BY sandbox.id`,
      );
    } finally {
      await dbWrite.execute(sql`
        UPDATE ${agentSandboxes}
        SET execution_tier = 'dedicated-always',
          activation_lifecycle_revision = lifecycle_revision + 1
        WHERE id = ${futureTierId}::uuid
      `);
    }

    expect(firstEnrollment).toMatchObject({
      shardId: 0,
      cohortId: "1",
      enrolled: 1,
      queued: 1,
      cohortComplete: false,
    });
    expect(initiallyRejected).toHaveLength(3);
    expect(
      initiallyRejected.every(
        ({ next_backup_at, work_count }) => next_backup_at === null && work_count === 0,
      ),
    ).toBe(true);
    const previousXids = new Map(initiallyRejected.map(({ id, xid }) => [id, xid]));

    await dbWrite
      .update(agentSandboxes)
      .set({
        deleted_at: null,
        activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
      })
      .where(sql`${agentSandboxes.id} = ${softDeletedId}::uuid`);
    await dbWrite
      .update(agentSandboxes)
      .set({
        deletion_attempt_id: null,
        deletion_started_at: null,
        activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
      })
      .where(sql`${agentSandboxes.id} = ${deletionOwnedId}::uuid`);

    const repaired = await sqlRows<{ id: string; visible: boolean; xid: string }>(
      dbWrite,
      sql`SELECT sandbox.id::text AS id, sandbox.backup_admission_xid::text AS xid,
          agent_backup_admission_source_visible(
            sandbox.backup_admission_xid, shard.scan_snapshot
          ) AS visible
        FROM ${agentSandboxes} AS sandbox
        JOIN ${agentBackupAdmissionEnrollmentShards} AS shard
          ON shard.work_kind = 'schedule_capture' AND shard.shard_id = 0
        WHERE sandbox.id IN (${futureTierId}::uuid, ${softDeletedId}::uuid,
          ${deletionOwnedId}::uuid)
        ORDER BY sandbox.id`,
    );
    expect(repaired).toHaveLength(3);
    expect(repaired.every(({ id, xid }) => xid !== previousXids.get(id))).toBe(true);
    expect(repaired.every(({ visible }) => !visible)).toBe(true);

    expect(await enroll("eligibility-snapshot-b", 100)).toMatchObject({
      shardId: 0,
      cohortId: "1",
      enrolled: 1,
      queued: 1,
      cohortComplete: true,
    });
    const firstCohort = await sqlRows<{ sandbox_id: string }>(
      dbWrite,
      sql`SELECT sandbox_id::text AS sandbox_id FROM ${agentBackupAdmissionWork}
        WHERE ready_cohort = 1 ORDER BY sandbox_id`,
    );
    expect(firstCohort.map(({ sandbox_id }) => sandbox_id)).toEqual([admittedAId, admittedBId]);

    expect(await enroll("eligibility-snapshot-next", 100)).toMatchObject({
      shardId: 0,
      cohortId: "2",
      enrolled: 3,
      queued: 3,
      cohortComplete: true,
    });
    const secondCohort = await sqlRows<{ sandbox_id: string }>(
      dbWrite,
      sql`SELECT sandbox_id::text AS sandbox_id FROM ${agentBackupAdmissionWork}
        WHERE ready_cohort = 2 ORDER BY sandbox_id`,
    );
    expect(secondCohort.map(({ sandbox_id }) => sandbox_id)).toEqual(invalidIds);
  });

  test("merges equal due keys across all raw frontiers without persisting the sentinel", async () => {
    await prioritizeShardZero();
    const dueAt = new Date("2026-08-16T00:10:00.000Z");
    const anchorAt = new Date(dueAt.getTime() - 60_000);
    const initialId = uuidForShard(0, 0xe600);
    const scheduledId = uuidForShard(0, 0xe601);
    const rpoId = uuidForShard(0, 0xe602);
    await insertAgent({
      id: initialId,
      generation: uuidForShard(32, 0xf600),
      index: 1,
      activationCompletedAt: dueAt,
    });
    await insertAgent({
      id: scheduledId,
      generation: uuidForShard(32, 0xf601),
      index: 2,
      activationCompletedAt: anchorAt,
    });
    await insertAgent({
      id: rpoId,
      generation: uuidForShard(32, 0xf602),
      index: 3,
      activationCompletedAt: anchorAt,
    });
    await dbWrite.execute(sql`
      UPDATE ${agentSandboxes}
      SET next_backup_at = CASE id
        WHEN ${scheduledId}::uuid THEN ${dueAt}::timestamptz
        WHEN ${rpoId}::uuid THEN ${new Date(dueAt.getTime() + 60_000)}::timestamptz
        ELSE next_backup_at END
      WHERE id IN (${scheduledId}::uuid, ${rpoId}::uuid)
    `);

    expect(await enroll("watermark-tie-a", 1)).toMatchObject({
      enrolled: 1,
      queued: 1,
      cohortComplete: false,
    });
    const [firstProgress] = await sqlRows<{
      scan_cursor_due_at: string;
      scan_cursor_id: string;
      scan_cursor_ordinal: number;
    }>(
      dbWrite,
      sql`SELECT scan_cursor_due_at::text AS scan_cursor_due_at,
          scan_cursor_id::text AS scan_cursor_id, scan_cursor_ordinal
        FROM ${agentBackupAdmissionEnrollmentShards}
        WHERE work_kind = 'schedule_capture' AND shard_id = 0`,
    );
    expect(firstProgress?.scan_cursor_id).toBe(initialId);
    expect(firstProgress?.scan_cursor_ordinal).toBe(0);
    expect(new Date(firstProgress?.scan_cursor_due_at ?? 0).getTime()).toBe(dueAt.getTime());

    expect(await enroll("watermark-tie-b", 1)).toMatchObject({
      enrolled: 1,
      queued: 1,
      cohortComplete: false,
    });
    expect(await enroll("watermark-tie-c", 1)).toMatchObject({
      enrolled: 1,
      queued: 1,
      cohortComplete: false,
    });
    expect(await enroll("watermark-tie-drain", 1)).toMatchObject({
      enrolled: 0,
      queued: 0,
      cohortComplete: true,
    });

    const work = await sqlRows<{
      cohort_ordinal: number;
      sandbox_id: string;
      source_due_at: string;
    }>(
      dbWrite,
      sql`SELECT cohort_ordinal, sandbox_id, source_due_at::text AS source_due_at
        FROM ${agentBackupAdmissionWork}
        ORDER BY cohort_ordinal`,
    );
    expect(work.map(({ sandbox_id }) => sandbox_id)).toEqual([initialId, scheduledId, rpoId]);
    expect(work.map(({ cohort_ordinal }) => cohort_ordinal)).toEqual([0, 1, 2]);
    expect(
      work.every(({ source_due_at }) => new Date(source_due_at).getTime() === dueAt.getTime()),
    ).toBe(true);
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

  test("re-enrolls an exhausted exact due while preserving successful replay fences", async () => {
    await prioritizeShardZero();
    const sandboxId = uuidForShard(0, 0xe425);
    await insertAgent({
      id: sandboxId,
      generation: uuidForShard(32, 0xf425),
      index: 1,
    });
    expect(await enroll("retry-epoch-initial", 100)).toMatchObject({
      shardId: 0,
      enrolled: 1,
      queued: 1,
      cohortComplete: true,
    });
    const [initial] = await sqlRows<{ id: string; source_due_at: string }>(
      dbWrite,
      sql`SELECT id, source_due_at::text AS source_due_at
        FROM ${agentBackupAdmissionWork}
        WHERE sandbox_id = ${sandboxId}`,
    );
    if (!initial) throw new Error("Initial retry epoch was not enrolled");
    await exhaustRetryEpoch(initial.id, "retry-epoch");
    const [exhausted] = await sqlRows<{ document: string }>(
      dbWrite,
      sql`SELECT row_to_json(work)::text AS document
        FROM ${agentBackupAdmissionWork} AS work
        WHERE id = ${initial.id}::uuid`,
    );

    const concurrent = await Promise.all(
      Array.from({ length: 4 }, (_, index) => enroll(`retry-epoch-fresh-${index}`, 100)),
    );
    expect(concurrent.reduce((total, result) => total + (result?.queued ?? 0), 0)).toBe(1);
    const epochs = await sqlRows<{
      attempts: number;
      id: string;
      settled_reason: string | null;
      source_due_at: string;
      state: string;
    }>(
      dbWrite,
      sql`SELECT id, state, attempts, settled_reason,
          source_due_at::text AS source_due_at
        FROM ${agentBackupAdmissionWork}
        WHERE sandbox_id = ${sandboxId}
        ORDER BY id`,
    );
    expect(epochs).toHaveLength(2);
    expect(epochs.find(({ id }) => id === initial.id)).toEqual({
      attempts: MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS,
      id: initial.id,
      settled_reason: "RETRY_EXHAUSTED",
      source_due_at: initial.source_due_at,
      state: "settled",
    });
    const fresh = epochs.find(({ id }) => id !== initial.id);
    expect(fresh).toMatchObject({
      attempts: 0,
      settled_reason: null,
      source_due_at: initial.source_due_at,
      state: "queued",
    });
    const [unchangedExhausted] = await sqlRows<{ document: string }>(
      dbWrite,
      sql`SELECT row_to_json(work)::text AS document
        FROM ${agentBackupAdmissionWork} AS work
        WHERE id = ${initial.id}::uuid`,
    );
    expect(unchangedExhausted?.document).toBe(exhausted?.document);
    expect(await enroll("retry-epoch-idempotent", 100)).toMatchObject({ queued: 0 });

    if (!fresh) throw new Error("Fresh retry epoch was not enrolled");
    await dbWrite.execute(sql`
      UPDATE ${agentBackupAdmissionWork}
      SET state = 'leased', lease_owner = 'retry-epoch-success',
        lease_generation = ${randomUUID()}::uuid,
        lease_expires_at = clock_timestamp() + INTERVAL '1 hour',
        attempts = attempts + 1, updated_at = clock_timestamp()
      WHERE id = ${fresh.id}::uuid
    `);
    await dbWrite.execute(sql`
      UPDATE ${agentBackupAdmissionWork}
      SET state = 'settled', lease_owner = NULL, lease_generation = NULL,
        lease_expires_at = NULL, settled_at = clock_timestamp(),
        settled_reason = 'CAPTURE_RESERVED', updated_at = clock_timestamp()
      WHERE id = ${fresh.id}::uuid
    `);
    expect(await enroll("retry-epoch-reserved-fence", 100)).toMatchObject({ queued: 0 });
    const [finalCount] = await sqlRows<{ count: number }>(
      dbWrite,
      sql`SELECT count(*)::integer AS count
        FROM ${agentBackupAdmissionWork}
        WHERE sandbox_id = ${sandboxId}`,
    );
    expect(finalCount?.count).toBe(2);
  });

  test("reuses one unsettled schedule authority when the RPO tightens", async () => {
    await prioritizeShardZero();
    const sandboxId = uuidForShard(0, 0xe451);
    const generation = uuidForShard(32, 0xf451);
    const activationCompletedAt = new Date(Date.now() - 20 * 60_000);
    const originalDueAt = new Date(activationCompletedAt.getTime() + 15 * 60_000);
    await insertAgent({
      id: sandboxId,
      generation,
      index: 1,
      activationCompletedAt,
    });
    await dbWrite
      .update(agentSandboxes)
      .set({ next_backup_at: originalDueAt })
      .where(sql`${agentSandboxes.id} = ${sandboxId}`);

    expect(await enroll("rpo-policy-original", 100, 15 * 60_000)).toMatchObject({
      shardId: 0,
      enrolled: 1,
      queued: 1,
      cohortComplete: true,
    });
    const [before] = await sqlRows<{
      document: string;
      id: string;
      work_kind: string;
      work_stage: string;
      source_due_at: string;
    }>(
      dbWrite,
      sql`
        SELECT row_to_json(work)::text AS document, id, work_kind, work_stage,
          source_due_at::text AS source_due_at
        FROM ${agentBackupAdmissionWork} AS work
        WHERE sandbox_id = ${sandboxId}
      `,
    );
    expect(before).toMatchObject({
      work_kind: "schedule_capture",
      work_stage: "reserve_capture",
    });
    expect(new Date(before?.source_due_at ?? 0).getTime()).toBe(originalDueAt.getTime());

    expect(await enroll("rpo-policy-tightened-a", 100, 60_000)).toMatchObject({
      shardId: 0,
      enrolled: 0,
      queued: 0,
      cohortComplete: true,
    });
    await dbWrite.execute(sql`
      UPDATE ${agentBackupAdmissionWork}
      SET state = 'deferred', deferred_reason = 'CAPACITY_WAIT',
        not_before = clock_timestamp() + INTERVAL '5 minutes', updated_at = clock_timestamp()
      WHERE id = ${before?.id}::uuid
    `);
    const [deferred] = await sqlRows<{ document: string }>(
      dbWrite,
      sql`
        SELECT row_to_json(work)::text AS document
        FROM ${agentBackupAdmissionWork} AS work
        WHERE id = ${before?.id}::uuid
      `,
    );
    expect(await enroll("rpo-policy-tightened-b", 100, 60_000)).toMatchObject({
      shardId: 0,
      enrolled: 0,
      queued: 0,
      cohortComplete: true,
    });
    const unchanged = await sqlRows<{
      document: string;
      unsettled: number;
      next_backup_at: string;
    }>(
      dbWrite,
      sql`
        SELECT row_to_json(work)::text AS document,
          count(*) FILTER (WHERE work.state <> 'settled') OVER ()::integer AS unsettled,
          sandbox.next_backup_at::text AS next_backup_at
        FROM ${agentBackupAdmissionWork} AS work
        JOIN ${agentSandboxes} AS sandbox ON sandbox.id = work.sandbox_id
        WHERE work.sandbox_id = ${sandboxId}
      `,
    );
    expect(unchanged).toHaveLength(1);
    expect(unchanged[0]).toMatchObject({ document: deferred?.document, unsettled: 1 });
    expect(new Date(unchanged[0]?.next_backup_at ?? 0).getTime()).toBe(originalDueAt.getTime());

    await dbWrite.execute(sql`
      UPDATE ${agentBackupAdmissionWork}
      SET state = 'settled', deferred_reason = NULL, settled_at = clock_timestamp(),
        settled_reason = 'CAPTURE_COMPLETED', updated_at = clock_timestamp()
      WHERE id = ${before?.id}::uuid
    `);
    expect(await enroll("rpo-policy-after-settlement", 100, 60_000)).toMatchObject({
      shardId: 0,
      enrolled: 1,
      queued: 1,
      cohortComplete: true,
    });
    const [replacement] = await sqlRows<{
      total: number;
      unsettled: number;
      source_due_at: string;
      work_kind: string;
      work_stage: string;
    }>(
      dbWrite,
      sql`
        SELECT count(*) OVER ()::integer AS total,
          count(*) FILTER (WHERE state <> 'settled') OVER ()::integer AS unsettled,
          source_due_at::text AS source_due_at, work_kind, work_stage
        FROM ${agentBackupAdmissionWork}
        WHERE sandbox_id = ${sandboxId}
        ORDER BY source_due_at
        LIMIT 1
      `,
    );
    expect(replacement).toMatchObject({
      total: 2,
      unsettled: 1,
      work_kind: "schedule_capture",
      work_stage: "reserve_capture",
    });
    expect(new Date(replacement?.source_due_at ?? 0).getTime()).toBe(
      activationCompletedAt.getTime() + 60_000,
    );
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
