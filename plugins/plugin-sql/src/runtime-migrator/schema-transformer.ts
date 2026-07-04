/**
 * Derives the per-plugin PostgreSQL schema name a non-core plugin's tables
 * should live in (so plugins don't collide in `public`), and provides
 * `createPluginSchema` for plugins to declare their tables namespaced from
 * the start. `transformPluginSchema` only warns about tables that aren't
 * already namespaced — it can't safely rewrite an existing table's schema
 * without reconstructing all its column/constraint definitions, so plugins
 * are expected to use `createPluginSchema` / `pgSchema` directly instead of
 * being auto-migrated into a namespace.
 */
import { logger } from "@elizaos/core";
import { getTableConfig, type PgTable, pgSchema } from "drizzle-orm/pg-core";

// Drizzle schema type - an object mapping names to tables or other schema objects
type DrizzleSchema = Record<string, unknown>;

// pgSchema object interface
interface PgSchemaObject {
  _schema?: string;
  table?: (...args: unknown[]) => unknown;
}

/**
 * Transform a plugin's schema to use the appropriate namespace
 *
 * @elizaos/plugin-sql uses 'public' schema (no transformation)
 * Other plugins get their tables wrapped in a namespaced schema
 */
export function transformPluginSchema(pluginName: string, schema: DrizzleSchema): DrizzleSchema {
  if (pluginName === "@elizaos/plugin-sql") {
    return schema;
  }

  const schemaName = deriveSchemaName(pluginName);

  if (isAlreadyNamespaced(schema, schemaName)) {
    logger.debug(
      { src: "plugin:sql", pluginName, schemaName },
      "Plugin already uses expected schema"
    );
    return schema;
  }

  logger.info({ src: "plugin:sql", pluginName, schemaName }, "Transforming plugin to use schema");

  const transformed: DrizzleSchema = {};

  for (const [key, value] of Object.entries(schema)) {
    if (isPgTable(value)) {
      const config = getTableConfig(value as PgTable);

      // Can't rewrite an existing table's schema without reconstructing all
      // its column/constraint definitions, so this only warns.
      if (!config.schema || config.schema === "public") {
        logger.warn(
          {
            src: "plugin:sql",
            tableName: config.name,
            pluginName,
            expectedSchema: schemaName,
          },
          "Table should use pgSchema for proper isolation - manual migration may be required"
        );
        transformed[key] = value;
      } else {
        transformed[key] = value;
      }
    } else if (typeof value === "object" && value !== null) {
      const obj = value as PgSchemaObject;
      if (obj._schema && obj.table) {
        transformed[key] = value;
      } else {
        transformed[key] = value;
      }
    } else {
      transformed[key] = value;
    }
  }

  return transformed;
}

/**
 * Derive a valid PostgreSQL schema name from a plugin name
 */
export function deriveSchemaName(pluginName: string): string {
  let schemaName = pluginName
    .replace(/^@[^/]+\//, "") // strip npm scope, e.g. @elizaos/
    .replace(/^plugin-/, "") // strip plugin- prefix
    .toLowerCase();

  schemaName = normalizeSchemaName(schemaName);

  // Reject empty or reserved names, falling back to a safe derived name.
  const reserved = ["public", "pg_catalog", "information_schema", "migrations"];
  if (!schemaName || reserved.includes(schemaName)) {
    schemaName = `plugin_${normalizeSchemaName(pluginName.toLowerCase())}`;
  }

  // PostgreSQL identifiers must start with a letter.
  if (!/^[a-z]/.test(schemaName)) {
    schemaName = `p_${schemaName}`;
  }

  // PostgreSQL identifier length limit is 63 characters.
  if (schemaName.length > 63) {
    schemaName = schemaName.substring(0, 63);
  }

  return schemaName;
}

/**
 * Normalize a string to be a valid PostgreSQL identifier.
 * Uses plain string manipulation (not a single regex) to avoid a
 * catastrophic-backtracking pattern on adversarial input.
 */
function normalizeSchemaName(input: string): string {
  const chars: string[] = [];
  let prevWasUnderscore = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (/[a-z0-9]/.test(char)) {
      chars.push(char);
      prevWasUnderscore = false;
    } else if (!prevWasUnderscore) {
      chars.push("_");
      prevWasUnderscore = true;
    }
  }

  const result = chars.join("");

  let start = 0;
  let end = result.length;

  while (start < end && result[start] === "_") {
    start++;
  }

  while (end > start && result[end - 1] === "_") {
    end--;
  }

  return result.slice(start, end);
}

/**
 * Check if a value is a PgTable
 */
function isPgTable(value: unknown): value is PgTable {
  if (!value || typeof value !== "object") {
    return false;
  }

  // error-policy:J3 type probe — instanceof doesn't work across module
  // boundaries, so probe the table-config shape; getTableConfig throwing on a
  // non-table value is the typed "not a PgTable" answer (false), not a fault.
  try {
    const config = getTableConfig(value as PgTable);
    return config && typeof config.name === "string";
  } catch {
    return false;
  }
}

/**
 * Check if a schema is already properly namespaced
 */
function isAlreadyNamespaced(schema: DrizzleSchema, expectedSchemaName: string): boolean {
  for (const value of Object.values(schema)) {
    if (isPgTable(value)) {
      try {
        const config = getTableConfig(value);
        if (config.schema === expectedSchemaName) {
          return true;
        }
      } catch {
        // Not a table, continue
      }
    }
  }
  return false;
}

/**
 * Create a namespaced schema helper for plugins
 * This is what plugins should ideally use to define their tables
 */
export function createPluginSchema(pluginName: string) {
  const schemaName = deriveSchemaName(pluginName);
  return pgSchema(schemaName);
}
