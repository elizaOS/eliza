/** Real-PGlite proofs for durable periodic-capture queue claiming and fencing. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const { closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } = await import(
  "../../client"
);
const {
  claimAgentBackupAdmissionWork,
  claimAgentBackupAdmissionWorkTurn,
  countUnsettledAgentBackupAdmissionWork,
  deferAgentBackupAdmissionClaim,
  heartbeatAgentBackupAdmissionClaim,
  MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS,
  settleAgentBackupAdmissionClaim,
} = await import("../agent-backup-admission-claim");
const { MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS } = await import(
  "../../schemas/agent-backup-admission"
);

const TIMEOUT = 60_000;
const IMAGE = `sha256:${"9".repeat(64)}`;
const HOST_KEY = "SHA256:backup-admission-test-host";
const OWNER_A = "schedule-worker-a";
const OWNER_B = "schedule-worker-b";
const WRONG_GENERATION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CLAIM_SHARD_GUARD_SQL = await Bun.file(
  new URL("../../migrations/0363_agent_backup_admission_claim_guard.sql", import.meta.url),
).text();
const CLAIM_ELIGIBILITY_SQL = await Bun.file(
  new URL("../../migrations/0364_agent_backup_admission_claim_eligibility.sql", import.meta.url),
).text();
const CLAIM_RECOVERY_CURSOR_SQL = await Bun.file(
  new URL("../../migrations/0369_agent_backup_admission_recovery_cursor.sql", import.meta.url),
).text();
const WORK_IDENTITY_GUARD_SQL = await Bun.file(
  new URL("../../migrations/0356_agent_backup_admission_work_identity_guard.sql", import.meta.url),
).text();
const WORK_STATE_GUARD_SQL = await Bun.file(
  new URL("../../migrations/0357_agent_backup_admission_work_state_guard.sql", import.meta.url),
).text();
const CLAIM_AUTHORITY_SQL = await Bun.file(
  new URL("../../migrations/0360_agent_backup_admission_claim_authority.sql", import.meta.url),
).text();
const CLAIM_SEED_SQL = await Bun.file(
  new URL("../../migrations/0361_agent_backup_admission_claim_seed.sql", import.meta.url),
).text();

interface SourceSeed {
  workId: string;
  organizationId: string;
  sandboxId: string;
  nodeRecordId: string;
  nodeHistoryId: string;
  nodeId: string;
  incarnation: string;
  activationGeneration: string;
  providerHandle: string;
  containerId: string;
  dueAt: Date | string;
  priorityClass?: "lifecycle_safety" | "active_rpo" | "drain_recovery" | "periodic_capture";
  basePriority?: 0 | 1 | 2 | 3;
  state?: "queued" | "deferred" | "leased" | "settled";
  attempts?: number;
  readyCohort?: bigint;
  cohortOrdinal?: number;
  shardId?: number;
}

const ids = (offset: number) => {
  const suffix = offset.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${suffix}`;
};

function source(offset: number, overrides: Partial<SourceSeed> = {}): SourceSeed {
  const shardId = overrides.shardId ?? 0;
  return {
    // Work UUIDs are opaque tie-breakers. Their first byte intentionally maps
    // away from the source-derived shard zero used by these fixtures.
    workId: ids(offset).replace(/^00/, "11"),
    organizationId: ids(offset + 100),
    sandboxId: ids(offset + 200).replace(/^[0-9a-f]{2}/, shardId.toString(16).padStart(2, "0")),
    nodeRecordId: ids(offset + 300),
    nodeHistoryId: ids(offset + 400),
    nodeId: `backup-node-${offset}`,
    incarnation: ids(offset + 500),
    activationGeneration: ids(offset + 600),
    providerHandle: `provider-handle-${offset}`,
    containerId: offset.toString(16).padStart(64, "a").slice(-64),
    dueAt: new Date(Date.now() - 30_000),
    priorityClass: "periodic_capture",
    basePriority: 3,
    state: "queued",
    attempts: 0,
    shardId,
    ...overrides,
  };
}

function microTimestamp(baseMs: number, microseconds: number): string {
  const base = new Date(Math.floor(baseMs / 1000) * 1000).toISOString();
  return base.replace(".000Z", `.${microseconds.toString().padStart(6, "0")}+00:00`);
}

async function seedSource(params: SourceSeed): Promise<void> {
  const dueAtMs = new Date(params.dueAt).getTime();
  if (!Number.isFinite(dueAtMs)) throw new Error("Source fixture dueAt must be valid");
  await dbWrite.execute(sql`INSERT INTO organizations (
      id, account_lifecycle_state, is_active, account_deletion_request_id
    ) VALUES (${params.organizationId}::uuid, 'active', TRUE, NULL)
    ON CONFLICT (id) DO NOTHING`);
  await dbWrite.execute(sql`INSERT INTO agent_node_incarnation_histories (
      id, docker_node_record_id, node_id, node_incarnation, fleet_kind,
      infrastructure_provider, provider_server_id, host_key_fingerprint
    ) VALUES (
      ${params.nodeHistoryId}::uuid, ${params.nodeRecordId}::uuid, ${params.nodeId},
      ${params.incarnation}::uuid, 'robot', 'hetzner', NULL, ${HOST_KEY}
    ) ON CONFLICT (id) DO NOTHING`);
  await dbWrite.execute(sql`INSERT INTO docker_nodes (
      id, node_id, node_incarnation, current_node_history_id, fleet_kind,
      infrastructure_provider, provider_server_id, host_key_fingerprint
    ) VALUES (
      ${params.nodeRecordId}::uuid, ${params.nodeId}, ${params.incarnation}::uuid,
      ${params.nodeHistoryId}::uuid, 'robot', 'hetzner', NULL, ${HOST_KEY}
    ) ON CONFLICT (id) DO UPDATE SET
      current_node_history_id = EXCLUDED.current_node_history_id`);
  await dbWrite.execute(sql`INSERT INTO agent_sandboxes (
      id, organization_id, status, pool_status, execution_tier, sandbox_id,
      node_id, image_digest, lifecycle_revision, activation_generation,
      activation_lifecycle_revision, activation_phase, activation_container_id,
      activation_node_id, activation_image_digest, activation_boot_id,
      activation_authority_published_at, activation_dispatched_at,
      activation_completed_at, next_backup_at
    ) VALUES (
      ${params.sandboxId}::uuid, ${params.organizationId}::uuid, 'running', NULL,
      'dedicated-always', ${params.providerHandle}, ${params.nodeId}, ${IMAGE}, 7,
      ${params.activationGeneration}::uuid, 7, 'active', ${params.containerId},
      ${params.nodeId}, ${IMAGE}, ${params.incarnation}::uuid,
      clock_timestamp() - INTERVAL '3 seconds',
      clock_timestamp() - INTERVAL '2 seconds',
      clock_timestamp() - INTERVAL '1 second', ${params.dueAt}
    )`);
  await dbWrite.execute(sql`INSERT INTO agent_backup_organization_admission_cursors (
      organization_id
    ) VALUES (${params.organizationId}::uuid)
    ON CONFLICT (organization_id) DO NOTHING`);
  await dbWrite.execute(sql`INSERT INTO agent_backup_node_admission_cursors (
      node_history_id
    ) VALUES (${params.nodeHistoryId}::uuid)
    ON CONFLICT (node_history_id) DO NOTHING`);

  const deferredReason = params.state === "deferred" ? "TEST_BACKPRESSURE" : null;
  const settledReason = params.state === "settled" ? "TEST_SETTLED" : null;
  await dbWrite.execute(sql`INSERT INTO agent_backup_admission_work (
      id, work_kind, work_stage, organization_id, sandbox_id, node_history_id,
      source_activation_generation, source_lifecycle_revision,
      source_provider_handle, source_container_id, source_image_digest,
      source_rpo_ms, requires_node_lane, priority_class, base_priority,
      source_due_at, rpo_deadline_at, first_eligible_at, state, not_before,
      deferred_reason, ready_cohort, cohort_ordinal, shard_id, attempts,
      settled_at, settled_reason
    ) VALUES (
      ${params.workId}::uuid, 'schedule_capture', 'reserve_capture',
      ${params.organizationId}::uuid, ${params.sandboxId}::uuid,
      ${params.nodeHistoryId}::uuid, ${params.activationGeneration}::uuid, 7,
      ${params.providerHandle}, ${params.containerId}, ${IMAGE}, 900000, TRUE,
      ${params.priorityClass}, ${params.basePriority}, ${params.dueAt},
      ${new Date(dueAtMs + 900_000)}, ${params.dueAt},
      ${params.state}, ${params.dueAt}, ${deferredReason},
      ${params.readyCohort ?? BigInt(`0x${params.workId.slice(-4)}`)},
      ${params.cohortOrdinal ?? 0}, ${params.shardId ?? 0}, ${params.attempts},
      ${params.state === "settled" ? new Date() : null}, ${settledReason}
    )`);
}

function fence(claim: Awaited<ReturnType<typeof claimAgentBackupAdmissionWork>>[number]) {
  return {
    workId: claim.workId,
    ownerId: claim.ownerId,
    generation: claim.generation,
    workAttempt: claim.workAttempt,
    claimCycleStartTurn: claim.claimCycleStartTurn,
    claimProofTurn: claim.claimProofTurn,
    claimProofXid: claim.claimProofXid,
    claimProofPriorityPass: claim.claimProofPriorityPass,
  };
}

type ClaimParams = Parameters<typeof claimAgentBackupAdmissionWork>[0];
type ClaimBatch = Awaited<ReturnType<typeof claimAgentBackupAdmissionWork>>;

const MAX_TEST_PROGRESS_TURNS = 32;

async function driveUntilClaim(
  params: ClaimParams,
  maxTurns = MAX_TEST_PROGRESS_TURNS,
): Promise<{ claims: ClaimBatch; progressTurns: number }> {
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const claims = await claimAgentBackupAdmissionWork(params);
    if (claims.length > 0) {
      return { claims, progressTurns: turn - 1 };
    }
  }
  throw new Error(`No admission claim after ${maxTurns} bounded progress turns`);
}

async function scheduleShardCycleActive(shardId = 0): Promise<boolean> {
  const result = await dbWrite.execute(sql`SELECT cycle_observed_at IS NOT NULL AS active
    FROM agent_backup_admission_claim_shards
    WHERE work_kind = 'schedule_capture' AND shard_id = ${shardId}`);
  return (result.rows[0] as { active: boolean } | undefined)?.active ?? false;
}

async function driveUntilScheduleShardIdle(
  params: ClaimParams,
  maxTurns = MAX_TEST_PROGRESS_TURNS,
): Promise<{ batches: ClaimBatch[]; turns: number }> {
  let observedActiveCycle = await scheduleShardCycleActive();
  const batches: ClaimBatch[] = [];

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const claims = await claimAgentBackupAdmissionWork(params);
    batches.push(claims);
    const active = await scheduleShardCycleActive();
    observedActiveCycle ||= active;
    if (observedActiveCycle && !active) return { batches, turns: turn };
  }
  throw new Error(`Schedule admission shard did not become idle after ${maxTurns} turns`);
}

async function readyCohort(workId: string): Promise<bigint> {
  const result = await dbWrite.execute(sql`SELECT ready_cohort::text AS ready_cohort
    FROM agent_backup_admission_work WHERE id = ${workId}::uuid`);
  const row = result.rows[0] as { ready_cohort: string } | undefined;
  if (!row) throw new Error(`Missing admission work ${workId}`);
  return BigInt(row.ready_cohort);
}

async function executeStatements(source: string): Promise<void> {
  for (const statement of source.split(";")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
}

beforeAll(async () => {
  getPgliteClientForTests();
  await executeStatements(`
    CREATE OR REPLACE FUNCTION agent_backup_admission_expected_shard(source_id uuid)
    RETURNS smallint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$ SELECT (get_byte(uuid_send(source_id), 0) % 64)::smallint $$;
    CREATE SEQUENCE agent_backup_admission_cohort_seq;
    CREATE TABLE organizations (
      id uuid PRIMARY KEY, account_lifecycle_state text NOT NULL DEFAULT 'active',
      is_active boolean NOT NULL DEFAULT TRUE, account_deletion_request_id uuid
    );
    CREATE TABLE agent_node_incarnation_histories (
      id uuid PRIMARY KEY, docker_node_record_id uuid NOT NULL, node_id text NOT NULL,
      node_incarnation uuid NOT NULL, fleet_kind text NOT NULL,
      infrastructure_provider text NOT NULL, provider_server_id text,
      host_key_fingerprint text NOT NULL
    );
    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY, node_id text NOT NULL, node_incarnation uuid,
      current_node_history_id uuid, fleet_kind text, infrastructure_provider text,
      provider_server_id text, host_key_fingerprint text
    );
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, status text NOT NULL,
      pool_status text, execution_tier text NOT NULL, sandbox_id text, node_id text,
      image_digest text, lifecycle_revision bigint NOT NULL, deletion_attempt_id uuid,
      deleted_at timestamptz,
      activation_generation uuid, activation_lifecycle_revision bigint,
      activation_phase text, activation_container_id text, activation_node_id text,
      activation_image_digest text, activation_boot_id uuid,
      activation_authority_published_at timestamptz,
      activation_dispatched_at timestamptz, activation_completed_at timestamptz,
      next_backup_at timestamptz
    );
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY, catalog_organization_id uuid, catalog_state text,
      catalog_resume_state text, source_node_history_id uuid,
      source_node_record_id uuid, source_node_incarnation uuid
    );
    CREATE TABLE agent_backup_organization_admission_cursors (
      organization_id uuid PRIMARY KEY, cursor_at timestamptz, updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE agent_backup_node_admission_cursors (
      node_history_id uuid PRIMARY KEY, cursor_at timestamptz, updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE agent_backup_admission_work (
      id uuid PRIMARY KEY, work_kind text NOT NULL, work_stage text NOT NULL,
      organization_id uuid NOT NULL, sandbox_id uuid, backup_id uuid, gc_object_id uuid,
      node_history_id uuid, source_activation_generation uuid,
      source_lifecycle_revision bigint, source_provider_handle text,
      source_container_id text, source_image_digest text, source_rpo_ms integer,
      requires_node_lane boolean NOT NULL, priority_class text NOT NULL,
      base_priority smallint NOT NULL, source_due_at timestamptz NOT NULL,
      rpo_deadline_at timestamptz, first_eligible_at timestamptz NOT NULL,
      state text NOT NULL, not_before timestamptz NOT NULL, deferred_reason text,
      ready_cohort bigint NOT NULL, cohort_ordinal integer NOT NULL, shard_id smallint NOT NULL,
      lease_owner text, lease_generation uuid, lease_expires_at timestamptz,
      attempts integer NOT NULL DEFAULT 0, settled_at timestamptz, settled_reason text,
      claim_cycle_start_turn bigint, claim_proof_turn bigint, claim_proof_xid xid8,
      claim_proof_priority_pass smallint, claim_proof_attempt integer,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX admission_one_leased_org
      ON agent_backup_admission_work (organization_id) WHERE state = 'leased';
    CREATE UNIQUE INDEX admission_one_leased_node
      ON agent_backup_admission_work (node_history_id)
      WHERE state = 'leased' AND node_history_id IS NOT NULL;
  `);
  await dbWrite.execute(
    sql.raw(`
    CREATE OR REPLACE FUNCTION guard_agent_backup_admission_shard_removal()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'backup admission shard authorities cannot be removed'
        USING ERRCODE = '55000';
    END
    $$
  `),
  );
  for (const statement of WORK_IDENTITY_GUARD_SQL.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
  for (const statement of WORK_STATE_GUARD_SQL.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
  for (const statement of CLAIM_AUTHORITY_SQL.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
  for (const statement of CLAIM_SEED_SQL.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
  for (const statement of CLAIM_SHARD_GUARD_SQL.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
  for (const statement of CLAIM_ELIGIBILITY_SQL.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
  for (const statement of CLAIM_RECOVERY_CURSOR_SQL.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
}, TIMEOUT);

beforeEach(async () => {
  await executeStatements(`
    DELETE FROM agent_backup_admission_work;
    DELETE FROM agent_backup_node_admission_cursors;
    DELETE FROM agent_backup_organization_admission_cursors;
    DELETE FROM agent_sandbox_backups;
    DELETE FROM agent_sandboxes;
    DELETE FROM docker_nodes;
    DELETE FROM agent_node_incarnation_histories;
    DELETE FROM organizations;
    ALTER TABLE agent_backup_admission_claim_shards DISABLE TRIGGER USER;
    UPDATE agent_backup_admission_claim_shards SET
      last_turn = 0, recovery_start_turn = NULL, recovery_cutoff_at = NULL,
      recovery_cursor_at = NULL, recovery_cursor_state = NULL,
      recovery_cursor_id = NULL, last_recovery_claim_cycle_start_turn = NULL,
      cycle_start_turn = NULL, cycle_observed_at = NULL,
      cycle_max_cohort = NULL,
      cycle_max_ordinal = NULL, cycle_max_id = NULL, cycle_aging_interval_ms = NULL,
      priority_pass = NULL, scan_cursor_cohort = NULL, scan_cursor_ordinal = NULL,
      scan_cursor_id = NULL, last_admitted_work_id = NULL,
      last_admission_proof_turn = NULL, updated_at = now();
    ALTER TABLE agent_backup_admission_claim_shards ENABLE TRIGGER USER;
    ALTER SEQUENCE agent_backup_admission_claim_turn_seq RESTART WITH 1;
    ALTER SEQUENCE agent_backup_admission_cohort_seq RESTART WITH 100000;
  `);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("schedule-capture admission claims on primary PGlite", () => {
  test("distinguishes a truly idle authority from durable claim progress", async () => {
    expect(
      await claimAgentBackupAdmissionWorkTurn({
        ownerId: OWNER_A,
        limit: 1,
        leaseMs: 60_000,
      }),
    ).toEqual({ outcome: "idle", claims: [] });

    const due = source(90, {
      priorityClass: "active_rpo",
      basePriority: 1,
    });
    await seedSource(due);
    const outcomes: string[] = [];
    let claimed: ClaimBatch = [];
    for (let turn = 0; turn < MAX_TEST_PROGRESS_TURNS && claimed.length === 0; turn += 1) {
      const result = await claimAgentBackupAdmissionWorkTurn({
        ownerId: OWNER_A,
        limit: 1,
        leaseMs: 60_000,
      });
      outcomes.push(result.outcome);
      claimed = result.claims;
    }

    expect(outcomes.at(0)).toBe("progressed");
    expect(outcomes.at(-1)).toBe("claimed");
    expect(outcomes).not.toContain("idle");
    expect(outcomes).not.toContain("contended");
    expect(claimed.map(({ workId }) => workId)).toEqual([due.workId]);
  });

  test("rejects lease horizons too short to return a consumable fence", async () => {
    await expect(
      claimAgentBackupAdmissionWork({
        ownerId: OWNER_A,
        limit: 1,
        leaseMs: MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS - 1,
      }),
    ).rejects.toThrow(/leaseMs must be between 1000 and 300000/);
    await expect(
      heartbeatAgentBackupAdmissionClaim({
        fence: {
          workId: ids(1),
          ownerId: OWNER_A,
          generation: WRONG_GENERATION,
          workAttempt: 1,
          claimCycleStartTurn: "1",
          claimProofTurn: "2",
          claimProofXid: "3",
          claimProofPriorityPass: 0,
        },
        leaseMs: MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS - 1,
      }),
    ).rejects.toThrow(/leaseMs must be between 1000 and 300000/);
  });

  test("rejects a lease owner that exceeds the UTF-8 byte contract", async () => {
    await expect(
      claimAgentBackupAdmissionWork({
        ownerId: "😀".repeat(33),
        limit: 1,
        leaseMs: 60_000,
      }),
    ).rejects.toThrow(/at most 128 UTF-8 bytes/i);
    await expect(
      claimAgentBackupAdmissionWork({
        ownerId: "schedule\u0085worker",
        limit: 1,
        leaseMs: 60_000,
      }),
    ).rejects.toThrow(/no control characters/i);
  });

  test("promotes old periodic work without mixing frozen priority passes in one batch", async () => {
    const aged = source(1, { dueAt: new Date(Date.now() - 46 * 60_000) });
    const active = source(2, {
      priorityClass: "active_rpo",
      basePriority: 1,
      dueAt: new Date(Date.now() - 30_000),
    });
    const periodic = source(3, { dueAt: new Date(Date.now() - 30_000) });
    await seedSource(aged);
    await seedSource(active);
    await seedSource(periodic);

    const first = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 3,
      leaseMs: 60_000,
    });
    expect(first.progressTurns).toBe(1);
    expect(first.claims.map(({ workId }) => workId)).toEqual([aged.workId]);
    expect(first.claims.map(({ effectivePriority }) => effectivePriority)).toEqual([0]);
    expect(first.claims.map(({ claimProofPriorityPass }) => claimProofPriorityPass)).toEqual([0]);
    const agedClaim = first.claims[0];
    if (!agedClaim) throw new Error("Expected the aged periodic claim");
    expect(
      await settleAgentBackupAdmissionClaim({ fence: fence(agedClaim), reason: "TEST_DONE" }),
    ).toBe(true);

    const second = await driveUntilClaim({ ownerId: OWNER_A, limit: 3, leaseMs: 60_000 });
    expect(second.progressTurns).toBeGreaterThan(0);
    expect(second.claims.map(({ workId }) => workId)).toEqual([active.workId]);
    expect(new Set(second.claims.map(({ effectivePriority }) => effectivePriority))).toEqual(
      new Set([1]),
    );
    expect(
      new Set(second.claims.map(({ claimProofPriorityPass }) => claimProofPriorityPass)),
    ).toEqual(new Set([1]));
    const activeClaim = second.claims[0];
    if (!activeClaim) throw new Error("Expected the active-RPO claim");
    expect(
      await settleAgentBackupAdmissionClaim({ fence: fence(activeClaim), reason: "TEST_DONE" }),
    ).toBe(true);

    const third = await driveUntilClaim({ ownerId: OWNER_A, limit: 3, leaseMs: 60_000 });
    expect(third.progressTurns).toBeGreaterThan(second.progressTurns);
    expect(third.claims.map(({ workId }) => workId)).toEqual([periodic.workId]);
    expect(new Set(third.claims.map(({ effectivePriority }) => effectivePriority))).toEqual(
      new Set([3]),
    );
    expect(
      new Set(third.claims.map(({ claimProofPriorityPass }) => claimProofPriorityPass)),
    ).toEqual(new Set([3]));
  });

  test("uses source age after equal unserved lane cursors", async () => {
    const older = source(90, { dueAt: new Date(Date.now() - 120_000) });
    const newerWithEarlierKey = source(80, { dueAt: new Date(Date.now() - 30_000) });
    await seedSource(older);
    await seedSource(newerWithEarlierKey);

    const { claims, progressTurns } = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    const [claim] = claims;

    expect(progressTurns).toBeGreaterThan(0);
    expect(claim?.workId).toBe(older.workId);
  });

  test("orders source eligibility at PostgreSQL microsecond precision", async () => {
    const baseMs = Date.now() - 120_000;
    const newerWithEarlierKey = source(96, { dueAt: microTimestamp(baseMs, 999) });
    const older = source(97, { dueAt: microTimestamp(baseMs, 1) });
    await seedSource(newerWithEarlierKey);
    await seedSource(older);

    const { claims } = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    const [claim] = claims;

    expect(claim?.workId).toBe(older.workId);
  });

  test("does not admit work due after the trigger-owned frozen clock", async () => {
    const notYetDue = source(98, { dueAt: new Date(Date.now() + 60_000) });
    await seedSource(notYetDue);
    await dbWrite.execute(sql`UPDATE agent_backup_admission_claim_shards AS claim_shard
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        cycle_observed_at = clock_timestamp(),
        cycle_max_cohort = work.ready_cohort,
        cycle_max_ordinal = work.cohort_ordinal,
        cycle_max_id = work.id,
        cycle_aging_interval_ms = 900000,
        priority_pass = 0
      FROM agent_backup_admission_work AS work
      WHERE claim_shard.work_kind = 'schedule_capture'
        AND claim_shard.shard_id = 0
        AND work.id = ${notYetDue.workId}::uuid`);

    const frozen = await dbWrite.execute(sql`SELECT
        claim_shard.cycle_observed_at < work.not_before AS frozen_before_readiness
      FROM agent_backup_admission_claim_shards AS claim_shard
      JOIN agent_backup_admission_work AS work ON work.id = ${notYetDue.workId}::uuid
      WHERE claim_shard.work_kind = 'schedule_capture' AND claim_shard.shard_id = 0`);
    expect(frozen.rows).toEqual([{ frozen_before_readiness: true }]);

    const frozenCycle = await driveUntilScheduleShardIdle({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    expect(frozenCycle.batches.every((batch) => batch.length === 0)).toBe(true);
    expect(frozenCycle.turns).toBeGreaterThan(1);
    const row = await dbWrite.execute(sql`SELECT state, attempts
      FROM agent_backup_admission_work WHERE id = ${notYetDue.workId}::uuid`);
    expect(row.rows).toEqual([{ state: "queued", attempts: 0 }]);
  });

  test("preserves microsecond lane-turn ordering before source age", async () => {
    const olderLane = source(94, { dueAt: new Date(Date.now() - 30_000) });
    const newerLaneWithOlderSource = source(95, {
      dueAt: new Date(Date.now() - 120_000),
    });
    await seedSource(olderLane);
    await seedSource(newerLaneWithOlderSource);
    await dbWrite.execute(sql`UPDATE agent_backup_organization_admission_cursors
      SET cursor_at = CASE organization_id
        WHEN ${olderLane.organizationId}::uuid THEN '2026-08-27 12:00:00.000001+00'::timestamptz
        ELSE '2026-08-27 12:00:00.000002+00'::timestamptz
      END`);
    await dbWrite.execute(sql`UPDATE agent_backup_node_admission_cursors
      SET cursor_at = CASE node_history_id
        WHEN ${olderLane.nodeHistoryId}::uuid THEN '2026-08-27 12:00:00.000001+00'::timestamptz
        ELSE '2026-08-27 12:00:00.000002+00'::timestamptz
      END`);

    const { claims } = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    const [claim] = claims;

    expect(claim?.workId).toBe(olderLane.workId);
  });

  test("resumes a trigger-frozen priority pass without recalculating aging from wall time", async () => {
    const dueAt = new Date(Date.now() - 59_500);
    const frozen = source(91, { dueAt });
    await seedSource(frozen);
    await dbWrite.execute(sql`UPDATE agent_backup_admission_claim_shards AS claim_shard
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        cycle_observed_at = clock_timestamp(),
        cycle_max_cohort = work.ready_cohort,
        cycle_max_ordinal = work.cohort_ordinal,
        cycle_max_id = work.id,
        cycle_aging_interval_ms = 60000,
        priority_pass = 0
      FROM agent_backup_admission_work AS work
      WHERE claim_shard.work_kind = 'schedule_capture'
        AND claim_shard.shard_id = 0
        AND work.id = ${frozen.workId}::uuid`);
    for (let nextPass = 1; nextPass <= 3; nextPass += 1) {
      await dbWrite.execute(sql`UPDATE agent_backup_admission_claim_shards
        SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          scan_cursor_cohort = cycle_max_cohort,
          scan_cursor_ordinal = cycle_max_ordinal,
          scan_cursor_id = cycle_max_id
        WHERE work_kind = 'schedule_capture' AND shard_id = 0`);
      await dbWrite.execute(sql`UPDATE agent_backup_admission_claim_shards
        SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          priority_pass = ${nextPass},
          scan_cursor_cohort = NULL,
          scan_cursor_ordinal = NULL,
          scan_cursor_id = NULL
        WHERE work_kind = 'schedule_capture' AND shard_id = 0`);
    }

    await Bun.sleep(1_200);

    const [claim] = await claimAgentBackupAdmissionWork({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });

    expect(claim?.workId).toBe(frozen.workId);
    expect(claim?.effectivePriority).toBe(3);
    const shard = await dbWrite.execute(sql`SELECT cycle_observed_at,
        priority_pass, scan_cursor_id
      FROM agent_backup_admission_claim_shards
      WHERE work_kind = 'schedule_capture' AND shard_id = 0`);
    expect(shard.rows).toEqual([
      {
        cycle_observed_at: shard.rows[0]?.cycle_observed_at,
        priority_pass: 0,
        scan_cursor_id: null,
      },
    ]);
    expect(shard.rows[0]?.cycle_observed_at).not.toBeNull();
  });

  test("defers a late same-shard row beyond the frozen full high-water tuple", async () => {
    const initial = source(92, { readyCohort: 92n, cohortOrdinal: 0 });
    const late = source(93, { readyCohort: 92n, cohortOrdinal: 1 });
    await seedSource(initial);
    await dbWrite.execute(sql`UPDATE agent_backup_admission_claim_shards AS claim_shard
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        cycle_observed_at = clock_timestamp(),
        cycle_max_cohort = work.ready_cohort,
        cycle_max_ordinal = work.cohort_ordinal,
        cycle_max_id = work.id,
        cycle_aging_interval_ms = 900000,
        priority_pass = 0
      FROM agent_backup_admission_work AS work
      WHERE claim_shard.work_kind = 'schedule_capture'
        AND claim_shard.shard_id = 0
        AND work.id = ${initial.workId}::uuid`);
    await seedSource(late);

    const firstCycle = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 2,
      leaseMs: 60_000,
    });
    expect(firstCycle.progressTurns).toBeGreaterThan(0);
    expect(firstCycle.claims.map(({ workId }) => workId)).toEqual([initial.workId]);
    const lateRow = await dbWrite.execute(sql`SELECT state, attempts
      FROM agent_backup_admission_work WHERE id = ${late.workId}::uuid`);
    expect(lateRow.rows).toEqual([{ state: "queued", attempts: 0 }]);
    const initialClaim = firstCycle.claims[0];
    if (!initialClaim) throw new Error("Expected the frozen high-water row");
    expect(
      await settleAgentBackupAdmissionClaim({
        fence: fence(initialClaim),
        reason: "TEST_DONE",
      }),
    ).toBe(true);

    const next = await driveUntilClaim({
      ownerId: OWNER_B,
      limit: 1,
      leaseMs: 60_000,
    });
    const [nextCycle] = next.claims;
    expect(next.progressTurns).toBeGreaterThan(1);
    expect(nextCycle?.workId).toBe(late.workId);
  });

  test(
    "refills after 256 filtered keys and resumes when the frozen high-water disappears",
    async () => {
      const filtered = Array.from({ length: 256 }, (_, index) =>
        source(2_000 + index, {
          readyCohort: BigInt(index + 1),
          cohortOrdinal: 0,
        }),
      );
      for (const candidate of filtered) await seedSource(candidate);
      await dbWrite.execute(sql`UPDATE organizations
        SET account_lifecycle_state = 'deletion_recovery'
        WHERE id IN (${sql.join(
          filtered.map(({ organizationId }) => sql`${organizationId}::uuid`),
          sql`, `,
        )})`);
      const validHighWater = source(2_256, {
        priorityClass: "lifecycle_safety",
        basePriority: 0,
        readyCohort: 257n,
        cohortOrdinal: 0,
      });
      await seedSource(validHighWater);

      const driven = await driveUntilClaim({
        ownerId: OWNER_A,
        limit: 1,
        leaseMs: 60_000,
      });
      const [claim] = driven.claims;
      expect(driven.progressTurns).toBe(1);
      expect(claim?.workId).toBe(validHighWater.workId);
      if (!claim) throw new Error("Expected the 257th raw key to refill the claim batch");
      const activeCycle = await dbWrite.execute(sql`SELECT
          last_turn::text AS last_turn, cycle_observed_at,
          cycle_max_cohort::text AS cycle_max_cohort,
          priority_pass, scan_cursor_cohort::text AS scan_cursor_cohort
        FROM agent_backup_admission_claim_shards
        WHERE work_kind = 'schedule_capture' AND shard_id = 0`);
      const active = activeCycle.rows[0] as
        | {
            last_turn: string;
            cycle_observed_at: Date | string | null;
            cycle_max_cohort: string;
            priority_pass: number;
            scan_cursor_cohort: string | null;
          }
        | undefined;
      expect(BigInt(active?.last_turn ?? "0")).toBeGreaterThan(0n);
      expect(active?.cycle_observed_at).not.toBeNull();
      expect(active?.cycle_max_cohort).toBe("257");
      expect(active?.priority_pass).toBe(0);
      expect(active?.scan_cursor_cohort).toBeNull();
      const filteredRows = await dbWrite.execute(sql`SELECT
          COUNT(*)::integer AS row_count,
          COUNT(*) FILTER (WHERE state = 'queued' AND attempts = 0)::integer AS untouched_count
        FROM agent_backup_admission_work
        WHERE id IN (${sql.join(
          filtered.map(({ workId }) => sql`${workId}::uuid`),
          sql`, `,
        )})`);
      expect(filteredRows.rows).toEqual([{ row_count: 256, untouched_count: 256 }]);
      expect(
        await settleAgentBackupAdmissionClaim({
          fence: fence(claim),
          reason: "TEST_HIGH_WATER_REMOVED",
        }),
      ).toBe(true);

      const finishedProgress = await driveUntilScheduleShardIdle({
        ownerId: OWNER_B,
        limit: 1,
        leaseMs: 60_000,
      });
      expect(finishedProgress.turns).toBe(12);
      expect(finishedProgress.batches.every((batch) => batch.length === 0)).toBe(true);
      const finishedCycle = await dbWrite.execute(sql`SELECT
          last_turn::text AS last_turn, cycle_observed_at, cycle_max_cohort,
          cycle_max_ordinal, cycle_max_id, cycle_aging_interval_ms,
          priority_pass, scan_cursor_cohort, scan_cursor_ordinal, scan_cursor_id
        FROM agent_backup_admission_claim_shards
        WHERE work_kind = 'schedule_capture' AND shard_id = 0`);
      const beforeTurn = BigInt(active?.last_turn ?? "0");
      const finished = finishedCycle.rows[0] as
        | { last_turn: string; [key: string]: unknown }
        | undefined;
      if (!finished) throw new Error("Expected the claim cycle authority after completion");
      expect(BigInt(finished?.last_turn ?? "0")).toBeGreaterThan(beforeTurn);
      expect(finished).toEqual({
        last_turn: finished.last_turn,
        cycle_observed_at: null,
        cycle_max_cohort: null,
        cycle_max_ordinal: null,
        cycle_max_id: null,
        cycle_aging_interval_ms: null,
        priority_pass: null,
        scan_cursor_cohort: null,
        scan_cursor_ordinal: null,
        scan_cursor_id: null,
      });
    },
    TIMEOUT,
  );

  test("maximizes the batch while serializing tenant and exact node-history lanes", async () => {
    const first = source(10, { dueAt: new Date(Date.now() - 90_000) });
    const sameOrganization = source(11, {
      organizationId: first.organizationId,
      dueAt: new Date(Date.now() - 60_000),
    });
    const sameOccurrence = source(12, {
      nodeRecordId: first.nodeRecordId,
      nodeHistoryId: first.nodeHistoryId,
      nodeId: first.nodeId,
      incarnation: first.incarnation,
      dueAt: new Date(Date.now() - 30_000),
    });
    await seedSource(first);
    await seedSource(sameOrganization);
    await seedSource(sameOccurrence);

    const { claims } = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 3,
      leaseMs: 60_000,
    });
    expect(claims.map(({ workId }) => workId)).toEqual([
      sameOrganization.workId,
      sameOccurrence.workId,
    ]);
  });

  test("does not evict lifecycle-safety work to increase periodic cardinality", async () => {
    const lifecycleSafety = source(60, {
      priorityClass: "lifecycle_safety",
      basePriority: 0,
    });
    const sameOrganization = source(61, {
      organizationId: lifecycleSafety.organizationId,
    });
    const sameOccurrence = source(62, {
      nodeRecordId: lifecycleSafety.nodeRecordId,
      nodeHistoryId: lifecycleSafety.nodeHistoryId,
      nodeId: lifecycleSafety.nodeId,
      incarnation: lifecycleSafety.incarnation,
    });
    await seedSource(lifecycleSafety);
    await seedSource(sameOrganization);
    await seedSource(sameOccurrence);

    const { claims } = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 3,
      leaseMs: 60_000,
    });

    expect(claims.map(({ workId }) => workId)).toEqual([lifecycleSafety.workId]);
    expect(claims[0]?.effectivePriority).toBe(0);
  });

  test("rotates both tenant and exact-node lanes ahead of source age across ticks", async () => {
    const now = Date.now();
    const first = source(14, { dueAt: new Date(now - 90_000) });
    const sameOrganization = source(15, {
      organizationId: first.organizationId,
      dueAt: new Date(now - 80_000),
    });
    const sameOccurrence = source(16, {
      nodeRecordId: first.nodeRecordId,
      nodeHistoryId: first.nodeHistoryId,
      nodeId: first.nodeId,
      incarnation: first.incarnation,
      dueAt: new Date(now - 70_000),
    });
    const unservedLanes = source(17, { dueAt: new Date(now - 10_000) });
    await seedSource(first);
    await seedSource(sameOrganization);
    await seedSource(sameOccurrence);
    await seedSource(unservedLanes);

    const initialBatch = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    const [initial] = initialBatch.claims;
    expect(initial?.workId).toBe(first.workId);
    if (!initial) throw new Error("Expected the oldest initial claim");
    expect(
      await settleAgentBackupAdmissionClaim({ fence: fence(initial), reason: "TEST_DONE" }),
    ).toBe(true);

    const rotatedBatch = await driveUntilClaim({
      ownerId: OWNER_B,
      limit: 1,
      leaseMs: 60_000,
    });
    const [rotated] = rotatedBatch.claims;
    expect(rotatedBatch.progressTurns).toBeGreaterThan(0);
    expect(rotated?.workId).toBe(unservedLanes.workId);
  });

  test("rotates exact-node lanes when every candidate shares one tenant", async () => {
    const now = Date.now();
    const first = source(60, { dueAt: new Date(now - 90_000) });
    const samePairBacklog = source(61, {
      organizationId: first.organizationId,
      nodeRecordId: first.nodeRecordId,
      nodeHistoryId: first.nodeHistoryId,
      nodeId: first.nodeId,
      incarnation: first.incarnation,
      dueAt: new Date(now - 80_000),
    });
    const unservedNode = source(62, {
      organizationId: first.organizationId,
      dueAt: new Date(now - 10_000),
    });
    await seedSource(first);
    await seedSource(samePairBacklog);
    await seedSource(unservedNode);

    const initialBatch = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    const [initial] = initialBatch.claims;
    expect(initial?.workId).toBe(first.workId);
    if (!initial) throw new Error("Expected the initial shared-tenant claim");
    expect(
      await settleAgentBackupAdmissionClaim({ fence: fence(initial), reason: "TEST_DONE" }),
    ).toBe(true);

    const rotatedBatch = await driveUntilClaim({
      ownerId: OWNER_B,
      limit: 1,
      leaseMs: 60_000,
    });
    const [rotated] = rotatedBatch.claims;
    expect(rotated?.workId).toBe(unservedNode.workId);
  });

  test("rotates tenant lanes when every candidate shares one exact node", async () => {
    const now = Date.now();
    const first = source(63, { dueAt: new Date(now - 90_000) });
    const samePairBacklog = source(64, {
      organizationId: first.organizationId,
      nodeRecordId: first.nodeRecordId,
      nodeHistoryId: first.nodeHistoryId,
      nodeId: first.nodeId,
      incarnation: first.incarnation,
      dueAt: new Date(now - 80_000),
    });
    const unservedTenant = source(65, {
      nodeRecordId: first.nodeRecordId,
      nodeHistoryId: first.nodeHistoryId,
      nodeId: first.nodeId,
      incarnation: first.incarnation,
      dueAt: new Date(now - 10_000),
    });
    await seedSource(first);
    await seedSource(samePairBacklog);
    await seedSource(unservedTenant);

    const initialBatch = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    const [initial] = initialBatch.claims;
    expect(initial?.workId).toBe(first.workId);
    if (!initial) throw new Error("Expected the initial shared-node claim");
    expect(
      await settleAgentBackupAdmissionClaim({ fence: fence(initial), reason: "TEST_DONE" }),
    ).toBe(true);

    const rotatedBatch = await driveUntilClaim({
      ownerId: OWNER_B,
      limit: 1,
      leaseMs: 60_000,
    });
    const [rotated] = rotatedBatch.claims;
    expect(rotated?.workId).toBe(unservedTenant.workId);
  });

  test("allows only one of two concurrent workers to lease one item", async () => {
    const only = source(20, {
      priorityClass: "lifecycle_safety",
      basePriority: 0,
    });
    await seedSource(only);
    expect(
      await claimAgentBackupAdmissionWork({ ownerId: OWNER_A, limit: 1, leaseMs: 60_000 }),
    ).toEqual([]);
    expect(await scheduleShardCycleActive()).toBe(true);
    const results = await Promise.all([
      claimAgentBackupAdmissionWork({ ownerId: OWNER_A, limit: 1, leaseMs: 60_000 }),
      claimAgentBackupAdmissionWork({ ownerId: OWNER_B, limit: 1, leaseMs: 60_000 }),
    ]);
    expect(results.flat()).toHaveLength(1);
    expect(results.flat()[0]?.workId).toBe(only.workId);
  });

  test("requires every independent account lifecycle admission predicate", async () => {
    const recovery = source(23);
    const inactive = source(24);
    const deleting = source(25);
    await seedSource(recovery);
    await seedSource(inactive);
    await seedSource(deleting);
    await dbWrite.execute(sql`UPDATE organizations
      SET account_lifecycle_state = 'deletion_recovery'
      WHERE id = ${recovery.organizationId}::uuid`);
    await dbWrite.execute(sql`UPDATE organizations
      SET is_active = FALSE
      WHERE id = ${inactive.organizationId}::uuid`);
    await dbWrite.execute(sql`UPDATE organizations
      SET account_deletion_request_id = ${ids(825)}::uuid
      WHERE id = ${deleting.organizationId}::uuid`);

    const completedCycle = await driveUntilScheduleShardIdle({
      ownerId: OWNER_A,
      limit: 3,
      leaseMs: 60_000,
    });
    expect(completedCycle.turns).toBeGreaterThan(1);
    expect(completedCycle.batches.every((batch) => batch.length === 0)).toBe(true);
    const result = await dbWrite.execute(sql`SELECT id, state, attempts
      FROM agent_backup_admission_work ORDER BY id`);
    expect(result.rows).toEqual(
      [recovery, inactive, deleting].map(({ workId }) => ({
        id: workId,
        state: "queued",
        attempts: 0,
      })),
    );
  });

  test("settles future-tier, soft-deleted, and deletion-owned sources before leasing", async () => {
    const futureTier = source(33, {
      priorityClass: "lifecycle_safety",
      basePriority: 0,
    });
    const softDeleted = source(34, {
      priorityClass: "lifecycle_safety",
      basePriority: 0,
    });
    const deletionOwned = source(35, {
      priorityClass: "lifecycle_safety",
      basePriority: 0,
    });
    const valid = source(36, {
      priorityClass: "lifecycle_safety",
      basePriority: 0,
    });
    for (const candidate of [futureTier, softDeleted, deletionOwned, valid]) {
      await seedSource(candidate);
    }
    await dbWrite.execute(sql`UPDATE agent_sandboxes
      SET execution_tier = 'future-dedicated'
      WHERE id = ${futureTier.sandboxId}::uuid`);
    await dbWrite.execute(sql`UPDATE agent_sandboxes
      SET deleted_at = clock_timestamp()
      WHERE id = ${softDeleted.sandboxId}::uuid`);
    await dbWrite.execute(sql`UPDATE agent_sandboxes
      SET deletion_attempt_id = ${ids(835)}::uuid
      WHERE id = ${deletionOwned.sandboxId}::uuid`);

    const { claims } = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 4,
      leaseMs: 60_000,
    });

    expect(claims.map(({ workId }) => workId)).toEqual([valid.workId]);
    const result = await dbWrite.execute(sql`SELECT id, state, attempts,
        lease_owner, settled_reason
      FROM agent_backup_admission_work
      ORDER BY id`);
    expect(result.rows).toEqual([
      {
        id: futureTier.workId,
        state: "settled",
        attempts: 0,
        lease_owner: null,
        settled_reason: "SOURCE_SUPERSEDED",
      },
      {
        id: softDeleted.workId,
        state: "settled",
        attempts: 0,
        lease_owner: null,
        settled_reason: "SOURCE_SUPERSEDED",
      },
      {
        id: deletionOwned.workId,
        state: "settled",
        attempts: 0,
        lease_owner: null,
        settled_reason: "SOURCE_SUPERSEDED",
      },
      {
        id: valid.workId,
        state: "leased",
        attempts: 1,
        lease_owner: OWNER_A,
        settled_reason: null,
      },
    ]);
  });

  test("continues when a visible recovery window transitions no rows", async () => {
    const unavailableRecovery = source(29, {
      priorityClass: "lifecycle_safety",
      basePriority: 0,
      dueAt: new Date(Date.now() - 60_000),
    });
    const queued = source(129, {
      priorityClass: "lifecycle_safety",
      basePriority: 0,
    });
    await seedSource(unavailableRecovery);
    await seedSource(queued);
    const initial = await driveUntilClaim({ ownerId: OWNER_A, limit: 1, leaseMs: 60_000 });
    const recoveryClaim = initial.claims[0];
    if (!recoveryClaim) throw new Error("Expected the recovery fixture to be claimed");
    expect(recoveryClaim.workId).toBe(unavailableRecovery.workId);
    expect(
      await deferAgentBackupAdmissionClaim({
        fence: fence(recoveryClaim),
        retryDelayMs: 25,
        reason: "TEST_BACKPRESSURE",
      }),
    ).toBe("deferred");
    await dbWrite.execute(
      sql`DELETE FROM organizations WHERE id = ${unavailableRecovery.organizationId}::uuid`,
    );
    await Bun.sleep(75);

    const driven = await driveUntilClaim({ ownerId: OWNER_A, limit: 1, leaseMs: 60_000 });

    expect(driven.progressTurns).toBeGreaterThan(0);
    expect(driven.claims.map(({ workId }) => workId)).toEqual([queued.workId]);
    const recovery = await dbWrite.execute(sql`SELECT state, attempts
      FROM agent_backup_admission_work WHERE id = ${unavailableRecovery.workId}::uuid`);
    expect(recovery.rows).toEqual([{ state: "deferred", attempts: 1 }]);
  });

  test("advances an active shard recovery turn so a less-served shard runs next", async () => {
    const recovering = source(130, {
      priorityClass: "lifecycle_safety",
      basePriority: 0,
      shardId: 0,
    });
    const otherShard = source(131, {
      priorityClass: "lifecycle_safety",
      basePriority: 0,
      shardId: 1,
    });
    await seedSource(recovering);
    expect(
      await claimAgentBackupAdmissionWork({ ownerId: OWNER_A, limit: 1, leaseMs: 60_000 }),
    ).toEqual([]);
    await seedSource(otherShard);
    expect(
      await claimAgentBackupAdmissionWork({ ownerId: OWNER_B, limit: 1, leaseMs: 60_000 }),
    ).toEqual([]);
    await dbWrite.execute(sql`UPDATE agent_backup_admission_work
      SET state = 'deferred', deferred_reason = 'TEST_BACKPRESSURE',
        not_before = clock_timestamp() - INTERVAL '1 second', updated_at = clock_timestamp()
      WHERE id = ${recovering.workId}::uuid`);

    expect(
      await claimAgentBackupAdmissionWork({ ownerId: OWNER_A, limit: 1, leaseMs: 60_000 }),
    ).toEqual([]);
    const otherClaim = await claimAgentBackupAdmissionWork({
      ownerId: OWNER_B,
      limit: 1,
      leaseMs: 60_000,
    });
    expect(otherClaim.map(({ workId }) => workId)).toEqual([otherShard.workId]);
    expect(
      await claimAgentBackupAdmissionWork({ ownerId: OWNER_A, limit: 1, leaseMs: 60_000 }),
    ).toEqual([]);

    const afterRecovery = await dbWrite.execute(sql`SELECT shard_id,
        last_turn::text AS last_turn, cycle_observed_at IS NOT NULL AS active_cycle,
        recovery_cursor_id
      FROM agent_backup_admission_claim_shards
      WHERE work_kind = 'schedule_capture' AND shard_id IN (0, 1)
      ORDER BY shard_id`);
    const recoveredWork = await dbWrite.execute(sql`SELECT state
      FROM agent_backup_admission_work WHERE id = ${recovering.workId}::uuid`);
    expect(recoveredWork.rows).toEqual([{ state: "queued" }]);
    const [recoveredShard, lessServedShard] = afterRecovery.rows as Array<{
      shard_id: number;
      last_turn: string;
      active_cycle: boolean;
      recovery_cursor_id: string | null;
    }>;
    expect(recoveredShard?.active_cycle).toBe(true);
    expect(recoveredShard?.recovery_cursor_id).toBe(recovering.workId);
    expect(BigInt(recoveredShard?.last_turn ?? "0")).toBeGreaterThan(
      BigInt(lessServedShard?.last_turn ?? "0"),
    );
    await expect(
      getPgliteClientForTests().exec(`UPDATE agent_backup_admission_claim_shards
        SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          recovery_cursor_id = '${ids(1)}'::uuid
        WHERE work_kind = 'schedule_capture' AND shard_id = 0`),
    ).rejects.toThrow(/recovery cursor must advance exactly/i);
    await expect(
      getPgliteClientForTests().exec(`UPDATE agent_backup_admission_claim_shards
        SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          scan_cursor_cohort = cycle_max_cohort,
          scan_cursor_ordinal = cycle_max_ordinal,
          scan_cursor_id = cycle_max_id
        WHERE work_kind = 'schedule_capture' AND shard_id = 0`),
    ).rejects.toThrow(/recovery must advance before claim-cycle authority/i);

    expect(
      await claimAgentBackupAdmissionWork({ ownerId: OWNER_B, limit: 1, leaseMs: 60_000 }),
    ).toEqual([]);
    const afterFairTurn = await dbWrite.execute(sql`SELECT shard_id,
        last_turn::text AS last_turn
      FROM agent_backup_admission_claim_shards
      WHERE work_kind = 'schedule_capture' AND shard_id IN (0, 1)
      ORDER BY shard_id`);
    const [unchangedRecovered, advancedOther] = afterFairTurn.rows as Array<{
      shard_id: number;
      last_turn: string;
    }>;
    expect(unchangedRecovered?.last_turn).toBe(recoveredShard?.last_turn);
    expect(BigInt(advancedOther?.last_turn ?? "0")).toBeGreaterThan(
      BigInt(lessServedShard?.last_turn ?? "0"),
    );
  });

  test("requeues ready deferred work and expired leases into a newer cohort", async () => {
    const deferred = source(26);
    await seedSource(deferred);
    const initialDeferredCohort = await readyCohort(deferred.workId);
    const initialDeferredBatch = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    const [initialDeferredClaim] = initialDeferredBatch.claims;
    if (!initialDeferredClaim) throw new Error("Expected the work to be claimed before deferral");
    expect(
      await deferAgentBackupAdmissionClaim({
        fence: fence(initialDeferredClaim),
        retryDelayMs: 25,
        reason: "TEST_BACKPRESSURE",
      }),
    ).toBe("deferred");
    await Bun.sleep(75);
    const deferredBatch = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    const [deferredClaim] = deferredBatch.claims;
    expect(deferredBatch.progressTurns).toBeGreaterThan(0);
    expect(deferredClaim?.workId).toBe(deferred.workId);
    expect(deferredClaim?.workAttempt).toBe(2);
    if (!deferredClaim) throw new Error("Expected the deferred work to be reclaimed");
    expect(deferredClaim.generation).not.toBe(initialDeferredClaim.generation);
    expect(await readyCohort(deferred.workId)).toBeGreaterThan(initialDeferredCohort);
    expect(
      await settleAgentBackupAdmissionClaim({
        fence: fence(deferredClaim),
        reason: "TEST_DONE",
      }),
    ).toBe(true);

    const expired = source(27);
    await seedSource(expired);
    const initialExpiredCohort = await readyCohort(expired.workId);
    const expiringBatch = await driveUntilClaim({
      ownerId: "crashed-worker",
      limit: 1,
      leaseMs: MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS,
    });
    const [expiringClaim] = expiringBatch.claims;
    expect(expiringClaim?.workId).toBe(expired.workId);
    expect(expiringClaim?.workAttempt).toBe(1);
    await Bun.sleep(MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS + 100);
    const expiredBatch = await driveUntilClaim({
      ownerId: OWNER_B,
      limit: 1,
      leaseMs: 60_000,
    });
    const [expiredClaim] = expiredBatch.claims;
    expect(expiredBatch.progressTurns).toBeGreaterThan(0);
    expect(expiredClaim?.workId).toBe(expired.workId);
    expect(expiredClaim?.workAttempt).toBe(2);
    expect(expiredClaim?.generation).not.toBe(expiringClaim?.generation);
    expect(await readyCohort(expired.workId)).toBeGreaterThan(initialExpiredCohort);
  });

  test(
    "settles an expired maximum attempt and advances the now-idle shard",
    async () => {
      const exhausted = source(28);
      await seedSource(exhausted);

      for (let attempt = 1; attempt < MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS; attempt += 1) {
        const retryBatch = await driveUntilClaim({
          ownerId: `retry-worker-${attempt}`,
          limit: 1,
          leaseMs: 60_000,
        });
        const [claim] = retryBatch.claims;
        expect(claim?.workAttempt).toBe(attempt);
        if (!claim) throw new Error(`Expected retry claim ${attempt}`);
        expect(
          await deferAgentBackupAdmissionClaim({
            fence: fence(claim),
            retryDelayMs: 1,
            reason: "TEST_RETRY",
          }),
        ).toBe("deferred");
        await Bun.sleep(10);
      }

      const lastBatch = await driveUntilClaim({
        ownerId: "crashed-final-worker",
        limit: 1,
        leaseMs: MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS,
      });
      const [lastClaim] = lastBatch.claims;
      expect(lastClaim?.workAttempt).toBe(MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS);
      const beforeIdle = await dbWrite.execute(sql`SELECT last_turn::text AS last_turn
      FROM agent_backup_admission_claim_shards
      WHERE work_kind = 'schedule_capture' AND shard_id = 0`);
      await Bun.sleep(MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS + 100);

      let settled = false;
      for (let recoveryTurn = 0; recoveryTurn < 4 && !settled; recoveryTurn += 1) {
        expect(
          await claimAgentBackupAdmissionWork({ ownerId: OWNER_B, limit: 1, leaseMs: 60_000 }),
        ).toEqual([]);
        const state = await dbWrite.execute(sql`SELECT state
        FROM agent_backup_admission_work WHERE id = ${exhausted.workId}::uuid`);
        settled = (state.rows[0] as { state: string } | undefined)?.state === "settled";
      }
      expect(settled).toBe(true);
      const work = await dbWrite.execute(sql`SELECT state, attempts, settled_reason
      FROM agent_backup_admission_work WHERE id = ${exhausted.workId}::uuid`);
      expect(work.rows).toEqual([
        {
          state: "settled",
          attempts: MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS,
          settled_reason: "RETRY_EXHAUSTED",
        },
      ]);
      const idleProgress = await driveUntilScheduleShardIdle({
        ownerId: OWNER_B,
        limit: 1,
        leaseMs: 60_000,
      });
      expect(idleProgress.batches.every((batch) => batch.length === 0)).toBe(true);
      const afterIdle = await dbWrite.execute(sql`SELECT last_turn::text AS last_turn,
        cycle_observed_at
      FROM agent_backup_admission_claim_shards
      WHERE work_kind = 'schedule_capture' AND shard_id = 0`);
      const beforeTurn = BigInt(
        (beforeIdle.rows[0] as { last_turn: string } | undefined)?.last_turn ?? "0",
      );
      const after = afterIdle.rows[0] as
        | { last_turn: string; cycle_observed_at: Date | null }
        | undefined;
      expect(BigInt(after?.last_turn ?? "0")).toBeGreaterThan(beforeTurn);
      expect(after?.cycle_observed_at).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "reports retry exhaustion when the final deferral settles the claim",
    async () => {
      const exhausted = source(132);
      await seedSource(exhausted);

      for (let attempt = 1; attempt <= MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS; attempt += 1) {
        const batch = await driveUntilClaim({
          ownerId: `defer-exhaustion-worker-${attempt}`,
          limit: 1,
          leaseMs: 60_000,
        });
        const [claim] = batch.claims;
        expect(claim?.workAttempt).toBe(attempt);
        if (!claim) throw new Error(`Expected retry-exhaustion claim ${attempt}`);
        expect(
          await deferAgentBackupAdmissionClaim({
            fence: fence(claim),
            retryDelayMs: 1,
            reason: "TEST_RETRY",
          }),
        ).toBe(attempt === MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS ? "retry_exhausted" : "deferred");
        if (attempt < MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS) await Bun.sleep(10);
      }

      const work = await dbWrite.execute(sql`SELECT state, attempts, settled_reason
      FROM agent_backup_admission_work WHERE id = ${exhausted.workId}::uuid`);
      expect(work.rows).toEqual([
        {
          state: "settled",
          attempts: MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS,
          settled_reason: "RETRY_EXHAUSTED",
        },
      ]);
      expect(await countUnsettledAgentBackupAdmissionWork()).toBe(0);
    },
    TIMEOUT,
  );

  test("settles ABA and activation drift instead of returning a fresh-boot candidate", async () => {
    const aba = source(30);
    const drifted = source(31);
    await seedSource(aba);
    await seedSource(drifted);
    const replacementHistory = ids(999);
    await dbWrite.execute(sql`INSERT INTO agent_node_incarnation_histories (
        id, docker_node_record_id, node_id, node_incarnation, fleet_kind,
        infrastructure_provider, provider_server_id, host_key_fingerprint
      ) VALUES (
        ${replacementHistory}::uuid, ${aba.nodeRecordId}::uuid, ${aba.nodeId},
        ${aba.incarnation}::uuid, 'robot', 'hetzner', NULL, ${HOST_KEY}
      )`);
    await dbWrite.execute(sql`UPDATE docker_nodes
      SET current_node_history_id = ${replacementHistory}::uuid
      WHERE id = ${aba.nodeRecordId}::uuid`);
    await dbWrite.execute(sql`UPDATE agent_sandboxes
      SET lifecycle_revision = lifecycle_revision + 1
      WHERE id = ${drifted.sandboxId}::uuid`);

    const completedCycle = await driveUntilScheduleShardIdle({
      ownerId: OWNER_A,
      limit: 2,
      leaseMs: 60_000,
    });
    expect(completedCycle.batches.every((batch) => batch.length === 0)).toBe(true);
    const result = await dbWrite.execute(sql`SELECT id, state, settled_reason
      FROM agent_backup_admission_work ORDER BY id`);
    expect(result.rows).toEqual([
      { id: aba.workId, state: "settled", settled_reason: "SOURCE_SUPERSEDED" },
      { id: drifted.workId, state: "settled", settled_reason: "SOURCE_SUPERSEDED" },
    ]);
  });

  test("settles work whose exact docker-node record was removed", async () => {
    const missingNode = source(32);
    await seedSource(missingNode);
    await dbWrite.execute(
      sql`DELETE FROM docker_nodes WHERE id = ${missingNode.nodeRecordId}::uuid`,
    );

    const completedCycle = await driveUntilScheduleShardIdle({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    expect(completedCycle.batches.every((batch) => batch.length === 0)).toBe(true);
    const result = await dbWrite.execute(sql`SELECT state, settled_reason
      FROM agent_backup_admission_work WHERE id = ${missingNode.workId}::uuid`);
    expect(result.rows).toEqual([{ state: "settled", settled_reason: "SOURCE_SUPERSEDED" }]);
  });

  test("fences heartbeat, defer, and settlement by generation and attempt", async () => {
    await seedSource(source(40));
    const claimBatch = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    const [claim] = claimBatch.claims;
    if (!claim) throw new Error("Expected one claim");
    const exact = fence(claim);
    const stale = { ...exact, generation: WRONG_GENERATION };

    expect(await heartbeatAgentBackupAdmissionClaim({ fence: stale, leaseMs: 60_000 })).toBeNull();
    expect(
      await deferAgentBackupAdmissionClaim({
        fence: stale,
        retryDelayMs: 1,
        reason: "TEST_RETRY",
      }),
    ).toBeNull();
    expect(await settleAgentBackupAdmissionClaim({ fence: stale, reason: "TEST_DONE" })).toBe(
      false,
    );
    expect(
      await heartbeatAgentBackupAdmissionClaim({ fence: exact, leaseMs: 60_000 }),
    ).toBeInstanceOf(Date);
    expect(await settleAgentBackupAdmissionClaim({ fence: exact, reason: "TEST_DONE" })).toBe(true);
    expect(await settleAgentBackupAdmissionClaim({ fence: exact, reason: "TEST_DONE" })).toBe(
      false,
    );
  });

  test("defers explicitly, reclaims with a new attempt, and counts each unsettled row once", async () => {
    const retry = source(50);
    const settled = source(51);
    await seedSource(settled);
    const settledBatch = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    const [settledClaim] = settledBatch.claims;
    if (!settledClaim) throw new Error("Expected the terminal fixture to be claimed");
    expect(
      await settleAgentBackupAdmissionClaim({
        fence: fence(settledClaim),
        reason: "TEST_SETTLED",
      }),
    ).toBe(true);
    await seedSource(retry);
    await dbWrite.execute(sql`INSERT INTO organizations (
        id, account_lifecycle_state, is_active, account_deletion_request_id
      ) VALUES (${ids(152)}::uuid, 'active', TRUE, NULL)`);
    await dbWrite.execute(sql`INSERT INTO agent_backup_admission_work (
        id, work_kind, work_stage, organization_id, requires_node_lane,
        priority_class, base_priority, source_due_at, first_eligible_at,
        state, not_before, ready_cohort, cohort_ordinal, shard_id, attempts
      ) VALUES (
        ${ids(52)}::uuid, 'catalog_operation', 'primary_publication', ${ids(152)}::uuid,
        FALSE, 'periodic_capture', 3, clock_timestamp(), clock_timestamp(),
        'queued', clock_timestamp(), 0, 0, 0, 0
      )`);
    expect(await countUnsettledAgentBackupAdmissionWork()).toBe(2);

    const firstBatch = await driveUntilClaim({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    const [first] = firstBatch.claims;
    if (!first) throw new Error("Expected first claim");
    expect(
      await deferAgentBackupAdmissionClaim({
        fence: fence(first),
        retryDelayMs: 25,
        reason: "TEST_BACKPRESSURE",
      }),
    ).toBe("deferred");
    expect(
      await claimAgentBackupAdmissionWork({ ownerId: OWNER_B, limit: 1, leaseMs: 60_000 }),
    ).toEqual([]);

    await Bun.sleep(75);
    const reclaimedBatch = await driveUntilClaim({
      ownerId: OWNER_B,
      limit: 1,
      leaseMs: 60_000,
    });
    const [reclaimed] = reclaimedBatch.claims;
    expect(reclaimedBatch.progressTurns).toBeGreaterThan(0);
    expect(reclaimed?.workId).toBe(retry.workId);
    expect(reclaimed?.workAttempt).toBe(2);
    expect(reclaimed?.generation).not.toBe(first.generation);
    expect(await countUnsettledAgentBackupAdmissionWork()).toBe(2);
  });
});
