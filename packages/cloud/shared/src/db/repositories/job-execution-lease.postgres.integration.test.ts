/** Real PostgreSQL interleavings for the job repository lease protocol. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { is, SQL, sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import { jobExecutionLeases } from "../schemas/job-execution-leases";
import type { Job } from "../schemas/jobs";
import { jobs } from "../schemas/jobs";

const url = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
const schema = `job_lease_${randomUUID().replaceAll("-", "_")}`;
const owner1 = randomUUID();
const owner2 = randomUUID();
let setup: Client;
let locker: Client;
let scopedUrl: string;
let database: typeof import("../client");
let bindings: typeof import("../../lib/runtime/cloud-bindings");
let repository: typeof import("./jobs");
let storage: typeof import("../../lib/storage/r2-runtime-binding");

function fixtureDefault(value: unknown, type: string): string {
  if (value === undefined) return "";
  if (is(value, SQL)) {
    const query = new PgDialect().sqlToQuery(value);
    if (query.params.length) throw Error("Job fixture defaults must be literal DDL");
    return ` DEFAULT ${query.sql}`;
  }
  if (value === null) return " DEFAULT NULL";
  if (typeof value === "number" || typeof value === "boolean") return ` DEFAULT ${value}`;
  if (typeof value === "string") return ` DEFAULT '${value.replaceAll("'", "''")}'`;
  if (type === "jsonb") return ` DEFAULT '${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  throw Error("Unsupported job fixture default");
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  return await bindings.runWithCloudBindingsAsync(
    {
      DATABASE_URL: scopedUrl,
      TEST_DATABASE_URL: scopedUrl,
      NODE_ENV: "test",
      ENVIRONMENT: "local",
      SQL_HEAVY_PAYLOAD_STORAGE: "inline",
    },
    fn,
  );
}

async function seed(overrides: Partial<Job> & { organization_id: string }): Promise<Job> {
  const [job] = await run(() =>
    database.dbWrite
      .insert(jobs)
      .values({
        type: "app_deploy",
        data: { appId: randomUUID() },
        ...overrides,
      })
      .returning(),
  );
  return job;
}

async function claim(job: Job, owner = owner1): Promise<Job> {
  const rows = await run(() =>
    repository.jobsRepository.claimPendingJobs({
      type: job.type,
      organizationId: job.organization_id,
      limit: 1,
      executionOwnerId: owner,
    }),
  );
  expect(rows.map((row) => row.id)).toEqual([job.id]);
  return rows[0];
}

async function expire(job: Job): Promise<void> {
  await setup.query("UPDATE jobs SET started_at=NOW()-interval '1 hour' WHERE id=$1", [job.id]);
  await setup.query(
    "UPDATE job_execution_leases SET expires_at=NOW()-interval '1 minute' WHERE job_id=$1",
    [job.id],
  );
}

(url ? describe : describe.skip)("job generation leases on real PostgreSQL", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      !parsed.username.startsWith("qa_")
    )
      throw Error("Job lease tests require loopback PostgreSQL with a qa_* role");
    setup = new Client({ connectionString: url });
    await setup.connect();
    await setup.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},pg_catalog`);
    for (const table of [jobs, jobExecutionLeases, agentSandboxes]) {
      const config = getTableConfig(table);
      await setup.query(
        `CREATE TABLE "${config.name}" (${config.columns
          .map(
            (column) =>
              `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}${column.notNull ? " NOT NULL" : ""}${fixtureDefault(column.default, column.getSQLType())}`,
          )
          .join(",")})`,
      );
    }
    await setup.query(
      "ALTER TABLE job_execution_leases ADD FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE",
    );
    parsed.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
    scopedUrl = parsed.toString();
    locker = new Client({ connectionString: scopedUrl });
    await locker.connect();
    database = await import("../client");
    bindings = await import("../../lib/runtime/cloud-bindings");
    repository = await import("./jobs");
    storage = await import("../../lib/storage/r2-runtime-binding");
  }, 60_000);

  afterAll(async () => {
    storage?.setRuntimeR2Bucket(null);
    if (database) await database.closeDatabaseConnectionsForTests();
    if (locker) await locker.end();
    if (setup) {
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    }
  });

  test("claim skips a locked due row and installs the exact owner lease", async () => {
    const organizationId = randomUUID();
    const first = await seed({ organization_id: organizationId });
    const foreign = await seed({ organization_id: randomUUID() });
    const second = await seed({ organization_id: organizationId });
    await locker.query("BEGIN");
    try {
      await locker.query("SELECT id FROM jobs WHERE id=$1 FOR UPDATE", [first.id]);
      const claimed = await claim(second);
      const lease = await setup.query(
        "SELECT execution_generation,owner_id FROM job_execution_leases WHERE job_id=$1",
        [second.id],
      );
      expect(lease.rows).toEqual([
        { execution_generation: claimed.execution_generation, owner_id: owner1 },
      ]);
      expect(
        (await setup.query("SELECT status FROM jobs WHERE id=$1", [first.id])).rows[0].status,
      ).toBe("pending");
      expect(
        (await setup.query("SELECT status FROM jobs WHERE id=$1", [foreign.id])).rows[0].status,
      ).toBe("pending");
    } finally {
      await locker.query("ROLLBACK");
    }
    await setup.query("DELETE FROM jobs WHERE id=ANY($1::uuid[])", [
      [first.id, second.id, foreign.id],
    ]);
  });

  test("a failed lease installation rolls back the job claim", async () => {
    const organizationId = randomUUID();
    const job = await seed({ organization_id: organizationId });
    await setup.query(
      "ALTER TABLE job_execution_leases ADD CONSTRAINT reject_test_lease CHECK (false) NOT VALID",
    );
    try {
      await expect(
        run(() =>
          repository.jobsRepository.claimPendingJobs({
            type: job.type,
            organizationId,
            limit: 1,
            executionOwnerId: owner1,
          }),
        ),
      ).rejects.toBeDefined();
      expect(
        (await setup.query("SELECT status,execution_generation FROM jobs WHERE id=$1", [job.id]))
          .rows,
      ).toEqual([{ status: "pending", execution_generation: null }]);
    } finally {
      await setup.query("ALTER TABLE job_execution_leases DROP CONSTRAINT reject_test_lease");
    }
    await setup.query("DELETE FROM jobs WHERE id=$1", [job.id]);
  });

  test("an expired lease can renew before recovery commits", async () => {
    const organizationId = randomUUID();
    const claimed = await claim(await seed({ organization_id: organizationId }));
    await expire(claimed);
    await expect(
      run(() => repository.jobsRepository.assertExecutionLease(claimed, owner1)),
    ).rejects.toMatchObject({ name: "StaleJobExecutionError" });
    expect(await run(() => repository.jobsRepository.renewExecutionLease(claimed, owner1))).toBe(
      "renewed",
    );
    await run(() => repository.jobsRepository.assertExecutionLease(claimed, owner1));
    const result = await run(() =>
      repository.jobsRepository.recoverStaleJobs({
        type: claimed.type,
        organizationId,
        staleThresholdMs: 1,
      }),
    );
    expect(result).toMatchObject({ scanned: 0, retried: 0, failures: [] });
    await setup.query("DELETE FROM jobs WHERE id=$1", [claimed.id]);
  });

  test("recovery replaces a generation and refuses stale mutation and settlement", async () => {
    const organizationId = randomUUID();
    const claimed = await claim(await seed({ organization_id: organizationId }));
    await expire(claimed);
    const recovered = await run(() =>
      repository.jobsRepository.recoverStaleJobs({
        type: claimed.type,
        organizationId,
        staleThresholdMs: 1,
      }),
    );
    expect(recovered).toMatchObject({ retried: 1, failures: [] });
    const next = await claim(claimed, owner2);
    expect(next.execution_generation).not.toBe(claimed.execution_generation);
    await run(() =>
      repository.jobsRepository.updateForExecution(next, { result: { receipt: "next" } }, owner2),
    );
    await expect(
      run(() =>
        repository.jobsRepository.updateForExecution(
          claimed,
          { result: { receipt: "stale" } },
          owner1,
        ),
      ),
    ).rejects.toMatchObject({ name: "StaleJobExecutionError" });
    await expect(
      run(() => repository.jobsRepository.settleExecution(claimed, "completed", undefined, owner1)),
    ).rejects.toMatchObject({ name: "StaleJobExecutionError" });
    expect(await run(() => repository.jobsRepository.renewExecutionLease(claimed, owner1))).toBe(
      "lost",
    );
    const current = await run(() => repository.jobsRepository.findByIdForWrite(claimed.id));
    expect(current?.result).toEqual({ receipt: "next" });
    await setup.query("DELETE FROM jobs WHERE id=$1", [claimed.id]);
  });

  test("same-generation terminal rejection is replay-safe and classified settled", async () => {
    const organizationId = randomUUID();
    const claimed = await claim(await seed({ organization_id: organizationId }));
    expect(
      await run(() =>
        repository.jobsRepository.rejectClaimedExecution(claimed, "invalid payload", owner1),
      ),
    ).toBe("rejected");
    expect(
      await run(() =>
        repository.jobsRepository.rejectClaimedExecution(claimed, "invalid payload", owner1),
      ),
    ).toBe("already-terminal");
    expect(await run(() => repository.jobsRepository.renewExecutionLease(claimed, owner2))).toBe(
      "settled",
    );
    const current = await run(() => repository.jobsRepository.findByIdForWrite(claimed.id));
    expect(current).toMatchObject({ status: "failed", attempts: 1 });
    expect(
      (await setup.query("SELECT * FROM job_execution_leases WHERE job_id=$1", [claimed.id])).rows,
    ).toEqual([]);
    await setup.query("DELETE FROM jobs WHERE id=$1", [claimed.id]);
  });

  test("a failed claim response leaves a recoverable generation and lease", async () => {
    const organizationId = randomUUID();
    const job = await seed({
      organization_id: organizationId,
      data_storage: "r2",
      data_key: "claim-response-payload",
    });
    storage.setRuntimeR2Bucket({
      async get() {
        throw Error("controlled object read failure");
      },
      async put() {
        return {};
      },
      async delete() {},
    });
    try {
      await expect(
        run(() =>
          repository.jobsRepository.claimPendingJobs({
            type: job.type,
            organizationId,
            limit: 1,
            executionOwnerId: owner1,
          }),
        ),
      ).rejects.toMatchObject({ code: "OBJECT_STORAGE_FIELD_UNAVAILABLE" });
    } finally {
      storage.setRuntimeR2Bucket(null);
    }
    const persisted = (
      await setup.query("SELECT status,execution_generation FROM jobs WHERE id=$1", [job.id])
    ).rows[0];
    const lease = (
      await setup.query(
        "SELECT execution_generation,owner_id FROM job_execution_leases WHERE job_id=$1",
        [job.id],
      )
    ).rows[0];
    expect(persisted.status).toBe("in_progress");
    expect(lease).toEqual({
      execution_generation: persisted.execution_generation,
      owner_id: owner1,
    });
    await expire(job);
    expect(
      await run(() =>
        repository.jobsRepository.recoverStaleJobs({
          type: job.type,
          organizationId,
          staleThresholdMs: 1,
        }),
      ),
    ).toMatchObject({ retried: 1, failures: [] });
    await setup.query("DELETE FROM jobs WHERE id=$1", [job.id]);
  });

  test("renewal during recovery hydration invalidates the selected stale snapshot", async () => {
    const organizationId = randomUUID();
    const claimed = await claim(await seed({ organization_id: organizationId, attempts: 2 }));
    await setup.query("UPDATE jobs SET data_storage='r2',data_key='recovery-renewal' WHERE id=$1", [
      claimed.id,
    ]);
    await expire(claimed);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let callbacks = 0;
    storage.setRuntimeR2Bucket({
      async get() {
        entered.resolve();
        await release.promise;
        return {
          async text() {
            return JSON.stringify(claimed.data);
          },
        };
      },
      async put() {
        return {};
      },
      async delete() {},
    });
    const recovery = run(() =>
      repository.jobsRepository.recoverStaleJobs({
        type: claimed.type,
        organizationId,
        staleThresholdMs: 1,
        buildFailureWriteback: () => async () => {
          callbacks++;
        },
      }),
    );
    try {
      await entered.promise;
      expect(await run(() => repository.jobsRepository.renewExecutionLease(claimed, owner1))).toBe(
        "renewed",
      );
    } finally {
      release.resolve();
    }
    try {
      expect(await recovery).toMatchObject({
        scanned: 1,
        unchanged: 1,
        permanentlyFailed: 0,
        failures: [],
      });
      expect(callbacks).toBe(0);
      await run(() => repository.jobsRepository.assertExecutionLease(claimed, owner1));
    } finally {
      storage.setRuntimeR2Bucket(null);
    }
    await setup.query("DELETE FROM jobs WHERE id=$1", [claimed.id]);
  }, 30_000);

  test("dependent failure rolls back recovery and remains retryable", async () => {
    const organizationId = randomUUID();
    const claimed = await claim(await seed({ organization_id: organizationId, attempts: 2 }));
    await expire(claimed);
    let callbackCount = 0;
    const fail = await run(() =>
      repository.jobsRepository.recoverStaleJobs({
        type: claimed.type,
        organizationId,
        staleThresholdMs: 1,
        buildFailureWriteback: () => async () => {
          callbackCount++;
          throw Error("dependent write failed");
        },
      }),
    );
    expect(fail).toMatchObject({ permanentlyFailed: 0, retried: 0 });
    expect(fail.failures).toHaveLength(1);
    expect(
      (await setup.query("SELECT status,attempts FROM jobs WHERE id=$1", [claimed.id])).rows,
    ).toEqual([{ status: "in_progress", attempts: 2 }]);
    expect(
      (await setup.query("SELECT job_id FROM job_execution_leases WHERE job_id=$1", [claimed.id]))
        .rows,
    ).toHaveLength(1);
    const retry = await run(() =>
      repository.jobsRepository.recoverStaleJobs({
        type: claimed.type,
        organizationId,
        staleThresholdMs: 1,
        buildFailureWriteback: () => async () => {
          callbackCount++;
        },
      }),
    );
    expect(retry).toMatchObject({ permanentlyFailed: 1, failures: [] });
    expect(callbackCount).toBe(2);
    expect(
      (await setup.query("SELECT status,attempts FROM jobs WHERE id=$1", [claimed.id])).rows,
    ).toEqual([{ status: "failed", attempts: 3 }]);
    expect(
      (await setup.query("SELECT job_id FROM job_execution_leases WHERE job_id=$1", [claimed.id]))
        .rows,
    ).toEqual([]);
    await setup.query("DELETE FROM jobs WHERE id=$1", [claimed.id]);
  });

  test("restart recovery consumes the interruption budget without spending attempts", async () => {
    const organizationId = randomUUID();
    const claimed = await claim(
      await seed({ organization_id: organizationId, attempts: 2, execution_interruptions: 5 }),
    );
    await expire(claimed);
    expect(
      await run(() =>
        repository.jobsRepository.recoverInProgressJobsStartedBefore({
          type: claimed.type,
          organizationId,
          startedBefore: new Date(),
        }),
      ),
    ).toMatchObject({ permanentlyFailed: 1, retried: 0, failures: [] });
    expect(
      (
        await setup.query("SELECT status,attempts,execution_interruptions FROM jobs WHERE id=$1", [
          claimed.id,
        ])
      ).rows,
    ).toEqual([{ status: "failed", attempts: 2, execution_interruptions: 6 }]);
    await setup.query("DELETE FROM jobs WHERE id=$1", [claimed.id]);
  });

  test("a legacy in-progress row acquires a fresh generation after recovery", async () => {
    const organizationId = randomUUID();
    const legacy = await seed({
      organization_id: organizationId,
      status: "in_progress",
      started_at: new Date(Date.now() - 3_600_000),
      attempts: 1,
    });
    expect(
      await run(() =>
        repository.jobsRepository.recoverInProgressJobsStartedBefore({
          type: legacy.type,
          organizationId,
          startedBefore: new Date(),
        }),
      ),
    ).toMatchObject({ retried: 1, failures: [] });
    const claimed = await claim(legacy);
    expect(claimed.execution_generation).not.toBeNull();
    expect(claimed).toMatchObject({ attempts: 1, execution_interruptions: 1 });
    await run(() => repository.jobsRepository.assertExecutionLease(claimed, owner1));
    await setup.query("DELETE FROM jobs WHERE id=$1", [claimed.id]);
  });

  test("lifecycle settlement requires and releases the exact resource fence", async () => {
    const organizationId = randomUUID();
    const [agent] = await run(() =>
      database.dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: organizationId,
          user_id: randomUUID(),
          agent_name: "lease-fence-test",
        })
        .returning(),
    );
    const claimed = await claim(
      await seed({ organization_id: organizationId, type: "agent_restart", agent_id: agent.id }),
    );
    await expect(
      run(() => repository.jobsRepository.settleExecution(claimed, "completed", undefined, owner1)),
    ).rejects.toMatchObject({ name: "StaleJobExecutionError" });
    const { updateAgentLifecycleExecutionFence } = await import(
      "./agent-lifecycle-execution-fence"
    );
    await run(() =>
      database.dbWrite.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${agent.id}))`,
        );
        await repository.jobsRepository.assertExecutionLease(claimed, owner1);
        expect(
          await updateAgentLifecycleExecutionFence(
            tx,
            claimed,
            claimed.execution_generation!,
            "claim",
          ),
        ).toEqual({ id: agent.id });
      }),
    );
    expect(
      await run(() =>
        repository.jobsRepository.settleExecution(claimed, "completed", undefined, owner1),
      ),
    ).toBe(true);
    expect(
      (
        await setup.query(
          "SELECT lifecycle_job_id,lifecycle_execution_generation FROM agent_sandboxes WHERE id=$1",
          [agent.id],
        )
      ).rows,
    ).toEqual([{ lifecycle_job_id: null, lifecycle_execution_generation: null }]);
    await setup.query("DELETE FROM jobs WHERE id=$1", [claimed.id]);
    await setup.query("DELETE FROM agent_sandboxes WHERE id=$1", [agent.id]);
  });

  test("a missing lifecycle resource permits terminal job cleanup", async () => {
    const organizationId = randomUUID();
    const claimed = await claim(
      await seed({
        organization_id: organizationId,
        type: "agent_restart",
        agent_id: randomUUID(),
      }),
    );
    expect(
      await run(() =>
        repository.jobsRepository.settleExecution(claimed, "cancelled", undefined, owner1),
      ),
    ).toBe(true);
    expect((await setup.query("SELECT status FROM jobs WHERE id=$1", [claimed.id])).rows).toEqual([
      { status: "cancelled" },
    ]);
    expect(
      (await setup.query("SELECT job_id FROM job_execution_leases WHERE job_id=$1", [claimed.id]))
        .rows,
    ).toEqual([]);
    await setup.query("DELETE FROM jobs WHERE id=$1", [claimed.id]);
  });

  test("recovery preserves a lifecycle fence held by another job", async () => {
    const organizationId = randomUUID();
    const [agent] = await run(() =>
      database.dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: organizationId,
          user_id: randomUUID(),
          agent_name: "foreign-fence-test",
        })
        .returning(),
    );
    const foreignJob = await claim(
      await seed({ organization_id: organizationId, type: "agent_restart", agent_id: agent.id }),
      owner2,
    );
    const { updateAgentLifecycleExecutionFence } = await import(
      "./agent-lifecycle-execution-fence"
    );
    await run(() =>
      database.dbWrite.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${agent.id}))`,
        );
        expect(
          await updateAgentLifecycleExecutionFence(
            tx,
            foreignJob,
            foreignJob.execution_generation!,
            "claim",
          ),
        ).toEqual({ id: agent.id });
      }),
    );
    const claimed = await claim(
      await seed({ organization_id: organizationId, type: "agent_restart", agent_id: agent.id }),
    );
    await expire(claimed);
    expect(
      await run(() =>
        repository.jobsRepository.recoverStaleJobs({
          type: claimed.type,
          organizationId,
          staleThresholdMs: 1,
        }),
      ),
    ).toMatchObject({ retried: 1, failures: [] });
    expect(
      (
        await setup.query(
          "SELECT lifecycle_job_id,lifecycle_execution_generation FROM agent_sandboxes WHERE id=$1",
          [agent.id],
        )
      ).rows,
    ).toEqual([
      {
        lifecycle_job_id: foreignJob.id,
        lifecycle_execution_generation: foreignJob.execution_generation,
      },
    ]);
    await run(() => repository.jobsRepository.assertExecutionLease(foreignJob, owner2));
    await setup.query("DELETE FROM jobs WHERE id=ANY($1::uuid[])", [[claimed.id, foreignJob.id]]);
    await setup.query("DELETE FROM agent_sandboxes WHERE id=$1", [agent.id]);
  });
});
