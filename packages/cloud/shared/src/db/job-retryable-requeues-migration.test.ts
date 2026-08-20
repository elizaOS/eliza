/**
 * Proves the retryable-requeue authority migration against real PGlite,
 * including replay, defaulting, and its nonnegative database invariant.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  join(import.meta.dir, "migrations", "0253_job_retryable_requeues.sql"),
  "utf8",
);
const databases: PGlite[] = [];

async function databaseWithJobs(): Promise<PGlite> {
  const database = new PGlite();
  databases.push(database);
  await database.exec(`CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    status text NOT NULL,
    attempts integer NOT NULL DEFAULT 0
  )`);
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("0253 job retryable requeues", () => {
  test("adds without an eager validation scan, then validates explicitly", () => {
    expect(migration).toContain('CHECK ("retryable_requeues" >= 0) NOT VALID');
    expect(migration).toContain('VALIDATE CONSTRAINT "jobs_retryable_requeues_nonnegative_check"');
  });

  test("is replay-safe and defaults existing and new rows to zero", async () => {
    const database = await databaseWithJobs();
    await database.exec(
      `INSERT INTO jobs (id, status) VALUES
       ('00000000-0000-4000-8000-000000000001', 'pending')`,
    );

    await database.exec(migration);
    await database.exec(migration);
    await database.exec(
      `INSERT INTO jobs (id, status) VALUES
       ('00000000-0000-4000-8000-000000000002', 'pending')`,
    );

    const result = await database.query<{ retryable_requeues: number }>(
      `SELECT retryable_requeues FROM jobs ORDER BY id`,
    );
    expect(result.rows).toEqual([{ retryable_requeues: 0 }, { retryable_requeues: 0 }]);
  });

  test("rejects negative retry authority", async () => {
    const database = await databaseWithJobs();
    await database.exec(migration);

    await expect(
      database.exec(
        `INSERT INTO jobs (id, status, retryable_requeues) VALUES
         ('00000000-0000-4000-8000-000000000003', 'pending', -1)`,
      ),
    ).rejects.toThrow("jobs_retryable_requeues_nonnegative_check");
  });

  test("does not mistake another table's same-named constraint for the jobs invariant", async () => {
    const database = await databaseWithJobs();
    await database.exec(`
      CREATE TABLE migration_decoy (retryable_requeues integer NOT NULL);
      ALTER TABLE migration_decoy ADD CONSTRAINT jobs_retryable_requeues_nonnegative_check
        CHECK (retryable_requeues >= 0);
    `);

    await database.exec(migration);

    await expect(
      database.exec(
        `INSERT INTO jobs (id, status, retryable_requeues) VALUES
         ('00000000-0000-4000-8000-000000000004', 'pending', -1)`,
      ),
    ).rejects.toThrow("jobs_retryable_requeues_nonnegative_check");
  });
});
