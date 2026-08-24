/**
 * Unit coverage for the runtime pendant-session Drizzle schema.
 *
 * Inspects real table metadata through drizzle-orm's `getTableConfig` and
 * `getTableColumns`: SQL names under the `app_lifeops` schema, application to
 * database column bindings, SQL types, nullability, defaults, composite
 * primary keys, cascade foreign keys, unique constraints, and index column
 * order. Deterministic by construction — no database connection is involved.
 */

import { getTableColumns } from "drizzle-orm";
import {
  getTableConfig,
  type PgColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  pendantSessionInsightRefs,
  pendantSessionPgSchema,
  pendantSessionSchema,
  pendantSessionSegments,
  pendantSessions,
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

function columnsOf(table: PgTable): Record<string, PgColumn> {
  return getTableColumns(table);
}

function columnNames(config: TableConfig): string[] {
  return config.columns.map((column) => column.name);
}

function primaryKeyViews(config: TableConfig): Array<{
  name: string;
  columns: string[];
}> {
  return config.primaryKeys.map((primaryKey) => ({
    name: primaryKey.getName(),
    columns: primaryKey.columns.map((column) => column.name),
  }));
}

function foreignKeyViews(config: TableConfig): Array<{
  name: string;
  columns: string[];
  foreignTableName: string;
  foreignColumns: string[];
  onDelete: string | undefined;
}> {
  return config.foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      name: foreignKey.getName(),
      columns: reference.columns.map((column) => column.name),
      foreignTableName: getTableConfig(reference.foreignTable).name,
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      onDelete: foreignKey.onDelete,
    };
  });
}

function requireConstraintName(name: string | undefined): string {
  if (!name) {
    throw new Error("constraint name is not registered");
  }
  return name;
}

function uniqueViews(config: TableConfig): Array<{
  name: string;
  columns: string[];
}> {
  return config.uniqueConstraints.map((constraint) => ({
    name: requireConstraintName(constraint.name),
    columns: constraint.columns.map((column) => column.name),
  }));
}

function indexViews(config: TableConfig): Array<{
  name: string;
  unique: boolean;
  columns: string[];
}> {
  return config.indexes.map((entry) => ({
    name: requireConstraintName(entry.config.name),
    unique: entry.config.unique === true,
    columns: entry.config.columns.map((column) => (column as PgColumn).name),
  }));
}

describe("pendantSessionPgSchema", () => {
  it("registers every pendant table under the app_lifeops Postgres schema", () => {
    expect(pendantSessionPgSchema.schemaName).toBe("app_lifeops");
    for (const table of [
      pendantSessions,
      pendantSessionSegments,
      pendantSessionInsightRefs,
    ]) {
      expect(configOf(table).schema).toBe("app_lifeops");
    }
  });
});

describe("pendantSessions", () => {
  it("maps to pendant_sessions with the declared application-to-database column bindings", () => {
    const config = configOf(pendantSessions);
    expect(config.name).toBe("pendant_sessions");

    const columns = Object.entries(columnsOf(pendantSessions));
    expect(columns.map(([key]) => key)).toEqual([
      "id",
      "ownerId",
      "agentId",
      "startedAt",
      "endedAt",
      "state",
      "processingLocation",
      "revision",
      "captureLeaseHolder",
      "captureLeaseExpiresAt",
      "captureLeaseTokenDigest",
      "createdAt",
      "updatedAt",
    ]);
    expect(
      Object.fromEntries(columns.map(([key, col]) => [key, col.name])),
    ).toEqual({
      id: "id",
      ownerId: "owner_id",
      agentId: "agent_id",
      startedAt: "started_at",
      endedAt: "ended_at",
      state: "state",
      processingLocation: "processing_location",
      revision: "revision",
      captureLeaseHolder: "capture_lease_holder",
      captureLeaseExpiresAt: "capture_lease_expires_at",
      captureLeaseTokenDigest: "capture_lease_token_digest",
      createdAt: "created_at",
      updatedAt: "updated_at",
    });
    expect(columnNames(config)).toEqual(
      Object.values(columnsOf(pendantSessions)).map((column) => column.name),
    );
  });

  it("declares text and integer types with exactly the lease and end columns nullable", () => {
    const config = configOf(pendantSessions);
    for (const name of [
      "id",
      "owner_id",
      "agent_id",
      "started_at",
      "ended_at",
      "state",
      "processing_location",
      "capture_lease_holder",
      "capture_lease_expires_at",
      "capture_lease_token_digest",
      "created_at",
      "updated_at",
    ]) {
      expect(requireColumn(config, name).getSQLType()).toBe("text");
    }
    expect(requireColumn(config, "revision").getSQLType()).toBe("integer");

    for (const name of [
      "ended_at",
      "capture_lease_holder",
      "capture_lease_expires_at",
      "capture_lease_token_digest",
    ]) {
      expect(requireColumn(config, name).notNull).toBe(false);
    }
    for (const name of [
      "id",
      "owner_id",
      "agent_id",
      "started_at",
      "state",
      "processing_location",
      "revision",
      "created_at",
      "updated_at",
    ]) {
      expect(requireColumn(config, name).notNull).toBe(true);
    }
  });

  it("defaults revision to integer 0 and gives no other column a default", () => {
    const columns = columnsOf(pendantSessions);
    expect(columns.revision?.hasDefault).toBe(true);
    expect(columns.revision?.default).toBe(0);

    const defaulted = Object.entries(columns)
      .filter(([, column]) => column.hasDefault)
      .map(([key]) => key);
    expect(defaulted).toEqual(["revision"]);
  });

  it("scopes rows by the owner_agent_id composite key and indexes recency lookups", () => {
    const config = configOf(pendantSessions);
    expect(primaryKeyViews(config)).toEqual([
      {
        name: "pendant_sessions_owner_agent_id_pk",
        columns: ["owner_id", "agent_id", "id"],
      },
    ]);
    expect(foreignKeyViews(config)).toEqual([]);
    expect(uniqueViews(config)).toEqual([]);
    expect(indexViews(config)).toEqual([
      {
        name: "pendant_sessions_owner_agent_updated_idx",
        unique: false,
        columns: ["owner_id", "agent_id", "updated_at"],
      },
    ]);
  });
});

