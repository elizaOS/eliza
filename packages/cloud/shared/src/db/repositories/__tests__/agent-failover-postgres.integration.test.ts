/**
 * Proves failover claiming and the fault scene freeze with independent PostgreSQL sessions.
 *
 * The PGlite suites can only show that a predicate is right; a single in-process
 * session cannot demonstrate that two workers race for the same row. This harness
 * acquires a real PostgreSQL instance, applies the shipped failover migrations and
 * their PL/pgSQL guards, and then drives the production repository from concurrent
 * sessions so `FOR UPDATE SKIP LOCKED`, the lease compare-and-set, the freeze
 * transaction, and the guarded step journal are exercised under real row
 * contention.
 *
 * It also asserts the negative: failover never touches `docker_nodes.allocated_count`,
 * because the restore authority owns target capacity.
 *
 * Skipped unless a real PostgreSQL is reachable (`APPS_TENANT_DB_EPHEMERAL=1`
 * with Docker, or `APPS_TENANT_DB_TEST_DSN`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";

const SKIP_REASON =
  "[agent failover PostgreSQL] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const REQUIRE_REAL_POSTGRES = process.env.REQUIRE_REAL_POSTGRES_AGENT_FAILOVER_TESTS === "1";
const APPLICATION_NAME = "agent-failover-postgres-test";
const TEST_TIMEOUT = 120_000;

const MIGRATIONS = ["0387_agent_failover_records", "0388_agent_failover_guards"] as const;

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const SOURCE_NODE_ID = "20000000-0000-4000-8000-000000000001";
const TARGET_NODE_ID = "20000000-0000-4000-8000-000000000002";
const SOURCE_NODE_HANDLE = "node-alpha";
const TARGET_NODE_HANDLE = "node-beta";
const SOURCE_INCARNATION = "30000000-0000-4000-8000-000000000001";
const SOURCE_HISTORY_ID = "40000000-0000-4000-8000-000000000001";
const TARGET_INCARNATION = "30000000-0000-4000-8000-000000000002";
const TARGET_HISTORY_ID = "40000000-0000-4000-8000-000000000002";
const AGENT_ID = "50000000-0000-4000-8000-000000000001";
const OTHER_AGENT_ID = "50000000-0000-4000-8000-000000000002";
const SOURCE_GENERATION = "60000000-0000-4000-8000-000000000001";
const SOURCE_PUBLICATION_ID = "70000000-0000-4000-8000-000000000001";
const OTHER_PUBLICATION_ID = "70000000-0000-4000-8000-000000000004";
const SOURCE_CONTAINER_ID = "a".repeat(64);
const SOURCE_RECEIPT_SHA = "c".repeat(64);
const SOURCE_LIFECYCLE_REVISION = 7;
const BACKUP_ID = "80000000-0000-4000-8000-000000000001";
const MANIFEST_SHA = "e".repeat(64);
const RESTORE_OPERATION_ID = "90000000-0000-4000-8000-000000000001";
const RESTORE_LEASE_ID = "90000000-0000-4000-8000-000000000002";
const RESTORE_LEASE_GENERATION = "90000000-0000-4000-8000-000000000003";
const RESTORE_LEASE_OWNER = "restore-worker";
const RESTORE_ATTEMPT_ID = "90000000-0000-4000-8000-000000000004";

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  LOCAL_PG_POOL_MAX: process.env.LOCAL_PG_POOL_MAX,
  RAILWAY_SERVICE_NAME: process.env.RAILWAY_SERVICE_NAME,
  DISABLE_LOCAL_PGLITE_FALLBACK: process.env.DISABLE_LOCAL_PGLITE_FALLBACK,
  NODE_ENV: process.env.NODE_ENV,
  MOCK_REDIS: process.env.MOCK_REDIS,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
};

type FailoverRepository = typeof import("../agent-failover").agentFailoverRepository;

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let databaseName: string | null = null;
let control: Client | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | undefined;
let repository: FailoverRepository | undefined;
let cleanupPromise: Promise<void> | undefined;

const PREREQUISITE_SQL = `
  CREATE TABLE IF NOT EXISTS organizations (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE IF NOT EXISTS docker_nodes (
    id uuid PRIMARY KEY,
    node_id text NOT NULL UNIQUE,
    hostname text NOT NULL,
    capacity integer NOT NULL DEFAULT 8,
    enabled boolean NOT NULL DEFAULT true,
    placement_state text NOT NULL DEFAULT 'open',
    status text NOT NULL DEFAULT 'healthy',
    allocated_count integer NOT NULL DEFAULT 0,
    node_incarnation uuid,
    current_node_history_id uuid,
    updated_at timestamp with time zone NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS agent_node_incarnation_histories (
    id uuid PRIMARY KEY,
    docker_node_record_id uuid NOT NULL,
    node_id text NOT NULL,
    node_incarnation uuid NOT NULL,
    fleet_kind text NOT NULL,
    infrastructure_provider text NOT NULL,
    provider_server_id text,
    host_key_fingerprint text NOT NULL,
    attested_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (id, docker_node_record_id, node_incarnation)
  );
  CREATE TABLE IF NOT EXISTS agent_sandboxes (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    node_id text,
    container_name text,
    activation_generation uuid,
    lifecycle_revision bigint NOT NULL DEFAULT 0,
    UNIQUE (id, organization_id)
  );
  CREATE TABLE IF NOT EXISTS agent_backup_restore_operations (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    backup_id uuid NOT NULL,
    restore_attempt_id uuid NOT NULL,
    lease_id uuid NOT NULL,
    lease_generation uuid NOT NULL,
    lease_owner_id text NOT NULL,
    expected_manifest_sha256 text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_backup_restore_leases (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    backup_id uuid NOT NULL,
    owner_id text NOT NULL,
    generation uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL DEFAULT now() + interval '1 hour',
    released_at timestamp with time zone
  );
  CREATE TABLE IF NOT EXISTS agent_sandbox_replacement_attempts (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    restore_operation_id uuid,
    restore_lease_id uuid,
    restore_lease_owner_id text,
    restore_lease_generation uuid,
    restore_backup_id uuid,
    cleanup_proven_at timestamp with time zone,
    cleanup_receipt_digest text
  );
  CREATE TABLE IF NOT EXISTS agent_activation_publications (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    activation_generation uuid NOT NULL,
    purpose text NOT NULL,
    backup_id uuid,
    backup_manifest_sha256 text,
    activation_receipt_sha256 text NOT NULL,
    previous_activation_generation uuid,
    lifecycle_revision numeric(20, 0) NOT NULL,
    container_id text NOT NULL,
    node_history_id uuid NOT NULL,
    docker_node_record_id uuid NOT NULL,
    node_id text NOT NULL,
    node_incarnation uuid NOT NULL,
    UNIQUE (organization_id, agent_id, activation_generation)
  );
`;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function requireRepository(): FailoverRepository {
  if (!repository) throw new Error("real PostgreSQL failover repository was not initialized");
  return repository;
}

function requireControl(): Client {
  if (!control) throw new Error("real PostgreSQL control session was not initialized");
  return control;
}

async function createIsolatedDatabase(baseDsn: string): Promise<{
  databaseName: string;
  dsn: string;
}> {
  const createdName = `eliza_agent_failover_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${createdName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${createdName}`;
  return { databaseName: createdName, dsn: url.toString() };
}

async function applyMigration(
  client: Client,
  migration: (typeof MIGRATIONS)[number],
): Promise<void> {
  const source = await readFile(
    new URL(`../../migrations/${migration}.sql`, import.meta.url),
    "utf8",
  );
  const statements = source
    .split("--> statement-breakpoint")
    .filter((statement) => statement.trim());
  await client.query("BEGIN");
  try {
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (cause) {
    // error-policy:J2 Preserve the migration failure after restoring transaction state.
    await client.query("ROLLBACK");
    throw cause;
  }
}

async function seedFixtures(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO organizations (id, name) VALUES ('${ORGANIZATION_ID}', 'org');
    INSERT INTO docker_nodes (id, node_id, hostname, node_incarnation, current_node_history_id, allocated_count)
      VALUES
        ('${SOURCE_NODE_ID}', '${SOURCE_NODE_HANDLE}', 'alpha.example', '${SOURCE_INCARNATION}', '${SOURCE_HISTORY_ID}', 1),
        ('${TARGET_NODE_ID}', '${TARGET_NODE_HANDLE}', 'beta.example', '${TARGET_INCARNATION}', '${TARGET_HISTORY_ID}', 0);
    INSERT INTO agent_node_incarnation_histories (
      id, docker_node_record_id, node_id, node_incarnation, fleet_kind,
      infrastructure_provider, provider_server_id, host_key_fingerprint
    ) VALUES
      ('${SOURCE_HISTORY_ID}', '${SOURCE_NODE_ID}', '${SOURCE_NODE_HANDLE}', '${SOURCE_INCARNATION}',
        'cloud', 'hetzner', '1234', 'SHA256:alpha'),
      ('${TARGET_HISTORY_ID}', '${TARGET_NODE_ID}', '${TARGET_NODE_HANDLE}', '${TARGET_INCARNATION}',
        'cloud', 'hetzner', '5678', 'SHA256:beta');
    INSERT INTO agent_sandboxes (
      id, organization_id, node_id, container_name, activation_generation, lifecycle_revision
    ) VALUES
      ('${AGENT_ID}', '${ORGANIZATION_ID}', '${SOURCE_NODE_HANDLE}', 'agent-one',
        '${SOURCE_GENERATION}', ${SOURCE_LIFECYCLE_REVISION}),
      ('${OTHER_AGENT_ID}', '${ORGANIZATION_ID}', '${SOURCE_NODE_HANDLE}', 'agent-two',
        '${SOURCE_GENERATION}', ${SOURCE_LIFECYCLE_REVISION});
    INSERT INTO agent_backup_restore_leases (
      id, organization_id, agent_id, backup_id, owner_id, generation, released_at
    ) VALUES (
      '${RESTORE_LEASE_ID}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${BACKUP_ID}',
      '${RESTORE_LEASE_OWNER}', '${RESTORE_LEASE_GENERATION}', NULL
    );
    INSERT INTO agent_backup_restore_operations (
      id, organization_id, agent_id, backup_id, restore_attempt_id, lease_id,
      lease_generation, lease_owner_id, expected_manifest_sha256
    ) VALUES (
      '${RESTORE_OPERATION_ID}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${BACKUP_ID}',
      '${RESTORE_ATTEMPT_ID}', '${RESTORE_LEASE_ID}', '${RESTORE_LEASE_GENERATION}',
      '${RESTORE_LEASE_OWNER}', '${MANIFEST_SHA}'
    );
    INSERT INTO agent_activation_publications (
      id, organization_id, agent_id, activation_generation, purpose, backup_id,
      backup_manifest_sha256, activation_receipt_sha256, previous_activation_generation,
      lifecycle_revision, container_id, node_history_id, docker_node_record_id, node_id,
      node_incarnation
    ) VALUES
      ('${SOURCE_PUBLICATION_ID}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${SOURCE_GENERATION}',
        'provision', NULL, NULL, '${SOURCE_RECEIPT_SHA}', NULL, ${SOURCE_LIFECYCLE_REVISION},
        '${SOURCE_CONTAINER_ID}', '${SOURCE_HISTORY_ID}', '${SOURCE_NODE_ID}',
        '${SOURCE_NODE_HANDLE}', '${SOURCE_INCARNATION}'),
      ('${OTHER_PUBLICATION_ID}', '${ORGANIZATION_ID}', '${OTHER_AGENT_ID}',
        '${SOURCE_GENERATION}', 'provision', NULL, NULL, '${SOURCE_RECEIPT_SHA}', NULL,
        ${SOURCE_LIFECYCLE_REVISION}, '${SOURCE_CONTAINER_ID}', '${SOURCE_HISTORY_ID}',
        '${SOURCE_NODE_ID}', '${SOURCE_NODE_HANDLE}', '${SOURCE_INCARNATION}');
  `);
}

async function resetFixture(): Promise<void> {
  const client = control;
  if (!client) return;
  await client.query(`
    DELETE FROM agent_failover_operations;
    DELETE FROM agent_node_failure_events;
    DELETE FROM agent_failover_step_attempts;
    DELETE FROM agent_backup_restore_operations;
    DELETE FROM agent_backup_restore_leases;
    DELETE FROM agent_activation_publications;
    DELETE FROM agent_sandboxes;
    DELETE FROM agent_node_incarnation_histories;
    DELETE FROM docker_nodes;
    DELETE FROM organizations;
  `);
  await seedFixtures(client);
}

/** Seeds one triggered fault and returns its id. */
async function seedTriggeredFault(): Promise<string> {
  const repo = requireRepository();
  const event = await repo.openFailureRecord({
    nodeRecordId: SOURCE_NODE_ID,
    nodeId: SOURCE_NODE_HANDLE,
    nodeIncarnation: SOURCE_INCARNATION,
    nodeHistoryId: SOURCE_HISTORY_ID,
  });
  await repo.recordFailureSignal({
    failureEventId: event.id,
    kind: "node_heartbeat_expired",
    source: "platform_heartbeat_monitor",
  });
  await repo.recordFailureSignal({
    failureEventId: event.id,
    kind: "provider_reported_failure",
    source: "infrastructure_provider_api",
  });
  await repo.triggerFailureRecord({ failureEventId: event.id });
  return event.id;
}

