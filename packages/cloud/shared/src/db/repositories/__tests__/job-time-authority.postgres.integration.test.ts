/** Real PostgreSQL proof of durable-job timestamp and retry authority. */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { runWithCloudBindingsAsync } from "../../../lib/runtime/cloud-bindings";
import { jobExecutionLeases } from "../../schemas/job-execution-leases";
import { jobs } from "../../schemas/jobs";

const url = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
let database: typeof import("../../client") | undefined;
let repository: typeof import("../jobs");
let admin: Client | undefined;
const schemas: string[] = [];

function fixtureDefault(value: unknown, type: string): string {
  if (value === undefined) return "";
  if (is(value, SQL)) {
    const query = new PgDialect().sqlToQuery(value);
    if (query.params.length) throw new Error("Job fixture defaults must be literal DDL");
    return ` DEFAULT ${query.sql}`;
  }
  if (value === null) return " DEFAULT NULL";
  if (typeof value === "number" || typeof value === "boolean") return ` DEFAULT ${value}`;
  if (typeof value === "string") return ` DEFAULT '${value.replaceAll("'", "''")}'`;
  if (type === "jsonb") return ` DEFAULT '${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  throw new Error("Unsupported job fixture default");
}

async function scoped(zone: string) {
  if (!admin || !database || !url) throw new Error("PostgreSQL fixture is not ready");
  const schema = `job_time_${randomUUID().replaceAll("-", "_")}`;
  schemas.push(schema);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema},pg_catalog -c timezone=${zone}`);
  const connectionString = parsed.toString();
  const control = new Client({ connectionString });
  await control.connect();
  for (const table of [jobs, jobExecutionLeases]) {
    const config = getTableConfig(table);
    await control.query(
      `CREATE TABLE ${config.name} (${config.columns
        .map(
          (column) =>
            `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}${column.notNull ? " NOT NULL" : ""}${fixtureDefault(column.default, column.getSQLType())}`,
        )
        .join(",")})`,
    );
  }
  const run = <T>(fn: () => Promise<T>) =>
    runWithCloudBindingsAsync(
      {
        DATABASE_URL: connectionString,
        TEST_DATABASE_URL: connectionString,
        NODE_ENV: "test",
        ENVIRONMENT: "local",
        MOCK_REDIS: "1",
        SQL_HEAVY_PAYLOAD_STORAGE: "inline",
      },
      fn,
    );
  const claim = async (leaseMs = 60_000) => {
    const organizationId = randomUUID(),
      id = randomUUID(),
      owner = randomUUID();
    await control.query(
      "INSERT INTO jobs(id,type,organization_id,data,estimated_completion_at) VALUES($1,'container_provision',$2,'{}',clock_timestamp()+interval '1 hour')",
      [id, organizationId],
    );
    const [job] = await run(() =>
      repository.jobsRepository.claimPendingJobs({
        type: "container_provision",
        organizationId,
        limit: 1,
        executionOwnerId: owner,
        executionLeaseMs: leaseMs,
      }),
    );
    if (!job?.execution_generation) throw new Error("Fixture did not obtain an execution claim");
    return { id, job, owner, organizationId };
  };
  return { run, claim, control };
}

async function withScope<T>(
  zone: string,
  fn: (scope: Awaited<ReturnType<typeof scoped>>) => Promise<T>,
) {
  const scope = await scoped(zone);
  try {
    return await fn(scope);
  } finally {
    await scope.control.end();
  }
}

async function sampleDatabaseTime(control: Client): Promise<string> {
  const result = await control.query<{ observed_at: string }>(
    "SELECT (clock_timestamp() AT TIME ZONE 'UTC')::text AS observed_at",
  );
  return result.rows[0].observed_at;
}

