/**
 * Applies migration 0505 to PGlite and proves only user-created live keys are
 * backfilled into the plan-limited API-key count (#22958).
 */

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const migrationSource = readFileSync(
  join(import.meta.dir, "migrations/0505_api_key_plan_ceilings.sql"),
  "utf8",
);
const ORG = "00000000-0000-4000-8000-000000022958";
const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

test("0505 backfills user-created keys and leaves system-provisioned keys uncounted", async () => {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      organization_id uuid NOT NULL,
      source_app_id uuid,
      deleted_at timestamp
    );
    CREATE TABLE apps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), api_key_id uuid);
    INSERT INTO api_keys (name, organization_id, source_app_id, deleted_at) VALUES
      ('Production', '${ORG}', NULL, NULL),
      ('Staging', '${ORG}', NULL, NULL),
      ('Old', '${ORG}', NULL, now()),
      ('Default API Key', '${ORG}', NULL, NULL),
      ('API Explorer Key', '${ORG}', NULL, NULL),
      ('SIWE sign-in', '${ORG}', NULL, NULL),
      ('SIWS sign-in', '${ORG}', NULL, NULL),
      ('Eliza App Default Key', '${ORG}', NULL, NULL),
      ('agent-sandbox:abc', '${ORG}', NULL, NULL),
      ('Shop - App API Key', '${ORG}', NULL, NULL),
      ('Renamed app key', '${ORG}', NULL, NULL),
      ('Mobile', '${ORG}', gen_random_uuid(), NULL);
    INSERT INTO apps (api_key_id) SELECT id FROM api_keys WHERE name = 'Renamed app key';
  `);
  for (const statement of migrationSource.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.exec(statement);
  }
  const counted = await db.query<{ name: string }>(
    "SELECT name FROM api_keys WHERE user_created ORDER BY name",
  );
  expect(counted.rows.map((row) => row.name)).toEqual(["Production", "Staging"]);
  const index = await db.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'api_keys' AND indexname = 'api_keys_user_created_org_idx'",
  );
  expect(index.rows).toHaveLength(1);
});