/** Triggered and frozen, with `AGENT_ID` in the set. */
async function seedFrozenOperation(): Promise<{ failureEventId: string; operationId: string }> {
  const repo = requireRepository();
  const failureEventId = await seedTriggeredFault();
  await repo.cordonAndFreezeFailure({ failureEventId });
  const operation = await repo.openOperation({ failureEventId, agentId: AGENT_ID });
  return { failureEventId, operationId: operation.id };
}

async function expireLease(operationId: string): Promise<void> {
  await requireControl().query(
    `UPDATE agent_failover_operations
     SET lease_expires_at = clock_timestamp() - INTERVAL '1 second',
         lease_heartbeat_at = clock_timestamp() - INTERVAL '2 seconds'
     WHERE id = $1`,
    [operationId],
  );
}

async function allocatedCount(nodeRecordId: string): Promise<number> {
  const result = await requireControl().query<{ allocated_count: number }>(
    "SELECT allocated_count FROM docker_nodes WHERE id = $1",
    [nodeRecordId],
  );
  return result.rows[0]?.allocated_count ?? -1;
}

async function cleanupHarnessOnce(): Promise<void> {
  const acquiredPostgres = postgres;
  const createdDatabase = databaseName;
  const errors: unknown[] = [];
  const capture = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (cause) {
      // error-policy:J6 Continue teardown while retaining every cleanup failure.
      errors.push(cause);
    }
  };

  if (control) await capture(async () => control?.end());
  control = null;
  if (closeDatabaseConnectionsForTests) await capture(closeDatabaseConnectionsForTests);
  closeDatabaseConnectionsForTests = undefined;
  repository = undefined;

  if (acquiredPostgres && createdDatabase) {
    let admin: Client | null = null;
    await capture(async () => {
      admin = new Client({ connectionString: acquiredPostgres.dsn });
      await admin.connect();
    });
    if (admin) {
      await capture(async () => {
        await (admin as Client).query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
            "WHERE datname = $1 AND pid <> pg_backend_pid()",
          [createdDatabase],
        );
      });
      await capture(async () => {
        await (admin as Client).query(`DROP DATABASE IF EXISTS "${createdDatabase}"`);
      });
      await capture(async () => (admin as Client).end());
    }
  }
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
  postgres = null;
  if (errors.length > 0) {
    throw new AggregateError(errors, "failover PostgreSQL harness cleanup failed");
  }
}