async function expectRetryWindow(control: Client, id: string, before: string) {
  const result = await control.query<{ within_window: boolean }>(
    `SELECT scheduled_for BETWEEN $2::timestamp + interval '30 seconds'
      AND (clock_timestamp() AT TIME ZONE 'UTC') + interval '30 seconds' AS within_window
      FROM jobs WHERE id=$1`,
    [id, before],
  );
  expect(result.rows[0].within_window).toBe(true);
}

(url ? describe : describe.skip)("durable job database-time authority", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      !parsed.username.startsWith("qa_")
    ) {
      throw new Error("Job time tests require an isolated loopback qa_* PostgreSQL database");
    }
    process.env.DATABASE_URL = url;
    process.env.NODE_ENV = "test";
    process.env.MOCK_REDIS = "1";
    admin = new Client({ connectionString: url });
    await admin.connect();
    database = await import("../../client");
    repository = await import("../jobs");
  });
  afterEach(() => setSystemTime());
  afterAll(async () => {
    await database?.closeDatabaseConnectionsForTests();
    if (admin) {
      try {
        for (const schema of schemas) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });

  for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu"]) {
    test(`${zone}: raw claimed timestamps match typed primary reads`, () =>
      withScope(zone, async ({ run, claim }) => {
        const { job, id } = await claim();
        const current = await run(() => repository.jobsRepository.findByIdForWrite(id));
        expect(current).toBeDefined();
        for (const field of [
          "created_at",
          "started_at",
          "updated_at",
          "scheduled_for",
          "estimated_completion_at",
        ] as const) {
          expect(job[field]).toBeInstanceOf(Date);
          expect((job[field] as Date).getTime()).toBe((current![field] as Date).getTime());
        }
      }));

    test(`${zone}: failed execution waits for its database backoff`, () =>
      withScope(zone, async ({ run, claim, control }) => {
        const { job, id, owner, organizationId } = await claim();
        const before = await sampleDatabaseTime(control);
        const retried = await run(() =>
          repository.jobsRepository.incrementAttempt(
            id,
            "provider failure",
            3,
            undefined,
            job.execution_generation!,
            owner,
          ),
        );
        expect(retried?.status).toBe("pending");
        expect(retried?.attempts).toBe(1);
        await expectRetryWindow(control, id, before);
        expect(
          await run(() =>
            repository.jobsRepository.claimPendingJobs({
              type: "container_provision",
              organizationId,
              limit: 1,
            }),
          ),
        ).toHaveLength(0);
      }));

    test(`${zone}: retryable outcomes accept the raw claim and preserve the attempt budget`, () =>
      withScope(zone, async ({ run, claim, control }) => {
        for (const bounded of [undefined, { maxRequeues: 2 }]) {
          const { job, id, owner } = await claim();
          const before = await sampleDatabaseTime(control);
          const retried = await run(() =>
            repository.jobsRepository.retryLaterWithoutIncrementingAttempts(
              job,
              "not ready",
              30_000,
              owner,
              bounded,
            ),
          );
          expect(retried?.status).toBe("pending");
          expect(retried?.attempts).toBe(0);
          expect(retried?.retryable_requeues).toBe(bounded ? 1 : 0);
          await expectRetryWindow(control, id, before);
        }
      }));
  }

  test("application clock skew cannot change a retry deadline", () =>
    withScope("UTC", async ({ run, claim, control }) => {
      const realNow = Date.now();
      for (const hours of [-5, 5]) {
        const { job, id, owner } = await claim();
        setSystemTime(realNow + hours * 3_600_000);
        const before = await sampleDatabaseTime(control);
        const retried = await run(() =>
          repository.jobsRepository.incrementAttempt(
            id,
            "provider failure",
            3,
            undefined,
            job.execution_generation!,
            owner,
          ),
        );
        expect(retried?.status).toBe("pending");
        await expectRetryWindow(control, id, before);
        setSystemTime();
      }
    }));

  test(
    "a renewal blocked on its job lock starts its lease after the wait",
    () =>
      withScope("America/New_York", async ({ run, claim, control }) => {
        const { job, id, owner } = await claim();
        await control.query("BEGIN");
        await control.query("SELECT id FROM jobs WHERE id=$1 FOR UPDATE", [id]);
        const {
          rows: [{ pid }],
        } = await control.query("SELECT pg_backend_pid() AS pid");
        const renewal = run(() => repository.jobsRepository.renewExecutionLease(job, owner, 1000));
        try {
          const deadline = Date.now() + 10_000;
          let ready = false;
          while (Date.now() < deadline) {
            // This control connection holds a transaction. Refresh its statistics
            // snapshot so a poll before renewal starts cannot stay stale.
            await control.query("SELECT pg_stat_clear_snapshot()");
            const {
              rows: [{ waited }],
            } = await control.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND clock_timestamp()>xact_start+interval '1.2 seconds') AS waited",
              [pid],
            );
            if (waited) {
              ready = true;
              break;
            }
            await Bun.sleep(10);
          }
          expect(ready).toBe(true);
          const {
            rows: [{ released_at: releasedAt }],
          } = await control.query("SELECT clock_timestamp()::text AS released_at");
          await control.query("ROLLBACK");
          expect(await renewal).toBe("renewed");
          const {
            rows: [{ starts_after_wait: startsAfterWait }],
          } = await control.query(
            "SELECT expires_at >= $2::timestamptz + interval '1 second' AS starts_after_wait FROM job_execution_leases WHERE job_id=$1",
            [id, releasedAt],
          );
          expect(startsAfterWait).toBe(true);
        } finally {
          await control.query("ROLLBACK");
          await renewal;
        }
      }),
    15_000,
  );

  test("old generations cannot reschedule a successor after recovery", () =>
    withScope("UTC", async ({ run, claim, control }) => {
      const old = await claim();
      await control.query(
        "UPDATE job_execution_leases SET expires_at=clock_timestamp()-interval '1 minute' WHERE job_id=$1",
        [old.id],
      );
      await control.query(
        "UPDATE jobs SET started_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",
        [old.id],
      );
      await run(() =>
        repository.jobsRepository.recoverInProgressJobsStartedBefore({
          type: "container_provision",
          organizationId: old.organizationId,
          startedBefore: new Date(),
        }),
      );
      const [next] = await run(() =>
        repository.jobsRepository.claimPendingJobs({
          type: "container_provision",
          organizationId: old.organizationId,
          limit: 1,
          executionOwnerId: randomUUID(),
        }),
      );
      expect(next?.execution_generation).not.toBe(old.job.execution_generation);
      expect(
        await run(() =>
          repository.jobsRepository.incrementAttempt(
            old.id,
            "stale failure",
            3,
            undefined,
            old.job.execution_generation!,
            old.owner,
          ),
        ),
      ).toBeUndefined();
      expect(
        await run(() =>
          repository.jobsRepository.retryLaterWithoutIncrementingAttempts(
            old.job,
            "stale retry",
            30_000,
            old.owner,
          ),
        ),
      ).toBeUndefined();
      const current = await run(() => repository.jobsRepository.findByIdForWrite(old.id));
      expect(current?.status).toBe("in_progress");
      expect(current?.execution_generation).toBe(next!.execution_generation);
    }));

  test("terminal failure preserves the original microsecond schedule", () =>
    withScope("UTC", async ({ run, claim, control }) => {
      const { job, id, owner } = await claim();
      await control.query(
        "UPDATE jobs SET scheduled_for=timestamp '2026-01-01 00:00:00.123456' WHERE id=$1",
        [id],
      );
      expect(
        (
          await run(() =>
            repository.jobsRepository.incrementAttempt(
              id,
              "exhausted",
              1,
              undefined,
              job.execution_generation!,
              owner,
            ),
          )
        )?.status,
      ).toBe("failed");
      const {
        rows: [{ original }],
      } = await control.query("SELECT scheduled_for::text AS original FROM jobs WHERE id=$1", [id]);
      expect(original).toBe("2026-01-01 00:00:00.123456");
    }));
});
