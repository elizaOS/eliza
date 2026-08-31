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
  const value = row?.[key];
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ElizaError("Legacy relationships row count is unreadable", {
      code: "RELATIONSHIPS_LEGACY_SCHEMA_INVENTORY_INVALID",
      context: { key, value },
      severity: "fatal",
    });
  }
  return parsed;
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
  const hasEntities =
    presence[0]?.entities === true || presence[0]?.entities === "true";
  const hasRelationships =
    presence[0]?.relationships === true ||
    presence[0]?.relationships === "true";
  const entityRows = hasEntities
    ? await exec("SELECT count(*) AS count FROM app_relationships.entities")
    : [{ count: 0 }];
  const relationshipRows = hasRelationships
    ? await exec(
        "SELECT count(*) AS count FROM app_relationships.relationships",
      )
    : [{ count: 0 }];
  return {
    entities: count(entityRows[0], "count"),
    relationships: count(relationshipRows[0], "count"),
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
