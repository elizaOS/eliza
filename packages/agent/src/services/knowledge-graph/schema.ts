/**
 * Runtime-owned knowledge-graph schema: entities + typed relationships.
 *
 * These tables back the runtime `KnowledgeGraphService`. They live under the
 * `app_lifeops` Postgres schema (the historical home) so the physical tables
 * are unchanged — ownership moved from `@elizaos/plugin-personal-assistant`
 * to the runtime, but no data migration or rename is involved.
 *
 * `life_entities` stores nodes (person, organization, place, project,
 * concept, ...). Per-connector identity claims are stored in
 * `life_entity_identities`; open-keyed extracted attributes in
 * `life_entity_attributes`. The `(agent_id, entity_id)` pair is unique;
 * `entityId === "self"` is the special user node.
 *
 * `life_relationships_v2` stores typed edges. Existing deployments may contain
 * more than one active edge for an `(agent_id, from_entity_id, to_entity_id,
 * type)` tuple, so migrations must detect ambiguity rather than impose a new
 * global constraint. `cadence_days` is surfaced as a column-level shortcut for
 * the cadence-overdue filter even though it also appears inside `metadata_json`.
 */

import { DEFAULT_CONNECTOR_ACCOUNT_ID } from "@elizaos/shared";
import {
  boolean,
  index,
  integer,
  pgSchema,
  real,
  text,
  unique,
} from "drizzle-orm/pg-core";

export const appLifeopsPgSchema = pgSchema("app_lifeops");

export const lifeEntities = appLifeopsPgSchema.table(
  "life_entities",
  {
    entityId: text("entity_id").notNull(),
    agentId: text("agent_id").notNull(),
    type: text("type").notNull(),
    preferredName: text("preferred_name").notNull(),
    fullName: text("full_name"),
    tagsJson: text("tags_json").notNull().default("[]"),
    visibility: text("visibility").notNull().default("owner_agent_admin"),
    stateLastObservedAt: text("state_last_observed_at"),
    stateLastInboundAt: text("state_last_inbound_at"),
    stateLastOutboundAt: text("state_last_outbound_at"),
    stateLastInteractionPlatform: text("state_last_interaction_platform"),
    legacyRelationshipId: text("legacy_relationship_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.entityId),
    index("life_entities_agent_type_idx").on(t.agentId, t.type),
    index("life_entities_agent_name_idx").on(t.agentId, t.preferredName),
  ],
);

export const lifeEntityIdentities = appLifeopsPgSchema.table(
  "life_entity_identities",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    entityId: text("entity_id").notNull(),
    platform: text("platform").notNull(),
    handle: text("handle").notNull(),
    connectorAccountId: text("connector_account_id")
      .notNull()
      .default(DEFAULT_CONNECTOR_ACCOUNT_ID),
    displayName: text("display_name"),
    verified: boolean("verified").notNull().default(false),
    confidence: real("confidence").notNull().default(0),
    addedAt: text("added_at").notNull(),
    addedVia: text("added_via").notNull(),
    evidenceJson: text("evidence_json").notNull().default("[]"),
  },
  (t) => [
    unique("life_entity_identities_entity_route_unique").on(
      t.agentId,
      t.entityId,
      t.platform,
      t.connectorAccountId,
      t.handle,
    ),
    index("life_entity_identities_lookup_idx").on(
      t.agentId,
      t.platform,
      t.connectorAccountId,
      t.handle,
    ),
  ],
);

export const lifeEntityAttributes = appLifeopsPgSchema.table(
  "life_entity_attributes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    entityId: text("entity_id").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull().default("null"),
    confidence: real("confidence").notNull().default(0),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.entityId, t.key),
    index("life_entity_attributes_lookup_idx").on(t.agentId, t.entityId),
  ],
);

export const lifeRelationshipsV2 = appLifeopsPgSchema.table(
  "life_relationships_v2",
  {
    relationshipId: text("relationship_id").primaryKey(),
    agentId: text("agent_id").notNull(),
    fromEntityId: text("from_entity_id").notNull(),
    toEntityId: text("to_entity_id").notNull(),
    type: text("type").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    cadenceDays: integer("cadence_days"),
    stateLastObservedAt: text("state_last_observed_at"),
    stateLastInteractionAt: text("state_last_interaction_at"),
    stateInteractionCount: integer("state_interaction_count")
      .notNull()
      .default(0),
    stateSentimentTrend: text("state_sentiment_trend"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    confidence: real("confidence").notNull().default(0),
    source: text("source").notNull(),
    status: text("status").notNull().default("active"),
    retiredAt: text("retired_at"),
    retiredReason: text("retired_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("life_relationships_v2_edge_idx").on(
      t.agentId,
      t.fromEntityId,
      t.toEntityId,
      t.type,
    ),
    index("life_relationships_v2_to_idx").on(t.agentId, t.toEntityId),
    index("life_relationships_v2_cadence_idx").on(
      t.agentId,
      t.cadenceDays,
      t.stateLastInteractionAt,
    ),
  ],
);

export const lifeRelationshipAuditEvents = appLifeopsPgSchema.table(
  "life_relationship_audit_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    relationshipId: text("relationship_id").notNull(),
    kind: text("kind").notNull(),
    detailsJson: text("details_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("life_relationship_audit_events_lookup_idx").on(
      t.agentId,
      t.relationshipId,
    ),
  ],
);

/**
 * Durable control plane for verifying a non-destructive Core
 * RelationshipsService copy.
 */
export const coreRelationshipsMigrationState = appLifeopsPgSchema.table(
  "core_relationships_migration_state",
  {
    agentId: text("agent_id").primaryKey(),
    status: text("status").notNull(),
    sourceDigest: text("source_digest").notNull(),
    inventoryJson: text("inventory_json").notNull(),
    relationshipsWorldId: text("relationships_world_id").notNull(),
    startedAt: text("started_at").notNull(),
    verifiedAt: text("verified_at"),
  },
);

/** Verbatim, hash-addressed source rows retained after verification. */
export const coreRelationshipsSourceRecords = appLifeopsPgSchema.table(
  "core_relationships_source_records",
  {
    agentId: text("agent_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    payloadJson: text("payload_json").notNull(),
    archivedAt: text("archived_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.sourceKind, t.sourceId)],
);

/** Source-to-target receipts used for resumable projection and exact readback. */
export const coreRelationshipsMigrationRecords = appLifeopsPgSchema.table(
  "core_relationships_migration_records",
  {
    agentId: text("agent_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    verifiedAt: text("verified_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.sourceKind, t.sourceId)],
);

/** Merge proposals and resolutions have no lossy typed-edge equivalent. */
export const coreRelationshipsMergeLineage = appLifeopsPgSchema.table(
  "core_relationships_merge_lineage",
  {
    agentId: text("agent_id").notNull(),
    candidateId: text("candidate_id").notNull(),
    entityA: text("entity_a").notNull(),
    entityB: text("entity_b").notNull(),
    status: text("status").notNull(),
    payloadJson: text("payload_json").notNull(),
    sourceHash: text("source_hash").notNull(),
    migratedAt: text("migrated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.candidateId)],
);

/**
 * Aggregate schema registered by the runtime "eliza" plugin so the SQL
 * plugin migrates these tables whenever the runtime runs.
 */
export const knowledgeGraphSchema = {
  lifeEntities,
  lifeEntityIdentities,
  lifeEntityAttributes,
  lifeRelationshipsV2,
  lifeRelationshipAuditEvents,
  coreRelationshipsMigrationState,
  coreRelationshipsSourceRecords,
  coreRelationshipsMigrationRecords,
  coreRelationshipsMergeLineage,
} as const;
