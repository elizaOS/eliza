/** Real-PGlite proofs for the generation-bound activation endpoint authority. */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { hashAgentActivationEndpointEnvelope } from "../lib/services/agent-activation-endpoint-authority";
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
const ORGANIZATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee0";
const AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const RUNTIME_AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";
const OTHER_RUNTIME_AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3";
const databases: PGlite[] = [];

setDefaultTimeout(60_000);

function endpoint(generation: string): AgentActivationEndpointEnvelopeV1 {
  return {
    version: 1,
    generation,
    kind: "dedicated-sandbox",
    serverName: `sandbox-${generation}`,
    runtimeAgentId: RUNTIME_AGENT_ID,
    registryUrl: "https://registry.internal/v1",
    bridgeUrl: "http://10.0.0.12:3000/bridge",
    healthUrl: "http://10.0.0.12:3000/api/health",
  };
}

function endpointSha256(value: AgentActivationEndpointEnvelopeV1): string {
  return hashAgentActivationEndpointEnvelope(value);
}

async function applySqlMigration(database: PGlite, migration: string): Promise<void> {
  await database.exec("BEGIN");
  try {
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
    await database.exec("COMMIT");
  } catch (error) {
    await database.exec("ROLLBACK");
    throw error;
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
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, agent_id uuid NOT NULL,
      restore_attempt_id uuid NOT NULL, phase text NOT NULL DEFAULT 'reserved', resume_phase text,
      expected_container_id text, expected_node_id text, expected_image_digest text,
      expected_node_incarnation uuid
    );
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, character_id uuid,
      activation_generation uuid,
      activation_purpose text, activation_phase text,
      activation_container_id text, activation_node_id text, activation_image_digest text,
      activation_boot_id uuid,
      status text NOT NULL DEFAULT 'running', deletion_attempt_id uuid,
      deletion_started_at timestamptz, deleted_at timestamptz
    );
    CREATE TABLE agent_activation_publications (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, agent_id uuid NOT NULL,
      activation_generation uuid NOT NULL, purpose text NOT NULL,
      container_id text, node_id text, image_digest text, node_incarnation uuid
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
  agentId = AGENT_ID,
): Promise<string> {
  const operationId = crypto.randomUUID();
  await database.query(
    `INSERT INTO agent_backup_restore_operations
      (id, organization_id, agent_id, restore_attempt_id,
        expected_endpoint_envelope, expected_endpoint_sha256)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      operationId,
      ORGANIZATION_ID,
      agentId,
      generation,
      envelope === null ? null : JSON.stringify(envelope),
      sha256,
    ],
  );
  return operationId;
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
        'agent_backup_restore_operations_endpoint_write_once',
        'agent_sandboxes_endpoint_identity_transition',
        'agent_backup_restore_operations_runtime_binding',
        'agent_activation_publications_endpoint_runtime_binding')
    `);
    expect(guards.rows).toEqual([{ count: 5 }]);
    const runtimeGuards = await database.query<{ definition: string; tgname: string }>(`
      SELECT tgname, pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgname IN ('agent_backup_restore_operations_runtime_binding',
        'agent_activation_publications_endpoint_runtime_binding') ORDER BY tgname
    `);
    expect(runtimeGuards.rows).toHaveLength(2);
    expect(runtimeGuards.rows.every(({ definition }) => /\bBEFORE\b/.test(definition))).toBe(true);
    expect(
      runtimeGuards.rows.find(
        ({ tgname }) => tgname === "agent_backup_restore_operations_runtime_binding",
      )?.definition,
    ).toContain("phase");
    const endpointGuardFunctions = await database.query<{
      definition: string;
      proname: string;
    }>(`
      SELECT proname, pg_get_functiondef(oid) AS definition FROM pg_proc
      WHERE proname IN ('guard_agent_restore_endpoint_write_once',
        'guard_agent_sandbox_endpoint_identity_transition',
        'enforce_agent_restore_endpoint_runtime_binding_v3') ORDER BY proname
    `);
    expect(endpointGuardFunctions.rows.map(({ proname }) => proname)).toEqual([
      "enforce_agent_restore_endpoint_runtime_binding_v3",
      "guard_agent_restore_endpoint_write_once",
      "guard_agent_sandbox_endpoint_identity_transition",
    ]);
    expect(
      endpointGuardFunctions.rows.every(({ definition }) =>
        definition.includes("SET search_path TO 'pg_catalog', 'public'"),
      ),
    ).toBe(true);
    const runtimeGuardDefinition = endpointGuardFunctions.rows[0]?.definition;
    expect(runtimeGuardDefinition).toContain("FOR UPDATE");
    expect(runtimeGuardDefinition).toContain('FROM public."agent_sandboxes" sandbox');
    expect(runtimeGuardDefinition).toContain(
      'FROM public."agent_backup_restore_operations" operation',
    );
    expect(contractMigration).toContain(
      'LOCK TABLE public."agent_backup_restore_operations", public."agent_sandboxes", public."agent_activation_publications" IN SHARE ROW EXCLUSIVE MODE',
    );
    expect(contractMigration).toContain("tgenabled IN ('O','A')");
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

  test("cannot redirect expand, preflight, or validation into pg_temp shadows", async () => {
    const database = await prerequisiteDatabase(false);
    await database.exec(`
      CREATE TEMP TABLE agent_backup_restore_operations AS
        SELECT * FROM public.agent_backup_restore_operations WITH NO DATA;
      CREATE TEMP TABLE agent_sandboxes AS
        SELECT * FROM public.agent_sandboxes WITH NO DATA;
      CREATE TEMP TABLE agent_activation_publications AS
        SELECT * FROM public.agent_activation_publications WITH NO DATA;
      SET search_path = pg_temp, public;
    `);
    await applySqlMigration(database, expandMigration);

    const expandedColumns = await database.query<{ table_schema: string }>(`
      SELECT table_schema FROM information_schema.columns
      WHERE table_name = 'agent_backup_restore_operations'
        AND column_name = 'expected_endpoint_envelope'
    `);
    expect(expandedColumns.rows).toEqual([{ table_schema: "public" }]);

    await database.exec(`
      DROP TABLE pg_temp.agent_backup_restore_operations;
      DROP TABLE pg_temp.agent_sandboxes;
      DROP TABLE pg_temp.agent_activation_publications;
      CREATE TEMP TABLE agent_backup_restore_operations AS
        SELECT * FROM public.agent_backup_restore_operations WITH NO DATA;
      CREATE TEMP TABLE agent_sandboxes AS
        SELECT * FROM public.agent_sandboxes WITH NO DATA;
      CREATE TEMP TABLE agent_activation_publications AS
        SELECT * FROM public.agent_activation_publications WITH NO DATA;
      INSERT INTO pg_temp.agent_backup_restore_operations
        (id, organization_id, agent_id, restore_attempt_id, phase)
        VALUES ('00000000-0000-4000-8000-000000000101',
          '00000000-0000-4000-8000-000000000102',
          '00000000-0000-4000-8000-000000000103',
          '00000000-0000-4000-8000-000000000104', 'container_created');
      INSERT INTO pg_temp.agent_sandboxes
        (id, organization_id, activation_purpose, activation_phase)
        VALUES ('00000000-0000-4000-8000-000000000103',
          '00000000-0000-4000-8000-000000000102', 'restore', 'active');
      INSERT INTO pg_temp.agent_activation_publications
        (id, organization_id, agent_id, activation_generation, purpose)
        VALUES ('00000000-0000-4000-8000-000000000105',
          '00000000-0000-4000-8000-000000000102',
          '00000000-0000-4000-8000-000000000103',
          '00000000-0000-4000-8000-000000000104', 'restore');
    `);

    await applySqlMigration(database, contractMigration);
    const publicConstraints = await database.query<{ convalidated: boolean }>(`
      SELECT convalidated FROM pg_catalog.pg_constraint
      WHERE conrelid IN ('public.agent_backup_restore_operations'::regclass,
        'public.agent_sandboxes'::regclass,
        'public.agent_activation_publications'::regclass)
        AND conname IN ('agent_backup_restore_operations_endpoint_v1_check',
          'agent_sandboxes_activation_endpoint_v1_check',
          'agent_activation_publications_endpoint_v1_check')
    `);
    expect(publicConstraints.rows).toHaveLength(3);
    expect(publicConstraints.rows.every(({ convalidated }) => convalidated)).toBe(true);
  });

  test("a clean pg_temp shadow cannot hide an invalid public backfill", async () => {
    const database = await prerequisiteDatabase(false);
    await database.query(
      `INSERT INTO public.agent_activation_publications
        (id, organization_id, agent_id, activation_generation, purpose)
        VALUES ($1, $2, $3, $4, 'restore')`,
      [crypto.randomUUID(), ORGANIZATION_ID, AGENT_ID, crypto.randomUUID()],
    );
    await database.exec(`
      CREATE TEMP TABLE agent_backup_restore_operations AS
        SELECT * FROM public.agent_backup_restore_operations WITH NO DATA;
      CREATE TEMP TABLE agent_sandboxes AS
        SELECT * FROM public.agent_sandboxes WITH NO DATA;
      CREATE TEMP TABLE agent_activation_publications AS
        SELECT * FROM public.agent_activation_publications WITH NO DATA;
      SET search_path = pg_temp, public;
    `);
    await applySqlMigration(database, expandMigration);

    await expect(applySqlMigration(database, contractMigration)).rejects.toThrow(
      /explicit publication backfill/,
    );
  });

  test("expands without a table scan and refuses a legacy restore publication", async () => {
    const publicationDatabase = await prerequisiteDatabase(false);
    const generation = crypto.randomUUID();
    await publicationDatabase.query(
      `INSERT INTO agent_activation_publications
        (id, organization_id, agent_id, activation_generation, purpose)
        VALUES ($1, $2, $3, $4, 'restore')`,
      [crypto.randomUUID(), ORGANIZATION_ID, AGENT_ID, generation],
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
        (id, organization_id, activation_generation, activation_purpose, activation_phase)
        VALUES ($1, $2, $3, 'restore', 'active')`,
      [crypto.randomUUID(), ORGANIZATION_ID, generation],
    );
    await applySqlMigration(sandboxDatabase, expandMigration);
    await expect(applySqlMigration(sandboxDatabase, contractMigration)).rejects.toThrow(
      /requires an explicit identity-bound active-sandbox backfill/,
    );
  });

  test("refuses a legacy post-container operation without endpoint authority", async () => {
    const database = await prerequisiteDatabase(false);
    const generation = crypto.randomUUID();
    await database.query(
      `INSERT INTO agent_backup_restore_operations
        (id, organization_id, agent_id, restore_attempt_id, phase)
        VALUES ($1, $2, $3, $4, 'container_created')`,
      [crypto.randomUUID(), ORGANIZATION_ID, AGENT_ID, generation],
    );
    await applySqlMigration(database, expandMigration);
    await expect(applySqlMigration(database, contractMigration)).rejects.toThrow(
      /requires an explicit post-container operation backfill/,
    );
  });

  test("refuses divergent current bindings backfilled between expand and contract", async () => {
    for (const target of ["operation", "publication"] as const) {
      const database = await prerequisiteDatabase(false);
      const generation = crypto.randomUUID();
      const valid = endpoint(generation);
      const divergent = { ...valid, runtimeAgentId: OTHER_RUNTIME_AGENT_ID };
      await database.query(
        `INSERT INTO agent_sandboxes
          (id, organization_id, character_id, activation_generation,
            activation_purpose, activation_phase)
          VALUES ($1, $2, $3, $4, 'restore', 'restore_pending')`,
        [AGENT_ID, ORGANIZATION_ID, RUNTIME_AGENT_ID, generation],
      );
      await applySqlMigration(database, expandMigration);
      await database.query(
        `UPDATE agent_sandboxes SET activation_endpoint_envelope = $1::jsonb,
          activation_endpoint_sha256 = $2 WHERE id = $3`,
        [JSON.stringify(valid), endpointSha256(valid), AGENT_ID],
      );
      if (target === "operation") {
        await insertOperation(database, generation, divergent, endpointSha256(divergent));
      } else {
        await database.query(
          `INSERT INTO agent_activation_publications
            (id, organization_id, agent_id, activation_generation, purpose,
              endpoint_envelope, endpoint_sha256)
            VALUES ($1, $2, $3, $4, 'restore', $5::jsonb, $6)`,
          [
            crypto.randomUUID(),
            ORGANIZATION_ID,
            AGENT_ID,
            generation,
            JSON.stringify(divergent),
            endpointSha256(divergent),
          ],
        );
      }
      await expect(applySqlMigration(database, contractMigration)).rejects.toThrow(
        /requires an exact current runtime binding backfill/,
      );
    }
  });

  test("refuses an orphaned nonterminal operation backfilled before contract", async () => {
    const database = await prerequisiteDatabase(false);
    const generation = crypto.randomUUID();
    const valid = endpoint(generation);
    await applySqlMigration(database, expandMigration);
    await insertOperation(database, generation, valid, endpointSha256(valid));
    await expect(applySqlMigration(database, contractMigration)).rejects.toThrow(
      /requires an exact current runtime binding backfill/,
    );
  });

  test("refuses unproven historical endpoint backfills on first contract install", async () => {
    for (const target of ["operation", "publication"] as const) {
      const database = await prerequisiteDatabase(false);
      const generation = crypto.randomUUID();
      const valid = endpoint(generation);
      await database.exec(`
        CREATE SCHEMA decoy;
        CREATE TABLE decoy.agent_backup_restore_operations (id integer);
        CREATE TABLE decoy.agent_activation_publications (id integer);
        CREATE FUNCTION decoy.pass_through() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RETURN NEW; END $$;
        CREATE TRIGGER agent_backup_restore_operations_runtime_binding
          BEFORE INSERT ON decoy.agent_backup_restore_operations
          FOR EACH ROW EXECUTE FUNCTION decoy.pass_through();
        CREATE TRIGGER agent_activation_publications_endpoint_runtime_binding
          BEFORE INSERT ON decoy.agent_activation_publications
          FOR EACH ROW EXECUTE FUNCTION decoy.pass_through();
      `);
      await applySqlMigration(database, expandMigration);
      await database.exec(`
        CREATE FUNCTION enforce_agent_restore_endpoint_runtime_binding() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER agent_backup_restore_operations_runtime_binding
          BEFORE INSERT OR UPDATE OF expected_endpoint_envelope, expected_endpoint_sha256
          ON agent_backup_restore_operations FOR EACH ROW
          EXECUTE FUNCTION enforce_agent_restore_endpoint_runtime_binding();
        CREATE TRIGGER agent_activation_publications_endpoint_runtime_binding
          BEFORE INSERT ON agent_activation_publications FOR EACH ROW
          EXECUTE FUNCTION enforce_agent_restore_endpoint_runtime_binding();
      `);
      if (target === "operation") {
        await database.query(
          `INSERT INTO agent_backup_restore_operations
            (id, organization_id, agent_id, restore_attempt_id, phase,
              expected_endpoint_envelope, expected_endpoint_sha256)
            VALUES ($1, $2, $3, $4, 'finalized', $5::jsonb, $6)`,
          [
            crypto.randomUUID(),
            ORGANIZATION_ID,
            AGENT_ID,
            generation,
            JSON.stringify(valid),
            endpointSha256(valid),
          ],
        );
      } else {
        await database.query(
          `INSERT INTO agent_activation_publications
            (id, organization_id, agent_id, activation_generation, purpose,
              endpoint_envelope, endpoint_sha256)
            VALUES ($1, $2, $3, $4, 'restore', $5::jsonb, $6)`,
          [
            crypto.randomUUID(),
            ORGANIZATION_ID,
            AGENT_ID,
            generation,
            JSON.stringify(valid),
            endpointSha256(valid),
          ],
        );
      }
      await expect(applySqlMigration(database, contractMigration)).rejects.toThrow(
        /requires an exact current runtime binding backfill/,
      );
    }
  });

  test("accepts G1 history only when exact origin-enabled triggers prove it", async () => {
    const database = await prerequisiteDatabase(false);
    const historicalGeneration = crypto.randomUUID();
    const currentGeneration = crypto.randomUUID();
    const historical = endpoint(historicalGeneration);
    const current = { ...endpoint(currentGeneration), runtimeAgentId: OTHER_RUNTIME_AGENT_ID };
    await applySqlMigration(database, expandMigration);
    await database.query(
      `INSERT INTO agent_sandboxes
        (id, organization_id, character_id, activation_generation,
          activation_purpose, activation_phase,
          activation_endpoint_envelope, activation_endpoint_sha256)
        VALUES ($1, $2, $3, $4, 'restore', 'restart_attested', $5::jsonb, $6)`,
      [
        AGENT_ID,
        ORGANIZATION_ID,
        RUNTIME_AGENT_ID,
        historicalGeneration,
        JSON.stringify(historical),
        endpointSha256(historical),
      ],
    );
    await database.query(
      `INSERT INTO agent_backup_restore_operations
        (id, organization_id, agent_id, restore_attempt_id, phase,
          expected_endpoint_envelope, expected_endpoint_sha256)
        VALUES ($1, $2, $3, $4, 'finalized', $5::jsonb, $6)`,
      [
        crypto.randomUUID(),
        ORGANIZATION_ID,
        AGENT_ID,
        historicalGeneration,
        JSON.stringify(historical),
        endpointSha256(historical),
      ],
    );
    await database.query(
      `INSERT INTO agent_activation_publications
        (id, organization_id, agent_id, activation_generation, purpose,
          endpoint_envelope, endpoint_sha256)
        VALUES ($1, $2, $3, $4, 'restore', $5::jsonb, $6)`,
      [
        crypto.randomUUID(),
        ORGANIZATION_ID,
        AGENT_ID,
        historicalGeneration,
        JSON.stringify(historical),
        endpointSha256(historical),
      ],
    );
    await applySqlMigration(database, contractMigration);
    await database.query(
      `UPDATE agent_sandboxes SET activation_purpose = 'wake',
        activation_generation = NULL, activation_phase = 'container_pending',
        activation_endpoint_envelope = NULL,
        activation_endpoint_sha256 = NULL WHERE id = $1`,
      [AGENT_ID],
    );
    await database.query(
      `UPDATE agent_sandboxes SET character_id = $1, activation_generation = $2,
        activation_purpose = 'restore', activation_phase = 'restart_attested',
        activation_endpoint_envelope = $3::jsonb, activation_endpoint_sha256 = $4
        WHERE id = $5`,
      [
        OTHER_RUNTIME_AGENT_ID,
        currentGeneration,
        JSON.stringify(current),
        endpointSha256(current),
        AGENT_ID,
      ],
    );
    await applySqlMigration(database, contractMigration);
    await database.exec(
      `ALTER TABLE agent_backup_restore_operations
        ENABLE REPLICA TRIGGER agent_backup_restore_operations_runtime_binding`,
    );
    await expect(applySqlMigration(database, contractMigration)).rejects.toThrow(
      /requires an exact current runtime binding backfill/,
    );
  });

  test("does not mistake the endpoint-only V2 trigger for the placement-bound V3 contract", async () => {
    const database = await prerequisiteDatabase(false);
    const generation = crypto.randomUUID();
    const nodeIncarnation = crypto.randomUUID();
    const valid = endpoint(generation);
    const validSha256 = endpointSha256(valid);
    const containerId = "a".repeat(64);
    const divergentContainerId = "b".repeat(64);
    const imageDigest = `sha256:${"c".repeat(64)}`;
    await applySqlMigration(database, expandMigration);
    await database.exec(`
      CREATE FUNCTION enforce_agent_restore_endpoint_runtime_binding_v2() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public AS $endpoint$
      DECLARE
        row_data jsonb := to_jsonb(NEW);
        endpoint_envelope jsonb := CASE WHEN TG_TABLE_NAME = 'agent_backup_restore_operations'
          THEN row_data->'expected_endpoint_envelope' ELSE row_data->'endpoint_envelope' END;
        endpoint_sha256 text := CASE WHEN TG_TABLE_NAME = 'agent_backup_restore_operations'
          THEN row_data->>'expected_endpoint_sha256' ELSE row_data->>'endpoint_sha256' END;
        endpoint_generation uuid := (CASE WHEN TG_TABLE_NAME = 'agent_backup_restore_operations'
          THEN row_data->>'restore_attempt_id' ELSE row_data->>'activation_generation' END)::uuid;
      BEGIN
        IF endpoint_sha256 IS NOT NULL AND TG_TABLE_NAME = 'agent_activation_publications' THEN
          PERFORM 1 FROM public.agent_backup_restore_operations operation
          WHERE operation.organization_id = (row_data->>'organization_id')::uuid
            AND operation.agent_id = (row_data->>'agent_id')::uuid
            AND operation.restore_attempt_id = endpoint_generation
            AND operation.expected_endpoint_envelope = endpoint_envelope
            AND operation.expected_endpoint_sha256 = endpoint_sha256;
          IF NOT FOUND THEN RAISE EXCEPTION 'old V2 operation binding failed'; END IF;
        END IF;
        IF endpoint_sha256 IS NOT NULL THEN
          PERFORM 1 FROM public.agent_sandboxes sandbox
          WHERE sandbox.id = (row_data->>'agent_id')::uuid
            AND sandbox.organization_id = (row_data->>'organization_id')::uuid
            AND sandbox.activation_generation = endpoint_generation
            AND sandbox.deleted_at IS NULL AND sandbox.deletion_attempt_id IS NULL
            AND sandbox.status NOT IN ('deletion_pending','deletion_failed')
            AND sandbox.activation_purpose = 'restore'
            AND sandbox.activation_phase IN ('restore_pending','restart_pending','restart_attested','active')
            AND sandbox.character_id::text = endpoint_envelope->>'runtimeAgentId'
            AND sandbox.activation_endpoint_envelope = endpoint_envelope
            AND sandbox.activation_endpoint_sha256 = endpoint_sha256;
          IF NOT FOUND THEN RAISE EXCEPTION 'old V2 sandbox binding failed'; END IF;
        END IF;
        RETURN NEW;
      END;
      $endpoint$;
      CREATE TRIGGER agent_backup_restore_operations_runtime_binding
        BEFORE INSERT OR UPDATE OF phase, resume_phase,
          expected_endpoint_envelope, expected_endpoint_sha256
        ON agent_backup_restore_operations FOR EACH ROW
        EXECUTE FUNCTION enforce_agent_restore_endpoint_runtime_binding_v2();
      CREATE TRIGGER agent_activation_publications_endpoint_runtime_binding
        BEFORE INSERT ON agent_activation_publications FOR EACH ROW
        EXECUTE FUNCTION enforce_agent_restore_endpoint_runtime_binding_v2();
    `);
    await database.query(
      `INSERT INTO agent_sandboxes
        (id, organization_id, character_id, activation_generation,
          activation_purpose, activation_phase, activation_container_id,
          activation_node_id, activation_image_digest, activation_boot_id,
          activation_endpoint_envelope, activation_endpoint_sha256)
        VALUES ($1, $2, $3, $4, 'restore', 'active', $5, 'node-a', $6, $7,
          $8::jsonb, $9)`,
      [
        AGENT_ID,
        ORGANIZATION_ID,
        RUNTIME_AGENT_ID,
        generation,
        containerId,
        imageDigest,
        nodeIncarnation,
        JSON.stringify(valid),
        validSha256,
      ],
    );
    await database.query(
      `INSERT INTO agent_backup_restore_operations
        (id, organization_id, agent_id, restore_attempt_id, phase,
          expected_container_id, expected_node_id, expected_image_digest,
          expected_node_incarnation, expected_endpoint_envelope, expected_endpoint_sha256)
        VALUES ($1, $2, $3, $4, 'finalized', $5, 'node-a', $6, $7, $8::jsonb, $9)`,
      [
        crypto.randomUUID(),
        ORGANIZATION_ID,
        AGENT_ID,
        generation,
        containerId,
        imageDigest,
        nodeIncarnation,
        JSON.stringify(valid),
        validSha256,
      ],
    );
    await database.query(
      `INSERT INTO agent_activation_publications
        (id, organization_id, agent_id, activation_generation, purpose,
          container_id, node_id, image_digest, node_incarnation,
          endpoint_envelope, endpoint_sha256)
        VALUES ($1, $2, $3, $4, 'restore', $5, 'node-a', $6, $7, $8::jsonb, $9)`,
      [
        crypto.randomUUID(),
        ORGANIZATION_ID,
        AGENT_ID,
        generation,
        divergentContainerId,
        imageDigest,
        nodeIncarnation,
        JSON.stringify(valid),
        validSha256,
      ],
    );
    await database.query(
      `UPDATE agent_sandboxes SET activation_generation = $1,
        activation_purpose = 'wake', activation_phase = 'container_pending',
        activation_container_id = NULL, activation_node_id = NULL,
        activation_image_digest = NULL, activation_boot_id = NULL,
        activation_endpoint_envelope = NULL, activation_endpoint_sha256 = NULL
        WHERE id = $2`,
      [crypto.randomUUID(), AGENT_ID],
    );
    await expect(applySqlMigration(database, contractMigration)).rejects.toThrow(
      /requires an exact current runtime binding backfill/,
    );
  });

  test("replays after trigger-proven authority becomes deletion-fenced", async () => {
    for (const fence of ["soft-delete", "deletion-intent"] as const) {
      const database = await prerequisiteDatabase(false);
      const generation = crypto.randomUUID();
      const valid = endpoint(generation);
      await applySqlMigration(database, expandMigration);
      await database.query(
        `INSERT INTO agent_sandboxes
          (id, organization_id, character_id, activation_generation,
            activation_purpose, activation_phase,
            activation_endpoint_envelope, activation_endpoint_sha256)
          VALUES ($1, $2, $3, $4, 'restore', 'active', $5::jsonb, $6)`,
        [
          AGENT_ID,
          ORGANIZATION_ID,
          RUNTIME_AGENT_ID,
          generation,
          JSON.stringify(valid),
          endpointSha256(valid),
        ],
      );
      await database.query(
        `INSERT INTO agent_backup_restore_operations
          (id, organization_id, agent_id, restore_attempt_id, phase,
            expected_endpoint_envelope, expected_endpoint_sha256)
          VALUES ($1, $2, $3, $4, 'finalized', $5::jsonb, $6)`,
        [
          crypto.randomUUID(),
          ORGANIZATION_ID,
          AGENT_ID,
          generation,
          JSON.stringify(valid),
          endpointSha256(valid),
        ],
      );
      await database.query(
        `INSERT INTO agent_activation_publications
          (id, organization_id, agent_id, activation_generation, purpose,
            endpoint_envelope, endpoint_sha256)
          VALUES ($1, $2, $3, $4, 'restore', $5::jsonb, $6)`,
        [
          crypto.randomUUID(),
          ORGANIZATION_ID,
          AGENT_ID,
          generation,
          JSON.stringify(valid),
          endpointSha256(valid),
        ],
      );
      await applySqlMigration(database, contractMigration);
      if (fence === "soft-delete") {
        await database.query(`UPDATE agent_sandboxes SET deleted_at = now() WHERE id = $1`, [
          AGENT_ID,
        ]);
      } else {
        await database.query(
          `UPDATE agent_sandboxes SET status = 'deletion_pending',
            deletion_attempt_id = $1, deletion_started_at = now() WHERE id = $2`,
          [crypto.randomUUID(), AGENT_ID],
        );
      }
      await applySqlMigration(database, contractMigration);
    }
  });

  test("enforces exact operation shape, generation, URL safety, digest, and write-once", async () => {
    const database = await prerequisiteDatabase();
    const generation = crypto.randomUUID();
    const valid = endpoint(generation);
    const validSha256 = endpointSha256(valid);
    await database.query(
      `INSERT INTO agent_sandboxes
        (id, organization_id, character_id, activation_generation,
          activation_purpose, activation_phase,
          activation_endpoint_envelope, activation_endpoint_sha256)
        VALUES ($1, $2, $3, $4, 'restore', 'restore_pending', $5::jsonb, $6)`,
      [AGENT_ID, ORGANIZATION_ID, RUNTIME_AGENT_ID, generation, JSON.stringify(valid), validSha256],
    );
    await insertOperation(database, generation, valid, validSha256);
    const divergentRuntime = { ...valid, runtimeAgentId: OTHER_RUNTIME_AGENT_ID };
    await expect(
      insertOperation(database, generation, divergentRuntime, endpointSha256(divergentRuntime)),
    ).rejects.toThrow(/not bound to the exact sandbox runtime/);
    await database.query(
      `UPDATE agent_backup_restore_operations SET expected_endpoint_envelope = $1::jsonb,
        expected_endpoint_sha256 = $2 WHERE restore_attempt_id = $3`,
      [JSON.stringify(valid), validSha256, generation],
    );

    await insertOperation(database, crypto.randomUUID(), null, null);
    await expect(
      database.query(
        `UPDATE agent_backup_restore_operations SET phase = 'container_created'
          WHERE expected_endpoint_envelope IS NULL`,
      ),
    ).rejects.toThrow(/endpoint_v1_check/);

    const changed = { ...valid, healthUrl: "https://other.internal/health" };
    await expect(
      database.query(
        `UPDATE agent_backup_restore_operations SET expected_endpoint_envelope = $1::jsonb
          WHERE restore_attempt_id = $2`,
        [JSON.stringify(changed), generation],
      ),
    ).rejects.toThrow(/endpoint authority is write-once/);

    for (const [candidate, digest] of [
      [null, validSha256],
      [valid, null],
      [{ ...valid, generation: crypto.randomUUID() }, validSha256],
      [{ ...valid, generation: valid.generation.toUpperCase() }, validSha256],
      [{ ...valid, serverName: "sandbox-wrong" }, validSha256],
      [{ ...valid, runtimeAgentId: valid.runtimeAgentId.toUpperCase() }, validSha256],
      [{ ...valid, extra: true }, validSha256],
      [{ ...valid, registryUrl: "https://user:secret@registry.internal/v1" }, validSha256],
      [{ ...valid, registryUrl: "http://host:99999/path" }, validSha256],
      [{ ...valid, registryUrl: "http://:80/path" }, validSha256],
      [{ ...valid, registryUrl: "https://registry.internal\\evil/path" }, validSha256],
      [{ ...valid, bridgeUrl: "https://bridge.internal/path?token=secret" }, validSha256],
      [{ ...valid, bridgeUrl: "https://bridge.internal/path?" }, validSha256],
      [{ ...valid, bridgeUrl: "https://bridge.internal/path#" }, validSha256],
      [{ ...valid, registryUrl: "https://registry.internal\\@evil.test/path" }, validSha256],
      [{ ...valid, healthUrl: "https://health.internal/health check" }, validSha256],
      [{ ...valid, healthUrl: `https://health.internal/${"x".repeat(4096)}` }, validSha256],
      [valid, "b".repeat(64)],
      [valid, "A".repeat(64)],
    ] as const) {
      await expect(insertOperation(database, generation, candidate, digest)).rejects.toThrow(
        /endpoint_v1_check|not bound to the exact sandbox runtime/,
      );
    }
    const nilGeneration = "00000000-0000-0000-0000-000000000000";
    const nilEndpoint = endpoint(nilGeneration);
    await expect(
      insertOperation(database, nilGeneration, nilEndpoint, endpointSha256(nilEndpoint)),
    ).rejects.toThrow(/endpoint_v1_check|not bound to the exact sandbox runtime/);
  });

  test("binds raw restore writers only to valid restore lifecycle phases", async () => {
    const database = await prerequisiteDatabase();
    const generation = crypto.randomUUID();
    const valid = endpoint(generation);
    const validSha256 = endpointSha256(valid);
    await database.query(
      `INSERT INTO agent_sandboxes
        (id, organization_id, character_id, activation_generation,
          activation_purpose, activation_phase,
          activation_endpoint_envelope, activation_endpoint_sha256)
        VALUES ($1, $2, $3, $4, 'wake', 'restore_pending', $5::jsonb, $6)`,
      [AGENT_ID, ORGANIZATION_ID, RUNTIME_AGENT_ID, generation, JSON.stringify(valid), validSha256],
    );
    await expect(insertOperation(database, generation, valid, validSha256)).rejects.toThrow(
      /not bound to the exact sandbox runtime/,
    );

    await database.query(
      `UPDATE agent_sandboxes SET activation_purpose = 'restore' WHERE id = $1`,
      [AGENT_ID],
    );
    const terminalFailureOperationId = await insertOperation(
      database,
      generation,
      valid,
      validSha256,
    );
    const retryableFailureOperationId = await insertOperation(
      database,
      generation,
      valid,
      validSha256,
    );
    await database.query(`UPDATE agent_sandboxes SET deleted_at = now() WHERE id = $1`, [AGENT_ID]);
    await expect(insertOperation(database, generation, valid, validSha256)).rejects.toThrow(
      /not bound to the exact sandbox runtime/,
    );
    await expect(
      database.query(
        `UPDATE agent_backup_restore_operations SET phase = 'restoring'
          WHERE id = $1`,
        [terminalFailureOperationId],
      ),
    ).rejects.toThrow(/not bound to the exact sandbox runtime/);
    await database.query(
      `UPDATE agent_backup_restore_operations SET phase = 'failed_terminal'
        WHERE id = $1`,
      [terminalFailureOperationId],
    );
    await database.query(
      `UPDATE agent_backup_restore_operations
        SET phase = 'failed_retryable', resume_phase = 'restoring' WHERE id = $1`,
      [retryableFailureOperationId],
    );
    await applySqlMigration(database, contractMigration);
    await expect(
      database.query(
        `UPDATE agent_backup_restore_operations SET phase = 'restoring', resume_phase = NULL
          WHERE id = $1`,
        [retryableFailureOperationId],
      ),
    ).rejects.toThrow(/not bound to the exact sandbox runtime/);
    await database.query(
      `UPDATE agent_sandboxes SET deleted_at = NULL,
        deletion_attempt_id = $1, deletion_started_at = now(), status = 'deletion_pending'
        WHERE id = $2`,
      [crypto.randomUUID(), AGENT_ID],
    );
    await expect(insertOperation(database, generation, valid, validSha256)).rejects.toThrow(
      /not bound to the exact sandbox runtime/,
    );
    await database.query(
      `UPDATE agent_sandboxes SET deletion_attempt_id = NULL,
        deletion_started_at = NULL, status = 'running' WHERE id = $1`,
      [AGENT_ID],
    );
    const insertPublication = () =>
      database.query(
        `INSERT INTO agent_activation_publications
          (id, organization_id, agent_id, activation_generation, purpose,
            endpoint_envelope, endpoint_sha256)
          VALUES ($1, $2, $3, $4, 'restore', $5::jsonb, $6)`,
        [
          crypto.randomUUID(),
          ORGANIZATION_ID,
          AGENT_ID,
          generation,
          JSON.stringify(valid),
          validSha256,
        ],
      );
    await expect(insertPublication()).rejects.toThrow(/not bound to its durable operation/);

    await database.query(
      `UPDATE agent_sandboxes SET activation_phase = 'restart_attested' WHERE id = $1`,
      [AGENT_ID],
    );
    await expect(insertPublication()).rejects.toThrow(/not bound to its durable operation/);
    for (const phase of ["published", "finalized"] as const) {
      await database.query(
        `UPDATE agent_backup_restore_operations
          SET phase = $1, resume_phase = NULL WHERE id = $2`,
        [phase, retryableFailureOperationId],
      );
      await expect(insertPublication()).rejects.toThrow(/not bound to its durable operation/);
    }
    await database.query(
      `UPDATE agent_backup_restore_operations
        SET phase = 'probed', resume_phase = NULL WHERE id = $1`,
      [retryableFailureOperationId],
    );
    await insertPublication();
    await database.query(`UPDATE agent_sandboxes SET status = 'deletion_failed' WHERE id = $1`, [
      AGENT_ID,
    ]);
    await expect(insertPublication()).rejects.toThrow(/not bound to the exact sandbox runtime/);
  });

  test("cannot prove runtime authority through a pg_temp sandbox shadow", async () => {
    const database = await prerequisiteDatabase();
    const generation = crypto.randomUUID();
    const valid = endpoint(generation);
    const validSha256 = endpointSha256(valid);
    await database.exec(`
      CREATE TEMP TABLE agent_sandboxes
        (LIKE public.agent_sandboxes INCLUDING DEFAULTS);
      SET search_path = pg_temp, public;
    `);
    await database.query(
      `INSERT INTO pg_temp.agent_sandboxes
        (id, organization_id, character_id, activation_generation,
          activation_purpose, activation_phase,
          activation_endpoint_envelope, activation_endpoint_sha256)
        VALUES ($1, $2, $3, $4, 'restore', 'restore_pending', $5::jsonb, $6)`,
      [AGENT_ID, ORGANIZATION_ID, RUNTIME_AGENT_ID, generation, JSON.stringify(valid), validSha256],
    );

    await expect(insertOperation(database, generation, valid, validSha256)).rejects.toThrow(
      /not bound to the exact sandbox runtime/,
    );
    await database.exec(`
      ALTER TABLE public.agent_backup_restore_operations
        DISABLE TRIGGER agent_backup_restore_operations_runtime_binding;
    `);
    await insertOperation(database, generation, valid, validSha256);
    await database.exec(`
      UPDATE public.agent_backup_restore_operations SET phase = 'probed'
        WHERE agent_id = '${AGENT_ID}' AND restore_attempt_id = '${generation}';
      ALTER TABLE public.agent_backup_restore_operations
        ENABLE TRIGGER agent_backup_restore_operations_runtime_binding;
    `);
    await database.query(
      `UPDATE pg_temp.agent_sandboxes SET activation_phase = 'restart_attested' WHERE id = $1`,
      [AGENT_ID],
    );
    await expect(
      database.query(
        `INSERT INTO public.agent_activation_publications
          (id, organization_id, agent_id, activation_generation, purpose,
            endpoint_envelope, endpoint_sha256)
          VALUES ($1, $2, $3, $4, 'restore', $5::jsonb, $6)`,
        [
          crypto.randomUUID(),
          ORGANIZATION_ID,
          AGENT_ID,
          generation,
          JSON.stringify(valid),
          validSha256,
        ],
      ),
    ).rejects.toThrow(/not bound to the exact sandbox runtime/);
  });

  test("rejects invalid URLs and false digests at every persisted boundary", async () => {
    const database = await prerequisiteDatabase();
    const generation = crypto.randomUUID();
    const valid = endpoint(generation);
    const validSha256 = endpointSha256(valid);
    const wrongSha256 = `${validSha256[0] === "a" ? "b" : "a"}${validSha256.slice(1)}`;
    const invalidUrls = [
      { ...valid, registryUrl: "http://host:99999/path" },
      { ...valid, registryUrl: "https://registry.internal/a\u00a0b" },
      { ...valid, registryUrl: "https://registry.internal/a\u202fb" },
      { ...valid, registryUrl: "https://registry.internal/a\ufeffb" },
      { ...valid, registryUrl: "https://registry.internal/café" },
    ];

    await expect(
      database.query(
        `INSERT INTO agent_sandboxes
          (id, organization_id, character_id, activation_generation,
            activation_purpose, activation_phase,
            activation_endpoint_envelope, activation_endpoint_sha256)
          VALUES ($1, $2, $3, $4, 'restore', 'restore_pending', $5::jsonb, $6)`,
        [
          AGENT_ID,
          ORGANIZATION_ID,
          RUNTIME_AGENT_ID,
          generation,
          JSON.stringify(valid),
          wrongSha256,
        ],
      ),
    ).rejects.toThrow(/agent_sandboxes_activation_endpoint_v1_check/);
    for (const invalidUrl of invalidUrls) {
      await expect(
        database.query(
          `INSERT INTO agent_sandboxes
            (id, organization_id, character_id, activation_generation,
              activation_purpose, activation_phase,
              activation_endpoint_envelope, activation_endpoint_sha256)
            VALUES ($1, $2, $3, $4, 'restore', 'restore_pending', $5::jsonb, $6)`,
          [
            AGENT_ID,
            ORGANIZATION_ID,
            RUNTIME_AGENT_ID,
            generation,
            JSON.stringify(invalidUrl),
            endpointSha256(invalidUrl),
          ],
        ),
      ).rejects.toThrow(/agent_sandboxes_activation_endpoint_v1_check/);
    }
    await database.query(
      `INSERT INTO agent_sandboxes
        (id, organization_id, character_id, activation_generation,
          activation_purpose, activation_phase,
          activation_endpoint_envelope, activation_endpoint_sha256)
        VALUES ($1, $2, $3, $4, 'restore', 'restore_pending', $5::jsonb, $6)`,
      [AGENT_ID, ORGANIZATION_ID, RUNTIME_AGENT_ID, generation, JSON.stringify(valid), validSha256],
    );
    await database.exec(`ALTER TABLE agent_backup_restore_operations
      DISABLE TRIGGER agent_backup_restore_operations_runtime_binding`);
    await expect(insertOperation(database, generation, valid, wrongSha256)).rejects.toThrow(
      /agent_backup_restore_operations_endpoint_v1_check/,
    );
    for (const invalidUrl of invalidUrls) {
      await expect(
        insertOperation(database, generation, invalidUrl, endpointSha256(invalidUrl)),
      ).rejects.toThrow(/agent_backup_restore_operations_endpoint_v1_check/);
    }
    await database.exec(`ALTER TABLE agent_backup_restore_operations
      ENABLE TRIGGER agent_backup_restore_operations_runtime_binding`);
    await insertOperation(database, generation, valid, validSha256);
    await database.query(
      `UPDATE agent_sandboxes SET activation_phase = 'restart_attested' WHERE id = $1`,
      [AGENT_ID],
    );
    await database.exec(`ALTER TABLE agent_activation_publications
      DISABLE TRIGGER agent_activation_publications_endpoint_runtime_binding`);
    await expect(
      database.query(
        `INSERT INTO agent_activation_publications
          (id, organization_id, agent_id, activation_generation, purpose,
            endpoint_envelope, endpoint_sha256)
          VALUES ($1, $2, $3, $4, 'restore', $5::jsonb, $6)`,
        [
          crypto.randomUUID(),
          ORGANIZATION_ID,
          AGENT_ID,
          generation,
          JSON.stringify(valid),
          wrongSha256,
        ],
      ),
    ).rejects.toThrow(/agent_activation_publications_endpoint_v1_check/);
    for (const invalidUrl of invalidUrls) {
      await expect(
        database.query(
          `INSERT INTO agent_activation_publications
            (id, organization_id, agent_id, activation_generation, purpose,
              endpoint_envelope, endpoint_sha256)
            VALUES ($1, $2, $3, $4, 'restore', $5::jsonb, $6)`,
          [
            crypto.randomUUID(),
            ORGANIZATION_ID,
            AGENT_ID,
            generation,
            JSON.stringify(invalidUrl),
            endpointSha256(invalidUrl),
          ],
        ),
      ).rejects.toThrow(/agent_activation_publications_endpoint_v1_check/);
    }
    await database.exec(`ALTER TABLE agent_activation_publications
      ENABLE TRIGGER agent_activation_publications_endpoint_runtime_binding`);
  });

  test("keeps one generation immutable and binds publication through the durable operation", async () => {
    const database = await prerequisiteDatabase();
    const generation = crypto.randomUUID();
    const rotatedGeneration = crypto.randomUUID();
    const valid = endpoint(generation);
    const validSha256 = endpointSha256(valid);
    const rebound = { ...valid, runtimeAgentId: OTHER_RUNTIME_AGENT_ID };
    const reboundSha256 = endpointSha256(rebound);

    await database.query(
      `INSERT INTO agent_sandboxes
        (id, organization_id, character_id, activation_generation,
          activation_purpose, activation_phase,
          activation_endpoint_envelope, activation_endpoint_sha256)
        VALUES ($1, $2, $3, $4, 'restore', 'restore_pending', $5::jsonb, $6)`,
      [AGENT_ID, ORGANIZATION_ID, RUNTIME_AGENT_ID, generation, JSON.stringify(valid), validSha256],
    );
    await insertOperation(database, generation, valid, validSha256);

    await database.query(`UPDATE agent_sandboxes SET activation_container_id = $1 WHERE id = $2`, [
      "a".repeat(64),
      AGENT_ID,
    ]);
    await expect(
      database.query(
        `UPDATE agent_backup_restore_operations SET phase = 'container_created'
          WHERE agent_id = $1 AND restore_attempt_id = $2`,
        [AGENT_ID, generation],
      ),
    ).rejects.toThrow(/not bound to the exact sandbox runtime/);
    await database.query(
      `UPDATE agent_sandboxes SET activation_container_id = NULL WHERE id = $1`,
      [AGENT_ID],
    );

    await expect(
      database.query(
        `UPDATE agent_sandboxes SET activation_endpoint_envelope = NULL,
          activation_endpoint_sha256 = NULL WHERE id = $1`,
        [AGENT_ID],
      ),
    ).rejects.toThrow(/immutable within one activation generation/);
    await database.query(
      `UPDATE agent_sandboxes SET activation_generation = $1,
        activation_purpose = 'wake', activation_phase = 'container_pending',
        activation_endpoint_envelope = NULL, activation_endpoint_sha256 = NULL
        WHERE id = $2`,
      [rotatedGeneration, AGENT_ID],
    );
    await database.query(
      `UPDATE agent_sandboxes SET character_id = $1, activation_generation = $2,
        activation_purpose = 'restore', activation_phase = 'restart_attested',
        activation_endpoint_envelope = $3::jsonb, activation_endpoint_sha256 = $4
        WHERE id = $5`,
      [OTHER_RUNTIME_AGENT_ID, generation, JSON.stringify(rebound), reboundSha256, AGENT_ID],
    );
    await expect(
      database.query(
        `INSERT INTO agent_activation_publications
          (id, organization_id, agent_id, activation_generation, purpose,
            endpoint_envelope, endpoint_sha256)
          VALUES ($1, $2, $3, $4, 'restore', $5::jsonb, $6)`,
        [
          crypto.randomUUID(),
          ORGANIZATION_ID,
          AGENT_ID,
          generation,
          JSON.stringify(rebound),
          reboundSha256,
        ],
      ),
    ).rejects.toThrow(/not bound to its durable operation/);
  });

  test("requires sandbox endpoints at restore attestation and keeps publication scope immutable", async () => {
    const database = await prerequisiteDatabase();
    const generation = crypto.randomUUID();
    const valid = endpoint(generation);
    const validSha256 = endpointSha256(valid);
    const sandboxId = crypto.randomUUID();

    await database.query(
      `INSERT INTO agent_sandboxes
        (id, organization_id, character_id, activation_generation,
          activation_purpose, activation_phase)
        VALUES ($1, $2, $3, $4, 'restore', 'restart_pending')`,
      [sandboxId, ORGANIZATION_ID, RUNTIME_AGENT_ID, generation],
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
      [JSON.stringify(valid), validSha256, sandboxId],
    );
    await expect(
      database.query(`UPDATE agent_sandboxes SET character_id = NULL WHERE id = $1`, [sandboxId]),
    ).rejects.toThrow(/immutable within one activation generation/);
    await expect(
      database.query(`UPDATE agent_sandboxes SET character_id = $1 WHERE id = $2`, [
        OTHER_RUNTIME_AGENT_ID,
        sandboxId,
      ]),
    ).rejects.toThrow(/immutable within one activation generation/);
    const rebound = { ...valid, runtimeAgentId: OTHER_RUNTIME_AGENT_ID };
    await expect(
      database.query(
        `UPDATE agent_sandboxes SET character_id = $1,
          activation_endpoint_envelope = $2::jsonb,
          activation_endpoint_sha256 = $3 WHERE id = $4`,
        [OTHER_RUNTIME_AGENT_ID, JSON.stringify(rebound), endpointSha256(rebound), sandboxId],
      ),
    ).rejects.toThrow(/immutable within one activation generation/);

    const operationId = await insertOperation(database, generation, valid, validSha256, sandboxId);
    await database.query(
      `UPDATE agent_backup_restore_operations SET phase = 'probed' WHERE id = $1`,
      [operationId],
    );

    await expect(
      database.query(
        `INSERT INTO agent_activation_publications
          (id, organization_id, agent_id, activation_generation, purpose,
            container_id, endpoint_envelope, endpoint_sha256)
          VALUES ($1, $2, $3, $4, 'restore', $5, $6::jsonb, $7)`,
        [
          crypto.randomUUID(),
          ORGANIZATION_ID,
          sandboxId,
          generation,
          "a".repeat(64),
          JSON.stringify(valid),
          validSha256,
        ],
      ),
    ).rejects.toThrow(/not bound to its durable operation/);

    await expect(
      database.query(
        `INSERT INTO agent_activation_publications
          (id, organization_id, agent_id, activation_generation, purpose)
          VALUES ($1, $2, $3, $4, 'restore')`,
        [crypto.randomUUID(), ORGANIZATION_ID, sandboxId, generation],
      ),
    ).rejects.toThrow(/endpoint_v1_check/);
    await database.query(
      `INSERT INTO agent_activation_publications
        (id, organization_id, agent_id, activation_generation, purpose)
        VALUES ($1, $2, $3, $4, 'wake')`,
      [crypto.randomUUID(), ORGANIZATION_ID, sandboxId, generation],
    );
    await expect(
      database.query(
        `INSERT INTO agent_activation_publications
          (id, organization_id, agent_id, activation_generation, purpose,
            endpoint_envelope, endpoint_sha256)
          VALUES ($1, $2, $3, $4, 'wake', $5::jsonb, $6)`,
        [
          crypto.randomUUID(),
          ORGANIZATION_ID,
          sandboxId,
          generation,
          JSON.stringify(valid),
          validSha256,
        ],
      ),
    ).rejects.toThrow(/endpoint_v1_check/);

    await expect(
      database.query(
        `INSERT INTO agent_activation_publications
          (id, organization_id, agent_id, activation_generation, purpose,
            endpoint_envelope, endpoint_sha256)
          VALUES ($1, $2, $3, $4, 'restore', $5::jsonb, $6)`,
        [
          crypto.randomUUID(),
          ORGANIZATION_ID,
          sandboxId,
          generation,
          JSON.stringify(rebound),
          endpointSha256(rebound),
        ],
      ),
    ).rejects.toThrow(/not bound to its durable operation/);

    const publicationId = crypto.randomUUID();
    await database.query(
      `INSERT INTO agent_activation_publications
        (id, organization_id, agent_id, activation_generation, purpose,
          endpoint_envelope, endpoint_sha256)
        VALUES ($1, $2, $3, $4, 'restore', $5::jsonb, $6)`,
      [publicationId, ORGANIZATION_ID, sandboxId, generation, JSON.stringify(valid), validSha256],
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
      entries: Array<{
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }>;
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
