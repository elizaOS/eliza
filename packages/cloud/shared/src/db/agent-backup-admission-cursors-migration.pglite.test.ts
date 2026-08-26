/** Proves the backup admission cursor expansion against an in-process PGlite catalog. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { dockerNodes } from "./schemas/docker-nodes";
import { organizations } from "./schemas/organizations";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const NODE_ID = "20000000-0000-4000-8000-000000000001";
const migration = readFileSync(
  new URL("./migrations/0330_agent_backup_admission_cursors.sql", import.meta.url),
  "utf8",
);

let database: PGlite;
let tablesBeforeMigration: string[];

async function publicTables(): Promise<string[]> {
  const result = await database.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return result.rows.map(({ table_name }) => table_name);
}

async function applyMigration(): Promise<void> {
  await database.transaction(async (transaction) => {
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await transaction.exec(statement);
    }
  });
}

beforeAll(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL
    );
    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY,
      node_id text NOT NULL UNIQUE,
      hostname text NOT NULL
    );
    INSERT INTO organizations (id, name)
      VALUES ('${ORGANIZATION_ID}', 'preexisting organization');
    INSERT INTO docker_nodes (id, node_id, hostname)
      VALUES ('${NODE_ID}', 'preexisting-node', 'node.example.test');
  `);
  tablesBeforeMigration = await publicTables();

  await applyMigration();
  await applyMigration();
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("0330 backup admission cursor migration", () => {
  test("preserves preexisting authorities and installs nullable timestamptz columns without defaults", async () => {
    const rows = await database.query<{
      hostname: string;
      node_cursor: string | null;
      node_id: string;
      organization_cursor: string | null;
      organization_name: string;
    }>(`
      SELECT
        organizations.name AS organization_name,
        organizations.backup_admission_cursor_at::text AS organization_cursor,
        docker_nodes.node_id,
        docker_nodes.hostname,
        docker_nodes.backup_admission_cursor_at::text AS node_cursor
      FROM organizations
      CROSS JOIN docker_nodes
      WHERE organizations.id = '${ORGANIZATION_ID}'
        AND docker_nodes.id = '${NODE_ID}'
    `);
    expect(rows.rows).toEqual([
      {
        hostname: "node.example.test",
        node_cursor: null,
        node_id: "preexisting-node",
        organization_cursor: null,
        organization_name: "preexisting organization",
      },
    ]);

    const columns = await database.query<{
      column_default: string | null;
      data_type: string;
      is_nullable: string;
      table_name: string;
      udt_name: string;
    }>(`
      SELECT table_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'backup_admission_cursor_at'
      ORDER BY table_name
    `);
    expect(columns.rows).toEqual([
      {
        column_default: null,
        data_type: "timestamp with time zone",
        is_nullable: "YES",
        table_name: "docker_nodes",
        udt_name: "timestamptz",
      },
      {
        column_default: null,
        data_type: "timestamp with time zone",
        is_nullable: "YES",
        table_name: "organizations",
        udt_name: "timestamptz",
      },
    ]);
  });

  test("round-trips exact instants written with different timezone offsets", async () => {
    await database.exec(`
      UPDATE organizations
      SET backup_admission_cursor_at = '2026-08-26T15:14:15.123456+02:00'
      WHERE id = '${ORGANIZATION_ID}';
      UPDATE docker_nodes
      SET backup_admission_cursor_at = '2026-08-26T08:09:10.654321-04:00'
      WHERE id = '${NODE_ID}';
    `);

    const cursors = await database.query<{
      node_cursor_utc: string;
      organization_cursor_utc: string;
    }>(`
      SELECT
        to_char(
          organizations.backup_admission_cursor_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS organization_cursor_utc,
        to_char(
          docker_nodes.backup_admission_cursor_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS node_cursor_utc
      FROM organizations
      CROSS JOIN docker_nodes
      WHERE organizations.id = '${ORGANIZATION_ID}'
        AND docker_nodes.id = '${NODE_ID}'
    `);
    expect(cursors.rows).toEqual([
      {
        node_cursor_utc: "2026-08-26T12:09:10.654321Z",
        organization_cursor_utc: "2026-08-26T13:14:15.123456Z",
      },
    ]);
  });

  test("does not create a cursor or node-history table", async () => {
    expect(tablesBeforeMigration).toEqual(["docker_nodes", "organizations"]);
    expect(await publicTables()).toEqual(tablesBeforeMigration);

    const historyTables = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (
          table_name LIKE '%backup%admission%'
          OR table_name LIKE '%node%history%'
          OR table_name LIKE '%node%histor%'
        )
    `);
    expect(historyTables.rows).toEqual([]);
  });

  test("keeps the Drizzle models aligned with the database expansion", () => {
    for (const table of [organizations, dockerNodes]) {
      const column = getTableConfig(table).columns.find(
        ({ name }) => name === "backup_admission_cursor_at",
      );
      expect(column).toBeDefined();
      expect(column?.notNull).toBe(false);
      expect(column?.hasDefault).toBe(false);
    }
  });
});
