/**
 * Real PGlite source snapshots preserve canonical retirement/deletion and full
 * legacy rows. Tenant/world filtering and SQL-trigger failures exercise the
 * actual archive transaction without replacing the implementation.
 */
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { stringToUuid } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveCoreRelationshipsInventory,
  type CoreRelationshipsInventoryDatabase,
} from "./core-relationships-inventory.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const CONTACT_ID = "00000000-0000-4000-8000-000000000002";
const COMPONENT_ID = "00000000-0000-4000-8000-000000000003";
const RELATIONSHIP_ID = "00000000-0000-4000-8000-000000000004";
const IDENTITY_ID = "00000000-0000-4000-8000-000000000005";
const CANDIDATE_ID = "00000000-0000-4000-8000-000000000006";
const UNRELATED_COMPONENT_ID = "00000000-0000-4000-8000-000000000008";
const COINCIDENT_IDENTITY_ID = "00000000-0000-4000-8000-000000000009";
const RELATIONSHIPS_WORLD_ID = stringToUuid(`relationships-world-${AGENT_ID}`);

describe("Core relationships inventory — real PGlite", () => {
  let database: PGlite;
  let inventoryDatabase: CoreRelationshipsInventoryDatabase;
  const execute = async (
    statement: string,
  ): Promise<Array<Record<string, unknown>>> => {
    const result = await database.query<Record<string, unknown>>(statement);
    return result.rows;
  };

  beforeEach(async () => {
    database = new PGlite();
    inventoryDatabase = {
      transaction: async (callback) => {
        await database.exec("BEGIN ISOLATION LEVEL SERIALIZABLE");
        try {
          const result = await callback({
            execute: async (statement) => {
              return execute(statement);
            },
          });
          await database.exec("COMMIT");
          return result;
        } catch (error) {
          // error-policy:J2 Roll back the real database transaction before rethrowing its failure.
          await database.exec("ROLLBACK");
          throw error;
        }
      },
    };
    await database.exec(`
      CREATE TABLE entities (
        id uuid PRIMARY KEY, agent_id uuid NOT NULL, created_at timestamptz NOT NULL,
        names text[] NOT NULL, metadata jsonb NOT NULL
      );
      CREATE TABLE components (
        id uuid PRIMARY KEY, entity_id uuid NOT NULL, agent_id uuid NOT NULL,
        room_id uuid NOT NULL, world_id uuid, source_entity_id uuid, type text NOT NULL,
        data jsonb NOT NULL, created_at timestamptz NOT NULL
      );
      CREATE TABLE relationships (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, source_entity_id uuid NOT NULL,
        target_entity_id uuid NOT NULL, agent_id uuid NOT NULL, tags text[], metadata jsonb
      );
      CREATE TABLE entity_identities (
        id uuid PRIMARY KEY, entity_id uuid NOT NULL, agent_id uuid NOT NULL,
        platform text NOT NULL, handle text NOT NULL, verified boolean NOT NULL,
        confidence real NOT NULL, source text, first_seen timestamptz NOT NULL,
        last_seen timestamptz NOT NULL, evidence_message_ids jsonb, created_at timestamptz NOT NULL
      );
      CREATE TABLE entity_merge_candidates (
        id uuid PRIMARY KEY, agent_id uuid NOT NULL, entity_a uuid NOT NULL, entity_b uuid NOT NULL,
        confidence real NOT NULL, evidence jsonb, status text NOT NULL,
        proposed_at timestamptz NOT NULL, resolved_at timestamptz
      );
      CREATE SCHEMA app_lifeops;
      CREATE TABLE app_lifeops.life_entities (
        entity_id text NOT NULL, agent_id text NOT NULL, type text NOT NULL,
        preferred_name text NOT NULL, full_name text, tags_json text NOT NULL,
        visibility text NOT NULL, state_last_observed_at text, state_last_inbound_at text,
        state_last_outbound_at text, state_last_interaction_platform text,
        created_at text NOT NULL, updated_at text NOT NULL, UNIQUE(agent_id, entity_id)
      );
      CREATE TABLE app_lifeops.life_entity_identities (
        id text PRIMARY KEY, agent_id text NOT NULL, entity_id text NOT NULL, platform text NOT NULL,
        handle text NOT NULL, connector_account_id text NOT NULL, display_name text,
        verified boolean NOT NULL, confidence real NOT NULL, added_at text NOT NULL,
        added_via text NOT NULL, evidence_json text NOT NULL,
        UNIQUE(agent_id, entity_id, platform, connector_account_id, handle)
      );
      CREATE TABLE app_lifeops.life_entity_attributes (
        id text PRIMARY KEY, agent_id text NOT NULL, entity_id text NOT NULL, key text NOT NULL,
        value_json text NOT NULL, confidence real NOT NULL, evidence_json text NOT NULL,
        updated_at text NOT NULL, UNIQUE(agent_id, entity_id, key)
      );
      CREATE TABLE app_lifeops.life_relationships_v2 (
        relationship_id text PRIMARY KEY, agent_id text NOT NULL, from_entity_id text NOT NULL,
        to_entity_id text NOT NULL, type text NOT NULL, metadata_json text NOT NULL,
        cadence_days integer, state_last_observed_at text, state_last_interaction_at text,
        state_interaction_count integer NOT NULL, state_sentiment_trend text,
        evidence_json text NOT NULL, confidence real NOT NULL, source text NOT NULL,
        status text NOT NULL, retired_at text, retired_reason text,
        created_at text NOT NULL, updated_at text NOT NULL
      );
      CREATE TABLE app_lifeops.life_relationship_audit_events (
        id text PRIMARY KEY, agent_id text NOT NULL, relationship_id text NOT NULL,
        kind text NOT NULL, details_json text NOT NULL, created_at text NOT NULL
      );
    `);
    await database.exec(`INSERT INTO app_lifeops.life_entities VALUES (
      'self', '${AGENT_ID}', 'person', 'self', NULL, '[]', 'owner_only',
      NULL, NULL, NULL, NULL, '2025-12-01T00:00:00Z', '2025-12-01T00:00:00Z'
    )`);
    await database.exec(`
      INSERT INTO entities VALUES
        ('${AGENT_ID}', '${AGENT_ID}', '2026-01-01T00:00:00Z', ARRAY['Owner'], '{"role":"owner"}'),
        ('${CONTACT_ID}', '${AGENT_ID}', '2026-01-02T00:00:00Z', ARRAY['Ada'], '{"displayName":"Ada"}');
      INSERT INTO components VALUES (
        '${COMPONENT_ID}', '${CONTACT_ID}', '${AGENT_ID}', '${AGENT_ID}', '${RELATIONSHIPS_WORLD_ID}',
        '${AGENT_ID}', 'contact_info',
        '{"categories":["friend"],"tags":["vip"],"preferences":{"channel":"signal"},"customFields":{"birthday":"1815-12-10"},"privacyLevel":"private","lastModified":"2026-02-01T00:00:00Z","handles":[{"id":"handle-1","platform":"signal","identifier":"ada"},{"id":"handle-2","platform":"matrix","identifier":"@ada:example.org"}],"interactions":[{"id":"interaction-1","platform":"signal","direction":"inbound","summary":"hello","externalRef":"message-1","occurredAt":"2026-02-02T00:00:00Z"}],"followupThresholdDays":14,"lastInteractionAt":"2026-02-02T00:00:00Z","relationshipGoal":{"goalText":"Stay in touch","targetCadenceDays":7,"setAt":"2026-02-01T00:00:00Z"},"relationshipStatus":"blocked"}',
        '2026-02-01T00:00:00Z'
      );
      INSERT INTO components VALUES (
        '${UNRELATED_COMPONENT_ID}', '${CONTACT_ID}', '${AGENT_ID}', '${AGENT_ID}', '${AGENT_ID}',
        '${AGENT_ID}', 'contact_info', '{"unrelated":true}', '2026-02-01T00:00:00Z'
      );
      INSERT INTO relationships VALUES (
        '${RELATIONSHIP_ID}', '2026-02-03T00:00:00Z', '${AGENT_ID}', '${CONTACT_ID}',
        '${AGENT_ID}', ARRAY['identity_link'],
        '{"status":"confirmed","evidence":["message-2"],"mergeSurvivorEntityId":"${AGENT_ID}"}'
      );
      INSERT INTO entity_identities VALUES (
        '${IDENTITY_ID}', '${CONTACT_ID}', '${AGENT_ID}', 'discord', 'ada#1', true, 0.9,
        'connector', '2026-02-01T00:00:00Z', '2026-02-04T00:00:00Z',
        '["message-3"]', '2026-02-01T00:00:00Z'
      );
      INSERT INTO entity_identities VALUES (
        '${COINCIDENT_IDENTITY_ID}', '${CONTACT_ID}', '${AGENT_ID}', 'signal', 'ada', true, 0.8,
        'connector', '2026-02-01T00:00:00Z', '2026-02-04T00:00:00Z',
        '["message-signal"]', '2026-02-01T00:00:00Z'
      );
      INSERT INTO entity_merge_candidates VALUES (
        '${CANDIDATE_ID}', '${AGENT_ID}', '${AGENT_ID}', '${CONTACT_ID}', 0.95,
        '{"messages":["message-4"],"reason":"same person"}', 'accepted',
        '2026-02-05T00:00:00Z', '2026-02-06T00:00:00Z'
      );
    `);
  });

  afterEach(async () => {
    await database.close();
  });

  const sourceTables = [
    "entities",
    "components",
    "relationships",
    "entity_identities",
    "entity_merge_candidates",
  ];
  const graphTables = [
    "life_entities",
    "life_entity_identities",
    "life_entity_attributes",
    "life_relationships_v2",
    "life_relationship_audit_events",
  ];
  const snapshot = async (tables: string[]) =>
    Promise.all(
      tables.map(async (table) =>
        (
          await execute(
            `SELECT row_to_json(t)::text AS payload FROM ${table} t ORDER BY to_jsonb(t)::text`,
          )
        ).map((row) => JSON.parse(String(row.payload))),
      ),
    );
  const run = () =>
    archiveCoreRelationshipsInventory(inventoryDatabase, { agentId: AGENT_ID });
  const archives = () =>
    execute(
      "SELECT * FROM app_lifeops.core_relationships_source_records ORDER BY agent_id, source_kind, source_id",
    );

  it.each([
    ["entities", "entity", AGENT_ID, "metadata", "created_at"],
    ["components", "contact_component", COMPONENT_ID, "data", "created_at"],
    [
      "relationships",
      "relationship",
      RELATIONSHIP_ID,
      "metadata",
      "created_at",
    ],
    [
      "entity_identities",
      "identity",
      IDENTITY_ID,
      "evidence_message_ids",
      "created_at",
    ],
    [
      "entity_merge_candidates",
      "merge_candidate",
      CANDIDATE_ID,
      "evidence",
      "proposed_at",
    ],
  ] as const)(
    "preserves PostgreSQL JSONB and timestamp precision for %s",
    async (table, kind, id, jsonField, timeField) => {
      await database.exec(`UPDATE ${table} SET ${jsonField} =
      '{"integer":9007199254740993,"decimal":0.123456789012345678901234567890,"nested":{"tail":"complete"}}'::jsonb,
      ${timeField} = '2026-01-02T03:04:05.123456Z' WHERE id = '${id}'`);
      const source = await execute(
        `SELECT row_to_json(t)::text AS payload FROM ${table} t WHERE id = '${id}'`,
      );
      await run();
      const comparison = await execute(`SELECT
      source.${jsonField} = archived.payload_json::jsonb -> '${jsonField}' AS json_equal,
      source.${timeField} = (archived.payload_json::jsonb ->> '${timeField}')::timestamptz AS timestamp_equal
      FROM ${table} source JOIN app_lifeops.core_relationships_source_records archived
      ON archived.source_id = source.id::text AND archived.source_kind = '${kind}'
      AND archived.agent_id = '${AGENT_ID}' WHERE source.id = '${id}'`);
      expect(comparison).toEqual([{ json_equal: true, timestamp_equal: true }]);
      expect(
        await execute(
          `SELECT row_to_json(t)::text AS payload FROM ${table} t WHERE id = '${id}'`,
        ),
      ).toEqual(source);
    },
  );

  it("archives full scoped rows while preserving source and canonical retirement/deletion on replay", async () => {
    await database.exec(`INSERT INTO app_lifeops.life_relationships_v2 VALUES (
      'core-contact:${COMPONENT_ID}', '${AGENT_ID}', 'self', '${CONTACT_ID}', 'contact', '{}',
      3, NULL, NULL, 1, NULL, '["owner-evidence"]', 1, 'manual', 'retired',
      '2026-03-01T00:00:00Z', 'owner:block', '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z'
    )`);
    const source = await snapshot(sourceTables);
    const canonicalTables = graphTables.map((table) => `app_lifeops.${table}`);
    const canonical = await snapshot(canonicalTables);
    await run();
    expect(await snapshot(sourceTables)).toEqual(source);
    expect(await snapshot(canonicalTables)).toEqual(canonical);
    const expected = source.flatMap((rows, index) =>
      rows.filter((row) => index !== 1 || row.id === COMPONENT_ID),
    );
    const copies = await archives();
    expect(
      copies
        .map((row) => JSON.parse(String(row.payload_json)))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)));
    for (const copy of copies) {
      expect(
        createHash("sha256").update(String(copy.payload_json)).digest("hex"),
      ).toBe(copy.source_hash);
    }
    await run();
    expect(await snapshot(canonicalTables)).toEqual(canonical);
    await database.exec(
      "DELETE FROM app_lifeops.life_relationships_v2; DELETE FROM app_lifeops.life_entities",
    );
    const deleted = await snapshot(canonicalTables);
    await run();
    expect(await snapshot(canonicalTables)).toEqual(deleted);
    expect(await snapshot(sourceTables)).toEqual(source);
  });

  it("excludes other tenants, worlds and contact source identities and preserves their snapshots", async () => {
    const other = "00000000-0000-4000-8000-000000000099";
    await database.exec(`INSERT INTO entities VALUES ('${other}', '${other}', now(), ARRAY['Other'], '{}');
      INSERT INTO components SELECT '00000000-0000-4000-8000-000000000097', entity_id, agent_id,
        room_id, world_id, '${other}', type, data, created_at FROM components WHERE id = '${COMPONENT_ID}';
      INSERT INTO relationships SELECT '00000000-0000-4000-8000-000000000098', created_at,
        source_entity_id, target_entity_id, '${other}', tags, metadata FROM relationships;`);
    await archiveCoreRelationshipsInventory(inventoryDatabase, {
      agentId: other,
    });
    const foreign = await archives();
    const source = await snapshot(sourceTables);
    await run();
    const rows = await archives();
    expect(rows.filter((row) => row.agent_id === other)).toEqual(foreign);
    const own = rows.filter((row) => row.agent_id === AGENT_ID);
    const selected = own.map((row) => JSON.parse(String(row.payload_json)));
    expect(selected.every((row) => row.agent_id === AGENT_ID)).toBe(true);
    expect(
      selected
        .filter((row) => row.type === "contact_info")
        .map((row) => row.id),
    ).toEqual([COMPONENT_ID]);
    expect(await snapshot(sourceTables)).toEqual(source);
  });

  it("rolls back corrupt archive writes and preserves the previous snapshot, then replaces current source rows", async () => {
    await run();
    const previous = await archives();
    await database.exec(`UPDATE entities SET metadata = '{"newOwnerValue":"complete"}' WHERE id = '${CONTACT_ID}';
      CREATE FUNCTION corrupt_archive() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.source_hash := 'corrupt'; RETURN NEW; END $$;
      CREATE TRIGGER corrupt_archive BEFORE INSERT ON app_lifeops.core_relationships_source_records
      FOR EACH ROW EXECUTE FUNCTION corrupt_archive();`);
    const source = await snapshot(sourceTables);
    await expect(run()).rejects.toMatchObject({
      code: "RELATIONSHIP_INVENTORY_FAILED",
    });
    expect(await archives()).toEqual(previous);
    expect(await snapshot(sourceTables)).toEqual(source);
    await database.exec(
      "DROP TRIGGER corrupt_archive ON app_lifeops.core_relationships_source_records; DELETE FROM entity_merge_candidates",
    );
    await run();
    const rows = await archives();
    expect(rows.some((row) => row.source_kind === "merge_candidate")).toBe(
      false,
    );
    expect(
      JSON.parse(
        String(
          rows.find(
            (row) =>
              row.source_kind === "entity" && row.source_id === CONTACT_ID,
          )?.payload_json,
        ),
      ).metadata,
    ).toEqual({ newOwnerValue: "complete" });
  });

  it("rejects missing source schema without fabricating an empty inventory or replacing the archive", async () => {
    await run();
    const previous = await archives();
    await database.exec(
      "ALTER TABLE entity_identities RENAME TO unavailable_identities",
    );
    await expect(run()).rejects.toMatchObject({
      code: "RELATIONSHIP_INVENTORY_FAILED",
    });
    expect(await archives()).toEqual(previous);
  });
});
