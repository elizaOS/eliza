/**
 * Durable alert state for fleet-wide managed-backup failures.
 *
 * Global conditions such as a disabled worker lane or capacity backlog are
 * independent of any one agent. Keeping their fingerprint here prevents a
 * fleet-sized incident from being represented as thousands of owner rows.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const agentBackupFleetHealthState = pgTable("agent_backup_fleet_health_state", {
  scope: varchar("scope", { length: 64 }).primaryKey(),
  alert_fingerprint: text("alert_fingerprint"),
  last_alerted_at: timestamp("last_alerted_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AgentBackupFleetHealthState = InferSelectModel<typeof agentBackupFleetHealthState>;
export type NewAgentBackupFleetHealthState = InferInsertModel<typeof agentBackupFleetHealthState>;
