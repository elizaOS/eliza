/** Real job claim/recovery/settlement and app publication; only provider response timing is controlled. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { pushSchema } from "drizzle-kit/api";
import { eq, is, SQL, sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { resolveAccountDeletionTestDatabase } from "../../../db/account-deletion-test-database";

const conformanceUrl = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
const conformanceSchema = `provisioning_authority_${randomUUID().replaceAll("-", "_")}`;
const testDatabase = conformanceUrl ? "loopback-postgres" : resolveAccountDeletionTestDatabase();
if (!testDatabase) throw new Error("Provisioning tests require an isolated local database");
const realPostgres = testDatabase === "loopback-postgres";
if (conformanceUrl) {
  const parsed = new URL(conformanceUrl);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    !parsed.username.startsWith("qa_")
  )
    throw new Error("Provisioning conformance requires a loopback PostgreSQL qa_* role");
  parsed.searchParams.set("options", `-c search_path=${conformanceSchema},pg_catalog`);
  process.env.DATABASE_URL = parsed.toString();
  process.env.TEST_DATABASE_URL = parsed.toString();
} else {
  process.env.DATABASE_URL = realPostgres
    ? (process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL)
    : "pglite://memory";
}
if (realPostgres) process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "true";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { apiKeys } from "../../../db/schemas/api-keys";
import { containers } from "../../../db/schemas/containers";
import { generations } from "../../../db/schemas/generations";
import { jobExecutionLeases } from "../../../db/schemas/job-execution-leases";
import { jobs } from "../../../db/schemas/jobs";
import { organizations } from "../../../db/schemas/organizations";
import { usageRecords } from "../../../db/schemas/usage-records";
import { users } from "../../../db/schemas/users";

let db: typeof import("../../../db/client").dbWrite;
let close: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let schemaClient: Client | undefined;
let schemaCreated = false;

function columnDefault(value: unknown, type: string): string {
  if (value === undefined) return "";
  if (is(value, SQL)) {
    const query = new PgDialect().sqlToQuery(value);
    if (query.params.length) throw new Error("Fixture defaults require literal production DDL");
    return ` DEFAULT ${query.sql}`;
  }
  if (value === null) return " DEFAULT NULL";
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean")
    return ` DEFAULT ${String(value)}`;
  if (typeof value === "string") return ` DEFAULT '${value.replaceAll("'", "''")}'`;
  if (type === "jsonb" || type === "json")
    return ` DEFAULT '${JSON.stringify(value).replaceAll("'", "''")}'::${type}`;
  throw new Error(`Unsupported fixture default for ${type}`);
}

beforeAll(async () => {
  if (conformanceUrl) {
    schemaClient = new Client({ connectionString: conformanceUrl });
    await schemaClient.connect();
    await schemaClient.query(
      `CREATE SCHEMA ${conformanceSchema}; SET search_path TO ${conformanceSchema},pg_catalog`,
    );
    schemaCreated = true;
    const enums = new Set<string>();
    for (const table of [
      organizations,
      users,
      apiKeys,
      generations,
      usageRecords,
      jobs,
      jobExecutionLeases,
    ]) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const enumeration = (
          column as unknown as { enum?: { enumName: string; enumValues: string[] } }
        ).enum;
        if (enumeration && !enums.has(enumeration.enumName)) {
          await schemaClient.query(
            `CREATE TYPE "${enumeration.enumName}" AS ENUM (${enumeration.enumValues.map((value) => `'${value.replaceAll("'", "''")}'`).join(",")})`,
          );
          enums.add(enumeration.enumName);
        }
      }
      await schemaClient.query(
        `CREATE TABLE "${config.name}" (${config.columns
          .map(
            (column) =>
              `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}${column.notNull ? " NOT NULL" : ""}${columnDefault(column.default, column.getSQLType())}`,
          )
          .join(",")})`,
      );
    }
    await schemaClient.query(
      "ALTER TABLE job_execution_leases ADD FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE",
    );
  }
  ({ dbWrite: db, closeDatabaseConnectionsForTests: close } = await import("../../../db/client"));
  if (!conformanceUrl) {
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        apiKeys,
        generations,
        usageRecords,
        jobs,
        jobExecutionLeases,
      } as never,
      db as never,
    );
    await apply();
  }
  await db.execute(CONTAINER_DDL);
  await db.execute(
    "CREATE TABLE docker_nodes(node_id text PRIMARY KEY,allocated_count integer NOT NULL DEFAULT 0,capacity integer NOT NULL,enabled boolean NOT NULL DEFAULT true,placement_state text NOT NULL DEFAULT 'open',updated_at timestamp NOT NULL DEFAULT now())",
  );
  await db.execute("INSERT INTO docker_nodes(node_id,capacity) VALUES('witness-node',10)");
}, 120000);
afterAll(async () => {
  try {
    if (close) await close();
  } finally {
    if (schemaClient) {
      try {
        if (schemaCreated) await schemaClient.query(`DROP SCHEMA ${conformanceSchema} CASCADE`);
      } finally {
        await schemaClient.end();
      }
    }
  }
});

async function fixture() {
  const { jobsRepository } = await import("../../../db/repositories/jobs");
  const { containersRepository } = await import("../../../db/repositories/containers");
  const { ContainerRepoAppContainerStore } = await import("../app-container-store");
  const { ElizaError } = await import("@elizaos/core");
  const orgId = randomUUID(),
    userId = randomUUID(),
    containerId = randomUUID(),
    appId = randomUUID(),
    appGeneration = randomUUID();
  await db
    .insert(organizations)
    .values({ id: orgId, name: "Authority", slug: `authority-${orgId}`, credit_balance: "5" });
  await db
    .insert(users)
    .values({ id: userId, organization_id: orgId, steward_user_id: `authority-${userId}` });
  await db.insert(containers).values({
    id: containerId,
    name: `app-${containerId}`,
    project_name: appId,
    organization_id: orgId,
    user_id: userId,
    status: "deploying",
    image_tag: "ghcr.io/elizaos/test:latest",
    metadata: { appId, deploymentGeneration: appGeneration },
  });
  const [job] = await db
    .insert(jobs)
    .values({
      type: "container_provision",
      organization_id: orgId,
      user_id: userId,
      data: { containerId, organizationId: orgId, userId, deploymentGeneration: appGeneration },
    })
    .returning();
  const ownerA = randomUUID(),
    ownerB = randomUUID();
  const [claimA] = await jobsRepository.claimPendingJobs({
    type: "container_provision",
    organizationId: orgId,
    limit: 1,
    executionOwnerId: ownerA,
    executionLeaseMs: 60000,
  });
  if (!claimA || !job) throw new Error("Fixture claim missing");
  const authority = (claim: typeof claimA, ownerId: string) => ({
    jobId: claim.id,
    organizationId: orgId,
    executionGeneration: claim.execution_generation!,
    executionOwnerId: ownerId,
  });
  const store = (executionAuthority?: import("../job-execution-authority").JobExecutionAuthority) =>
    new ContainerRepoAppContainerStore({
      readDatabase: db as never,
      writeDatabase: db as never,
      repository: containersRepository,
      executionAuthority,
      errorFactory: (message, options) => new ElizaError(message, options),
    });
  const snapshot = await store().getById(containerId);
  if (!snapshot) throw new Error("Fixture row missing");
  const publication = {
    organizationId: orgId,
    deploymentGeneration: appGeneration,
    createdAtSnapshot: snapshot.createdAtSnapshot,
  };
  const recover = async (nextOwner = ownerB) => {
    // Claims and leases use the database clock. Keep fixture aging on that
    // clock even when the local PostgreSQL session is outside UTC.
    await db.execute(
      sql`UPDATE job_execution_leases SET expires_at=clock_timestamp()-interval '1 minute' WHERE job_id=${job.id}`,
    );
    await db.execute(
      sql`UPDATE jobs SET started_at=clock_timestamp()-interval '2 minutes' WHERE id=${job.id}`,
    );
    const result = await jobsRepository.recoverInProgressJobsStartedBefore({
      type: "container_provision",
      organizationId: orgId,
      startedBefore: new Date(),
    });
    expect(result.retried).toBe(1);
    expect(result.failures).toHaveLength(0);
    const [claimB] = await jobsRepository.claimPendingJobs({
      type: "container_provision",
      organizationId: orgId,
      limit: 1,
      executionOwnerId: nextOwner,
      executionLeaseMs: 60000,
    });
    if (!claimB) throw new Error("Recovery claim missing");
    expect(claimB.execution_generation).not.toBe(claimA.execution_generation);
    return claimB;
  };
  return {
    jobsRepository,
    orgId,
    userId,
    containerId,
    appId,
    appGeneration,
    job,
    claimA,
    ownerA,
    ownerB,
    store,
    authority,
    publication,
    recover,
  };
}

for (const lateFailure of [false, true]) {
  test(`recovered worker ${lateFailure ? "failure" : "success"} cannot mutate successor placement or delete by name`, async () => {
    const f = await fixture();
    const initialCount = Number(
      (await db.execute(sql`SELECT allocated_count FROM docker_nodes WHERE node_id='witness-node'`))
        .rows[0]!.allocated_count,
    );
    const { setContainerExecutorDeps } = await import("../container-job-service");
    const { ProvisioningJobService } = await import("../../../node/provisioning-worker");
    const { assertJobExecutionAuthority, lockJobExecutionAuthority } = await import(
      "../../../db/repositories/job-execution-authority"
    );
    const started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<{
        containerId: string;
        hostPort: number;
        network: string;
        nodeId: string;
        nodeHost: string;
      }>();
    let calls = 0;
    const deleted: string[] = [];
    setContainerExecutorDeps((authority) => ({
      store: f.store(authority),
      isAppDeploymentCurrent: async () => true,
      assertExecutionCurrent: authority
        ? () =>
            db.transaction(async (tx) => {
              await lockJobExecutionAuthority(tx, authority);
              await assertJobExecutionAuthority(tx, authority);
            })
        : undefined,
      provider: {
        targetNodeId: "witness-node",
        async provision() {
          calls++;
          if (calls === 1) {
            started.resolve();
            return await release.promise;
          }
          return {
            containerId: "newer-docker",
            hostPort: 22002,
            network: "app-network",
            nodeId: "witness-node",
            nodeHost: "127.0.0.1",
          };
        },
        async deletePrimaryById(id: string) {
          deleted.push(id);
        },
        async delete(name: string) {
          deleted.push(`name:${name}`);
        },
      } as never,
    }));
    type Dispatch = { executeJobDispatch(job: typeof f.claimA): Promise<void> };
    const first = new ProvisioningJobService({ executionOwnerId: f.ownerA }) as unknown as Dispatch;
    const firstOutcome = first.executeJobDispatch(f.claimA).then(
      () => null,
      (error) => error,
    );
    await started.promise;
    const claimB = await f.recover();
    const second = new ProvisioningJobService({
      executionOwnerId: f.ownerB,
    }) as unknown as Dispatch;
    await second.executeJobDispatch(claimB);
    if (lateFailure) release.reject(new Error("late provider error"));
    else
      release.resolve({
        containerId: "older-docker",
        hostPort: 22001,
        network: "app-network",
        nodeId: "witness-node",
        nodeHost: "127.0.0.1",
      });
    const failure = await firstOutcome;
    expect(failure?.name).toBe("StaleJobExecutionError");
    const [after] = await db.select().from(containers).where(eq(containers.id, f.containerId));
    const [settled] = await db.select().from(jobs).where(eq(jobs.id, f.job.id));
    expect(settled!.status).toBe("completed");
    expect(settled!.execution_generation).toBe(claimB.execution_generation);
    expect(after!.status).toBe("running");
    expect(after!.metadata.hostContainerId).toBe("newer-docker");
    expect(deleted).toEqual(lateFailure ? [] : ["older-docker"]);
    const result = await db.execute(
      sql`SELECT allocated_count FROM docker_nodes WHERE node_id='witness-node'`,
    );
    expect(Number(result.rows[0]!.allocated_count)).toBe(initialCount + 1);
  }, 120000);
}

test("expired lease fails dependent writes before any takeover", async () => {
  const f = await fixture();
  const store = f.store(f.authority(f.claimA, f.ownerA));
  await db
    .update(jobExecutionLeases)
    .set({ expires_at: new Date(0) })
    .where(eq(jobExecutionLeases.job_id, f.job.id));
  await expect(
    store.markRunning(
      f.containerId,
      { hostContainerId: "late", hostPort: 12, network: "n" },
      f.publication,
    ),
  ).rejects.toHaveProperty("name", "StaleJobExecutionError");
  const [row] = await db.select().from(containers).where(eq(containers.id, f.containerId));
  expect(row!.status).toBe("deploying");
  expect(row!.metadata.hostContainerId).toBeUndefined();
});

test("job tenant, owner and generation each fence dependent publication", async () => {
  const f = await fixture();
  const authority = f.authority(f.claimA, f.ownerA);
  for (const invalid of [
    { ...authority, organizationId: randomUUID() },
    { ...authority, executionOwnerId: randomUUID() },
    { ...authority, executionGeneration: randomUUID() },
  ]) {
    await expect(
      f
        .store(invalid)
        .markRunning(
          f.containerId,
          { hostContainerId: "foreign", hostPort: 12, network: "n" },
          f.publication,
        ),
    ).rejects.toHaveProperty("name", "StaleJobExecutionError");
  }
  const [row] = await db.select().from(containers).where(eq(containers.id, f.containerId));
  expect(row!.status).toBe("deploying");
  expect(row!.metadata.hostContainerId).toBeUndefined();
});

test("the same worker owner cannot reuse a stale execution generation", async () => {
  const f = await fixture();
  const replacement = await f.recover(f.ownerA);
  await expect(
    f
      .store(f.authority(f.claimA, f.ownerA))
      .markRunning(
        f.containerId,
        { hostContainerId: "old-generation", hostPort: 12, network: "n" },
        f.publication,
      ),
  ).rejects.toHaveProperty("name", "StaleJobExecutionError");
  await f
    .store(f.authority(replacement, f.ownerA))
    .markRunning(
      f.containerId,
      { hostContainerId: "new-generation", hostPort: 13, network: "n" },
      f.publication,
    );
  const [row] = await db.select().from(containers).where(eq(containers.id, f.containerId));
  expect(row!.metadata.hostContainerId).toBe("new-generation");
});

test("all dependent failure, release and deletion writes reject a superseded claim", async () => {
  const f = await fixture();
  const store = f.store(f.authority(f.claimA, f.ownerA));
  await store.claimNodeSlot(f.containerId, f.orgId, "witness-node");
  await f.recover();
  const effects = [
    () => store.markError(f.containerId, "late", f.publication),
    () => store.markCleanupRequired(f.containerId, "late", f.publication),
    () => store.rollbackNodeSlotClaim(f.containerId, f.orgId, "witness-node", f.publication),
    () => store.markDeleted(f.containerId, f.orgId, "witness-node"),
    () => store.claimNodeSlot(f.containerId, f.orgId, "witness-node"),
  ];
  for (const effect of effects)
    await expect(effect()).rejects.toHaveProperty("name", "StaleJobExecutionError");
  const [row] = await db.select().from(containers).where(eq(containers.id, f.containerId));
  expect(row!.status).toBe("deploying");
  expect(row!.metadata.slotClaimedAt).toBeDefined();
  expect(row!.metadata.slotReleasedAt).toBeUndefined();
});

test("cancelled claim cannot publish after provider completion", async () => {
  const f = await fixture();
  await f.jobsRepository.settleExecution(f.claimA, "cancelled", {}, f.ownerA);
  await expect(
    f
      .store(f.authority(f.claimA, f.ownerA))
      .markRunning(
        f.containerId,
        { hostContainerId: "late", hostPort: 12, network: "n" },
        f.publication,
      ),
  ).rejects.toHaveProperty("name", "StaleJobExecutionError");
});

test("a live job cannot change a terminal container back to failed", async () => {
  const f = await fixture();
  await db.update(containers).set({ status: "deleted" }).where(eq(containers.id, f.containerId));
  await f.store(f.authority(f.claimA, f.ownerA)).markError(f.containerId, "late failure");
  const [row] = await db.select().from(containers).where(eq(containers.id, f.containerId));
  expect(row!.status).toBe("deleted");
});

test("expired execution rejects each container provider entry point before dispatch", async () => {
  const f = await fixture();
  const authority = f.authority(f.claimA, f.ownerA);
  await db
    .update(containers)
    .set({
      metadata: {
        appId: f.appId,
        deploymentGeneration: f.appGeneration,
        hostContainerId: "original-docker",
      },
    })
    .where(eq(containers.id, f.containerId));
  await db
    .update(jobExecutionLeases)
    .set({ expires_at: new Date(0) })
    .where(eq(jobExecutionLeases.job_id, f.job.id));
  const { assertJobExecutionAuthority, lockJobExecutionAuthority } = await import(
    "../../../db/repositories/job-execution-authority"
  );
  const executors = await import("../container-job-executors");
  let providerCalls = 0;
  const forbiddenCall = async () => {
    providerCalls++;
    throw new Error("Unexpected provider dispatch");
  };
  const deps = {
    store: f.store(authority),
    isAppDeploymentCurrent: async () => true,
    assertExecutionCurrent: () =>
      db.transaction(async (tx) => {
        await lockJobExecutionAuthority(tx, authority);
        await assertJobExecutionAuthority(tx, authority);
      }),
    provider: {
      targetNodeId: "witness-node",
      provision: forbiddenCall,
      restart: forbiddenCall,
      logs: forbiddenCall,
      delete: forbiddenCall,
      deleteById: forbiddenCall,
      deletePrimaryById: forbiddenCall,
    },
  } as import("../container-job-executors").ContainerExecutorDeps;
  for (const execute of [
    executors.executeContainerProvision,
    executors.executeContainerRestart,
    executors.executeContainerLogs,
    executors.executeContainerUpgrade,
    executors.executeContainerDelete,
  ]) {
    await expect(execute(f.claimA, deps)).rejects.toHaveProperty("name", "StaleJobExecutionError");
  }
  expect(providerCalls).toBe(0);
});

test("retirement beats a live claim's delayed publication without losing its delete receipt", async () => {
  const f = await fixture();
  const { retireContainerWithDeleteJob } = await import("../container-retirement");
  const retirement = await retireContainerWithDeleteJob(f.containerId, f.orgId);
  await expect(
    f
      .store(f.authority(f.claimA, f.ownerA))
      .markRunning(
        f.containerId,
        { hostContainerId: "late", hostPort: 12, network: "n" },
        f.publication,
      ),
  ).rejects.toHaveProperty("code", "APP_CONTAINER_PUBLICATION_STALE");
  const [row] = await db.select().from(containers).where(eq(containers.id, f.containerId));
  expect(row!.status).toBe("deleting");
  expect((row!.metadata.retirement as { deleteJobId: string }).deleteJobId).toBe(retirement.jobId!);
});

test.skipIf(!realPostgres)(
  "publication rechecks the database lease clock after waiting for its resource lock",
  async () => {
    const f = await fixture();
    const control = new Client({ connectionString: process.env.DATABASE_URL });
    await control.connect();
    let publication: Promise<unknown> | undefined;
    try {
      await db.execute(
        sql`UPDATE job_execution_leases SET expires_at=clock_timestamp()+interval '1 second' WHERE job_id=${f.job.id}`,
      );
      await control.query("BEGIN");
      await control.query("SELECT id FROM containers WHERE id=$1 FOR UPDATE", [f.containerId]);
      const {
        rows: [self],
      } = await control.query("SELECT pg_backend_pid() AS pid");
      publication = f
        .store(f.authority(f.claimA, f.ownerA))
        .markRunning(
          f.containerId,
          { hostContainerId: "expired-docker", hostPort: 12000, network: "n" },
          f.publication,
        )
        .then(
          (value) => value,
          (error) => error,
        );
      const deadline = Date.now() + 5000;
      let blocked = false,
        expired = false;
      while (Date.now() < deadline) {
        const {
          rows: [state],
        } = await control.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked, clock_timestamp()>=(SELECT expires_at FROM job_execution_leases WHERE job_id=$2) AS expired",
          [self.pid, f.job.id],
        );
        blocked ||= state.blocked;
        expired = state.expired;
        if (blocked && expired) break;
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      expect(expired).toBe(true);
      await control.query("ROLLBACK");
      expect(await publication).toHaveProperty("name", "StaleJobExecutionError");
      const [row] = await db.select().from(containers).where(eq(containers.id, f.containerId));
      expect(row!.status).toBe("deploying");
      expect(row!.metadata.hostContainerId).toBeUndefined();
    } finally {
      await control.query("ROLLBACK");
      await publication;
      await control.end();
    }
  },
);

test.skipIf(!realPostgres)(
  "an admitted dependent transaction retains its locks through lease expiry",
  async () => {
    const f = await fixture();
    const { containersRepository } = await import("../../../db/repositories/containers");
    const { ContainerRepoAppContainerStore } = await import("../app-container-store");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const control = new Client({ connectionString: process.env.DATABASE_URL });
    await control.connect();
    const store = new ContainerRepoAppContainerStore({
      readDatabase: db as never,
      writeDatabase: db as never,
      executionAuthority: f.authority(f.claimA, f.ownerA),
      repository: {
        tryReleaseNodeSlot: containersRepository.tryReleaseNodeSlot.bind(containersRepository),
        updateStatus: containersRepository.updateStatus.bind(containersRepository),
        async update(...args: Parameters<typeof containersRepository.update>) {
          entered.resolve();
          await release.promise;
          return await containersRepository.update(...args);
        },
      },
      errorFactory: (message, options) => Object.assign(new Error(message), options),
    });
    await db.execute(
      sql`UPDATE job_execution_leases SET expires_at=clock_timestamp()+interval '2 seconds' WHERE job_id=${f.job.id}`,
    );
    const publication = store.markRunning(
      f.containerId,
      { hostContainerId: "admitted-docker", hostPort: 12000, network: "n" },
      f.publication,
    );
    try {
      await Promise.race([entered.promise, publication]);
      await expect(
        control.query("SELECT id FROM jobs WHERE id=$1 FOR UPDATE NOWAIT", [f.job.id]),
      ).rejects.toHaveProperty("code", "55P03");
      await expect(
        control.query("SELECT job_id FROM job_execution_leases WHERE job_id=$1 FOR UPDATE NOWAIT", [
          f.job.id,
        ]),
      ).rejects.toHaveProperty("code", "55P03");
      await expect(
        control.query("SELECT id FROM containers WHERE id=$1 FOR UPDATE NOWAIT", [f.containerId]),
      ).rejects.toHaveProperty("code", "55P03");
      const deadline = Date.now() + 10000;
      let expired = false;
      while (!expired && Date.now() < deadline) {
        const result = await control.query(
          "SELECT clock_timestamp()>=expires_at AS expired FROM job_execution_leases WHERE job_id=$1",
          [f.job.id],
        );
        expired = result.rows[0].expired;
        if (!expired) await Bun.sleep(10);
      }
      expect(expired).toBe(true);
      release.resolve();
      await publication;
      const [row] = await db.select().from(containers).where(eq(containers.id, f.containerId));
      expect(row!.status).toBe("running");
      expect(row!.metadata.hostContainerId).toBe("admitted-docker");
    } finally {
      release.resolve();
      await publication.catch(() => {});
      await control.end();
    }
  },
  30000,
);

const CONTAINER_DDL = `CREATE TABLE containers (
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
        total_billed numeric(10,2) NOT NULL DEFAULT 0,
        lifecycle_revision integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`;
