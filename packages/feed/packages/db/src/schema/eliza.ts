/**
 * ElizaOS schema re-exports.
 *
 * Re-exports @elizaos/plugin-sql schema tables so Drizzle Kit can manage
 * their DDL through `bun run db:generate && bun run db:migrate` instead of
 * the framework's runtime migrator (which adds ~2 min cold-start per agent
 * and is not designed for serverless deployments).
 *
 * Pattern borrowed from eliza-cloud-v2/db/schemas/eliza.ts.
 */
// @ts-expect-error — @elizaos/plugin-sql types may not resolve depending on package version
import plugin from "@elizaos/plugin-sql";

const pluginSchema = (plugin as { schema: Record<string, object> }).schema;

export const elizaAgentTable = pluginSchema.agentTable;
export const elizaRoomTable = pluginSchema.roomTable;
export const elizaParticipantTable = pluginSchema.participantTable;
export const elizaMemoryTable = pluginSchema.memoryTable;
// NOTE: embeddingTable omitted — it uses pgvector `vector` columns which
// require `CREATE EXTENSION vector` and break `db:push` / `db:generate` on
// databases without the extension. ElizaOS runtime creates it when needed.
export const elizaEntityTable = pluginSchema.entityTable;
export const elizaRelationshipTable = pluginSchema.relationshipTable;
export const elizaComponentTable = pluginSchema.componentTable;
export const elizaTaskTable = pluginSchema.taskTable;
export const elizaLogTable = pluginSchema.logTable;
export const elizaCacheTable = pluginSchema.cacheTable;
export const elizaWorldTable = pluginSchema.worldTable;
export const elizaMessageTable = pluginSchema.messageTable;
export const elizaMessageServerTable = pluginSchema.messageServerTable;
export const elizaChannelTable = pluginSchema.channelTable;
export const elizaChannelParticipantsTable =
  pluginSchema.channelParticipantsTable;
export const elizaMessageServerAgentsTable =
  pluginSchema.messageServerAgentsTable;
