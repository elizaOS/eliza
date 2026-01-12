/**
 * ElizaOS Cloud Database Module
 *
 * Provides managed PostgreSQL database access via ElizaOS Cloud.
 * When using ElizaOS Cloud, users don't need to set up their own database.
 * The cloud provisions and manages the database automatically.
 *
 * For direct database connections (e.g., cloud platform itself), use createDirectDatabaseAdapter.
 */

export { CloudDatabaseAdapter, createCloudDatabaseAdapter } from "./adapter";
export { createDirectDatabaseAdapter, createDatabaseAdapter } from "./direct-adapter";
export type { CloudDatabaseConfig, CloudDatabaseStatus } from "./types";

// Re-export schema tables for direct database access
export {
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
  serverAgentsTable, // Alias for serverTable (backwards compat)
  messageTable,
  messageServerTable,
  messageServerAgentsTable,
  channelTable,
  channelParticipantsTable,
  pluginSql,
} from "./schema";
