/**
 * elizaOS schema exports.
 *
 * Re-exports elizaOS plugin-sql schema tables for integration with Drizzle migrations.
 * Provides database access to elizaOS tables.
 */
import plugin from "@elizaos/plugin-sql/node";
import {
  longTermMemories,
  sessionSummaries,
  memoryAccessLogs,
} from "@elizaos/plugin-memory/node";

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
} = plugin.schema;

/**
 * Re-exported elizaOS memory plugin tables.
 */
export { longTermMemories, sessionSummaries, memoryAccessLogs };
