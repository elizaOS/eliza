/**
 * Proves container project-intent quota admission with independent real
 * PostgreSQL sessions. An external holder parks both repository transactions
 * on the organization row lock before release, so a one-slot organization can
 * commit exactly one distinct project while the loser observes the committed
 * row and fails with the canonical quota error.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import type { NewContainer } from "../containers";

const SKIP_REASON =
  "[container project-intent PostgreSQL] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  ENVIRONMENT: process.env.ENVIRONMENT,
  LOCAL_PG_POOL_MAX: process.env.LOCAL_PG_POOL_MAX,
};

let postgres: EphemeralPostgres | null = null;
let databaseName: string | null = null;
let isolatedDsn: string | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | undefined;
let dbWrite: typeof import("../../client").dbWrite | undefined;
let containersRepository: typeof import("../containers").containersRepository | undefined;
let QuotaExceededError: typeof import("../containers").QuotaExceededError | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createIsolatedDatabase(baseDsn: string): Promise<string> {
  databaseName = `eliza_container_admission_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function waitUntilBlockedWaiters(observer: Client, minimum: number): Promise<number[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ pid: number }>(`
      SELECT activity.pid::int AS pid
      FROM pg_stat_activity activity
      WHERE activity.datname = current_database()
        AND activity.pid <> pg_backend_pid()
        AND cardinality(pg_blocking_pids(activity.pid)) > 0
      ORDER BY activity.pid
    `);
    if (result.rows.length >= minimum) return result.rows.map(({ pid }) => pid);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} blocked container-admission transactions`);
}

function candidate(organizationId: string, userId: string, projectName: string): NewContainer {
  return {
    name: projectName,
    project_name: projectName,
    organization_id: organizationId,
    user_id: userId,
    image_tag: "ghcr.io/elizaos/eliza:stable",
    status: "pending",
  };
}

async function cleanupHarness(): Promise<void> {
  const acquiredPostgres = postgres;
  const databaseToDrop = databaseName;
  let firstError: unknown;
  const capture = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      // error-policy:J6 Teardown continues through every resource so the first
      // cleanup failure does not leak the database or PostgreSQL process.
      firstError ??= error;
    }
  };

  await capture(async () => {
    await closeDatabaseConnectionsForTests?.();
  });
  closeDatabaseConnectionsForTests = undefined;

  if (acquiredPostgres && databaseToDrop) {
    await capture(async () => {
      const admin = new Client({ connectionString: acquiredPostgres.dsn });
      await admin.connect();
      try {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [databaseToDrop],
        );
        await admin.query(`DROP DATABASE IF EXISTS "${databaseToDrop}"`);
      } finally {
        await admin.end();
      }
    });
  }

  await capture(async () => {
    await acquiredPostgres?.stop();
  });
  postgres = null;
  databaseName = null;
  isolatedDsn = null;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }

  if (firstError) throw firstError;
}

async function initializeHarness(): Promise<void> {
  postgres = await acquireEphemeralPostgres();
  if (!postgres) {
    console.warn(SKIP_REASON);
    return;
  }

  isolatedDsn = await createIsolatedDatabase(postgres.dsn);
  process.env.DATABASE_URL = isolatedDsn;
  process.env.TEST_DATABASE_URL = isolatedDsn;
  process.env.NODE_ENV = "test";
  process.env.ENVIRONMENT = "local";
  process.env.LOCAL_PG_POOL_MAX = "8";

  const [clientModule, repositoryModule] = await Promise.all([
    import("../../client"),
    import("../containers"),
  ]);
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  dbWrite = clientModule.dbWrite;
  containersRepository = repositoryModule.containersRepository;
  QuotaExceededError = repositoryModule.QuotaExceededError;
}

afterAll(cleanupHarness, 60_000);

try {
  await initializeHarness();
} catch (error) {
  // error-policy:J2 Preserve initialization and cleanup failures together.
  try {
    await cleanupHarness();
  } catch (cleanupError) {
    // error-policy:J2 Aggregate both causes instead of masking either failure.
    throw new AggregateError(
      [error, cleanupError],
      "PostgreSQL container-admission harness initialization and cleanup both failed",
    );
  }
  throw error;
}

beforeAll(async () => {
  if (!dbWrite) return;
  const ddl = [
    `CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      credit_balance numeric(16,6) NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE organization_config (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL UNIQUE,
      webhook_url text,
      webhook_secret text,
      max_api_requests integer DEFAULT 1000,
      max_tokens_per_request integer,
      allowed_models jsonb NOT NULL DEFAULT '[]',
      allowed_providers jsonb NOT NULL DEFAULT '[]',
      settings jsonb NOT NULL DEFAULT '{}',
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE containers (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      project_name text NOT NULL,
      description text,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      api_key_id uuid,
      character_id uuid,
      load_balancer_url text,
      public_hostname text,
      status text NOT NULL DEFAULT 'pending',
      image_tag text,
      environment_vars jsonb NOT NULL DEFAULT '{}',
      desired_count integer NOT NULL DEFAULT 1,
      cpu integer NOT NULL DEFAULT 1792,
      memory integer NOT NULL DEFAULT 1792,
      port integer NOT NULL DEFAULT 3000,
      health_check_path text DEFAULT '/health',
      node_id text,
      volume_path text,
      volume_size_gb integer,
      hcloud_volume_id integer,
      volume_location text,
      last_deployed_at timestamp,
      last_health_check timestamp,
      deployment_log text,
      deployment_log_storage text NOT NULL DEFAULT 'inline',
      deployment_log_key text,
      error_message text,
      metadata jsonb NOT NULL DEFAULT '{}',
      last_billed_at timestamp,
      next_billing_at timestamp,
      billing_status text NOT NULL DEFAULT 'active',
      shutdown_warning_sent_at timestamp,
      scheduled_shutdown_at timestamp,
      total_billed numeric(18,6) NOT NULL DEFAULT 0,
      lifecycle_revision bigint NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
  ];
  for (const statement of ddl) {
    await dbWrite.execute(statement);
  }
}, 60_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("container project-intent PostgreSQL admission", () => {
  test("two independent contenders for a one-slot organization commit one durable row", async () => {
    if (!isolatedDsn || !dbWrite || !containersRepository || !QuotaExceededError) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const repository = containersRepository;
    const QuotaError = QuotaExceededError;
    const organizationId = randomUUID();
    const userId = randomUUID();
    const suffix = randomUUID();
    const projectNames = [`left-${suffix}`, `right-${suffix}`] as const;

    await dbWrite.execute(
      sql`INSERT INTO organizations (id, credit_balance) VALUES (${organizationId}, 0)`,
    );
    await dbWrite.execute(sql`
      INSERT INTO organization_config (id, organization_id, settings)
      VALUES (${randomUUID()}, ${organizationId}, ${JSON.stringify({ max_containers: 1 })}::jsonb)
    `);

    const holder = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([holder.connect(), observer.connect()]);
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [organizationId]);

    const creates = projectNames.map((projectName) =>
      repository.createWithProjectIntentAndQuotaCheck(
        candidate(organizationId, userId, projectName),
      ),
    );
    let holderReleased = false;

    try {
      const blockedPids = await waitUntilBlockedWaiters(observer, 2);
      expect(blockedPids).toHaveLength(2);
      expect(new Set(blockedPids).size).toBe(2);

      await holder.query("COMMIT");
      holderReleased = true;

      const outcomes = await Promise.allSettled(creates);
      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winner = fulfilled[0];
      const loser = rejected[0];
      if (winner?.status !== "fulfilled" || loser?.status !== "rejected") {
        throw new Error("expected one container-admission winner and one loser");
      }
      expect(winner.value.created).toBe(true);
      expect(loser.reason).toBeInstanceOf(QuotaError);
      expect(loser.reason).toMatchObject({ current: 1, max: 1 });

      const durable = await observer.query<{
        id: string;
        name: string;
        project_name: string;
        organization_id: string;
        status: string;
      }>(
        `SELECT id, name, project_name, organization_id, status
         FROM containers
         WHERE organization_id = $1`,
        [organizationId],
      );
      expect(durable.rows).toHaveLength(1);
      const row = durable.rows[0];
      if (!row) throw new Error("winning container row did not persist");
      expect(projectNames).toContain(
        winner.value.container.project_name as (typeof projectNames)[number],
      );
      expect(row).toMatchObject({
        id: winner.value.container.id,
        name: winner.value.container.name,
        project_name: winner.value.container.project_name,
        organization_id: organizationId,
        status: "pending",
      });
    } finally {
      if (!holderReleased) await holder.query("ROLLBACK");
      await Promise.allSettled(creates);
      await Promise.all([holder.end(), observer.end()]);
    }
  }, 30_000);
});
