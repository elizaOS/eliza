/** Dedicated durable fairness authorities for backup operation admission. */

import type { InferSelectModel } from "drizzle-orm";
import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentNodeIncarnationHistories } from "./agent-node-incarnation-histories";
import { organizations } from "./organizations";

/** One tenant lane, isolated from the hot organizations lifecycle/billing row. */
export const agentBackupOrganizationAdmissionCursors = pgTable(
  "agent_backup_organization_admission_cursors",
  {
    organization_id: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cursor_at: timestamp("cursor_at", { withTimezone: true }),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/** One exact append-only source occurrence lane; reusable boot UUIDs are not authorities. */
export const agentBackupNodeAdmissionCursors = pgTable("agent_backup_node_admission_cursors", {
  node_history_id: uuid("node_history_id")
    .primaryKey()
    .references(() => agentNodeIncarnationHistories.id, { onDelete: "restrict" }),
  cursor_at: timestamp("cursor_at", { withTimezone: true }),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AgentBackupOrganizationAdmissionCursor = InferSelectModel<
  typeof agentBackupOrganizationAdmissionCursors
>;
export type AgentBackupNodeAdmissionCursor = InferSelectModel<
  typeof agentBackupNodeAdmissionCursors
>;
