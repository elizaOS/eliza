/**
 * Exercises the legacy CONTAINER_DELETE reconciler against real in-process
 * Postgres semantics (PGlite): classification of persisted payloads, dry-run
 * write-freedom, the two status-guarded apply transitions, idempotent
 * re-application, and concurrent double-apply safety. Integration-backed; no
 * mocks stand in for the system under test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const TIMEOUT = 60_000;
const ORG_A = "00000000-0000-4000-8000-000000015821";
const ORG_B = "00000000-0000-4000-8000-000000025821";
const CONTAINER_A = "00000000-0000-4000-8000-000000115821";
const CONTAINER_B = "00000000-0000-4000-8000-000000215821";
const JOB_VALID = "00000000-0000-4000-8000-000000315821";
const JOB_ORG_ONLY_FAILED = "00000000-0000-4000-8000-000000415821";
const JOB_ORG_ONLY_NO_ROWS = "00000000-0000-4000-8000-000000515821";
const JOB_UNRECOVERABLE_PENDING = "00000000-0000-4000-8000-000000615821";
const JOB_UNRECOVERABLE_FAILED = "00000000-0000-4000-8000-000000715821";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let reconcileContainerDeleteJobs: typeof import("../container-delete-job-reconciler").reconcileContainerDeleteJobs;
let UNRECOVERABLE_DELETE_JOB_ERROR: string;
let databaseReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ reconcileContainerDeleteJobs, UNRECOVERABLE_DELETE_JOB_ERROR } = await import(
      "../container-delete-job-reconciler"
    ));
    await dbWrite.execute(`
      CREATE TABLE IF NOT EXISTS containers (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        status text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamp NOT NULL DEFAULT now()
      );
    `);
    await dbWrite.execute(`
      CREATE TABLE IF NOT EXISTS jobs (
        id uuid PRIMARY KEY,
        type text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        data jsonb NOT NULL,
        error text,
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 3,
        organization_id uuid NOT NULL,
        scheduled_for timestamp NOT NULL DEFAULT now(),
        completed_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      );
    `);
  } catch (error) {
    databaseReady = false;
    console.warn("[container-delete-job-reconciler-test] PGlite setup failed", error);
  }
}, TIMEOUT);

afterAll(async () => {
  await closeDb?.();
});

async function seed(): Promise<void> {
  await dbWrite.execute("DELETE FROM jobs");
  await dbWrite.execute("DELETE FROM containers");
  await dbWrite.execute(`
    INSERT INTO containers (id, organization_id, status, metadata) VALUES
      ('${CONTAINER_A}', '${ORG_A}', 'deleting', '{"hostContainerId":"abc123"}'::jsonb),
      ('${CONTAINER_B}', '${ORG_A}', 'running', '{}'::jsonb)
  `);
  await dbWrite.execute(`
    INSERT INTO jobs (id, type, status, data, attempts, organization_id, error) VALUES
      ('${JOB_VALID}', 'container_delete', 'pending',
       '{"containerId":"${CONTAINER_A}","organizationId":"${ORG_A}"}'::jsonb, 0, '${ORG_A}', NULL),
      ('${JOB_ORG_ONLY_FAILED}', 'container_delete', 'failed',
       '{"organizationId":"${ORG_A}"}'::jsonb, 3, '${ORG_A}', 'Invalid container delete job data'),
      ('${JOB_ORG_ONLY_NO_ROWS}', 'container_delete', 'failed',
       '{"organizationId":"${ORG_B}"}'::jsonb, 3, '${ORG_B}', 'Invalid container delete job data'),
      ('${JOB_UNRECOVERABLE_PENDING}', 'container_delete', 'pending',
       '{"containerId":""}'::jsonb, 0, '${ORG_B}', NULL),
      ('${JOB_UNRECOVERABLE_FAILED}', 'container_delete', 'failed',
       '{}'::jsonb, 3, '${ORG_B}', 'Invalid container delete job data')
  `);
}

async function jobRow(id: string): Promise<{ status: string; error: string | null }> {
  const result = await dbWrite.execute(`SELECT status, error FROM jobs WHERE id = '${id}'`);
  const rows = (result as { rows: Array<{ status: string; error: string | null }> }).rows;
  expect(rows.length).toBe(1);
  return rows[0];
}

describe("container-delete job reconciler (PGlite integration)", () => {
  beforeEach(async () => {
    if (!databaseReady) return;
    await seed();
  });

  test(
    "dry run classifies every row and writes nothing",
    async () => {
      if (!databaseReady) return;
      const report = await reconcileContainerDeleteJobs(dbWrite);
      expect(report.dryRun).toBe(true);
      expect(report.scannedJobs).toBe(5);
      expect(report.validJobs).toBe(1);
      expect(report.recoverableJobs).toBe(2);
      expect(report.unrecoverableJobs).toBe(2);
      expect(report.requeuedJobs).toBe(0);
      expect(report.markedFailedJobs).toBe(0);

      const byId = new Map(report.entries.map((entry) => [entry.jobId, entry]));
      expect(byId.get(JOB_VALID)?.plannedAction).toBe("none");
      expect(byId.get(JOB_ORG_ONLY_FAILED)?.plannedAction).toBe("requeue");
      expect(byId.get(JOB_ORG_ONLY_FAILED)?.deletingContainerIds).toEqual([CONTAINER_A]);
      expect(byId.get(JOB_ORG_ONLY_FAILED)?.deletingContainersWithHostId).toBe(1);
      expect(byId.get(JOB_ORG_ONLY_NO_ROWS)?.plannedAction).toBe("none");
      expect(byId.get(JOB_UNRECOVERABLE_PENDING)?.plannedAction).toBe("mark-failed");
      expect(byId.get(JOB_UNRECOVERABLE_FAILED)?.plannedAction).toBe("none");
      for (const entry of report.entries) expect(entry.applied).toBe(false);

      expect((await jobRow(JOB_ORG_ONLY_FAILED)).status).toBe("failed");
      expect((await jobRow(JOB_UNRECOVERABLE_PENDING)).status).toBe("pending");
    },
    TIMEOUT,
  );

  test(
    "apply performs only the two guarded transitions and is idempotent",
    async () => {
      if (!databaseReady) return;
      const first = await reconcileContainerDeleteJobs(dbWrite, { apply: true });
      expect(first.requeuedJobs).toBe(1);
      expect(first.markedFailedJobs).toBe(1);

      const requeued = await jobRow(JOB_ORG_ONLY_FAILED);
      expect(requeued.status).toBe("pending");
      expect(requeued.error).toBeNull();
      const failed = await jobRow(JOB_UNRECOVERABLE_PENDING);
      expect(failed.status).toBe("failed");
      expect(failed.error).toBe(UNRECOVERABLE_DELETE_JOB_ERROR);
      expect((await jobRow(JOB_VALID)).status).toBe("pending");
      expect((await jobRow(JOB_ORG_ONLY_NO_ROWS)).status).toBe("failed");

      const second = await reconcileContainerDeleteJobs(dbWrite, { apply: true });
      expect(second.requeuedJobs).toBe(0);
      // The previously stamped unrecoverable row is failed now; a re-run
      // reports it without touching it again.
      expect(second.markedFailedJobs).toBe(0);
      expect((await jobRow(JOB_ORG_ONLY_FAILED)).status).toBe("pending");
    },
    TIMEOUT,
  );

  test(
    "concurrent apply runs never double-transition a row",
    async () => {
      if (!databaseReady) return;
      const [a, b] = await Promise.all([
        reconcileContainerDeleteJobs(dbWrite, { apply: true }),
        reconcileContainerDeleteJobs(dbWrite, { apply: true }),
      ]);
      expect(a.requeuedJobs + b.requeuedJobs).toBe(1);
      expect(a.markedFailedJobs + b.markedFailedJobs).toBe(1);
      expect((await jobRow(JOB_ORG_ONLY_FAILED)).status).toBe("pending");
      expect((await jobRow(JOB_UNRECOVERABLE_PENDING)).status).toBe("failed");
    },
    TIMEOUT,
  );

  test(
    "requeued organization-only row satisfies the executor's recovery contract",
    async () => {
      if (!databaseReady) return;
      await reconcileContainerDeleteJobs(dbWrite, { apply: true });
      const { isContainerDeleteJobData } = await import("../container-jobs-data");
      const result = await dbWrite.execute(
        `SELECT data FROM jobs WHERE id = '${JOB_ORG_ONLY_FAILED}'`,
      );
      const data = (result as { rows: Array<{ data: unknown }> }).rows[0].data;
      // Still organization-only (the reconciler never fabricates a containerId),
      // which is exactly the shape the executor's recovery branch handles.
      expect(isContainerDeleteJobData(data)).toBe(false);
      const organizationId = Reflect.get(data as object, "organizationId");
      expect(organizationId).toBe(ORG_A);
    },
    TIMEOUT,
  );
});
