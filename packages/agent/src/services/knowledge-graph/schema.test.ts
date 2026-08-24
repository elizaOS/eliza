/**
 * Unit coverage for the runtime knowledge-graph Drizzle schema.
 *
 * Inspects real table metadata through drizzle-orm's `getTableConfig`: SQL
 * names under the `app_lifeops` schema, nullability, defaults, primary keys,
 * unique constraints, and index column order. Deterministic by construction —
 * no database connection is involved.
 */

import { DEFAULT_CONNECTOR_ACCOUNT_ID } from "@elizaos/shared";
import {
  getTableConfig,
  type PgColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  appLifeopsPgSchema,
  knowledgeGraphSchema,
  lifeEntities,
  lifeEntityAttributes,
  lifeEntityIdentities,
  lifeRelationshipAuditEvents,
  lifeRelationshipsV2,
} from "./schema.ts";

type TableConfig = ReturnType<typeof getTableConfig>;

function configOf(table: PgTable): TableConfig {
  return getTableConfig(table);
}

function requireColumn(config: TableConfig, name: string): PgColumn {
  const found = config.columns.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`column ${name} is not registered on ${config.name}`);
  }
  return found;
}

function columnNames(config: TableConfig): string[] {
  return config.columns.map((column) => column.name);
}

function primaryKeyColumnNames(config: TableConfig): string[] {
  return config.columns
    .filter((column) => column.primary)
    .map((column) => column.name);
}

function uniqueViews(config: TableConfig): Array<{
  name: string | undefined;
  columns: string[];
}> {
  return config.uniqueConstraints.map((constraint) => ({
    name: constraint.name,
    columns: constraint.columns.map((column) => column.name),
  }));
}

function indexViews(config: TableConfig): Array<{
  name: string | undefined;
  unique: boolean;
  columns: string[];
}> {
  return config.indexes.map((entry) => ({
    name: entry.config.name,
    unique: entry.config.unique === true,
    columns: entry.config.columns.map((column) => (column as PgColumn).name),
  }));
}

describe("appLifeopsPgSchema", () => {
  it("registers every table under the app_lifeops Postgres schema", () => {
    expect(appLifeopsPgSchema.schemaName).toBe("app_lifeops");
    for (const table of [
      lifeEntities,
      lifeEntityIdentities,
      lifeEntityAttributes,
      lifeRelationshipsV2,
      lifeRelationshipAuditEvents,
    ]) {
      expect(configOf(table).schema).toBe("app_lifeops");
    }
  });
});

describe("lifeEntities", () => {
  it("maps to life_entities with the declared column set", () => {
    const config = configOf(lifeEntities);
    expect(config.name).toBe("life_entities");
    expect(columnNames(config)).toEqual([
      "entity_id",
      "agent_id",
      "type",
      "preferred_name",
      "full_name",
      "tags_json",
      "visibility",
      "state_last_observed_at",
      "state_last_inbound_at",
      "state_last_outbound_at",
      "state_last_interaction_platform",
      "legacy_relationship_id",
      "created_at",
      "updated_at",
    ]);
  });

  it("keeps identity columns required and observation columns nullable", () => {
    const config = configOf(lifeEntities);
    for (const name of [
      "entity_id",
      "agent_id",
      "type",
      "preferred_name",
      "created_at",
      "updated_at",
    ]) {
      expect(requireColumn(config, name).notNull).toBe(true);
    }
    for (const name of [
      "full_name",
      "state_last_observed_at",
      "state_last_inbound_at",
      "state_last_outbound_at",
      "state_last_interaction_platform",
      "legacy_relationship_id",
    ]) {
      expect(requireColumn(config, name).notNull).toBe(false);
    }
  });

  it("defaults serialized tags and visibility without defaulting timestamps", () => {
    const config = configOf(lifeEntities);
    const tags = requireColumn(config, "tags_json");
    expect(tags.hasDefault).toBe(true);
    expect(tags.default).toBe("[]");
    const visibility = requireColumn(config, "visibility");
    expect(visibility.hasDefault).toBe(true);
    expect(visibility.default).toBe("owner_agent_admin");
    for (const name of ["entity_id", "preferred_name", "created_at"]) {
      expect(requireColumn(config, name).hasDefault).toBe(false);
    }
  });

  it("declares no primary key, one (agent_id, entity_id) uniqueness, and ordered lookup indexes", () => {
    const config = configOf(lifeEntities);
    expect(primaryKeyColumnNames(config)).toEqual([]);
    expect(uniqueViews(config)).toEqual([
      {
        columns: ["agent_id", "entity_id"],
        name: "life_entities_agent_id_entity_id_unique",
      },
    ]);
    expect(indexViews(config)).toEqual([
      {
        name: "life_entities_agent_type_idx",
        unique: false,
        columns: ["agent_id", "type"],
      },
      {
        name: "life_entities_agent_name_idx",
        unique: false,
        columns: ["agent_id", "preferred_name"],
      },
    ]);
  });
});

