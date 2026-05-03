import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";

/**
 * Represents the allowlist of approved senders for each channel.
 * Senders in this list are permitted to send DMs to the bot.
 */
export const pairingAllowlistTable = pgTable(
  "pairing_allowlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The messaging channel (telegram, discord, whatsapp, etc.) */
    channel: text("channel").notNull(),
    /** Approved sender identifier */
    senderId: text("sender_id").notNull(),
    /** When the entry was added */
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    /** Optional metadata about the approved sender */
    metadata: jsonb("metadata").default(sql`'{}'::jsonb`),
    /** Agent ID this allowlist belongs to */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    // Index for looking up allowlist by channel and agent
    index("pairing_allowlist_channel_agent_idx").on(table.channel, table.agentId),
    // Unique constraint to prevent duplicate entries
    uniqueIndex("pairing_allowlist_sender_channel_agent_idx").on(
      table.senderId,
      table.channel,
      table.agentId
    ),
  ]
);
