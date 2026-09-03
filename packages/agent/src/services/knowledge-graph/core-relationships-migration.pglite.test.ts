/**
 * Real-PGlite coverage for the Core relationships migration and cutover.
 * The test drives actual PostgreSQL-compatible tables, verifies lossless source
 * archival and canonical projection, reruns after a source change, then proves
 * database-enforced cutover rejects legacy writes without deleting source rows.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CoreRelationshipsSqlExecutor,
  migrateCoreRelationshipsToKnowledgeGraph,
} from "./core-relationships-migration.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const CONTACT_ID = "00000000-0000-4000-8000-000000000002";
const COMPONENT_ID = "00000000-0000-4000-8000-000000000003";
const RELATIONSHIP_ID = "00000000-0000-4000-8000-000000000004";
const IDENTITY_ID = "00000000-0000-4000-8000-000000000005";
const CANDIDATE_ID = "00000000-0000-4000-8000-000000000006";

describe("Core relationships migration — real PGlite", () => {
  let database: PGlite;
  let exec: CoreRelationshipsSqlExecutor;

  beforeAll(async () => {
    database = new PGlite();
    exec = async (statement) => {
      const result = await database.query<Record<string, unknown>>(statement);
      return result.rows;
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
    await database.exec(`
      INSERT INTO entities VALUES
        ('${AGENT_ID}', '${AGENT_ID}', '2026-01-01T00:00:00Z', ARRAY['Owner'], '{"role":"owner"}'),
        ('${CONTACT_ID}', '${AGENT_ID}', '2026-01-02T00:00:00Z', ARRAY['Ada'], '{"displayName":"Ada"}');
      INSERT INTO components VALUES (
        '${COMPONENT_ID}', '${CONTACT_ID}', '${AGENT_ID}', '${AGENT_ID}', '${AGENT_ID}',
        '${AGENT_ID}', 'contact_info',
        '{"categories":["friend"],"tags":["vip"],"preferences":{"channel":"signal"},"customFields":{"birthday":"1815-12-10"},"privacyLevel":"private","lastModified":"2026-02-01T00:00:00Z","handles":[{"id":"handle-1","platform":"signal","identifier":"ada"}],"interactions":[{"id":"interaction-1","platform":"signal","direction":"inbound","summary":"hello","externalRef":"message-1","occurredAt":"2026-02-02T00:00:00Z"}],"followupThresholdDays":14,"lastInteractionAt":"2026-02-02T00:00:00Z","relationshipGoal":{"goalText":"Stay in touch","targetCadenceDays":7,"setAt":"2026-02-01T00:00:00Z"},"relationshipStatus":"blocked"}',
        '2026-02-01T00:00:00Z'
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

  it("archives, projects, resumes, verifies, and cuts over without deleting source rows", async () => {
    await database.exec(`INSERT INTO app_lifeops.life_relationships_v2 VALUES (
      '${RELATIONSHIP_ID}', '${AGENT_ID}', 'self', '${CONTACT_ID}', 'unrelated', '{}',
      NULL, NULL, NULL, 0, NULL, '[]', 1, 'manual', 'active', NULL, NULL,
      '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'
    )`);
    await expect(
      migrateCoreRelationshipsToKnowledgeGraph(exec, {
        agentId: AGENT_ID,
        now: "2026-02-28T00:00:00.000Z",
      }),
    ).rejects.toThrow(
      `Canonical relationship id collision for ${RELATIONSHIP_ID}`,
    );
    expect(
      await exec(
        "SELECT count(*)::int AS count FROM app_lifeops.core_relationships_source_records",
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await exec(
        `SELECT type, source FROM app_lifeops.life_relationships_v2
         WHERE relationship_id = '${RELATIONSHIP_ID}'`,
      ),
    ).toEqual([{ type: "unrelated", source: "manual" }]);
    await database.exec(
      `DELETE FROM app_lifeops.life_relationships_v2 WHERE relationship_id = '${RELATIONSHIP_ID}'`,
    );

    const first = await migrateCoreRelationshipsToKnowledgeGraph(exec, {
      agentId: AGENT_ID,
      now: "2026-03-01T00:00:00.000Z",
    });
    expect(first).toMatchObject({
      status: "verified",
      inventory: {
        entity: 2,
        contact_component: 1,
        relationship: 1,
        identity: 1,
        merge_candidate: 1,
      },
      archivedRecords: 6,
      projectedRecords: 6,
    });

    const archived = await exec(
      `SELECT source_kind, source_id, payload_json FROM app_lifeops.core_relationships_source_records
       WHERE agent_id = '${AGENT_ID}' ORDER BY source_kind, source_id`,
    );
    expect(archived).toHaveLength(6);
    expect(
      archived.find((row) => row.source_kind === "contact_component")
        ?.payload_json,
    ).toContain("Stay in touch");
    expect(
      await exec(
        `SELECT entity_id, preferred_name FROM app_lifeops.life_entities
         WHERE agent_id = '${AGENT_ID}' ORDER BY entity_id`,
      ),
    ).toEqual([
      { entity_id: CONTACT_ID, preferred_name: "Ada" },
      { entity_id: "self", preferred_name: "Owner" },
    ]);
    const contactEdge = (
      await exec(
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
      await exec(
        `SELECT verified, confidence, evidence_json FROM app_lifeops.life_entity_identities
         WHERE entity_id = '${CONTACT_ID}'`,
      ),
    ).toEqual([
      { verified: true, confidence: 0.9, evidence_json: '["message-3"]' },
    ]);
    expect(
      await exec(
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
      await exec(
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

    await database.exec(`UPDATE components SET data = data || '{"followupThresholdDays":21}'::jsonb
      WHERE id = '${COMPONENT_ID}'`);
    const resumed = await migrateCoreRelationshipsToKnowledgeGraph(exec, {
      agentId: AGENT_ID,
      now: "2026-03-02T00:00:00.000Z",
    });
    expect(resumed.sourceDigest).not.toBe(first.sourceDigest);
    expect(
      await exec(
        `SELECT payload_json FROM app_lifeops.core_relationships_source_records
         WHERE source_kind = 'contact_component' AND source_id = '${COMPONENT_ID}'`,
      ),
    ).toEqual([{ payload_json: expect.stringContaining("21") }]);

    await database.exec(`INSERT INTO app_lifeops.core_relationships_source_records
      (agent_id, source_kind, source_id, source_hash, payload_json, archived_at)
      VALUES ('${AGENT_ID}', 'entity', 'disappeared-source', 'stale', '{}',
        '2026-03-02T12:00:00.000Z')`);
    await expect(
      migrateCoreRelationshipsToKnowledgeGraph(exec, {
        agentId: AGENT_ID,
        activateCutover: true,
        now: "2026-03-02T12:01:00.000Z",
      }),
    ).rejects.toThrow(
      "Core relationships source rows disappeared after archival; refusing cutover",
    );
    expect(
      await exec(
        `SELECT status FROM app_lifeops.core_relationships_migration_state
         WHERE agent_id = '${AGENT_ID}'`,
      ),
    ).toEqual([{ status: "verified" }]);
    await database.exec(`DELETE FROM app_lifeops.core_relationships_source_records
      WHERE agent_id = '${AGENT_ID}' AND source_id = 'disappeared-source'`);

    const cutover = await migrateCoreRelationshipsToKnowledgeGraph(exec, {
      agentId: AGENT_ID,
      activateCutover: true,
      now: "2026-03-03T00:00:00.000Z",
    });
    expect(cutover.status).toBe("cutover");
    await expect(
      database.exec(
        `UPDATE components SET data = '{}' WHERE id = '${COMPONENT_ID}'`,
      ),
    ).rejects.toThrow(/persistence is cut over/);
    await expect(
      database.exec(
        `UPDATE relationships SET metadata = '{}' WHERE id = '${RELATIONSHIP_ID}'`,
      ),
    ).rejects.toThrow(/persistence is cut over/);
    await expect(
      database.exec(`INSERT INTO components VALUES (
        '00000000-0000-4000-8000-000000000099', '${CONTACT_ID}', '${AGENT_ID}',
        '${AGENT_ID}', '${AGENT_ID}', '${AGENT_ID}', 'unrelated_component', '{}', now())`),
    ).resolves.toBeDefined();
    expect(
      await exec(
        `SELECT count(*)::int AS count FROM components WHERE type = 'contact_info'`,
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      await exec("SELECT count(*)::int AS count FROM relationships"),
    ).toEqual([{ count: 1 }]);
  });
});