describe("lifeEntityIdentities", () => {
  it("maps to life_entity_identities keyed by the id text column", () => {
    const config = configOf(lifeEntityIdentities);
    expect(config.name).toBe("life_entity_identities");
    expect(primaryKeyColumnNames(config)).toEqual(["id"]);
    expect(config.primaryKeys).toHaveLength(0);
  });

  it("keeps route columns required and display_name nullable", () => {
    const config = configOf(lifeEntityIdentities);
    for (const name of [
      "id",
      "agent_id",
      "entity_id",
      "platform",
      "handle",
      "connector_account_id",
      "added_at",
      "added_via",
    ]) {
      expect(requireColumn(config, name).notNull).toBe(true);
    }
    expect(requireColumn(config, "display_name").notNull).toBe(false);
  });

  it("defaults connector account to the shared sentinel and falsy sentinels stay explicit", () => {
    const config = configOf(lifeEntityIdentities);
    const connectorAccount = requireColumn(config, "connector_account_id");
    expect(connectorAccount.hasDefault).toBe(true);
    expect(connectorAccount.default).toBe(DEFAULT_CONNECTOR_ACCOUNT_ID);

    const verified = requireColumn(config, "verified");
    expect(verified.hasDefault).toBe(true);
    expect(verified.default).toBe(false);
    expect(verified.notNull).toBe(true);

    const confidence = requireColumn(config, "confidence");
    expect(confidence.hasDefault).toBe(true);
    expect(confidence.default).toBe(0);
    expect(confidence.getSQLType()).toBe("real");

    const evidence = requireColumn(config, "evidence_json");
    expect(evidence.hasDefault).toBe(true);
    expect(evidence.default).toBe("[]");
  });

  it("uniqueness covers the full entity route and the lookup index matches its order", () => {
    const config = configOf(lifeEntityIdentities);
    expect(uniqueViews(config)).toEqual([
      {
        name: "life_entity_identities_entity_route_unique",
        columns: [
          "agent_id",
          "entity_id",
          "platform",
          "connector_account_id",
          "handle",
        ],
      },
    ]);
    expect(indexViews(config)).toEqual([
      {
        name: "life_entity_identities_lookup_idx",
        unique: false,
        columns: ["agent_id", "platform", "connector_account_id", "handle"],
      },
    ]);
  });
});

describe("lifeEntityAttributes", () => {
  it("maps to life_entity_attributes keyed by id with every column required", () => {
    const config = configOf(lifeEntityAttributes);
    expect(config.name).toBe("life_entity_attributes");
    expect(primaryKeyColumnNames(config)).toEqual(["id"]);
    for (const column of config.columns) {
      expect(column.notNull).toBe(true);
    }
  });

  it('serializes an absent value as the JSON string "null", never SQL NULL', () => {
    const config = configOf(lifeEntityAttributes);
    const valueJson = requireColumn(config, "value_json");
    expect(valueJson.hasDefault).toBe(true);
    expect(valueJson.default).toBe("null");
    expect(typeof valueJson.default).toBe("string");

    const confidence = requireColumn(config, "confidence");
    expect(confidence.default).toBe(0);
    const evidence = requireColumn(config, "evidence_json");
    expect(evidence.default).toBe("[]");
  });

  it("uniquely scopes attribute keys per agent entity and indexes lookups", () => {
    const config = configOf(lifeEntityAttributes);
    expect(uniqueViews(config)).toEqual([
      {
        columns: ["agent_id", "entity_id", "key"],
        name: "life_entity_attributes_agent_id_entity_id_key_unique",
      },
    ]);
    expect(indexViews(config)).toEqual([
      {
        name: "life_entity_attributes_lookup_idx",
        unique: false,
        columns: ["agent_id", "entity_id"],
      },
    ]);
  });
});

