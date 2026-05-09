/**
 * elizaOS schema exports.
 *
 * Re-exports elizaOS plugin-sql schema tables for integration with Drizzle migrations.
 * Provides database access to elizaOS tables.
 */

import * as elizaSchema from "@elizaos/plugin-sql";

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
  messageServerAgentsTable,
  messageTable,
  messageServerTable,
  channelTable,
  channelParticipantsTable,
} = elizaSchema;

export const serverAgentsTable = messageServerAgentsTable;
