/**
 * Applies the Discord configuration revision migration to real PGlite rows
 * and proves existing rows receive the initial non-null revision.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_PATH = join(
  import.meta.dir,
  "migrations/0208_discord_connection_configuration_revision.sql",
);

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE discord_connections (
      id uuid PRIMARY KEY,
      metadata jsonb,
      last_heartbeat timestamptz,
      events_received integer DEFAULT 0 NOT NULL
    );
    INSERT INTO discord_connections (id, metadata)
    VALUES (
      '00000000-0000-4000-8000-000000000001',
      '{"responseMode":"mention"}'::jsonb
    );
  `);
});

afterAll(async () => {
  await client.close();
});

describe("0208 Discord connection configuration revision", () => {
  test("backfills, widens prior integers, and ignores telemetry writes", async () => {
    const migration = readFileSync(MIGRATION_PATH, "utf8");
    await client.exec(migration);

    const initial = await client.query<{ configuration_revision: string }>(`
      SELECT configuration_revision::text AS configuration_revision
      FROM discord_connections
      WHERE id = '00000000-0000-4000-8000-000000000001'
    `);
    expect(initial.rows).toEqual([{ configuration_revision: "0" }]);

    await client.exec(`
      ALTER TABLE discord_connections
      ALTER COLUMN configuration_revision
      TYPE integer USING configuration_revision::integer;
      UPDATE discord_connections
      SET configuration_revision = 2147483647
      WHERE id = '00000000-0000-4000-8000-000000000001';
    `);
    await client.exec(migration);

    const column = await client.query<{ data_type: string }>(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'discord_connections'
        AND column_name = 'configuration_revision'
    `);
    expect(column.rows).toEqual([{ data_type: "numeric" }]);

    await client.exec(`
      UPDATE discord_connections
      SET configuration_revision = configuration_revision + 1
      WHERE id = '00000000-0000-4000-8000-000000000001';
    `);

    await client.exec(`
      UPDATE discord_connections
      SET last_heartbeat = now(), events_received = events_received + 1
      WHERE id = '00000000-0000-4000-8000-000000000001'
    `);
    const afterTelemetry = await client.query<{
      configuration_revision: string;
    }>(`
      SELECT configuration_revision::text AS configuration_revision
      FROM discord_connections
      WHERE id = '00000000-0000-4000-8000-000000000001'
    `);
    expect(afterTelemetry.rows).toEqual([{ configuration_revision: "2147483648" }]);
  });
});
