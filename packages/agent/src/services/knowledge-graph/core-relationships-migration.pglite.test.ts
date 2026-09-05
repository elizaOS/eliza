/**
 * Real-PGlite coverage for Core relationships migration verification.
 * The test verifies lossless archival, collision handling, provenance-owned
 * entity replay, and embedded-handle reconciliation without changing source
 * authority or deleting source rows.
 */

import { PGlite } from "@electric-sql/pglite";
import { stringToUuid } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CoreRelationshipsMigrationDatabase,
  migrateCoreRelationshipsToKnowledgeGraph,
} from "./core-relationships-migration.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const CONTACT_ID = "00000000-0000-4000-8000-000000000002";
const COMPONENT_ID = "00000000-0000-4000-8000-000000000003";
const RELATIONSHIP_ID = "00000000-0000-4000-8000-000000000004";
const IDENTITY_ID = "00000000-0000-4000-8000-000000000005";
const CANDIDATE_ID = "00000000-0000-4000-8000-000000000006";
const UNRELATED_COMPONENT_ID = "00000000-0000-4000-8000-000000000008";
const COINCIDENT_IDENTITY_ID = "00000000-0000-4000-8000-000000000009";
const RELATIONSHIPS_WORLD_ID = stringToUuid(`relationships-world-${AGENT_ID}`);

