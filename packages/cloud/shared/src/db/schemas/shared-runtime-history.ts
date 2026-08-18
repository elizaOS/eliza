// Defines the shared runtime history Drizzle table shape used by cloud repositories and services.
import type { ChannelType } from "@elizaos/core/edge";
import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** One persisted turn in a shared-runtime conversation. Mirrors `SharedTurnMessage`. */
export type SharedRuntimeHistoryMessage = {
  /** Stable message id used to merge DO and Postgres writes without clobbering. */
  id?: string;
  role: "system" | "user" | "assistant";
  content: string;
  /** Original transport provenance; absent only on legacy rows. */
  source?: string;
  channelType?: ChannelType;
  /** Epoch-ms timestamp; used to order turns merged from concurrent writers. */
  createdAt?: number;
  /** True when an assistant message is a partial interrupted response. */
  interrupted?: boolean;
};

/**
 * Durable conversation history for Tier-0 "shared" agents (which run in-Worker
 * with no container, so they have no per-agent database of their own).
 *
 * Previously this history lived ONLY in the request cache, which is disabled on
 * the prod Worker (`CACHE_ENABLED=false`, no KV backend) — so `cache.set` was a
 * silent no-op, history never persisted, and the agent had no cross-turn memory
 * (and `GET .../messages` always returned `[]`). This table makes it durable in
 * the same Postgres the Worker already uses, independent of any cache config.
 *
 * One row per `(agent_id, channel_id)` holds the capped, ordered message list,
 * merged by stable message id each turn. Kept deliberately isolated from the encrypted/billed
 * `conversations`/`conversation_messages` tables (the chat-completions product)
 * so the lightweight shared tier stays decoupled, as designed.
 */
export const sharedRuntimeHistory = pgTable(
  "shared_runtime_history",
  {
    agent_id: text("agent_id").notNull(),
    channel_id: text("channel_id").notNull(),
    messages: jsonb("messages").$type<SharedRuntimeHistoryMessage[]>().notNull(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agent_id, table.channel_id] }),
  }),
);

export type SharedRuntimeHistoryRow = typeof sharedRuntimeHistory.$inferSelect;
export type NewSharedRuntimeHistoryRow = typeof sharedRuntimeHistory.$inferInsert;
