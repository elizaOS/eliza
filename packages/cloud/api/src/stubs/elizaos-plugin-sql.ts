/**
 * Workerd-safe stand-in for @elizaos/plugin-sql, wired via the wrangler.toml
 * alias so the Worker bundle never pulls node-only adapter code. The Drizzle
 * tables below are REAL query surfaces: cloud-shared repositories build SQL
 * from them, so table/column names must stay in sync with
 * plugins/plugin-sql/src/schema (the source the cloud migrations were
 * generated from). Drift here 500s the deployed Worker (42703/42P01, #13406);
 * __tests__/plugin-sql-stub-mirror.test.ts enforces the sync mechanically.
 */
import {
  boolean,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey();
const created = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updated = () =>
  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
const meta = () => jsonb("metadata").$type<Record<string, unknown>>();

// Full column mirror of plugins/plugin-sql/src/schema/agent.ts. The Worker's
// agents repository selects `system` and `settings` explicitly, so a partial
// stub here turns those drizzle column refs into `undefined` at bundle time
// and crashes the query builder — the same 500 class as #13406.
const agents = pgTable("agents", {
  id: id(),
  enabled: boolean("enabled").default(true),
  server_id: text("server_id"),
  createdAt: created(),
  updatedAt: updated(),
  name: text("name"),
  username: text("username"),
  system: text("system"),
  bio: jsonb("bio"),
  messageExamples: jsonb("message_examples"),
  postExamples: jsonb("post_examples"),
  topics: jsonb("topics"),
  adjectives: jsonb("adjectives"),
  knowledge: jsonb("knowledge"),
  plugins: jsonb("plugins"),
  settings: jsonb("settings"),
  style: jsonb("style"),
});

// Column names MUST mirror plugins/plugin-sql/src/schema/* (the source the
// cloud migrations were generated from): repositories in cloud-shared build
// real SQL from these tables, so a drifted column here (e.g. the old
// `server_id`, renamed upstream to `message_server_id`) makes every
// `select().from(...)` fail with 42703 in the deployed Worker (#13406).
const rooms = pgTable("rooms", {
  id: id(),
  agentId: text("agent_id"),
  source: text("source"),
  type: text("type"),
  messageServerId: text("message_server_id"),
  worldId: text("world_id"),
  name: text("name"),
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
  roomId: text("room_id"),
  worldId: text("world_id"),
  entityId: text("entity_id"),
  agentId: text("agent_id"),
  // text[] in the real schema (and the deployed DB) — jsonb here would
  // misdecode reads and break writes.
  tags: text("tags").array(),
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
  messageServerId: text("message_server_id"),
  createdAt: created(),
});

const messageServerAgents = pgTable(
  "message_server_agents",
  {
    messageServerId: text("message_server_id").notNull(),
    agentId: text("agent_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.messageServerId, table.agentId] })],
);

// The real table is `central_messages` (plugin-sql message.ts); a stub named
// `messages` points every query at a table that doesn't exist (42P01).
const messages = pgTable("central_messages", {
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
  messageServerId: text("message_server_id"),
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
  entityId: text("entity_id"),
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
  messageServerAgentsTable: messageServerAgents,
  messageTable: messages,
  messageServerTable: messageServers,
  channelTable: channels,
  channelParticipantsTable: channelParticipants,
};

const workerSqlSurface = {
  name: "@elizaos/plugin-sql",
  description:
    "Workers compatibility surface for @elizaos/plugin-sql — schema only; runtime calls are sidecar-only",
  schema,
  init: async () => {
    throw new Error(
      "@elizaos/plugin-sql runtime calls are unavailable in the Cloudflare Workers bundle. Server-side agent runtime calls run on the agent-server sidecar.",
    );
  },
};

export function createDatabaseAdapter(
  _config: { dataDir?: string; postgresUrl?: string },
  _agentId: string,
): never {
  throw new Error(
    "@elizaos/plugin-sql database adapter calls are unavailable in the Cloudflare Workers bundle. Agent DB access runs on the agent-server sidecar, not the Worker.",
  );
}

export default workerSqlSurface;
export type WorkerSqlSurface = typeof workerSqlSurface;

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
  messageServerAgents as messageServerAgentsTable,
  messageServers as messageServerTable,
  messages as messageTable,
  participants as participantTable,
  relationships as relationshipTable,
  rooms as roomTable,
  tasks as taskTable,
  worlds as worldTable,
};
