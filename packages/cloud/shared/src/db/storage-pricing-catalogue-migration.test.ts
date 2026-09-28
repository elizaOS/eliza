/**
 * Applies migration 0503 to PGlite and proves the storage service_pricing
 * mirror equals the ratified STORAGE_PRICING catalogue (#22956).
 */

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { STORAGE_PRICING } from "../lib/constants/pricing";

const migrationSource = readFileSync(
  join(import.meta.dir, "migrations/0503_storage_pricing_catalogue_mirror.sql"),
  "utf8",
);
const databases: PGlite[] = [];

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE service_pricing (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_id text NOT NULL,
      method text NOT NULL,
      cost numeric(18,12) NOT NULL,
      description text,
      metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
      is_active boolean DEFAULT true NOT NULL,
      updated_by text,
      created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL
    );
    CREATE UNIQUE INDEX service_pricing_service_method_idx ON service_pricing (service_id, method);
    CREATE TABLE service_pricing_audit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_pricing_id uuid,
      service_id text NOT NULL,
      method text NOT NULL,
      old_cost numeric(18,12),
      new_cost numeric(18,12) NOT NULL,
      change_type text NOT NULL,
      changed_by text NOT NULL,
      reason text,
      created_at timestamp DEFAULT now() NOT NULL
    );
  `);
  return db;
}

async function applyMigration(db: PGlite): Promise<void> {
  for (const statement of migrationSource.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.exec(statement);
  }
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

test("0503 pins every storage row to the catalogue and audits only corrections", async () => {
  const db = await database();
  await db.exec(`
    INSERT INTO service_pricing (service_id, method, cost, is_active) VALUES
      ('storage', 'put', 0.0001, true),
      ('storage', 'get', 0.5, false),
      ('storage', 'delete', 0, true),
      ('other', 'get', 0.5, true);
  `);
  await applyMigration(db);
  await applyMigration(db);

  const rows = await db.query<{ method: string; cost: string; is_active: boolean }>(
    `SELECT method, cost::text AS cost, is_active FROM service_pricing
     WHERE service_id = 'storage' ORDER BY method`,
  );
  expect(Object.fromEntries(rows.rows.map((row) => [row.method, Number(row.cost)]))).toEqual(
    Object.fromEntries(
      Object.entries(STORAGE_PRICING).map(([method, cost]) => [method, Number(cost)]),
    ),
  );
  expect(rows.rows.every((row) => row.is_active)).toBe(true);

  const audit = await db.query<{ method: string; old_cost: string; new_cost: string }>(
    `SELECT method, old_cost::text AS old_cost, new_cost::text AS new_cost
     FROM service_pricing_audit ORDER BY method`,
  );
  expect(audit.rows).toEqual([
    { method: "get", old_cost: "0.500000000000", new_cost: "0.000050000000" },
  ]);

  const other = await db.query<{ cost: string }>(
    `SELECT cost::text AS cost FROM service_pricing WHERE service_id = 'other'`,
  );
  expect(other.rows).toEqual([{ cost: "0.500000000000" }]);
});
