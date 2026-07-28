/**
 * Proves lifecycle enqueue and stuck-row reconciliation serialize through the
 * same per-agent advisory lock on two real PostgreSQL transactions.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { pushSchema } from "drizzle-kit/api";
import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { apiKeys } from "../../schemas/api-keys";
import { generations } from "../../schemas/generations";
import { jobs } from "../../schemas/jobs";
import { organizations } from "../../schemas/organizations";
import { usageRecords } from "../../schemas/usage-records";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";

const SKIP_REASON =
  "[stuck provisioning lock] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
  MOCK_REDIS: process.env.MOCK_REDIS,
};
const SWEEP_CUTOFF = new Date("2026-07-28T12:20:00.000Z");
const STALE_UPDATED_AT = new Date(SWEEP_CUTOFF.getTime() - 1);

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let isolatedDatabaseName: string | null = null;
let isolatedDsn: string | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | undefined;
let dbWrite: typeof import("../../client").dbWrite | undefined;
let agentSandboxesRepository:
  | typeof import("../agent-sandboxes").agentSandboxesRepository
  | undefined;
let provisioningJobService:
  | typeof import("../../../lib/services/provisioning-jobs").provisioningJobService
  | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function createIsolatedDatabase(baseDsn: string): Promise<{
  databaseName: string;
  dsn: string;
}> {
  const databaseName = `eliza_sweep_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return { databaseName, dsn: url.toString() };
}

async function dropIsolatedDatabase(baseDsn: string, databaseName: string): Promise<void> {
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

async function waitForAdvisoryWaiters(observer: Client, minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_locks " +
        "WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) " +
        "AND NOT granted",
    );
    if (Number(result.rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} advisory-lock waiter(s)`);
}

if (!postgres) {
  console.warn(SKIP_REASON);
} else {
  const isolated = await createIsolatedDatabase(postgres.dsn);
  isolatedDatabaseName = isolated.databaseName;
  isolatedDsn = isolated.dsn;
  process.env.DATABASE_URL = isolated.dsn;
  process.env.TEST_DATABASE_URL = isolated.dsn;
  process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
  process.env.MOCK_REDIS = "1";

  const [clientModule, repositoryModule, jobModule] = await Promise.all([
    import("../../client"),
    import("../agent-sandboxes"),
    import("../../../lib/services/provisioning-jobs"),
  ]);
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  dbWrite = clientModule.dbWrite;
  agentSandboxesRepository = repositoryModule.agentSandboxesRepository;
  provisioningJobService = jobModule.provisioningJobService;
}

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  if (postgres && isolatedDatabaseName) {
    await dropIsolatedDatabase(postgres.dsn, isolatedDatabaseName);
  }
  await postgres?.stop();
  postgres = null;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
});

const realPostgres = postgres ? describe : describe.skip;

realPostgres("stuck provisioning lifecycle lock", () => {
  beforeAll(async () => {
    if (!dbWrite) throw new Error("isolated database was not initialized");
    const schema = {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      apiKeys,
      usageRecords,
      generations,
      jobs,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  }, 60_000);

  test("an enqueue holding the agent lock commits before the sweep rechecks ownership", async () => {
    if (!isolatedDsn || !dbWrite || !agentSandboxesRepository || !provisioningJobService) {
      throw new Error("real PostgreSQL harness was not initialized");
    }

    const suffix = randomUUID();
    const [organization] = await dbWrite
      .insert(organizations)
      .values({ name: "Sweep Lock Org", slug: `sweep-lock-${suffix}` })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `sweep-lock-${suffix}`,
        organization_id: organization.id,
      })
      .returning();
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: organization.id,
        user_id: user.id,
        agent_name: `sweep-lock-${suffix}`,
        status: "provisioning",
        execution_tier: "dedicated-always",
        sandbox_id: `sandbox-${suffix}`,
        node_id: `node-${suffix}`,
        container_name: `container-${suffix}`,
        updated_at: STALE_UPDATED_AT,
      })
      .returning();

    const gateKeyOne = `sweep-gate-${suffix}`;
    const gateKeyTwo = `job-insert-${suffix}`;
    const control = new Client({ connectionString: isolatedDsn });
    const setup = new Client({ connectionString: isolatedDsn });
    await Promise.all([control.connect(), setup.connect()]);
    try {
      await setup.query(`
        CREATE FUNCTION block_test_job_insert() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext(TG_ARGV[0]), hashtext(TG_ARGV[1]));
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await setup.query(
        `CREATE TRIGGER block_test_job_insert_trigger
         BEFORE INSERT ON jobs
         FOR EACH ROW
         EXECUTE FUNCTION block_test_job_insert('${gateKeyOne}', '${gateKeyTwo}')`,
      );

      await control.query("BEGIN");
      await control.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        gateKeyOne,
        gateKeyTwo,
      ]);

      const enqueue = provisioningJobService.enqueueAgentProvisionOnce({
        agentId: sandbox.id,
        organizationId: organization.id,
        userId: user.id,
        agentName: sandbox.agent_name ?? sandbox.id,
        expectedUpdatedAt: sandbox.updated_at,
      });
      await waitForAdvisoryWaiters(control, 1);

      const sweep =
        agentSandboxesRepository.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
      await waitForAdvisoryWaiters(control, 2);
      await control.query("COMMIT");

      const [enqueueResult, swept] = await Promise.all([enqueue, sweep]);
      expect(enqueueResult.created).toBe(true);
      expect(swept.map((row) => row.agentId)).not.toContain(sandbox.id);

      const [persistedSandbox] = await dbWrite
        .select({ status: agentSandboxes.status })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, sandbox.id));
      const activeJobs = await dbWrite
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.organization_id, organization.id),
            eq(jobs.agent_id, sandbox.id),
            eq(jobs.status, "pending"),
          ),
        );
      expect(persistedSandbox?.status).toBe("provisioning");
      expect(activeJobs).toHaveLength(1);
    } finally {
      await control.query("ROLLBACK");
      await Promise.allSettled([control.end(), setup.end()]);
    }
  }, 30_000);
});
