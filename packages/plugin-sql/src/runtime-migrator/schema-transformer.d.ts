/**
 * Transform a plugin's schema to use the appropriate namespace
 *
 * @elizaos/plugin-sql uses 'public' schema (no transformation)
 * Other plugins get their tables wrapped in a namespaced schema
 */
export declare function transformPluginSchema(
  pluginName: string,
  schema: any,
): any;
/**
 * Derive a valid PostgreSQL schema name from a plugin name
 */
export declare function deriveSchemaName(pluginName: string): string;
/**
 * Create a namespaced schema helper for plugins
 * This is what plugins should ideally use to define their tables
 */
export declare function createPluginSchema(
  pluginName: string,
): import("drizzle-orm/pg-core").PgSchema<string>;
//# sourceMappingURL=schema-transformer.d.ts.map