function cleanupHarness(): Promise<void> {
  cleanupPromise ??= cleanupHarnessOnce();
  return cleanupPromise;
}

if (!postgres && REQUIRE_REAL_POSTGRES) {
  throw new Error(`${SKIP_REASON} (REQUIRE_REAL_POSTGRES_AGENT_FAILOVER_TESTS=1 demands it)`);
}
if (!postgres) console.warn(SKIP_REASON);

if (postgres) {
  const isolated = await createIsolatedDatabase(postgres.dsn);
  databaseName = isolated.databaseName;

  process.env.DATABASE_URL = isolated.dsn;
  process.env.TEST_DATABASE_URL = isolated.dsn;
  process.env.LOCAL_PG_POOL_MAX = "16";
  process.env.RAILWAY_SERVICE_NAME = APPLICATION_NAME;
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  process.env.NODE_ENV = "test";
  process.env.MOCK_REDIS = "1";
  process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

  const [clientModule, repositoryModule] = await Promise.all([
    import("../../client"),
    import("../agent-failover"),
  ]);
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  repository = repositoryModule.agentFailoverRepository;
  control = new Client({
    connectionString: isolated.dsn,
    application_name: `${APPLICATION_NAME}-control`,
  });
  await control.connect();
  await control.query(PREREQUISITE_SQL);
  // Applying twice proves the deploy path is idempotent.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const migration of MIGRATIONS) await applyMigration(control, migration);
  }
}

