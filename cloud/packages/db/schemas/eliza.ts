/**
 * elizaOS schema exports.
 *
 * Re-exports elizaOS plugin-sql schema tables for integration with Drizzle migrations.
 * Provides database access to elizaOS tables.
 */

import plugin from "@elizaos/plugin-sql";

/**
 * Re-exported elizaOS plugin-sql tables.
 */
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
  serverAgentsTable,
  messageTable,
  messageServerTable,
  channelTable,
  channelParticipantsTable,
} = (plugin as unknown as { schema: Record<string, any> }).schema as Record<string, any>;
