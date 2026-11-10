/** Real PostgreSQL admission, rollback and response interleavings. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { jobExecutionLeases } from "../schemas/job-execution-leases";
import { jobs, type NewJob } from "../schemas/jobs";

const databaseUrl = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
const schema = `job_capacity_${randomUUID().replaceAll("-", "_")}`;
const applicationName = `capacity_${randomUUID()}`;
const owner = randomUUID();
let scopedUrl: string;
let setup: Client;
let locker: Client;
let database: typeof import("../client");
let bindings: typeof import("../../lib/runtime/cloud-bindings");
let repository: typeof import("./jobs");
let storage: typeof import("../../lib/storage/r2-runtime-binding");
let sharedTypes: string[];
let maximum: number;
let schemaCreated = false;
let ready = false;

function fixtureDefault(value: unknown, type: string): string {
  if (value === undefined) return "";
  if (is(value, SQL)) {
    const query = new PgDialect().sqlToQuery(value);
    if (query.params.length) throw new Error("Capacity fixture defaults require literal DDL");
    return ` DEFAULT ${query.sql}`;
  }
  if (value === null) return " DEFAULT NULL";
  if (typeof value === "number" || typeof value === "boolean") return ` DEFAULT ${value}`;
  if (typeof value === "string") return ` DEFAULT '${value.replaceAll("'", "''")}'`;
  if (type === "jsonb") return ` DEFAULT '${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  throw new Error("Unsupported capacity fixture default");
}

async function run<T>(operation: () => Promise<T>): Promise<T> {
  return await bindings.runWithCloudBindingsAsync(
    {
      DATABASE_URL: scopedUrl,
      TEST_DATABASE_URL: scopedUrl,
      NODE_ENV: "test",
      ENVIRONMENT: "local",
      SQL_HEAVY_PAYLOAD_STORAGE: "inline",
    },
    operation,
  );
}

async function seed(type: string, organizationId: string, extra: Partial<NewJob> = {}) {
  const [job] = await run(() =>
    database.dbWrite
      .insert(jobs)
      .values({ type, organization_id: organizationId, data: {}, ...extra })
      .returning(),
  );
  if (!job) throw new Error("Capacity fixture job missing");
  return job;
}

async function seedRunning(type: string, organizationId: string) {
  const job = await seed(type, organizationId);
  const claimed = await run(() =>
    repository.jobsRepository.claimPendingJobs({
      type,
      organizationId,
      limit: 1,
      executionOwnerId: owner,
    }),
  );
  expect(claimed.map((row) => row.id)).toEqual([job.id]);
  return claimed[0];
}

async function claim(type: string, organizationId: string, limit = 5) {
  return await run(() =>
    repository.jobsRepository.claimPendingJobsWithinSharedRunningLimit({
      type,
      organizationId,
      sharedTypes,
      maxRunning: maximum,
      limit,
      executionOwnerId: owner,
    }),
  );
}

(databaseUrl ? describe : describe.skip)("shared image-change capacity on real PostgreSQL", () => {
  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      !parsed.username.startsWith("qa_")
    ) {
      throw new Error("Capacity tests require an isolated loopback PostgreSQL qa_* role");
    }
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    await setup.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},pg_catalog`);
    schemaCreated = true;
    for (const table of [jobs, jobExecutionLeases]) {
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
    parsed.searchParams.set("application_name", applicationName);
    scopedUrl = parsed.toString();
    locker = new Client({ connectionString: scopedUrl });
    await locker.connect();
    database = await import("../client");
    bindings = await import("../../lib/runtime/cloud-bindings");
    repository = await import("./jobs");
    storage = await import("../../lib/storage/r2-runtime-binding");
    ({ SHARED_IMAGE_CHANGE_JOB_TYPES: sharedTypes } = await import(
      "../../lib/services/provisioning-job-policy"
    ));
    ({ ADMIN_CANARY_MAX_RUNNING_JOBS: maximum } = await import(
      "../../lib/services/admin-canary-image"
    ));
    expect(sharedTypes).toEqual(["agent_upgrade", "agent_admin_canary_image"]);
    expect(maximum).toBe(3);
    ready = true;
  }, 60_000);

  afterEach(async () => {
    storage?.setRuntimeR2Bucket(null);
    if (locker) await locker.query("ROLLBACK");
    if (ready) await setup.query("TRUNCATE job_execution_leases, jobs");
  });

  afterAll(async () => {
    try {
      if (database) await database.closeDatabaseConnectionsForTests();
    } finally {
      if (locker) await locker.end();
      if (setup) {
        try {
          if (schemaCreated) await setup.query(`DROP SCHEMA ${schema} CASCADE`);
        } finally {
          await setup.end();
        }
      }
    }
  });

  test("concurrent cross-type claims share the last global capacity slot", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    await seedRunning(sharedTypes[0], orgA);
    await seedRunning(sharedTypes[1], orgB);
    await seed(sharedTypes[0], orgA);
    await seed(sharedTypes[1], orgB);
    await locker.query("BEGIN");
    await locker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('eliza:image-change-capacity:v1',0))",
    );
    const pending = Promise.all([claim(sharedTypes[0], orgA), claim(sharedTypes[1], orgB)]);
    let waiting = 0;
    try {
      const deadline = Date.now() + 8_000;
      while (waiting < 2 && Date.now() < deadline) {
        const result = await setup.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'",
          [applicationName],
        );
        waiting = result.rows[0].count;
        if (waiting < 2) await Bun.sleep(10);
      }
    } finally {
      await locker.query("ROLLBACK");
    }
    const responses = await pending;
    expect(waiting).toBe(2);
    expect(responses.flat()).toHaveLength(1);
    for (const [index, rows] of responses.entries()) {
      for (const row of rows) {
        expect(row.type).toBe(sharedTypes[index]);
        expect(row.organization_id).toBe(index === 0 ? orgA : orgB);
        expect(
          (
            await setup.query(
              "SELECT execution_generation,owner_id FROM job_execution_leases WHERE job_id=$1",
              [row.id],
            )
          ).rows,
        ).toEqual([{ execution_generation: row.execution_generation, owner_id: owner }]);
      }
    }
    expect(
      (await setup.query("SELECT count(*)::int AS count FROM jobs WHERE status='in_progress'"))
        .rows[0].count,
    ).toBe(3);
  }, 30_000);

  test("foreign tenant occupancy counts while due tenant candidates keep their order", async () => {
    const organizationId = randomUUID();
    const foreignOrganization = randomUUID();
    await seedRunning(sharedTypes[0], foreignOrganization);
    await seedRunning(sharedTypes[1], foreignOrganization);
    const first = await seed(sharedTypes[0], organizationId);
    const second = await seed(sharedTypes[0], organizationId);
    const foreign = await seed(sharedTypes[0], foreignOrganization);
    const future = await seed(sharedTypes[0], organizationId, {
      scheduled_for: new Date(Date.now() + 3_600_000),
    });
    await setup.query("UPDATE jobs SET scheduled_for=NOW()-interval '2 minutes' WHERE id=$1", [
      first.id,
    ]);
    await setup.query("UPDATE jobs SET scheduled_for=NOW()-interval '1 minute' WHERE id=$1", [
      second.id,
    ]);
    expect((await claim(sharedTypes[0], organizationId)).map((job) => job.id)).toEqual([first.id]);
    expect(
      (
        await setup.query("SELECT id FROM jobs WHERE id=ANY($1::uuid[]) AND status='pending'", [
          [second.id, foreign.id, future.id],
        ])
      ).rows,
    ).toHaveLength(3);
  });

  test("a locked first row is skipped without blocking the next due claim", async () => {
    const organizationId = randomUUID();
    const first = await seed(sharedTypes[0], organizationId);
    const second = await seed(sharedTypes[0], organizationId);
    await setup.query("UPDATE jobs SET scheduled_for=NOW()-interval '2 minutes' WHERE id=$1", [
      first.id,
    ]);
    await locker.query("BEGIN");
    try {
      await locker.query("SELECT id FROM jobs WHERE id=$1 FOR UPDATE", [first.id]);
      expect((await claim(sharedTypes[0], organizationId)).map((job) => job.id)).toEqual([
        second.id,
      ]);
      expect(
        (await setup.query("SELECT status FROM jobs WHERE id=$1", [first.id])).rows[0].status,
      ).toBe("pending");
    } finally {
      await locker.query("ROLLBACK");
    }
  }, 30_000);

  test("failed lease installation rolls back both admission and capacity consumption", async () => {
    const organizationId = randomUUID();
    const job = await seed(sharedTypes[0], organizationId);
    await setup.query(
      `ALTER TABLE job_execution_leases ADD CONSTRAINT capacity_controlled_failure CHECK(owner_id <> '${owner}')`,
    );
    try {
      await expect(claim(sharedTypes[0], organizationId)).rejects.toThrow();
      expect(
        (await setup.query("SELECT status,execution_generation FROM jobs WHERE id=$1", [job.id]))
          .rows,
      ).toEqual([{ status: "pending", execution_generation: null }]);
      expect((await setup.query("SELECT * FROM job_execution_leases")).rows).toHaveLength(0);
      await locker.query("BEGIN");
      try {
        expect(
          (
            await locker.query(
              "SELECT pg_try_advisory_xact_lock(hashtextextended('eliza:image-change-capacity:v1',0)) AS acquired",
            )
          ).rows[0].acquired,
        ).toBe(true);
      } finally {
        await locker.query("ROLLBACK");
      }
    } finally {
      await setup.query(
        "ALTER TABLE job_execution_leases DROP CONSTRAINT capacity_controlled_failure",
      );
    }
    expect((await claim(sharedTypes[0], organizationId)).map((row) => row.id)).toEqual([job.id]);
  });

  test("historical overfull occupancy admits no additional job", async () => {
    const organizationId = randomUUID();
    for (let index = 0; index < 4; index++) {
      await seedRunning(sharedTypes[index % sharedTypes.length], randomUUID());
    }
    const pending = await seed(sharedTypes[0], organizationId);
    expect(await claim(sharedTypes[0], organizationId)).toEqual([]);
    expect(
      (await setup.query("SELECT status,execution_generation FROM jobs WHERE id=$1", [pending.id]))
        .rows,
    ).toEqual([{ status: "pending", execution_generation: null }]);
    expect(
      (await setup.query("SELECT count(*)::int AS count FROM job_execution_leases")).rows[0].count,
    ).toBe(4);
  });

  test("postcommit hydration failure retains the exact durable capacity claim", async () => {
    const organizationId = randomUUID();
    const job = await seed(sharedTypes[0], organizationId, {
      data_storage: "r2",
      data_key: "capacity-response-payload",
    });
    storage.setRuntimeR2Bucket({
      async get() {
        throw new Error("controlled capacity response read failure");
      },
      async put() {
        return {};
      },
      async delete() {},
    });
    try {
      await expect(claim(sharedTypes[0], organizationId)).rejects.toMatchObject({
        code: "OBJECT_STORAGE_FIELD_UNAVAILABLE",
      });
    } finally {
      storage.setRuntimeR2Bucket(null);
    }
    const persisted = (
      await setup.query("SELECT status,execution_generation FROM jobs WHERE id=$1", [job.id])
    ).rows[0];
    expect(persisted.status).toBe("in_progress");
    expect(
      (
        await setup.query(
          "SELECT execution_generation,owner_id FROM job_execution_leases WHERE job_id=$1",
          [job.id],
        )
      ).rows,
    ).toEqual([{ execution_generation: persisted.execution_generation, owner_id: owner }]);
  });

  test("queue eligibility uses current database time after an advisory lock wait", async () => {
    const organizationId = randomUUID();
    const job = await seed(sharedTypes[0], organizationId);
    await setup.query(
      "UPDATE jobs SET scheduled_for=clock_timestamp()+interval '1 hour' WHERE id=$1",
      [job.id],
    );
    await locker.query("BEGIN");
    await locker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('eliza:image-change-capacity:v1',0))",
    );
    const pending = claim(sharedTypes[0], organizationId);
    let waiting = false;
    let dueAfterStart = false;
    try {
      const deadline = Date.now() + 8_000;
      while (!waiting && Date.now() < deadline) {
        const result = await setup.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory') AS waiting",
          [applicationName],
        );
        waiting = result.rows[0].waiting;
        if (!waiting) await Bun.sleep(10);
      }
      // The transaction is already waiting. Move the fixture deadline just
      // beyond its start, then cross it on the real database clock.
      await setup.query(
        "UPDATE jobs SET scheduled_for=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",
        [job.id],
      );
      await setup.query("SELECT pg_sleep(0.2)");
      const relation = await setup.query(
        `SELECT bool_and(j.scheduled_for > a.xact_start AND j.scheduled_for < clock_timestamp()) AS crossed
         FROM jobs j CROSS JOIN pg_stat_activity a
         WHERE j.id=$1 AND a.application_name=$2 AND a.wait_event='advisory'`,
        [job.id, applicationName],
      );
      dueAfterStart = relation.rows[0].crossed === true;
    } finally {
      await locker.query("ROLLBACK");
    }
    const waitingTransaction = await pending;
    expect(waiting).toBe(true);
    expect(dueAfterStart).toBe(true);
    expect(waitingTransaction.map((row) => row.id)).toEqual([job.id]);
    expect(await claim(sharedTypes[0], organizationId)).toEqual([]);
  }, 30_000);

  test("invalid shared capacity inputs return empty without changing the queue", async () => {
    const organizationId = randomUUID();
    const job = await seed(sharedTypes[0], organizationId);
    for (const invalid of [{ sharedTypes: [] }, { maxRunning: 0 }, { limit: 0 }]) {
      expect(
        await run(() =>
          repository.jobsRepository.claimPendingJobsWithinSharedRunningLimit({
            type: sharedTypes[0],
            organizationId,
            sharedTypes,
            maxRunning: maximum,
            limit: 5,
            executionOwnerId: owner,
            ...invalid,
          }),
        ),
      ).toEqual([]);
    }
    expect(
      (await setup.query("SELECT status FROM jobs WHERE id=$1", [job.id])).rows[0].status,
    ).toBe("pending");
    expect((await setup.query("SELECT * FROM job_execution_leases")).rows).toHaveLength(0);
  });
});