describe("Core relationships migration — real PGlite", () => {
  let database: PGlite;
  let migrationDatabase: CoreRelationshipsMigrationDatabase;
  const execute = async (
    statement: string,
  ): Promise<Array<Record<string, unknown>>> => {
    const result = await database.query<Record<string, unknown>>(statement);
    return result.rows;
  };

  beforeAll(async () => {
    database = new PGlite();
    migrationDatabase = {
      execute,
      transaction: async (callback, options) => {
        expect(options).toEqual({ isolationLevel: "serializable" });
        await database.exec("BEGIN ISOLATION LEVEL SERIALIZABLE");
        let firstStatement = "";
        try {
          const result = await callback({
            execute: async (statement) => {
              firstStatement ||= statement;
              return execute(statement);
            },
          });
          await database.exec("COMMIT");
          return result;
        } catch (error) {
          await database.exec("ROLLBACK");
          throw error;
        } finally {
          expect(firstStatement.trimStart()).toMatch(/^LOCK TABLE entities,/);
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

  afterAll(async () => {
    await database.close();
  });

  it("archives, projects, resumes, and verifies without deleting source rows", async () => {
    await database.exec(`INSERT INTO app_lifeops.life_relationships_v2 VALUES (
      '${RELATIONSHIP_ID}', '${AGENT_ID}', 'self', '${CONTACT_ID}', 'unrelated', '{}',
      NULL, NULL, NULL, 0, NULL, '[]', 1, 'manual', 'active', NULL, NULL,
      '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'
    )`);
    await expect(
      migrateCoreRelationshipsToKnowledgeGraph(migrationDatabase, {
        agentId: AGENT_ID,
        now: "2026-02-28T00:00:00.000Z",
      }),
    ).rejects.toThrow(
      `Canonical relationship id collision for ${RELATIONSHIP_ID}`,
    );
    expect(
      await execute(
        "SELECT count(*)::int AS count FROM app_lifeops.core_relationships_source_records",
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await execute(
        `SELECT type, source FROM app_lifeops.life_relationships_v2
         WHERE relationship_id = '${RELATIONSHIP_ID}'`,
      ),
    ).toEqual([{ type: "unrelated", source: "manual" }]);
    await database.exec(
      `DELETE FROM app_lifeops.life_relationships_v2 WHERE relationship_id = '${RELATIONSHIP_ID}'`,
    );

    await database.exec(`INSERT INTO app_lifeops.life_relationships_v2 VALUES (
      'other-active-contact', '${AGENT_ID}', 'self', '${CONTACT_ID}', 'identity_link', '{}',
      NULL, NULL, NULL, 0, NULL, '[]', 1, 'manual', 'active', NULL, NULL,
      '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'
    )`);
    await expect(
      migrateCoreRelationshipsToKnowledgeGraph(migrationDatabase, {
        agentId: AGENT_ID,
        now: "2026-02-28T01:00:00.000Z",
      }),
    ).rejects.toThrow(/Canonical active-edge collision/);
    await database.exec(
      "DELETE FROM app_lifeops.life_relationships_v2 WHERE relationship_id = 'other-active-contact'",
    );

    await database.exec(`INSERT INTO app_lifeops.life_entities VALUES (
      '${CONTACT_ID}', '${AGENT_ID}', 'person', 'Unrelated Ada', NULL, '[]',
      'owner_agent_admin', NULL, NULL, NULL, NULL,
      '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'
    )`);
    await expect(
      migrateCoreRelationshipsToKnowledgeGraph(migrationDatabase, {
        agentId: AGENT_ID,
        now: "2026-02-28T02:00:00.000Z",
      }),
    ).rejects.toThrow(/exists without matching migration provenance/);
    await database.exec(
      `DELETE FROM app_lifeops.life_entities WHERE entity_id = '${CONTACT_ID}'`,
    );

    const first = await migrateCoreRelationshipsToKnowledgeGraph(
      migrationDatabase,
      {
        agentId: AGENT_ID,
        now: "2026-03-01T00:00:00.000Z",
      },
    );
    expect(first).toMatchObject({
      status: "verified",
      inventory: {
        entity: 2,
        contact_component: 1,
        relationship: 1,
        identity: 2,
        merge_candidate: 1,
      },
      archivedRecords: 7,
      projectedRecords: 7,
    });

    const archived = await execute(
      `SELECT source_kind, source_id, payload_json FROM app_lifeops.core_relationships_source_records
       WHERE agent_id = '${AGENT_ID}' ORDER BY source_kind, source_id`,
    );
    expect(archived).toHaveLength(7);
    expect(
      archived.find((row) => row.source_kind === "contact_component")
        ?.payload_json,
    ).toContain("Stay in touch");
    expect(
      await execute(
        `SELECT entity_id, preferred_name FROM app_lifeops.life_entities
         WHERE agent_id = '${AGENT_ID}' ORDER BY entity_id`,
      ),
    ).toEqual([
      { entity_id: CONTACT_ID, preferred_name: "Ada" },
      { entity_id: "self", preferred_name: "self" },
    ]);
    const contactEdge = (
      await execute(
        `SELECT cadence_days, state_last_interaction_at, state_interaction_count,
                evidence_json, metadata_json, status, retired_at, retired_reason
         FROM app_lifeops.life_relationships_v2
         WHERE relationship_id = 'core-contact:${COMPONENT_ID}'`,
      )
    )[0];
    expect(contactEdge).toMatchObject({
      cadence_days: 7,
      state_last_interaction_at: "2026-02-02T00:00:00.000Z",
      state_interaction_count: 1,
      status: "retired",
      retired_at: "2026-02-01T00:00:00.000Z",
      retired_reason: "legacy:blocked",
    });
    expect(contactEdge.evidence_json).toContain("message-1");
    expect(contactEdge.metadata_json).toContain("birthday");
    expect(
      await execute(
        `SELECT verified, confidence, evidence_json FROM app_lifeops.life_entity_identities
         WHERE entity_id = '${CONTACT_ID}' AND platform = 'discord'`,
      ),
    ).toEqual([
      {
        verified: true,
        confidence: 0.9,
        evidence_json: `["core-identity:${IDENTITY_ID}","message-3"]`,
      },
    ]);
    const signalClaims = await execute(
      `SELECT id, platform, handle, connector_account_id, added_via, verified,
              confidence, evidence_json
       FROM app_lifeops.life_entity_identities
       WHERE entity_id = '${CONTACT_ID}' AND platform = 'signal'`,
    );
    expect(signalClaims).toHaveLength(1);
    expect(signalClaims[0]).toMatchObject({
      id: `core-handle:${COMPONENT_ID}:handle-1`,
      platform: "signal",
      handle: "ada",
      connector_account_id: "default",
      added_via: "import",
      verified: true,
      confidence: 1,
    });
    expect(signalClaims[0]?.evidence_json).toContain("message-signal");
    expect(signalClaims[0]?.evidence_json).toContain(
      `core-identity:${COINCIDENT_IDENTITY_ID}`,
    );
    expect(
      await execute(`SELECT target_id
        FROM app_lifeops.core_relationships_migration_records
        WHERE source_kind = 'identity' AND source_id = '${COINCIDENT_IDENTITY_ID}'`),
    ).toEqual([{ target_id: `core-handle:${COMPONENT_ID}:handle-1` }]);
    await database.exec(`UPDATE components SET data = jsonb_set(
      data, '{handles,0,identifier}', '"ada-mutated"'::jsonb)
      WHERE id = '${COMPONENT_ID}'`);
    await expect(
      migrateCoreRelationshipsToKnowledgeGraph(migrationDatabase, {
        agentId: AGENT_ID,
        now: "2026-03-01T01:00:00.000Z",
      }),
    ).rejects.toThrow(/Canonical contact handle id collision/);
    await database.exec(`UPDATE components SET data = jsonb_set(
      data, '{handles,0,identifier}', '"ada"'::jsonb)
      WHERE id = '${COMPONENT_ID}'`);

    await database.exec(`UPDATE app_lifeops.life_entity_identities
      SET entity_id = 'self'
      WHERE id = 'core-handle:${COMPONENT_ID}:handle-1'`);
    await expect(
      migrateCoreRelationshipsToKnowledgeGraph(migrationDatabase, {
        agentId: AGENT_ID,
        now: "2026-03-01T02:00:00.000Z",
      }),
    ).rejects.toThrow(/Canonical contact handle id collision/);
    await database.exec(`UPDATE app_lifeops.life_entity_identities
      SET entity_id = '${CONTACT_ID}'
      WHERE id = 'core-handle:${COMPONENT_ID}:handle-1'`);
    expect(
      await execute(
        `SELECT status, payload_json FROM app_lifeops.core_relationships_merge_lineage
         WHERE candidate_id = '${CANDIDATE_ID}'`,
      ),
    ).toEqual([
      expect.objectContaining({
        status: "accepted",
        payload_json: expect.stringContaining("message-4"),
      }),
    ]);
    expect(
      await execute(
        `SELECT relationship_id, kind, details_json
         FROM app_lifeops.life_relationship_audit_events
         WHERE agent_id = '${AGENT_ID}' ORDER BY relationship_id`,
      ),
    ).toEqual([
      expect.objectContaining({
        relationship_id: RELATIONSHIP_ID,
        kind: "core_relationships_migrated",
        details_json: expect.stringContaining("sourceHash"),
      }),
      expect.objectContaining({
        relationship_id: `core-contact:${COMPONENT_ID}`,
        kind: "core_relationships_migrated",
        details_json: expect.stringContaining("sourceHash"),
      }),
    ]);
    await database.exec(`INSERT INTO app_lifeops.life_relationships_v2 VALUES (
      'duplicate-active-edge', '${AGENT_ID}', 'self', '${CONTACT_ID}', 'identity_link', '{}',
      NULL, NULL, NULL, 0, NULL, '[]', 1, 'manual', 'active', NULL, NULL,
      '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'
    )`);
    await expect(
      migrateCoreRelationshipsToKnowledgeGraph(migrationDatabase, {
        agentId: AGENT_ID,
        now: "2026-03-01T12:00:00.000Z",
      }),
    ).rejects.toThrow(/Canonical active-edge collision/);
    await database.exec(`DELETE FROM app_lifeops.life_relationships_v2
      WHERE relationship_id = 'duplicate-active-edge'`);

    await database.exec(`UPDATE app_lifeops.life_entities SET
      full_name = 'Augusta Ada King', tags_json = '["canonical"]',
      visibility = 'owner_only', state_last_observed_at = '2026-03-01T10:00:00.000Z'
      WHERE agent_id = '${AGENT_ID}' AND entity_id = '${CONTACT_ID}'`);
    await database.exec(`UPDATE app_lifeops.life_entity_identities SET
      display_name = 'Canonical Ada', verified = TRUE, confidence = 1,
      added_at = '2025-01-01T00:00:00.000Z', added_via = 'manual',
      evidence_json = (evidence_json::jsonb || '["canonical-evidence"]'::jsonb)::text
      WHERE agent_id = '${AGENT_ID}' AND platform IN ('discord', 'signal')`);
    await database.exec(`UPDATE components
      SET data = (data - 'handles') || '{"followupThresholdDays":21}'::jsonb
      WHERE id = '${COMPONENT_ID}'`);
    await database.exec(`UPDATE entities SET names = ARRAY['Ada Lovelace']
      WHERE id = '${CONTACT_ID}'`);
    const resumed = await migrateCoreRelationshipsToKnowledgeGraph(
      migrationDatabase,
      {
        agentId: AGENT_ID,
        now: "2026-03-02T00:00:00.000Z",
      },
    );
    expect(resumed.sourceDigest).not.toBe(first.sourceDigest);
    expect(
      await execute(
        `SELECT payload_json FROM app_lifeops.core_relationships_source_records
         WHERE source_kind = 'contact_component' AND source_id = '${COMPONENT_ID}'`,
      ),
    ).toEqual([{ payload_json: expect.stringContaining("21") }]);
    expect(
      await execute(`SELECT preferred_name, full_name, tags_json, visibility,
          state_last_observed_at FROM app_lifeops.life_entities
        WHERE agent_id = '${AGENT_ID}' AND entity_id = '${CONTACT_ID}'`),
    ).toEqual([
      {
        preferred_name: "Ada Lovelace",
        full_name: "Augusta Ada King",
        tags_json: '["canonical"]',
        visibility: "owner_only",
        state_last_observed_at: "2026-03-01T10:00:00.000Z",
      },
    ]);
    expect(
      await execute(`SELECT platform, display_name, verified, confidence, added_at,
          added_via, evidence_json FROM app_lifeops.life_entity_identities
        WHERE agent_id = '${AGENT_ID}' AND platform IN ('discord', 'signal')
        ORDER BY platform`),
    ).toEqual([
      expect.objectContaining({
        platform: "discord",
        display_name: "Canonical Ada",
        verified: true,
        confidence: 1,
        added_at: "2025-01-01T00:00:00.000Z",
        added_via: "manual",
        evidence_json: expect.stringContaining("canonical-evidence"),
      }),
      expect.objectContaining({
        platform: "signal",
        display_name: "Canonical Ada",
        verified: true,
        confidence: 1,
        added_at: "2025-01-01T00:00:00.000Z",
        added_via: "manual",
        evidence_json: expect.stringContaining("message-signal"),
      }),
    ]);
    expect(
      await execute(`SELECT id FROM app_lifeops.life_entity_identities
        WHERE agent_id = '${AGENT_ID}' AND platform = 'matrix'`),
    ).toEqual([]);

    await database.exec(`UPDATE app_lifeops.life_entities
      SET preferred_name = 'Countess Ada', updated_at = '2026-03-02T01:00:00.000Z'
      WHERE agent_id = '${AGENT_ID}' AND entity_id = '${CONTACT_ID}'`);
    await database.exec(`UPDATE entities SET names = ARRAY['Ada Byron']
      WHERE id = '${CONTACT_ID}'`);
    const enrichedReplay = await migrateCoreRelationshipsToKnowledgeGraph(
      migrationDatabase,
      { agentId: AGENT_ID, now: "2026-03-02T02:00:00.000Z" },
    );
    expect(
      await execute(`SELECT preferred_name, full_name FROM app_lifeops.life_entities
        WHERE agent_id = '${AGENT_ID}' AND entity_id = '${CONTACT_ID}'`),
    ).toEqual([
      { preferred_name: "Countess Ada", full_name: "Augusta Ada King" },
    ]);
    expect(
      await execute(`SELECT value_json FROM app_lifeops.life_entity_attributes
        WHERE agent_id = '${AGENT_ID}' AND entity_id = '${CONTACT_ID}'
          AND key = 'legacy.core.migration_entity'`),
    ).toEqual([{ value_json: expect.stringContaining('"owned":false') }]);

    await database.exec(`INSERT INTO app_lifeops.core_relationships_source_records
      (agent_id, source_kind, source_id, source_hash, payload_json, archived_at)
      VALUES ('${AGENT_ID}', 'entity', 'disappeared-source', 'stale', '{}',
        '2026-03-02T12:00:00.000Z')`);
    await expect(
      migrateCoreRelationshipsToKnowledgeGraph(migrationDatabase, {
        agentId: AGENT_ID,
        now: "2026-03-02T12:01:00.000Z",
      }),
    ).rejects.toThrow(
      "Core relationships source rows disappeared after archival; refusing verification",
    );
    expect(
      await execute(
        `SELECT status FROM app_lifeops.core_relationships_migration_state
         WHERE agent_id = '${AGENT_ID}'`,
      ),
    ).toEqual([{ status: "verified" }]);
    await database.exec(`DELETE FROM app_lifeops.core_relationships_source_records
      WHERE agent_id = '${AGENT_ID}' AND source_id = 'disappeared-source'`);

    await expect(
      database.exec(
        `UPDATE components SET data = '{"stillUnrelated":true}'
         WHERE id = '${UNRELATED_COMPONENT_ID}'`,
      ),
    ).resolves.toBeDefined();
    const replay = await migrateCoreRelationshipsToKnowledgeGraph(
      migrationDatabase,
      { agentId: AGENT_ID, now: "2026-03-04T00:00:00.000Z" },
    );
    expect(replay).toMatchObject({
      status: "verified",
      sourceDigest: enrichedReplay.sourceDigest,
    });
    expect(
      await execute(
        `SELECT status, verified_at
         FROM app_lifeops.core_relationships_migration_state WHERE agent_id = '${AGENT_ID}'`,
      ),
    ).toEqual([
      {
        status: "verified",
        verified_at: "2026-03-04T00:00:00.000Z",
      },
    ]);
  });
});
