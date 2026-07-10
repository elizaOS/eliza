/**
 * Applies the historical container-retirement repair to real PGlite tables and
 * proves it creates exactly one durable job without duplicating owned rows.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const TIMEOUT = 60_000;
const ORG_ID = "00000000-0000-4000-8000-000000015951";
const ORPHAN_ID = "00000000-0000-4000-8000-000000215951";
const OWNED_ID = "00000000-0000-4000-8000-000000315951";
const OWNED_JOB_ID = "00000000-0000-4000-8000-000000415951";
const migrationUrl = new URL("./migrations/0176_container_retirement_outbox.sql", import.meta.url);

let dbWrite: typeof import("./client").dbWrite;
let closeDb: typeof import("./client").closeDatabaseConnectionsForTests | undefined;
let databaseReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("./client"));
    await dbWrite.execute(`
      CREATE TABLE containers (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        status text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamp NOT NULL DEFAULT now()
      );
    `);
    await dbWrite.execute(`
      CREATE TABLE jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        type text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        data jsonb NOT NULL,
        data_storage text NOT NULL DEFAULT 'inline',
        organization_id uuid NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      );
    `);
  } catch (error) {
    databaseReady = false;
    console.warn("[container-retirement-migration] PGlite setup failed", error);
  }
}, TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

async function applyMigration(): Promise<void> {
  const sql = readFileSync(fileURLToPath(migrationUrl), "utf8");
  await dbWrite.execute(sql);
}

async function deleteJobs(containerId: string): Promise<Array<{ id: string; status: string }>> {
  const result = await dbWrite.execute(
    `SELECT id, status FROM jobs
     WHERE type = 'container_delete' AND data->>'containerId' = '${containerId}'
     ORDER BY created_at;`,
  );
  return result.rows as Array<{ id: string; status: string }>;
}

describe("0176 container retirement outbox repair", () => {
  test("is registered in the migration journal", () => {
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((entry) => entry.tag === "0176_container_retirement_outbox")).toBe(
      true,
    );
  });

  test("repairs only the unowned row and is idempotent", async () => {
    expect(databaseReady).toBe(true);
    await dbWrite.execute(
      `INSERT INTO containers (id, organization_id, status)
       VALUES
         ('${ORPHAN_ID}', '${ORG_ID}', 'deleting'),
         ('${OWNED_ID}', '${ORG_ID}', 'deleting');`,
    );
    await dbWrite.execute(
      `INSERT INTO jobs (id, type, data, organization_id)
       VALUES (
         '${OWNED_JOB_ID}',
         'container_delete',
         '{"containerId":"${OWNED_ID}","organizationId":"${ORG_ID}"}'::jsonb,
         '${ORG_ID}'
       );`,
    );

    await applyMigration();
    await applyMigration();

    const orphanJobs = await deleteJobs(ORPHAN_ID);
    expect(orphanJobs).toHaveLength(1);
    expect(orphanJobs[0]?.status).toBe("pending");
    expect(await deleteJobs(OWNED_ID)).toEqual([{ id: OWNED_JOB_ID, status: "pending" }]);

    const container = await dbWrite.execute(
      `SELECT status, metadata #>> '{retirement,deleteJobId}' AS delete_job_id
       FROM containers WHERE id = '${ORPHAN_ID}';`,
    );
    expect(container.rows).toEqual([
      {
        status: "deleting",
        delete_job_id: orphanJobs[0]?.id,
      },
    ]);
  });
});

test("PGlite schema applied — migration proofs never silently skip", () => {
  expect(databaseReady).toBe(true);
});
