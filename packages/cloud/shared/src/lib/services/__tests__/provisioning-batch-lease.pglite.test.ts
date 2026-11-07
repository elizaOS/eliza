/** A provisioning batch runs its claimed jobs one at a time. A job waiting behind a slow one must keep a live execution lease, or the stale-job sweep counts it as timed out before it has run. Real ProvisioningJobService claim and lease heartbeat on PGlite; only job execution is controlled. */

import { afterAll, beforeAll, expect, test } from "bun:test";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error("provisioning-batch-lease.pglite.test requires an isolated PGlite DATABASE_URL");
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { ProvisioningJobService } from "@elizaos/cloud-shared/node";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { apiKeys } from "../../../db/schemas/api-keys";
import { generations } from "../../../db/schemas/generations";
import { jobExecutionLeases } from "../../../db/schemas/job-execution-leases";
import { jobs } from "../../../db/schemas/jobs";
import { organizations } from "../../../db/schemas/organizations";
import { usageRecords } from "../../../db/schemas/usage-records";
import { users } from "../../../db/schemas/users";
import { JOB_TYPES } from "../provisioning-job-types";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  const { apply } = await pushSchema(
    { organizations, users, apiKeys, generations, jobs, jobExecutionLeases, usageRecords } as never,
    dbWrite as never,
  );
  await apply();
}, 120_000);

afterAll(async () => {
  await closeDb();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the third claimed job keeps a live lease while two slow jobs run", async () => {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: `org-${crypto.randomUUID()}`, credit_balance: "5.000000" })
    .returning();
  const claimed = await dbWrite
    .insert(jobs)
    .values(
      [1, 2, 3].map((n) => ({
        type: JOB_TYPES.APP_DEPLOY,
        data: { appId: `app-${n}` },
        organization_id: organization.id,
      })),
    )
    .returning();

  // A lease is the job timeout plus two heartbeats (400 + 2 x 50 = 500 ms).
  // The first job runs to just under its timeout and the second for 300 ms,
  // so at 600 ms the third is still waiting, past its claim-time lease.
  const executed: string[] = [];
  const worker = new ProvisioningJobService({
    executeJob: async (job) => {
      executed.push(job.id);
      if (executed.length === 1) await sleep(380);
      if (executed.length === 2) await sleep(300);
    },
    executionTimeoutMs: () => 400,
    executionLeaseMs: 100,
    executionLeaseHeartbeatMs: 50,
  });
  const run = worker.processPendingJobs(3, { jobTypes: [JOB_TYPES.APP_DEPLOY] });

  await sleep(600);
  expect(executed).toHaveLength(2);
  const waiting = claimed.find((job) => !executed.includes(job.id));
  if (!waiting) throw new Error("no waiting job");
  const [lease] = await dbWrite
    .select({ live: sql<boolean>`${jobExecutionLeases.expires_at} > now()` })
    .from(jobExecutionLeases)
    .where(eq(jobExecutionLeases.job_id, waiting.id));
  expect(lease?.live).toBe(true);

  await run;
  expect(executed).toHaveLength(3);
}, 60_000);
