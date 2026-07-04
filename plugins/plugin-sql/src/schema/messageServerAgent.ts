/** Join table linking agents to the message servers they participate in; composite PK prevents duplicate membership and cascade-deletes with either side. */
import { pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";
import { messageServerTable } from "./messageServer";

export const messageServerAgentsTable = pgTable(
  "message_server_agents",
  {
    messageServerId: uuid("message_server_id")
      .notNull()
      .references(() => messageServerTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.messageServerId, table.agentId] })]
);
