import { logger } from "@elizaos/core";
import { getTableConfig, type MySqlTable } from "drizzle-orm/mysql-core";

type DrizzleSchema = Record<string, unknown>;

/**
 * Transform a plugin's schema to use the appropriate namespace.
 * MySQL doesn't have schemas like PostgreSQL.
 * Instead, plugins use table name prefixing for isolation.
 *
 * @elizaos/plugin-mysql uses no prefix (core tables)
 * Other plugins get their tables kept as-is (MySQL uses databases for isolation)
 */
export function transformPluginSchema(pluginName: string, schema: DrizzleSchema): DrizzleSchema {
  // Core plugin uses default tables - no transformation needed
  if (pluginName === "@elizaos/plugin-mysql") {
    return schema;
  }

  // For other plugins, keep tables as-is since MySQL doesn't have
  // PostgreSQL-style schemas. Isolation is at the database level.
  logger.debug(
    { src: "plugin:mysql", pluginName },
    "Plugin schema kept as-is (MySQL uses database-level isolation)"
  );

  return schema;
}

/**
 * Derive a valid MySQL identifier from a plugin name.
 * MySQL identifiers are limited to 64 characters.
 */
export function deriveSchemaName(pluginName: string): string {
  let schemaName = pluginName
    .replace(/^@[^/]+\//, "") // Remove npm scope like @elizaos/
    .replace(/^plugin-/, "") // Remove plugin- prefix
    .toLowerCase();

  schemaName = normalizeSchemaName(schemaName);

  const reserved = ["mysql", "information_schema", "performance_schema", "sys", "migrations"];
  if (!schemaName || reserved.includes(schemaName)) {
    schemaName = `plugin_${normalizeSchemaName(pluginName.toLowerCase())}`;
  }

  // Ensure it starts with a letter (MySQL requirement for unquoted identifiers)
  if (!/^[a-z]/.test(schemaName)) {
    schemaName = `p_${schemaName}`;
  }

  // MySQL identifier limit is 64 characters
  if (schemaName.length > 64) {
    schemaName = schemaName.substring(0, 64);
  }

  return schemaName;
}

/**
 * Normalize a string to be a valid MySQL identifier.
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
 * Check if a value is a MySqlTable
 */
function isMysqlTable(value: unknown): value is MySqlTable {
  if (!value || typeof value !== "object") {
    return false;
  }

  try {
    const config = getTableConfig(value as MySqlTable);
    return config && typeof config.name === "string";
  } catch {
    return false;
  }
}

/**
 * Create a prefixed table name for plugin isolation.
 * In MySQL, this is the recommended approach instead of PostgreSQL schemas.
 */
export function createPluginTablePrefix(pluginName: string): string {
  return `${deriveSchemaName(pluginName)}_`;
}
