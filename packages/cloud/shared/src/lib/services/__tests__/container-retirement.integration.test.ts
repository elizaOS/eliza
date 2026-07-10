/**
 * Runs atomic container retirement and historical-row reconciliation against
 * real in-process Postgres semantics, including ambiguous post-commit failure.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const TIMEOUT = 60_000;
const ORG_ID = "00000000-0000-4000-8000-000000015951";
const RUNNING_ID = "00000000-0000-4000-8000-000000115951";
const TERMINAL_ID = "00000000-0000-4000-8000-000000315951";
const REJECTED_ID = "00000000-0000-4000-8000-000000515951";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let retireContainerWithDeleteJob: typeof import("../container-retirement").retireContainerWithDeleteJob;
let databaseReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ retireContainerWithDeleteJob } = await import("../container-retirement"));
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
        data_storage text NOT NULL DEFAULT 'inline',
        data_key text,
        agent_id text,
        character_id text,
        result jsonb,
        result_storage text NOT NULL DEFAULT 'inline',
        result_key text,
        error text,
        error_storage text NOT NULL DEFAULT 'inline',
        error_key text,
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 3,
        organization_id uuid NOT NULL,
        user_id uuid,
        api_key_id uuid,
        generation_id uuid,
        webhook_url text,
        webhook_status text,
        estimated_completion_at timestamp,
        scheduled_for timestamp NOT NULL DEFAULT now(),
        started_at timestamp,
        completed_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT reject_test_delete CHECK (
          type <> 'container_delete'
          OR data->>'containerId' <> '${REJECTED_ID}'
        )
      );
    `);
  } catch (error) {
    databaseReady = false;
    console.warn("[container-retirement-test] PGlite setup failed", error);
  }
}, TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

beforeEach(async () => {
  expect(databaseReady).toBe(true);
  await dbWrite.execute("DELETE FROM jobs;");
  await dbWrite.execute("DELETE FROM containers;");
});

async function seedContainer(id: string, status: string): Promise<void> {
  await dbWrite.execute(
    `INSERT INTO containers (id, organization_id, status)
     VALUES ('${id}', '${ORG_ID}', '${status}');`,
  );
}

async function databaseState(containerId: string): Promise<{
  status: string;
  deleteJobIds: string[];
  metadataJobId?: string;
}> {
  const containerResult = await dbWrite.execute(
    `SELECT status, metadata #>> '{retirement,deleteJobId}' AS delete_job_id
     FROM containers WHERE id = '${containerId}';`,
  );
  const jobResult = await dbWrite.execute(
    `SELECT id FROM jobs
     WHERE type = 'container_delete'
       AND data->>'containerId' = '${containerId}'
     ORDER BY created_at;`,
  );
  const container = containerResult.rows[0] as
    | { status: string; delete_job_id: string | null }
    | undefined;
  if (!container) throw new Error(`Missing container ${containerId}`);
  return {
    status: container.status,
    deleteJobIds: jobResult.rows.map((row) => String((row as { id: string }).id)),
    ...(container.delete_job_id ? { metadataJobId: container.delete_job_id } : {}),
  };
}

describe("atomic prior-container retirement", () => {
  test("a rejected job insert rolls back the deleting transition", async () => {
    await seedContainer(REJECTED_ID, "running");

    await expect(retireContainerWithDeleteJob(REJECTED_ID, ORG_ID)).rejects.toThrow();

    const state = await databaseState(REJECTED_ID);
    expect(state.status).toBe("running");
    expect(state.deleteJobIds).toEqual([]);
  });

  test("a commit-then-throw boundary leaves deleting paired with one durable job", async () => {
    await seedContainer(RUNNING_ID, "running");

    await expect(
      (async () => {
        await retireContainerWithDeleteJob(RUNNING_ID, ORG_ID);
        throw new Error("transport failed after database commit");
      })(),
    ).rejects.toThrow("after database commit");

    const state = await databaseState(RUNNING_ID);
    expect(state.status).toBe("deleting");
    expect(state.deleteJobIds).toHaveLength(1);
    expect(state.metadataJobId).toBe(state.deleteJobIds[0]);

    const retry = await retireContainerWithDeleteJob(RUNNING_ID, ORG_ID);
    expect(retry.outcome).toBe("already_owned");
    expect((await databaseState(RUNNING_ID)).deleteJobIds).toEqual(state.deleteJobIds);
  });

  test("a worker terminal transition cannot be overwritten by retry compensation", async () => {
    await seedContainer(TERMINAL_ID, "running");
    await retireContainerWithDeleteJob(TERMINAL_ID, ORG_ID);
    await dbWrite.execute(`UPDATE containers SET status = 'deleted' WHERE id = '${TERMINAL_ID}';`);

    const retry = await retireContainerWithDeleteJob(TERMINAL_ID, ORG_ID);

    expect(retry.outcome).toBe("worker_owned");
    expect((await databaseState(TERMINAL_ID)).status).toBe("deleted");
  });

  test("cleanup_required remains worker-owned and never receives a delete job", async () => {
    await seedContainer(TERMINAL_ID, "cleanup_required");

    const result = await retireContainerWithDeleteJob(TERMINAL_ID, ORG_ID);

    expect(result.outcome).toBe("worker_owned");
    const state = await databaseState(TERMINAL_ID);
    expect(state.status).toBe("cleanup_required");
    expect(state.deleteJobIds).toEqual([]);
  });
});

test("PGlite schema applied — database proofs never silently skip", () => {
  expect(databaseReady).toBe(true);
});
