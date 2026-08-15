/**
 * Applies the terminal-job timestamp backfill to real PGlite rows and proves
 * its source precedence, idempotence, and non-terminal exclusion.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_PATH = join(
  import.meta.dir,
  "migrations/0195_job_terminal_completed_at_backfill.sql",
);

let client: PGlite;

async function applyMigration(): Promise<void> {
  for (const statement of readFileSync(MIGRATION_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((candidate) => candidate.trim())
    .filter(Boolean)) {
    await client.exec(statement);
  }
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE jobs (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      execution_quiesced_at timestamp,
      started_at timestamp,
      completed_at timestamp,
      created_at timestamp NOT NULL,
      updated_at timestamp NOT NULL
    );
    INSERT INTO jobs
      (id, status, execution_quiesced_at, started_at, completed_at, created_at, updated_at)
    VALUES
      ('00000000-0000-4000-8000-000000000001', 'failed',
       '2026-01-02T00:00:00Z', '2026-01-01T12:00:00Z', NULL,
       '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z'),
      ('00000000-0000-4000-8000-000000000002', 'cancelled',
       NULL, '2026-01-01T12:00:00Z', NULL,
       '2026-01-01T00:00:00Z', '2026-01-04T00:00:00Z'),
      ('00000000-0000-4000-8000-000000000003', 'failed',
       '2026-01-02T00:00:00Z', '2026-01-01T12:00:00Z', '2026-01-02T12:00:00Z',
       '2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z'),
      ('00000000-0000-4000-8000-000000000004', 'pending',
       NULL, '2026-01-01T12:00:00Z', NULL,
       '2026-01-01T00:00:00Z', '2026-01-06T00:00:00Z');
  `);
});

afterAll(async () => {
  await client.close();
});

describe("0195 job terminal completed_at backfill", () => {
  test("backfills only missing terminal timestamps from the best durable source", async () => {
    await applyMigration();
    await applyMigration();

    const result = await client.query<{ id: string; completed_at: Date | null }>(
      "SELECT id, completed_at FROM jobs ORDER BY id",
    );
    expect(
      result.rows.map((row) => ({
        id: row.id,
        completed_at: row.completed_at?.toISOString() ?? null,
      })),
    ).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        completed_at: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        completed_at: "2026-01-04T00:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        completed_at: "2026-01-02T12:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000004",
        completed_at: null,
      },
    ]);
  });
});
