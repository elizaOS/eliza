/** Applies migration 0335 to PGlite and proves terminal billing exactly-once. */

import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await Bun.file(
  new URL("./0335_container_stop_terminal_billing_receipts.sql", import.meta.url),
).text();
const schema = await Bun.file(new URL("../schemas/containers.ts", import.meta.url)).text();
const databases: PGlite[] = [];

const CONTAINER_A = "10000000-0000-4000-8000-000000000001";
const CONTAINER_B = "10000000-0000-4000-8000-000000000002";
const PERIOD = "2026-08-20 17:00:00";

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE container_billing_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      container_id uuid NOT NULL,
      billing_period_start timestamp NOT NULL,
      status text NOT NULL
    );
    CREATE UNIQUE INDEX container_billing_records_period_unique
      ON container_billing_records (container_id, billing_period_start)
      WHERE status = 'success';
  `);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0335 container stop terminal billing receipts", () => {
  test("makes success and uncollected mutually exclusive in either order", async () => {
    const db = await database();
    await db.exec(migration);
    await db.exec(`
      INSERT INTO container_billing_records (container_id, billing_period_start, status)
      VALUES
        ('${CONTAINER_A}', '${PERIOD}', 'success'),
        ('${CONTAINER_B}', '${PERIOD}', 'uncollected');
    `);

    await expect(
      db.exec(`INSERT INTO container_billing_records
        (container_id, billing_period_start, status)
        VALUES ('${CONTAINER_A}', '${PERIOD}', 'uncollected')`),
    ).rejects.toThrow();
    await expect(
      db.exec(`INSERT INTO container_billing_records
        (container_id, billing_period_start, status)
        VALUES ('${CONTAINER_B}', '${PERIOD}', 'success')`),
    ).rejects.toThrow();
  });

  test("allows multiple retryable receipts for the same period", async () => {
    const db = await database();
    await db.exec(migration);
    await db.exec(`
      INSERT INTO container_billing_records (container_id, billing_period_start, status)
      VALUES
        ('${CONTAINER_A}', '${PERIOD}', 'failed'),
        ('${CONTAINER_A}', '${PERIOD}', 'failed'),
        ('${CONTAINER_A}', '${PERIOD}', 'insufficient_credits'),
        ('${CONTAINER_A}', '${PERIOD}', 'insufficient_credits'),
        ('${CONTAINER_A}', '${PERIOD}', 'success'),
        ('${CONTAINER_A}', '${PERIOD}', 'failed');
    `);

    const counts = await db.query<{ count: number; status: string }>(`
      SELECT status, count(*)::int AS count
      FROM container_billing_records
      GROUP BY status
      ORDER BY status
    `);
    expect(counts.rows).toEqual([
      { count: 3, status: "failed" },
      { count: 2, status: "insufficient_credits" },
      { count: 1, status: "success" },
    ]);
  });

  test("re-applies idempotently and keeps SQL and schema predicates aligned", async () => {
    const db = await database();
    await db.exec(migration);
    await db.exec(migration);

    const indexes = await db.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'container_billing_records_period_unique'
    `);
    expect(indexes.rows).toEqual([{ indexname: "container_billing_records_period_unique" }]);
    expect(migration).not.toMatch(/\b(?:BEGIN|COMMIT)\s*;/i);
    expect(migration).toContain("DROP INDEX IF EXISTS");
    expect(migration).toContain(`WHERE "status" IN ('success', 'uncollected');`);
    expect(schema).toContain("// success, uncollected, failed, insufficient_credits");
    expect(schema).toContain(".where(sql`${table.status} in ('success', 'uncollected')`)");
  });
});
