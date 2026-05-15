import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey();
const created = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updated = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
const meta = () => jsonb("metadata").$type<Record<string, unknown>>();

const agents = pgTable("agents", {
  id: id(),
  name: text("name"),
  username: text("username"),
  enabled: boolean("enabled").default(true),
  bio: jsonb("bio"),
  createdAt: created(),
  updatedAt: updated(),
});

const rooms = pgTable("rooms", {
  id: id(),
  agentId: text("agent_id"),
  source: text("source"),
  type: text("type"),
  serverId: text("server_id"),
  worldId: text("world_id"),
  channelId: text("channel_id"),
  metadata: meta(),
  createdAt: created(),
});

const participants = pgTable("participants", {
  id: id(),
  entityId: text("entity_id"),
  roomId: text("room_id"),
  agentId: text("agent_id"),
  roomState: text("room_state"),
  createdAt: created(),
});

const memories = pgTable("memories", {
  id: id(),
  type: text("type"),
  content: jsonb("content"),
  entityId: text("entity_id"),
  agentId: text("agent_id"),
  roomId: text("room_id"),
  worldId: text("world_id"),
  unique: boolean("unique").default(true),
  metadata: meta(),
  createdAt: created(),
});

const embeddings = pgTable("embeddings", {
  id: id(),
  memoryId: text("memory_id"),
  createdAt: created(),
});

const entities = pgTable("entities", {
  id: id(),
  agentId: text("agent_id"),
  names: jsonb("names").$type<string[]>(),
  metadata: meta(),
  createdAt: created(),
});

const relationships = pgTable("relationships", {
  id: id(),
  sourceEntityId: text("source_entity_id"),
  targetEntityId: text("target_entity_id"),
  agentId: text("agent_id"),
  tags: jsonb("tags").$type<string[]>(),
  metadata: meta(),
  createdAt: created(),
});

const components = pgTable("components", {
  id: id(),
  entityId: text("entity_id"),
  agentId: text("agent_id"),
  roomId: text("room_id"),
  worldId: text("world_id"),
  sourceEntityId: text("source_entity_id"),
  type: text("type"),
  data: jsonb("data"),
  createdAt: created(),
});

const tasks = pgTable("tasks", {
  id: id(),
  name: text("name"),
  description: text("description"),
  agentId: text("agent_id"),
  roomId: text("room_id"),
  worldId: text("world_id"),
  tags: jsonb("tags").$type<string[]>(),
  metadata: meta(),
  createdAt: created(),
  updatedAt: updated(),
});

const logs = pgTable("logs", {
  id: id(),
  entityId: text("entity_id"),
  body: jsonb("body"),
  type: text("type"),
  roomId: text("room_id"),
  createdAt: created(),
});

const cache = pgTable("cache", {
  key: text("key").primaryKey(),
  agentId: text("agent_id"),
  value: jsonb("value"),
  createdAt: created(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

const worlds = pgTable("worlds", {
  id: id(),
  agentId: text("agent_id"),
  name: text("name"),
  metadata: meta(),
  serverId: text("server_id"),
  createdAt: created(),
});

const serverAgents = pgTable("server_agents", {
  serverId: text("server_id"),
  agentId: text("agent_id"),
});

const messages = pgTable("messages", {
  id: id(),
  channelId: text("channel_id"),
  authorId: text("author_id"),
  content: text("content"),
  rawMessage: jsonb("raw_message"),
  inReplyToRootMessageId: text("in_reply_to_root_message_id"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  metadata: meta(),
  createdAt: created(),
  updatedAt: updated(),
});

const messageServers = pgTable("message_servers", {
  id: id(),
  name: text("name"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  metadata: meta(),
  createdAt: created(),
  updatedAt: updated(),
});

const channels = pgTable("channels", {
  id: id(),
  serverId: text("server_id"),
  name: text("name"),
  type: text("type"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  topic: text("topic"),
  metadata: meta(),
  createdAt: created(),
  updatedAt: updated(),
});

const channelParticipants = pgTable("channel_participants", {
  channelId: text("channel_id"),
  userId: text("user_id"),
});

export const schema = {
  agentTable: agents,
  roomTable: rooms,
  participantTable: participants,
  memoryTable: memories,
  embeddingTable: embeddings,
  entityTable: entities,
  relationshipTable: relationships,
  componentTable: components,
  taskTable: tasks,
  logTable: logs,
  cacheTable: cache,
  worldTable: worlds,
  serverAgentsTable: serverAgents,
  messageTable: messages,
  messageServerTable: messageServers,
  channelTable: channels,
  channelParticipantsTable: channelParticipants,
};

const stub = {
  name: "@elizaos/plugin-sql",
  description:
    "Workers stub for @elizaos/plugin-sql — schema only; runtime methods are unimplemented",
  schema,
  init: async () => {
    throw new Error(
      "@elizaos/plugin-sql is stubbed in the Cloudflare Workers bundle. Server-side agent runtime calls cannot run on the Worker; use the agent-server sidecar.",
    );
  },
};

export function createDatabaseAdapter(
  _config: { dataDir?: string; postgresUrl?: string },
  _agentId: string,
): never {
  throw new Error(
    "@elizaos/plugin-sql is stubbed in the Cloudflare Workers bundle. Agent DB access runs on the agent-server sidecar, not the Worker.",
  );
}

export default stub;
export type Stub = typeof stub;

export {
  agents as agentTable,
  cache as cacheTable,
  channelParticipants as channelParticipantsTable,
  channels as channelTable,
  components as componentTable,
  embeddings as embeddingTable,
  entities as entityTable,
  logs as logTable,
  memories as memoryTable,
  messageServers as messageServerTable,
  messages as messageTable,
  participants as participantTable,
  relationships as relationshipTable,
  rooms as roomTable,
  serverAgents as serverAgentsTable,
  tasks as taskTable,
  worlds as worldTable,
};