const realPostgresTest = postgres ? test : test.skip;

beforeAll(async () => {
  if (!control) return;
  await resetFixture();
}, TEST_TIMEOUT);

beforeEach(resetFixture);

afterAll(cleanupHarness, TEST_TIMEOUT);

describe("failover claiming on real PostgreSQL", () => {
  realPostgresTest(
    "hands one operation to exactly one of two racing workers",
    async () => {
      const repo = requireRepository();
      await seedFrozenOperation();

      const [left, right] = await Promise.all([
        repo.claimNextOperation({ leaseOwner: "worker-a" }),
        repo.claimNextOperation({ leaseOwner: "worker-b" }),
      ]);
      const winners = [left, right].filter((receipt) => receipt !== null);
      expect(winners).toHaveLength(1);

      const loserOwner = left === null ? "worker-a" : "worker-b";
      expect(await repo.claimNextOperation({ leaseOwner: loserOwner })).toBeNull();
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "refuses to displace a live lease under real sessions",
    async () => {
      const repo = requireRepository();
      const { operationId } = await seedFrozenOperation();
      const owner = await repo.claimOperation({ operationId, leaseOwner: "worker-a" });
      expect(owner).not.toBeNull();
      expect(await repo.claimOperation({ operationId, leaseOwner: "worker-b" })).toBeNull();
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "rotates the fence exactly once when two workers race an expired lease",
    async () => {
      const repo = requireRepository();
      const { operationId } = await seedFrozenOperation();
      const first = await repo.claimOperation({ operationId, leaseOwner: "worker-a" });
      if (!first) throw new Error("the first claim was refused");
      await expireLease(operationId);

      const [left, right] = await Promise.all([
        repo.claimOperation({ operationId, leaseOwner: "worker-b" }),
        repo.claimOperation({ operationId, leaseOwner: "worker-c" }),
      ]);
      const winners = [left, right].filter((receipt) => receipt !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.leaseGeneration).not.toBe(first.leaseGeneration);

      const operation = await repo.findOperation(operationId);
      expect(operation?.claim_count).toBe(2);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "admits only one step attempt when the winning worker is duplicated",
    async () => {
      const repo = requireRepository();
      const { operationId } = await seedFrozenOperation();
      const claim = await repo.claimOperation({ operationId, leaseOwner: "worker-a" });
      if (!claim) throw new Error("claim was refused");
      const fence = { leaseOwner: claim.leaseOwner, leaseGeneration: claim.leaseGeneration };

      const results = await Promise.allSettled([
        repo.beginStepAttempt({ operationId, ...fence, step: "isolate_source" }),
        repo.beginStepAttempt({ operationId, ...fence, step: "isolate_source" }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

      const attempts = await requireControl().query<{ attempt: number }>(
        "SELECT attempt FROM agent_failover_step_attempts WHERE operation_id = $1 ORDER BY attempt",
        [operationId],
      );
      expect(attempts.rows.map((row) => row.attempt)).toEqual([1]);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "refuses a settlement presented by a superseded session",
    async () => {
      const repo = requireRepository();
      const { operationId } = await seedFrozenOperation();
      const first = await repo.claimOperation({ operationId, leaseOwner: "worker-a" });
      if (!first) throw new Error("the first claim was refused");
      const opened = await repo.beginStepAttempt({
        operationId,
        leaseOwner: first.leaseOwner,
        leaseGeneration: first.leaseGeneration,
        step: "isolate_source",
      });
      await expireLease(operationId);
      expect(await repo.claimOperation({ operationId, leaseOwner: "worker-b" })).not.toBeNull();

      await expect(
        repo.settleStepAttempt({
          operationId,
          leaseOwner: first.leaseOwner,
          leaseGeneration: first.leaseGeneration,
          step: "isolate_source",
          attempt: opened.attempt.attempt,
          outcome: "succeeded",
        }),
      ).rejects.toThrow(/not held by worker-a/);

      const attempt = await requireControl().query<{ state: string }>(
        "SELECT state FROM agent_failover_step_attempts WHERE id = $1",
        [opened.attempt.id],
      );
      expect(attempt.rows[0]?.state).toBe("started");
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "cordons and freezes exactly one agent set under concurrent freezes",
    async () => {
      const repo = requireRepository();
      const failureEventId = await seedTriggeredFault();

      const results = await Promise.allSettled([
        repo.cordonAndFreezeFailure({ failureEventId }),
        repo.cordonAndFreezeFailure({ failureEventId }),
      ]);
      const fulfilled = results.filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof repo.cordonAndFreezeFailure>>
        > => result.status === "fulfilled",
      );
      // Both callers converge on the same frozen set; neither widens it.
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      const candidates = await requireControl().query<{ agent_id: string }>(
        "SELECT agent_id FROM agent_node_failure_candidates WHERE failure_event_id = $1",
        [failureEventId],
      );
      expect(candidates.rows.map((row) => row.agent_id).sort()).toEqual(
        [AGENT_ID, OTHER_AGENT_ID].sort(),
      );
      const node = await requireControl().query<{ placement_state: string }>(
        "SELECT placement_state FROM docker_nodes WHERE id = $1",
        [SOURCE_NODE_ID],
      );
      expect(node.rows[0]?.placement_state).toBe("cordoned");
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "never counts target capacity itself",
    async () => {
      const repo = requireRepository();
      const { operationId } = await seedFrozenOperation();
      const claim = await repo.claimOperation({ operationId, leaseOwner: "worker-a" });
      if (!claim) throw new Error("claim was refused");
      await repo.markAwaitingCapacity({
        operationId,
        leaseOwner: claim.leaseOwner,
        leaseGeneration: claim.leaseGeneration,
        reason: "no_target_capacity",
      });
      await repo.finishOperation({
        operationId,
        leaseOwner: claim.leaseOwner,
        leaseGeneration: claim.leaseGeneration,
        status: "blocked_no_backup",
        errorCode: "AGENT_BACKUP_NOT_RESTORABLE",
        errorMessage: "no restore-verified backup",
      });
      // The restore authority owns the slot; failover only references it.
      expect(await allocatedCount(SOURCE_NODE_ID)).toBe(1);
      expect(await allocatedCount(TARGET_NODE_ID)).toBe(0);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "replays both migrations and installs every guard",
    async () => {
      const guards = await requireControl().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_trigger
         WHERE NOT tgisinternal AND tgname IN ('agent_node_failure_events_guard',
           'agent_node_failure_signals_guard', 'agent_node_failure_candidates_guard',
           'agent_failover_operations_guard', 'agent_failover_step_attempts_guard')`,
      );
      expect(guards.rows[0]?.count).toBe("5");
    },
    TEST_TIMEOUT,
  );
});
