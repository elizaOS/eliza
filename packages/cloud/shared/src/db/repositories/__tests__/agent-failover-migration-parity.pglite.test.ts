/**
 * Proves the hand-reviewed failover migrations match the Drizzle schema.
 *
 * `drizzle-kit generate` cannot run against this repository's current snapshot
 * set (it fails serialising BigInt columns), so `0387_agent_failover_records.sql`
 * was reviewed by hand and `0388_agent_failover_guards.sql` is hand-written
 * outright. Hand-written DDL is exactly where a column, type, default, or
 * constraint silently drifts from the schema that types the code, and nothing
 * else in the suite would notice: the behavioural tests only exercise the
 * predicates they assert.
 *
 * This suite builds a database from the committed migrations alone, replays them
 * to prove the deploy path is idempotent, and checks,
 * per table, that every schema column exists with the same SQL type,
 * nullability and default, and that the check, unique, foreign-key and index
 * names are the same set on both sides with no extras in the database.
 *
 * Predicate *bodies* are covered behaviourally instead — refusal tests in
 * `agent-failover.pglite.test.ts` assert the guards actually reject the writes
 * each rule forbids, which is stronger than comparing normalised SQL text.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  agentFailoverOperations,
  agentFailoverOperatorActions,
  agentFailoverStepAttempts,
  agentNodeFailureCandidates,
  agentNodeFailureEvents,
  agentNodeFailureSignals,
} from "../../schemas/agent-failover";

const TIMEOUT = 120_000;

const FAILOVER_TABLES = [
  agentNodeFailureEvents,
  agentNodeFailureSignals,
  agentNodeFailureCandidates,
  agentFailoverOperations,
  agentFailoverOperatorActions,
  agentFailoverStepAttempts,
] as const;

const PREREQUISITE_SQL = `
  CREATE TABLE organizations (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE docker_nodes (
    id uuid PRIMARY KEY,
    node_id text NOT NULL UNIQUE,
    hostname text NOT NULL
  );
  CREATE TABLE agent_node_incarnation_histories (
    id uuid PRIMARY KEY,
    docker_node_record_id uuid NOT NULL,
    node_id text NOT NULL,
    node_incarnation uuid NOT NULL,
    UNIQUE (id, docker_node_record_id, node_incarnation)
  );
  CREATE TABLE agent_sandboxes (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES organizations(id),
    node_id text,
    container_name text,
    activation_generation uuid,
    UNIQUE (id, organization_id)
  );
  CREATE TABLE agent_backup_restore_operations (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    backup_id uuid NOT NULL,
    restore_attempt_id uuid NOT NULL,
    lease_id uuid NOT NULL,
    lease_generation uuid NOT NULL,
    lease_owner_id text NOT NULL,
    expected_manifest_sha256 text NOT NULL
  );
  CREATE TABLE agent_backup_restore_leases (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    backup_id uuid NOT NULL,
    owner_id text NOT NULL,
    generation uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL DEFAULT now() + interval '1 hour',
    released_at timestamp with time zone
  );
  CREATE TABLE agent_sandbox_replacement_attempts (id uuid PRIMARY KEY);
  CREATE TABLE agent_activation_publications (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    activation_generation uuid NOT NULL,
    purpose text NOT NULL,
    backup_id uuid,
    backup_manifest_sha256 text,
    activation_receipt_sha256 text NOT NULL,
    previous_activation_generation uuid,
    lifecycle_revision numeric(20, 0) NOT NULL,
    container_id text NOT NULL,
    node_history_id uuid NOT NULL,
    docker_node_record_id uuid NOT NULL,
    node_id text NOT NULL,
    node_incarnation uuid NOT NULL,
    UNIQUE (organization_id, agent_id, activation_generation)
  );
`;

const MIGRATION_SQL = ["0387_agent_failover_records", "0388_agent_failover_guards"].map((name) =>
  readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), "utf8"),
);

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

let database: PGlite | null = null;
let setupFailure: string | null = null;

async function introspectColumns(tableName: string): Promise<ColumnRow[]> {
  if (!database) throw new Error("the migration database was not created");
  const result = await database.query<ColumnRow>(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY column_name`,
    [tableName],
  );
  return result.rows;
}

async function introspectConstraintNames(
  tableName: string,
  type: "c" | "u" | "f",
): Promise<string[]> {
  if (!database) throw new Error("the migration database was not created");
  const result = await database.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conrelid = $1::regclass AND contype = $2 ORDER BY conname`,
    [tableName, type],
  );
  return result.rows.map(({ conname }) => conname);
}

async function introspectIndexNames(tableName: string): Promise<string[]> {
  if (!database) throw new Error("the migration database was not created");
  const result = await database.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname",
    [tableName],
  );
  return result.rows.map(({ indexname }) => indexname);
}

beforeAll(async () => {
  try {
    const instance = new PGlite();
    await instance.exec(PREREQUISITE_SQL);
    // Applying twice proves the deploy path is idempotent: every statement is
    // guarded with IF NOT EXISTS / IF EXISTS / CREATE OR REPLACE.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const source of MIGRATION_SQL) {
        for (const statement of source.split("--> statement-breakpoint")) {
          if (statement.trim()) await instance.exec(statement);
        }
      }
    }
    database = instance;
  } catch (error) {
    setupFailure = error instanceof Error ? error.message : String(error);
  }
}, TIMEOUT);

afterAll(async () => {
  await database?.close();
});

/**
 * Narrows a declared constraint or index name.
 *
 * These tables name every check, key, and index explicitly. An unnamed one would
 * make the database derive a name the schema never states, which is exactly the
 * drift this suite exists to catch, so a missing name is a failure rather than a
 * value to skip.
 */
