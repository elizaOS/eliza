/**
 * `reEnqueueFailedDeletions` must reach every stranded deletion whose retry
 * budget is not yet spent. A row the circuit breaker has abandoned
 * (`error_count >= maxReEnqueues`) is skipped without a write, so it stays in
 * the due set forever and occupies one slot of every capped batch. This test
 * puts two abandoned rows in front of one recoverable row and requires the
 * recoverable row to be reached. Real PGlite; the enqueue effect is a stub.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error(
    "provisioning-deletion-rearm-fairness.pglite.test requires an isolated PGlite DATABASE_URL",
  );
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { sql } from "drizzle-orm";

const ORGANIZATION_ID = "org-rearm-fairness";
const OLD = new Date("2026-10-01T00:00:00.000Z");

let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let dbWrite: typeof import("../../../db/client").dbWrite;
let provisioningJobService: typeof import("../provisioning-job-queue").provisioningJobService;

async function insertSandbox(
  id: string,
  status: string,
  errorCount: number | null,
  updatedAt: Date = OLD,
): Promise<void> {
  await dbWrite.execute(sql`
    INSERT INTO agent_sandboxes (id, organization_id, user_id, status, error_count, updated_at)
    VALUES (${id}, ${ORGANIZATION_ID}, ${"user-1"}, ${status}, ${errorCount}, ${updatedAt})
  `);
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ provisioningJobService } = await import("../provisioning-job-queue"));

  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_sandboxes (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      user_id text,
      status text NOT NULL,
      error_count integer,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY,
      agent_id text,
      organization_id text,
      type text,
      status text
    )
  `);
}, 120_000);

afterAll(async () => {
  await closeDb();
}, 60_000);

test("an abandoned row does not consume the batch in front of a recoverable row", async () => {
  await dbWrite.execute(sql`DELETE FROM agent_sandboxes`);
  // Inserted first: these two rows are the physical head of the due set, and
  // nothing ever writes them again, so an unordered capped SELECT returns them
  // on every sweep.
  await insertSandbox("sandbox-abandoned-1", "deletion_failed", 3);
  await insertSandbox("sandbox-abandoned-2", "deletion_pending", 7);
  await insertSandbox("sandbox-recoverable", "deletion_failed", 1);

  const enqueued: string[] = [];
  const spy = spyOn(provisioningJobService, "enqueueAgentDeleteOnce").mockImplementation(
    async (params: { agentId: string }) => {
      enqueued.push(params.agentId);
      return { id: `job-${params.agentId}` } as never;
    },
  );

  const result = await provisioningJobService.reEnqueueFailedDeletions({
    minAgeMs: 60 * 60 * 1000,
    maxAgents: 2,
    maxReEnqueues: 3,
  });

  spy.mockRestore();

  expect(enqueued).toEqual(["sandbox-recoverable"]);
  expect(result.reEnqueued).toBe(1);
  // The abandoned rows stay visible to ops as a count, not as batch work.
  expect(result.abandoned).toBe(2);
}, 60_000);

test("a due set larger than the batch is read oldest first", async () => {
  await dbWrite.execute(sql`DELETE FROM agent_sandboxes`);
  const now = Date.now();
  // Insertion order is deliberately not the waiting order: pglite returns the
  // physical head when the query has no ORDER BY.
  await insertSandbox("sandbox-newest", "deletion_failed", 0, new Date(now - 2 * 60 * 60 * 1000));
  await insertSandbox("sandbox-oldest", "deletion_failed", 0, new Date(now - 4 * 60 * 60 * 1000));
  await insertSandbox("sandbox-middle", "deletion_failed", 0, new Date(now - 3 * 60 * 60 * 1000));

  const enqueued: string[] = [];
  const spy = spyOn(provisioningJobService, "enqueueAgentDeleteOnce").mockImplementation(
    async (params: { agentId: string }) => {
      enqueued.push(params.agentId);
      return { id: `job-${params.agentId}` } as never;
    },
  );

  const result = await provisioningJobService.reEnqueueFailedDeletions({
    minAgeMs: 60 * 60 * 1000,
    maxAgents: 2,
    maxReEnqueues: 3,
  });

  spy.mockRestore();

  expect(enqueued).toEqual(["sandbox-oldest", "sandbox-middle"]);
  expect(result).toEqual({ scanned: 2, reEnqueued: 2, failed: 0, abandoned: 0 });
}, 60_000);
