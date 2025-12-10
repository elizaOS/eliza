/**
 * ElizaOS Database Schema Re-exports
 *
 * Re-exports database schema tables from @elizaos/plugin-sql for use in cloud platform.
 * This allows cloud consumers to import schema from plugin-elizacloud without directly
 * depending on plugin-sql.
 */

import pluginSql from "@elizaos/plugin-sql/node";

// Re-export the entire plugin for schema access
export { pluginSql };

// Extract and re-export schema tables using correct names from plugin-sql
export const {
  agentTable,
  roomTable,
  participantTable,
  memoryTable,
  embeddingTable,
  entityTable,
  relationshipTable,
  componentTable,
  taskTable,
  logTable,
  cacheTable,
  worldTable,
  serverTable,
  messageTable,
  messageServerTable,
  messageServerAgentsTable,
  channelTable,
  channelParticipantsTable,
} = pluginSql.schema;

// Alias for backwards compatibility
export const serverAgentsTable = serverTable;
