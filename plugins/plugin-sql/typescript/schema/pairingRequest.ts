import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";

/**
 * Represents pending pairing requests from users trying to access the bot via DM.
 * Requests are stored temporarily until approved or expired.
 */
export const pairingRequestTable = pgTable(
  "pairing_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The messaging channel (telegram, discord, whatsapp, etc.) */
    channel: text("channel").notNull(),
    /** User identifier on the channel (userId, phoneNumber, etc.) */
    senderId: text("sender_id").notNull(),
    /** Human-friendly pairing code */
    code: text("code").notNull(),
    /** When the request was created */
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    /** When the request was last seen/updated */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).default(sql`now()`).notNull(),
    /** Optional metadata about the requester */
    metadata: jsonb("metadata").default(sql`'{}'::jsonb`),
    /** Agent ID that received this request */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    // Index for looking up requests by channel and agent
    index("pairing_requests_channel_agent_idx").on(table.channel, table.agentId),
    // Unique constraint on code per channel/agent to prevent duplicates
    uniqueIndex("pairing_requests_code_channel_agent_idx").on(
      table.code,
      table.channel,
      table.agentId
    ),
    // Unique constraint on sender per channel/agent (one request per user)
    uniqueIndex("pairing_requests_sender_channel_agent_idx").on(
      table.senderId,
      table.channel,
      table.agentId
    ),
  ]
);
