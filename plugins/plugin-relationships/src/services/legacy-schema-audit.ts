/**
 * Startup guard for the retired `app_relationships` persistence fork.
 *
 * The relationships action and provider use the runtime-owned knowledge graph
 * in `app_lifeops`; this guard prevents a populated legacy schema from being
 * silently ignored now that the plugin no longer registers or creates it.
 */
import { ElizaError, type IAgentRuntime, logger, Service } from "@elizaos/core";

export const RELATIONSHIPS_LEGACY_SCHEMA_AUDIT_SERVICE_TYPE =
  "relationships_legacy_schema_audit";

export type SqlExecutor = (
  statement: string,
) => Promise<Array<Record<string, unknown>>>;

export interface LegacyRelationshipsInventory {
  entities: number;
  relationships: number;
}

function count(row: Record<string, unknown> | undefined, key: string): number {
  if (!row || !(key in row)) {
    throw invalidInventory("Legacy relationships row count is missing", {
      key,
      row,
    });
  }
  const value = row[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalidInventory("Legacy relationships row count is unreadable", {
      key,
      value,
    });
  }
  return parsed;
}

function invalidInventory(
  message: string,
  context: Record<string, unknown>,
): ElizaError {
  return new ElizaError(message, {
    code: "RELATIONSHIPS_LEGACY_SCHEMA_INVENTORY_INVALID",
    context,
    severity: "fatal",
  });
}

function requireSingleRow(
  rows: Array<Record<string, unknown>>,
  query: "presence" | "entities-count" | "relationships-count",
): Record<string, unknown> {
  if (rows.length !== 1) {
    throw invalidInventory(
      "Legacy relationships inventory returned an unexpected row count",
      {
        query,
        rowCount: rows.length,
      },
    );
  }
  return rows[0];
}

function databaseBoolean(
  row: Record<string, unknown>,
  key: "entities" | "relationships",
): boolean {
  if (!(key in row)) {
    throw invalidInventory("Legacy relationships table presence is missing", {
      key,
      row,
    });
  }
  const value = row[key];
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw invalidInventory("Legacy relationships table presence is unreadable", {
    key,
    value,
  });
}

/** Inventory the competing schema without creating, changing, or deleting it. */
export async function inventoryLegacyRelationshipsSchema(
  exec: SqlExecutor,
): Promise<LegacyRelationshipsInventory> {
  const presence = await exec(`
    SELECT
      to_regclass('app_relationships.entities') IS NOT NULL AS entities,
      to_regclass('app_relationships.relationships') IS NOT NULL AS relationships
  `);
  const presenceRow = requireSingleRow(presence, "presence");
  const hasEntities = databaseBoolean(presenceRow, "entities");
  const hasRelationships = databaseBoolean(presenceRow, "relationships");
  const entityRows = hasEntities
    ? await exec("SELECT count(*) AS count FROM app_relationships.entities")
    : [{ count: 0 }];
  const relationshipRows = hasRelationships
    ? await exec(
        "SELECT count(*) AS count FROM app_relationships.relationships",
      )
    : [{ count: 0 }];
  return {
    entities: count(requireSingleRow(entityRows, "entities-count"), "count"),
    relationships: count(
      requireSingleRow(relationshipRows, "relationships-count"),
      "count",
    ),
  };
}

function extractRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return result.filter(
      (row): row is Record<string, unknown> =>
        typeof row === "object" && row !== null && !Array.isArray(row),
    );
  }
  if (result && typeof result === "object" && "rows" in result) {
    return extractRows((result as { rows: unknown }).rows);
  }
  return [];
}

export class LegacyRelationshipsSchemaAuditService extends Service {
  static override readonly serviceType =
    RELATIONSHIPS_LEGACY_SCHEMA_AUDIT_SERVICE_TYPE;

  override capabilityDescription =
    "Fails closed when the retired app_relationships graph contains rows that require an operator-approved tenant mapping.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<LegacyRelationshipsSchemaAuditService> {
    const service = new LegacyRelationshipsSchemaAuditService(runtime);
    const db = runtime.db as
      | { execute?: (query: unknown) => Promise<unknown> }
      | undefined;
    if (!db?.execute) {
      throw new ElizaError(
        "Relationships legacy-schema audit requires the SQL runtime database",
        {
          code: "RELATIONSHIPS_LEGACY_SCHEMA_AUDIT_DB_UNAVAILABLE",
          severity: "fatal",
        },
      );
    }
    const { sql } = await import("drizzle-orm");
    const inventory = await inventoryLegacyRelationshipsSchema(
      async (statement) => extractRows(await db.execute?.(sql.raw(statement))),
    );
    if (inventory.entities > 0 || inventory.relationships > 0) {
      throw new ElizaError(
        "The retired app_relationships graph contains data and cannot be assigned to an agent automatically; inventory and import it into the runtime knowledge graph before enabling this plugin",
        {
          code: "RELATIONSHIPS_LEGACY_SCHEMA_DATA_REQUIRES_IMPORT",
          context: { ...inventory },
          severity: "fatal",
        },
      );
    }
    logger.debug(
      { inventory },
      "[Relationships] retired app_relationships schema is absent or empty",
    );
    return service;
  }

  override async stop(): Promise<void> {}
}