describe("pendantSessionSegments", () => {
  it("maps to pendant_session_segments with the declared application-to-database column bindings", () => {
    const config = configOf(pendantSessionSegments);
    expect(config.name).toBe("pendant_session_segments");

    const columns = Object.entries(columnsOf(pendantSessionSegments));
    expect(columns.map(([key]) => key)).toEqual([
      "id",
      "sessionId",
      "ownerId",
      "agentId",
      "ordinal",
      "status",
      "text",
      "wordsJson",
      "speakerCluster",
      "speakerAlias",
      "confidence",
      "error",
      "startedAt",
      "endedAt",
      "revision",
      "createdAt",
      "updatedAt",
    ]);
    expect(
      Object.fromEntries(columns.map(([key, col]) => [key, col.name])),
    ).toEqual({
      id: "id",
      sessionId: "session_id",
      ownerId: "owner_id",
      agentId: "agent_id",
      ordinal: "ordinal",
      status: "status",
      text: "text",
      wordsJson: "words_json",
      speakerCluster: "speaker_cluster",
      speakerAlias: "speaker_alias",
      confidence: "confidence",
      error: "error",
      startedAt: "started_at",
      endedAt: "ended_at",
      revision: "revision",
      createdAt: "created_at",
      updatedAt: "updated_at",
    });
  });

  it("declares real confidence and integer ordinal with speaker, error, and end columns nullable", () => {
    const config = configOf(pendantSessionSegments);
    expect(requireColumn(config, "confidence").getSQLType()).toBe("real");
    expect(requireColumn(config, "ordinal").getSQLType()).toBe("integer");
    expect(requireColumn(config, "revision").getSQLType()).toBe("integer");
    for (const name of [
      "id",
      "session_id",
      "owner_id",
      "agent_id",
      "status",
      "text",
      "words_json",
      "speaker_cluster",
      "speaker_alias",
      "error",
      "started_at",
      "ended_at",
      "created_at",
      "updated_at",
    ]) {
      expect(requireColumn(config, name).getSQLType()).toBe("text");
    }

    for (const name of [
      "speaker_cluster",
      "speaker_alias",
      "confidence",
      "error",
      "ended_at",
    ]) {
      expect(requireColumn(config, name).notNull).toBe(false);
    }
    for (const name of [
      "id",
      "session_id",
      "owner_id",
      "agent_id",
      "ordinal",
      "status",
      "text",
      "words_json",
      "started_at",
      "revision",
      "created_at",
      "updated_at",
    ]) {
      expect(requireColumn(config, name).notNull).toBe(true);
    }
  });

  it("defaults words_json to an empty JSON array and revision to 0 with no other defaults", () => {
    const columns = columnsOf(pendantSessionSegments);
    expect(columns.wordsJson?.hasDefault).toBe(true);
    expect(columns.wordsJson?.default).toBe("[]");
    expect(columns.revision?.hasDefault).toBe(true);
    expect(columns.revision?.default).toBe(0);

    const defaulted = Object.entries(columns)
      .filter(([, column]) => column.hasDefault)
      .map(([key]) => key);
    expect(defaulted.sort()).toEqual(["revision", "wordsJson"].sort());
  });

  it("scopes segments under their session with cascade delete and per-session ordinal uniqueness", () => {
    const config = configOf(pendantSessionSegments);
    expect(primaryKeyViews(config)).toEqual([
      {
        name: "pendant_segments_owner_agent_session_id_pk",
        columns: ["owner_id", "agent_id", "session_id", "id"],
      },
    ]);
    expect(foreignKeyViews(config)).toEqual([
      {
        name: "pendant_segments_session_fk",
        columns: ["owner_id", "agent_id", "session_id"],
        foreignTableName: "pendant_sessions",
        foreignColumns: ["owner_id", "agent_id", "id"],
        onDelete: "cascade",
      },
    ]);
    expect(uniqueViews(config)).toEqual([
      {
        name: "pendant_segments_owner_agent_session_ordinal_uniq",
        columns: ["owner_id", "agent_id", "session_id", "ordinal"],
      },
    ]);
    expect(indexViews(config)).toEqual([
      {
        name: "pendant_segments_owner_agent_session_idx",
        unique: false,
        columns: ["owner_id", "agent_id", "session_id"],
      },
    ]);
  });
});

