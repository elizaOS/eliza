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
