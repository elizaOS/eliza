/** Real-PGlite proofs for the generation-bound activation endpoint authority. */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { AgentActivationEndpointEnvelopeV1 } from "./schemas/agent-sandboxes";

const expandMigrationUrl = new URL(
  "./migrations/0333_agent_restore_endpoint_authority_expand.sql",
  import.meta.url,
);
const contractMigrationUrl = new URL(
  "./migrations/0334_agent_restore_endpoint_authority_contract.sql",
  import.meta.url,
);
const journalUrl = new URL("./migrations/meta/_journal.json", import.meta.url);
const expandMigration = readFileSync(expandMigrationUrl, "utf8");
const contractMigration = readFileSync(contractMigrationUrl, "utf8");
const SHA = "a".repeat(64);
const databases: PGlite[] = [];

setDefaultTimeout(60_000);

function endpoint(generation: string): AgentActivationEndpointEnvelopeV1 {
  return {
    version: 1,
    generation,
    kind: "dedicated-sandbox",
    serverName: `sandbox-${generation}`,
    registryUrl: "https://registry.internal/v1",
    bridgeUrl: "http://10.0.0.12:3000/bridge",
    healthUrl: "http://10.0.0.12:3000/api/health",
  };
}

async function applySqlMigration(database: PGlite, migration: string): Promise<void> {
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
}

async function applyEndpointMigrations(database: PGlite): Promise<void> {
  await applySqlMigration(database, expandMigration);
  await applySqlMigration(database, contractMigration);
}

async function prerequisiteDatabase(applyMigrations = true): Promise<PGlite> {
  const database = new PGlite();
  databases.push(database);
  await database.exec(`
    CREATE TABLE agent_backup_restore_operations (
      id uuid PRIMARY KEY, restore_attempt_id uuid NOT NULL
    );
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY, activation_generation uuid,
      activation_purpose text, activation_phase text
    );
    CREATE TABLE agent_activation_publications (
      id uuid PRIMARY KEY, activation_generation uuid NOT NULL, purpose text NOT NULL
    );
    CREATE FUNCTION reject_agent_restore_immutable_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'immutable restore authority cannot be changed' USING ERRCODE = '55000';
      END; $$;
    CREATE TRIGGER agent_activation_publications_immutable
      BEFORE UPDATE OR DELETE ON agent_activation_publications
      FOR EACH ROW EXECUTE FUNCTION reject_agent_restore_immutable_mutation();
  `);
  if (applyMigrations) await applyEndpointMigrations(database);
  return database;
}

