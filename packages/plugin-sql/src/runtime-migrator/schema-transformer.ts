import { pgSchema } from 'drizzle-orm/pg-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { logger } from '@elizaos/core';

/**
 * Transform a plugin's schema to use the appropriate namespace
 *
 * @elizaos/plugin-sql uses 'public' schema (no transformation)
 * Other plugins get their tables wrapped in a namespaced schema
 */
export function transformPluginSchema(pluginName: string, schema: any): any {
  // Core plugin uses public schema - no transformation needed
  if (pluginName === '@elizaos/plugin-sql') {
    return schema;
  }

  // Derive schema name from plugin name
  const schemaName = deriveSchemaName(pluginName);

  // If schema is already using pgSchema, return as-is
  if (isAlreadyNamespaced(schema, schemaName)) {
    logger.debug(`[SchemaTransformer] Plugin '${pluginName}' already uses schema '${schemaName}'`);
    return schema;
  }

  logger.info(
    `[SchemaTransformer] Transforming plugin '${pluginName}' to use schema '${schemaName}'`
  );

  // Transform the schema object
  const transformed: any = {};

  for (const [key, value] of Object.entries(schema)) {
    if (isPgTable(value)) {
      // Get the table configuration
      const config = getTableConfig(value as any);

      // If the table doesn't have a schema or is in public, warn about it
      if (!config.schema || config.schema === 'public') {
        // Note: We can't easily transform existing tables to use a different schema
        // as it would require reconstructing all column definitions, constraints, etc.
        // For now, we'll log a warning and return the original
        logger.warn(
          `[SchemaTransformer] Table '${config.name}' in plugin '${pluginName}' should use pgSchema('${schemaName}').table(...) ` +
            `for proper isolation. Manual migration may be required.`
        );
        transformed[key] = value;
      } else {
        // Table already has a schema, keep it as-is
        transformed[key] = value;
      }
    } else if (typeof value === 'object' && value !== null) {
      // Check if this is a schema object (created with pgSchema)
      // Cast to any to access properties since we're doing runtime checks
      const obj = value as any;
      if (obj._schema && obj.table) {
        // This is already a pgSchema object, keep it
        transformed[key] = value;
      } else {
        // Regular object, keep as-is
        transformed[key] = value;
      }
    } else {
      // Not a table, keep as-is
      transformed[key] = value;
    }
  }

  return transformed;
}

/**
 * Derive a valid PostgreSQL schema name from a plugin name
 */
export function deriveSchemaName(pluginName: string): string {
  // Remove common prefixes and convert to lowercase with underscores
  let schemaName = pluginName
    .replace(/^@[^/]+\//, '') // Remove npm scope like @elizaos/
    .replace(/^plugin-/, '') // Remove plugin- prefix
    .toLowerCase();

  // Replace non-alphanumeric characters with underscores (avoid polynomial regex)
  schemaName = normalizeSchemaName(schemaName);

  // Ensure schema name is valid (not empty, not a reserved word)
  const reserved = ['public', 'pg_catalog', 'information_schema', 'migrations'];
  if (!schemaName || reserved.includes(schemaName)) {
    // Fallback to using the full plugin name with safe characters
    schemaName = 'plugin_' + normalizeSchemaName(pluginName.toLowerCase());
  }

  // Ensure it starts with a letter (PostgreSQL requirement)
  if (!/^[a-z]/.test(schemaName)) {
    schemaName = 'p_' + schemaName;
  }

  // Truncate if too long (PostgreSQL identifier limit is 63 chars)
  if (schemaName.length > 63) {
    schemaName = schemaName.substring(0, 63);
  }

  return schemaName;
}

/**
 * Normalize a string to be a valid PostgreSQL identifier
 * Avoids polynomial regex by using string manipulation instead
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
      // Only add underscore if previous char wasn't already an underscore
      chars.push('_');
      prevWasUnderscore = true;
    }
    // Skip consecutive non-alphanumeric characters
  }

  // Remove leading and trailing underscores
  const result = chars.join('');

  // Trim underscores from start and end efficiently
  let start = 0;
  let end = result.length;

  while (start < end && result[start] === '_') {
    start++;
  }

  while (end > start && result[end - 1] === '_') {
    end--;
  }

  return result.slice(start, end);
}

/**
 * Check if a value is a PgTable
 */
function isPgTable(value: any): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  // Check for table-like properties
  // This is a heuristic since we can't use instanceof across module boundaries
  try {
    const config = getTableConfig(value);
    return config && typeof config.name === 'string';
  } catch {
    return false;
  }
}

/**
 * Check if a schema is already properly namespaced
 */
function isAlreadyNamespaced(schema: any, expectedSchemaName: string): boolean {
  for (const value of Object.values(schema)) {
    if (isPgTable(value)) {
      try {
        const config = getTableConfig(value as any);
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