describe("pendantSessionInsightRefs", () => {
  it("maps to pendant_session_insight_refs with fully required columns and declared bindings", () => {
    const config = configOf(pendantSessionInsightRefs);
    expect(config.name).toBe("pendant_session_insight_refs");

    const columns = Object.entries(columnsOf(pendantSessionInsightRefs));
    expect(columns.map(([key]) => key)).toEqual([
      "id",
      "sessionId",
      "ownerId",
      "agentId",
      "segmentIdsJson",
      "revision",
      "createdAt",
      "updatedAt",
    ]);
    expect(
      Object.fromEntries(columns.map(([key, col]) => [key, col.name])),
    ).toEqual({
      id: "id",
      sessionId: "session_id",
      ownerId: "owner_id",
      agentId: "agent_id",
      segmentIdsJson: "segment_ids_json",
      revision: "revision",
      createdAt: "created_at",
      updatedAt: "updated_at",
    });

    for (const column of config.columns) {
      expect(column.notNull).toBe(true);
    }
    expect(requireColumn(config, "segment_ids_json").getSQLType()).toBe("text");
    expect(requireColumn(config, "revision").getSQLType()).toBe("integer");
  });

  it("defaults segment_ids_json to an empty JSON array and revision to 0", () => {
    const columns = columnsOf(pendantSessionInsightRefs);
    expect(columns.segmentIdsJson?.hasDefault).toBe(true);
    expect(columns.segmentIdsJson?.default).toBe("[]");
    expect(columns.revision?.hasDefault).toBe(true);
    expect(columns.revision?.default).toBe(0);

    const defaulted = Object.entries(columns)
      .filter(([, column]) => column.hasDefault)
      .map(([key]) => key);
    expect(defaulted.sort()).toEqual(["revision", "segmentIdsJson"].sort());
  });

  it("cascades insight references away with their session and indexes the lookup path", () => {
    const config = configOf(pendantSessionInsightRefs);
    expect(primaryKeyViews(config)).toEqual([
      {
        name: "pendant_insight_refs_owner_agent_session_id_pk",
        columns: ["owner_id", "agent_id", "session_id", "id"],
      },
    ]);
    expect(foreignKeyViews(config)).toEqual([
      {
        name: "pendant_insight_refs_session_fk",
        columns: ["owner_id", "agent_id", "session_id"],
        foreignTableName: "pendant_sessions",
        foreignColumns: ["owner_id", "agent_id", "id"],
        onDelete: "cascade",
      },
    ]);
    expect(uniqueViews(config)).toEqual([]);
    expect(indexViews(config)).toEqual([
      {
        name: "pendant_insight_refs_owner_agent_session_idx",
        unique: false,
        columns: ["owner_id", "agent_id", "session_id"],
      },
    ]);
  });
});

describe("pendantSessionSchema", () => {
  it("aggregates exactly the three exported tables by identity", () => {
    expect(Object.keys(pendantSessionSchema)).toEqual([
      "pendantSessions",
      "pendantSessionSegments",
      "pendantSessionInsightRefs",
    ]);
    expect(pendantSessionSchema.pendantSessions).toBe(pendantSessions);
    expect(pendantSessionSchema.pendantSessionSegments).toBe(
      pendantSessionSegments,
    );
    expect(pendantSessionSchema.pendantSessionInsightRefs).toBe(
      pendantSessionInsightRefs,
    );
  });
});
