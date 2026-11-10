/**
 * The database schema of the agent's own `eliza` plugin, apart from the plugin
 * so the mobile build can migrate it into the pre-migrated PGlite snapshot
 * (scripts/make-pglite-migrated-snapshot.ts) without loading the plugin.
 */
import { knowledgeGraphSchema } from "@elizaos/plugin-relationships";
import { retainedPendantSchema } from "./retained-pendant-schema.ts";

export const ELIZA_PLUGIN_NAME = "eliza";

// Retired feature data remains part of the schema until an explicit retention migration.
export const elizaPluginSchema = {
  ...retainedPendantSchema,
  ...knowledgeGraphSchema,
};
