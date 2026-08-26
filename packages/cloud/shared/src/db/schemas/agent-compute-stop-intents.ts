/** Retains operator-visible recovery authority for billing-driven agent stops. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { organizations } from "./organizations";

export type AgentComputeStopIntentStatus =
  | "pending"
  | "dispatching"
  | "retry"
  | "terminal_attention"
  | "provider_confirmed"
  | "superseded";

export type AgentComputeStopIntentAuthorization = "billing_request" | "user_request";

export const agentComputeStopIntents = pgTable(
  "agent_compute_stop_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agent_id: uuid("agent_id").notNull(),
    lifecycle_revision: bigint("lifecycle_revision", { mode: "number" }).notNull(),
    authorization: text("authorization")
      .$type<AgentComputeStopIntentAuthorization>()
      .notNull()
      .default("billing_request"),
    status: text("status").$type<AgentComputeStopIntentStatus>().notNull().default("pending"),
    job_id: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    attempts: integer("attempts").notNull().default(0),
    last_error: text("last_error"),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    provider_started_at: timestamp("provider_started_at", { withTimezone: true }),
    provider_confirmed_at: timestamp("provider_confirmed_at", { withTimezone: true }),
    retained_backup_billing: boolean("retained_backup_billing").notNull().default(false),
    retained_backup_rate_per_hour: numeric("retained_backup_rate_per_hour", {
      precision: 18,
      scale: 6,
    }),
    superseded_at: timestamp("superseded_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    active_unique: uniqueIndex("agent_compute_stop_intents_active_unique")
      .on(table.organization_id, table.agent_id)
      .where(sql`${table.status} IN ('pending', 'dispatching', 'retry', 'terminal_attention')`),
    user_request_unique: uniqueIndex("agent_compute_stop_intents_user_request_unique")
      .on(table.organization_id, table.agent_id, table.lifecycle_revision)
      .where(sql`${table.authorization} = 'user_request'`),
    recovery_idx: index("agent_compute_stop_intents_recovery_idx")
      .on(table.status, table.next_attempt_at)
      .where(sql`${table.status} IN ('pending', 'retry', 'terminal_attention')`),
    status_check: check(
      "agent_compute_stop_intents_status_check",
      sql`${table.status} IN ('pending', 'dispatching', 'retry', 'terminal_attention', 'provider_confirmed', 'superseded')`,
    ),
    authorization_check: check(
      "agent_compute_stop_intents_authorization_check",
      sql`${table.authorization} IN ('billing_request', 'user_request')`,
    ),
    retained_backup_billing_check: check(
      "agent_compute_stop_intents_retained_backup_billing_check",
      sql`(${table.retained_backup_billing} = true AND ${table.retained_backup_rate_per_hour} > 0)
        OR (${table.retained_backup_billing} = false AND ${table.retained_backup_rate_per_hour} IS NULL)`,
    ),
    attempts_check: check("agent_compute_stop_intents_attempts_check", sql`${table.attempts} >= 0`),
  }),
);

export type AgentComputeStopIntent = InferSelectModel<typeof agentComputeStopIntents>;
export type NewAgentComputeStopIntent = InferInsertModel<typeof agentComputeStopIntents>;