function requireName(name: string | undefined, table: string, kind: string): string {
  if (!name) throw new Error(`${table} has an unnamed ${kind}`);
  return name;
}

function requireDatabase(): PGlite {
  if (setupFailure) throw new Error(`failover migration could not be applied: ${setupFailure}`);
  if (!database) throw new Error("the migration database was not created");
  return database;
}

describe("the failover migrations install their guards", () => {
  test(
    "every failover guard trigger exists exactly once",
    async () => {
      requireDatabase();
      const triggers = await database!.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger
       WHERE NOT tgisinternal AND tgname IN (
         'agent_node_failure_events_guard', 'agent_node_failure_signals_guard',
         'agent_failover_operations_guard', 'agent_failover_step_attempts_guard')
       ORDER BY tgname`,
      );
      expect(triggers.rows.map(({ tgname }) => tgname)).toEqual([
        "agent_failover_operations_guard",
        "agent_failover_step_attempts_guard",
        "agent_node_failure_events_guard",
        "agent_node_failure_signals_guard",
      ]);
    },
    TIMEOUT,
  );
});

describe("the failover migration matches the Drizzle schema", () => {
  for (const table of FAILOVER_TABLES) {
    const config = getTableConfig(table);

    test(
      `${config.name} declares every schema column with the same shape`,
      async () => {
        requireDatabase();
        const actual = new Map(
          (await introspectColumns(config.name)).map((row) => [row.column_name, row]),
        );
        expect([...actual.keys()].sort()).toEqual(config.columns.map(({ name }) => name).sort());

        for (const column of config.columns) {
          const row = actual.get(column.name);
          if (!row) throw new Error(`${config.name}.${column.name} is missing from the migration`);
          expect({ column: column.name, dataType: row.data_type }).toEqual({
            column: column.name,
            dataType: column.getSQLType(),
          });
          // A primary key is not nullable in PostgreSQL even when the schema does
          // not say so explicitly, so the schema's own flag is not the expectation.
          expect({ column: column.name, notNull: row.is_nullable === "NO" }).toEqual({
            column: column.name,
            notNull: column.notNull || column.primary,
          });
          expect({ column: column.name, hasDefault: row.column_default !== null }).toEqual({
            column: column.name,
            hasDefault: column.hasDefault,
          });
        }
      },
      TIMEOUT,
    );

    test(
      `${config.name} declares the same checks, uniques and foreign keys`,
      async () => {
        requireDatabase();
        expect(await introspectConstraintNames(config.name, "c")).toEqual(
          config.checks.map(({ name }) => requireName(name, config.name, "check")).sort(),
        );
        expect(await introspectConstraintNames(config.name, "u")).toEqual(
          config.uniqueConstraints
            .map(({ name }) => requireName(name, config.name, "unique constraint"))
            .sort(),
        );
        // Every foreign key in these tables is declared with an explicit name, so
        // the expected name is the schema's own. An unnamed one would make the
        // database derive a name the schema never states, which is exactly the
        // drift this suite exists to catch.
        const expectedForeignKeys = config.foreignKeys
          .map((foreignKey) => {
            const declared = foreignKey.getName();
            if (!declared) throw new Error(`${config.name} has an unnamed foreign key`);
            return declared;
          })
          .sort();
        expect(await introspectConstraintNames(config.name, "f")).toEqual(expectedForeignKeys);
      },
      TIMEOUT,
    );

    test(
      `${config.name} declares the same indexes and no extra ones`,
      async () => {
        requireDatabase();
        // `uniqueIndex()` entries are ordinary indexes carrying `unique: true`, so
        // the declared name set below already covers them.
        const declared = config.indexes
          .map(({ config: indexConfig }) => {
            if (!indexConfig.name) throw new Error(`${config.name} has an unnamed index`);
            return indexConfig.name;
          })
          .sort();
        expect(await introspectIndexNames(config.name)).toEqual(
          // Primary and unique constraints are backed by indexes PostgreSQL names
          // after the constraint, so those are expected alongside the declared ones.
          [
            ...declared,
            ...config.uniqueConstraints.map(({ name }) =>
              requireName(name, config.name, "unique constraint"),
            ),
            `${config.name}_pkey`,
          ].sort(),
        );
      },
      TIMEOUT,
    );
  }
});