describe("lifeRelationshipsV2", () => {
  it("maps to life_relationships_v2 keyed by relationship_id", () => {
    const config = configOf(lifeRelationshipsV2);
    expect(config.name).toBe("life_relationships_v2");
    expect(primaryKeyColumnNames(config)).toEqual(["relationship_id"]);
    expect(columnNames(config)).toEqual([
      "relationship_id",
      "agent_id",
      "from_entity_id",
      "to_entity_id",
      "type",
      "metadata_json",
      "cadence_days",
      "state_last_observed_at",
      "state_last_interaction_at",
      "state_interaction_count",
      "state_sentiment_trend",
      "evidence_json",
      "confidence",
      "source",
      "status",
      "retired_at",
      "retired_reason",
      "created_at",
      "updated_at",
    ]);
  });

  it("keeps cadence and retirement state nullable while interaction counters are required", () => {
    const config = configOf(lifeRelationshipsV2);
    for (const name of [
      "cadence_days",
      "state_last_observed_at",
      "state_last_interaction_at",
      "state_sentiment_trend",
      "retired_at",
      "retired_reason",
    ]) {
      expect(requireColumn(config, name).notNull).toBe(false);
    }
    for (const name of [
      "agent_id",
      "from_entity_id",
      "to_entity_id",
      "type",
      "metadata_json",
      "state_interaction_count",
      "evidence_json",
      "confidence",
      "source",
      "status",
      "created_at",
      "updated_at",
    ]) {
      expect(requireColumn(config, name).notNull).toBe(true);
    }
  });

  it("defaults cadence-free edges to active status with zero interactions", () => {
    const config = configOf(lifeRelationshipsV2);
    const metadata = requireColumn(config, "metadata_json");
    expect(metadata.hasDefault).toBe(true);
    expect(metadata.default).toBe("{}");

    const interactionCount = requireColumn(config, "state_interaction_count");
    expect(interactionCount.hasDefault).toBe(true);
    expect(interactionCount.default).toBe(0);
    expect(interactionCount.getSQLType()).toBe("integer");

    const cadenceDays = requireColumn(config, "cadence_days");
    expect(cadenceDays.hasDefault).toBe(false);
    expect(cadenceDays.default).toBeUndefined();

    const status = requireColumn(config, "status");
    expect(status.hasDefault).toBe(true);
    expect(status.default).toBe("active");

    const confidence = requireColumn(config, "confidence");
    expect(confidence.default).toBe(0);
    const evidence = requireColumn(config, "evidence_json");
    expect(evidence.default).toBe("[]");
  });

  it("indexes edge triples for lookup without registering a schema-level unique constraint", () => {
    // The module header describes active-edge uniqueness, but at runtime only
    // this non-unique edge index exists; uniqueness is enforced above the
    // schema layer. This pins that observed contract.
    const config = configOf(lifeRelationshipsV2);
    expect(uniqueViews(config)).toEqual([]);
    expect(indexViews(config)).toEqual([
      {
        name: "life_relationships_v2_edge_idx",
        unique: false,
        columns: ["agent_id", "from_entity_id", "to_entity_id", "type"],
      },
      {
        name: "life_relationships_v2_to_idx",
        unique: false,
        columns: ["agent_id", "to_entity_id"],
      },
      {
        name: "life_relationships_v2_cadence_idx",
        unique: false,
        columns: ["agent_id", "cadence_days", "state_last_interaction_at"],
      },
    ]);
  });
});

describe("lifeRelationshipAuditEvents", () => {
  it("maps to life_relationship_audit_events with all columns required", () => {
    const config = configOf(lifeRelationshipAuditEvents);
    expect(config.name).toBe("life_relationship_audit_events");
    expect(primaryKeyColumnNames(config)).toEqual(["id"]);
    for (const column of config.columns) {
      expect(column.notNull).toBe(true);
    }
    const details = requireColumn(config, "details_json");
    expect(details.hasDefault).toBe(true);
    expect(details.default).toBe("{}");
  });

  it("indexes audit lookups by agent and relationship", () => {
    const config = configOf(lifeRelationshipAuditEvents);
    expect(indexViews(config)).toEqual([
      {
        name: "life_relationship_audit_events_lookup_idx",
        unique: false,
        columns: ["agent_id", "relationship_id"],
      },
    ]);
  });
});

describe("knowledgeGraphSchema", () => {
  it("aggregates exactly the five tables by reference identity", () => {
    expect(Object.keys(knowledgeGraphSchema)).toEqual([
      "lifeEntities",
      "lifeEntityIdentities",
      "lifeEntityAttributes",
      "lifeRelationshipsV2",
      "lifeRelationshipAuditEvents",
    ]);
    expect(knowledgeGraphSchema.lifeEntities).toBe(lifeEntities);
    expect(knowledgeGraphSchema.lifeEntityIdentities).toBe(
      lifeEntityIdentities,
    );
    expect(knowledgeGraphSchema.lifeEntityAttributes).toBe(
      lifeEntityAttributes,
    );
    expect(knowledgeGraphSchema.lifeRelationshipsV2).toBe(lifeRelationshipsV2);
    expect(knowledgeGraphSchema.lifeRelationshipAuditEvents).toBe(
      lifeRelationshipAuditEvents,
    );
  });
});