async function insertOperation(
  database: PGlite,
  generation: string,
  envelope: unknown,
  sha256: string | null,
): Promise<void> {
  await database.query(
    `INSERT INTO agent_backup_restore_operations
      (id, restore_attempt_id, expected_endpoint_envelope, expected_endpoint_sha256)
      VALUES ($1, $2, $3::jsonb, $4)`,
    [crypto.randomUUID(), generation, envelope === null ? null : JSON.stringify(envelope), sha256],
  );
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("0333/0334 restore endpoint authority migrations", () => {
  test("applies and replays with its columns, checks, and narrow write-once trigger", async () => {
    const database = await prerequisiteDatabase();
    await applyEndpointMigrations(database);

    const columns = await database.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('agent_backup_restore_operations', 'agent_sandboxes',
        'agent_activation_publications') AND column_name LIKE '%endpoint%'
      ORDER BY column_name
    `);
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
      "activation_endpoint_envelope",
      "activation_endpoint_sha256",
      "endpoint_envelope",
      "endpoint_sha256",
      "expected_endpoint_envelope",
      "expected_endpoint_sha256",
    ]);
    const guards = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgname IN ('agent_activation_publications_immutable',
        'agent_backup_restore_operations_endpoint_write_once')
    `);
    expect(guards.rows).toEqual([{ count: 2 }]);
    const constraints = await database.query<{ conname: string; convalidated: boolean }>(`
      SELECT conname, convalidated FROM pg_constraint
      WHERE conname IN ('agent_backup_restore_operations_endpoint_v1_check',
        'agent_sandboxes_activation_endpoint_v1_check',
        'agent_activation_publications_endpoint_v1_check') ORDER BY conname
    `);
    expect(constraints.rows).toEqual([
      {
        conname: "agent_activation_publications_endpoint_v1_check",
        convalidated: true,
      },
      {
        conname: "agent_backup_restore_operations_endpoint_v1_check",
        convalidated: true,
      },
      { conname: "agent_sandboxes_activation_endpoint_v1_check", convalidated: true },
    ]);
  });

  test("expands without a table scan and refuses a legacy restore publication", async () => {
    const publicationDatabase = await prerequisiteDatabase(false);
    const generation = crypto.randomUUID();
    await publicationDatabase.query(
      `INSERT INTO agent_activation_publications (id, activation_generation, purpose)
        VALUES ($1, $2, 'restore')`,
      [crypto.randomUUID(), generation],
    );
    await applySqlMigration(publicationDatabase, expandMigration);
    const pending = await publicationDatabase.query<{ convalidated: boolean }>(`
      SELECT convalidated FROM pg_constraint
      WHERE conname = 'agent_activation_publications_endpoint_v1_check'
    `);
    expect(pending.rows).toEqual([{ convalidated: false }]);
    await expect(applySqlMigration(publicationDatabase, contractMigration)).rejects.toThrow(
      /requires an explicit publication backfill/,
    );
  });

  test("refuses a legacy active restore sandbox before validation", async () => {
    const sandboxDatabase = await prerequisiteDatabase(false);
    const generation = crypto.randomUUID();
    await sandboxDatabase.query(
      `INSERT INTO agent_sandboxes
        (id, activation_generation, activation_purpose, activation_phase)
        VALUES ($1, $2, 'restore', 'active')`,
      [crypto.randomUUID(), generation],
    );
    await applySqlMigration(sandboxDatabase, expandMigration);
    await expect(applySqlMigration(sandboxDatabase, contractMigration)).rejects.toThrow(
      /requires an explicit active-sandbox backfill/,
    );
  });

  test("enforces exact operation shape, generation, URL safety, digest, and write-once", async () => {
    const database = await prerequisiteDatabase();
    const generation = crypto.randomUUID();
    const valid = endpoint(generation);
    await insertOperation(database, generation, valid, SHA);
    await database.query(
      `UPDATE agent_backup_restore_operations SET expected_endpoint_envelope = $1::jsonb,
        expected_endpoint_sha256 = $2 WHERE restore_attempt_id = $3`,
      [JSON.stringify(valid), SHA, generation],
    );

    const changed = { ...valid, healthUrl: "https://other.internal/health" };
    await expect(
      database.query(
        `UPDATE agent_backup_restore_operations SET expected_endpoint_envelope = $1::jsonb
          WHERE restore_attempt_id = $2`,
        [JSON.stringify(changed), generation],
      ),
    ).rejects.toThrow(/endpoint authority is write-once/);

    for (const [candidate, digest] of [
      [null, SHA],
      [valid, null],
      [{ ...valid, generation: crypto.randomUUID() }, SHA],
      [{ ...valid, generation: valid.generation.toUpperCase() }, SHA],
      [{ ...valid, serverName: "sandbox-wrong" }, SHA],
      [{ ...valid, extra: true }, SHA],
      [{ ...valid, registryUrl: "https://user:secret@registry.internal/v1" }, SHA],
      [{ ...valid, bridgeUrl: "https://bridge.internal/path?token=secret" }, SHA],
      [{ ...valid, bridgeUrl: "https://bridge.internal/path?" }, SHA],
      [{ ...valid, bridgeUrl: "https://bridge.internal/path#" }, SHA],
      [{ ...valid, registryUrl: "https://registry.internal\\@evil.test/path" }, SHA],
      [{ ...valid, healthUrl: "https://health.internal/health check" }, SHA],
      [{ ...valid, healthUrl: `https://health.internal/${"x".repeat(4096)}` }, SHA],
      [valid, SHA.toUpperCase()],
    ] as const) {
      await expect(insertOperation(database, generation, candidate, digest)).rejects.toThrow(
        /endpoint_v1_check/,
      );
    }
    const nilGeneration = "00000000-0000-0000-0000-000000000000";
    await expect(
      insertOperation(database, nilGeneration, endpoint(nilGeneration), SHA),
    ).rejects.toThrow(/endpoint_v1_check/);
  });

  test("requires sandbox endpoints at restore attestation and keeps publication scope immutable", async () => {
    const database = await prerequisiteDatabase();
    const generation = crypto.randomUUID();
    const valid = endpoint(generation);
    const sandboxId = crypto.randomUUID();

    await database.query(
      `INSERT INTO agent_sandboxes
        (id, activation_generation, activation_purpose, activation_phase)
        VALUES ($1, $2, 'restore', 'restart_pending')`,
      [sandboxId, generation],
    );
    await expect(
      database.query(
        `UPDATE agent_sandboxes SET activation_phase = 'restart_attested' WHERE id = $1`,
        [sandboxId],
      ),
    ).rejects.toThrow(/endpoint_v1_check/);
    await database.query(
      `UPDATE agent_sandboxes SET activation_phase = 'restart_attested',
        activation_endpoint_envelope = $1::jsonb, activation_endpoint_sha256 = $2 WHERE id = $3`,
      [JSON.stringify(valid), SHA, sandboxId],
    );

    await expect(
      database.query(
        `INSERT INTO agent_activation_publications (id, activation_generation, purpose)
          VALUES ($1, $2, 'restore')`,
        [crypto.randomUUID(), generation],
      ),
    ).rejects.toThrow(/endpoint_v1_check/);
    await database.query(
      `INSERT INTO agent_activation_publications (id, activation_generation, purpose)
        VALUES ($1, $2, 'wake')`,
      [crypto.randomUUID(), generation],
    );
    await expect(
      database.query(
        `INSERT INTO agent_activation_publications
          (id, activation_generation, purpose, endpoint_envelope, endpoint_sha256)
          VALUES ($1, $2, 'wake', $3::jsonb, $4)`,
        [crypto.randomUUID(), generation, JSON.stringify(valid), SHA],
      ),
    ).rejects.toThrow(/endpoint_v1_check/);

    const publicationId = crypto.randomUUID();
    await database.query(
      `INSERT INTO agent_activation_publications
        (id, activation_generation, purpose, endpoint_envelope, endpoint_sha256)
        VALUES ($1, $2, 'restore', $3::jsonb, $4)`,
      [publicationId, generation, JSON.stringify(valid), SHA],
    );
    await expect(
      database.query(
        `UPDATE agent_activation_publications SET endpoint_sha256 = $1 WHERE id = $2`,
        ["b".repeat(64), publicationId],
      ),
    ).rejects.toThrow(/immutable restore authority/);
  });

  test("is the exact registered journal tail and stays below the migration size ceiling", () => {
    const journal = JSON.parse(readFileSync(journalUrl, "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    expect(journal.entries.slice(-2)).toEqual([
      {
        idx: 316,
        version: "7",
        when: 1794254400024,
        tag: "0333_agent_restore_endpoint_authority_expand",
        breakpoints: true,
      },
      {
        idx: 317,
        version: "7",
        when: 1794254400025,
        tag: "0334_agent_restore_endpoint_authority_contract",
        breakpoints: true,
      },
    ]);
    expect(expandMigration.split(/\r?\n/).length).toBeLessThan(100);
    expect(contractMigration.split(/\r?\n/).length).toBeLessThan(100);
  });
});
