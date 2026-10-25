/**
 * Join table linking entities (agents or central users) to the channels they
 * participate in. Composite primary key `(channelId, entityId)` prevents
 * duplicate membership rows; cascade-deletes when the channel is removed.
 */
import { pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { channelTable } from "./channel";

export const channelParticipantsTable = pgTable(
  "channel_participants",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channelTable.id, { onDelete: "cascade" }),
    entityId: text("entity_id").notNull(), // Entity UUID (can be an agentId or a dedicated central user ID)
  },
  (table) => [primaryKey({ columns: [table.channelId, table.entityId] })]
);
