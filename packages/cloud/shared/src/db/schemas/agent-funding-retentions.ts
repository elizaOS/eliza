/**
 * Retention clock for agents whose funding stopped (#22967, migration 0501).
 *
 * One open row per stopped agent. `delete_after` is 30 days after the stop;
 * notices are recorded when sent; at the deadline the container is removed by
 * the sleep lifecycle and the latest backup is pinned until
 * `backup_retain_until` (90 more days). Funding restored before the deadline
 * closes the row, and the existing resume paths restart the same agent.
 */

import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const AGENT_FUNDING_RETENTION_REASONS = [
  "credits_exhausted",
  "subscription_lapsed",
] as const;
export type AgentFundingRetentionReason = (typeof AGENT_FUNDING_RETENTION_REASONS)[number];

export const AGENT_FUNDING_RETENTION_STATES = [
  "retained",
  "container_deletion_pending",
  "container_deleted",
  "closed",
] as const;
export type AgentFundingRetentionState = (typeof AGENT_FUNDING_RETENTION_STATES)[number];

export type AgentFundingRetentionClosedReason = "funding_restored" | "agent_changed";

export const agentFundingRetentions = pgTable(
  "agent_funding_retentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agent_id: uuid("agent_id").notNull(),
    user_id: uuid("user_id").notNull(),
    reason: text("reason").$type<AgentFundingRetentionReason>().notNull(),
    /** Provider-confirmed billing stop that started the clock (credits). */
    stop_intent_id: uuid("stop_intent_id"),
    /** Plan-withdrawal fallback interval that started the clock (subscription). */
    fallback_id: uuid("fallback_id"),
    state: text("state").$type<AgentFundingRetentionState>().notNull().default("retained"),
    suspended_at: timestamp("suspended_at", { withTimezone: true }).notNull(),
    delete_after: timestamp("delete_after", { withTimezone: true }).notNull(),
    notice_7d_sent_at: timestamp("notice_7d_sent_at", { withTimezone: true }),
    notice_1d_sent_at: timestamp("notice_1d_sent_at", { withTimezone: true }),
    sleep_job_id: uuid("sleep_job_id"),
    container_deleted_at: timestamp("container_deleted_at", { withTimezone: true }),
    retained_backup_id: uuid("retained_backup_id"),
    backup_retain_until: timestamp("backup_retain_until", { withTimezone: true }),
    closed_at: timestamp("closed_at", { withTimezone: true }),
    closed_reason: text("closed_reason").$type<AgentFundingRetentionClosedReason>(),
    last_error: text("last_error"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    open_agent_unique: uniqueIndex("agent_funding_retentions_open_agent_unique")
      .on(table.organization_id, table.agent_id)
      .where(sql`${table.state} IN ('retained', 'container_deletion_pending')`),
    stop_intent_unique: uniqueIndex("agent_funding_retentions_stop_intent_unique")
      .on(table.stop_intent_id)
      .where(sql`${table.stop_intent_id} IS NOT NULL`),
    fallback_unique: uniqueIndex("agent_funding_retentions_fallback_unique")
      .on(table.fallback_id)
      .where(sql`${table.fallback_id} IS NOT NULL`),
    due_idx: index("agent_funding_retentions_due_idx")
      .on(table.state, table.delete_after)
      .where(sql`${table.state} IN ('retained', 'container_deletion_pending')`),
    reason_check: check(
      "agent_funding_retentions_reason_check",
      sql`(${table.reason} = 'credits_exhausted' AND ${table.stop_intent_id} IS NOT NULL AND ${table.fallback_id} IS NULL)
        OR (${table.reason} = 'subscription_lapsed' AND ${table.fallback_id} IS NOT NULL AND ${table.stop_intent_id} IS NULL)`,
    ),
    state_check: check(
      "agent_funding_retentions_state_check",
      sql`(${table.state} = 'retained' AND ${table.container_deleted_at} IS NULL AND ${table.closed_at} IS NULL)
        OR (${table.state} = 'container_deletion_pending' AND ${table.sleep_job_id} IS NOT NULL
          AND ${table.container_deleted_at} IS NULL AND ${table.closed_at} IS NULL)
        OR (${table.state} = 'container_deleted' AND ${table.container_deleted_at} IS NOT NULL
          AND ${table.backup_retain_until} IS NOT NULL AND ${table.closed_at} IS NULL)
        OR (${table.state} = 'closed' AND ${table.container_deleted_at} IS NULL AND ${table.closed_at} IS NOT NULL
          AND ${table.closed_reason} IN ('funding_restored', 'agent_changed'))`,
    ),
    window_check: check(
      "agent_funding_retentions_window_check",
      sql`${table.delete_after} > ${table.suspended_at}`,
    ),
  }),
);

export type AgentFundingRetention = InferSelectModel<typeof agentFundingRetentions>;
