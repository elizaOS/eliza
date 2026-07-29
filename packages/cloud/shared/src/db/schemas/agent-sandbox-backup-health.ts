/**
 * Durable scheduler and fleet-health state for managed agent backups.
 *
 * One row follows each sandbox across cron and daemon restarts. Capability is
 * scoped only to an immutable image digest: mutable tags never earn a durable
 * unsupported classification that could suppress future backup attempts.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agentSandboxes } from "./agent-sandboxes";

export type AgentSandboxBackupCapability = "unknown" | "supported" | "unsupported";

export type AgentSandboxBackupOutcome =
  | "in_progress"
  | "success"
  | "unsupported"
  | "unavailable"
  | "failed"
  | "enqueue_failed"
  | "image_changed"
  | "generation_changed";

export const agentSandboxBackupHealth = pgTable(
  "agent_sandbox_backup_health",
  {
    sandbox_record_id: uuid("sandbox_record_id")
      .primaryKey()
      .references(() => agentSandboxes.id, { onDelete: "cascade" }),
    /**
     * Registry-resolved image digest copied from `agent_sandboxes.image_digest`.
     * Null means the exact image is unknown; in that state capability remains
     * `unknown` even if an endpoint probe returns unsupported.
     */
    image_identity: text("image_identity"),
    capability: text("capability")
      .$type<AgentSandboxBackupCapability>()
      .notNull()
      .default("unknown"),
    last_attempt_started_at: timestamp("last_attempt_started_at", {
      withTimezone: true,
    }),
    last_attempt_completed_at: timestamp("last_attempt_completed_at", {
      withTimezone: true,
    }),
    last_success_at: timestamp("last_success_at", { withTimezone: true }),
    last_outcome: text("last_outcome").$type<AgentSandboxBackupOutcome>(),
    attempt_token: uuid("attempt_token"),
    attempt_job_id: uuid("attempt_job_id"),
    attempt_job_started_at: timestamp("attempt_job_started_at"),
    lease_token: uuid("lease_token"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    /**
     * True when the exact current image has no confirmed backup even if the
     * sandbox's historical success clock is recent. Image changes set this
     * bit; only a success fenced to that same image clears it.
     */
    backup_required: boolean("backup_required").notNull().default(false),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }),
    consecutive_failures: integer("consecutive_failures").notNull().default(0),
    last_error: varchar("last_error", { length: 1024 }),
    /**
     * Current ops-visible failure signature. Health monitoring only alerts
     * when this changes; a successful backup clears it so a later relapse can
     * raise a fresh incident without periodic duplicate pages.
     */
    alert_fingerprint: text("alert_fingerprint"),
    last_alerted_at: timestamp("last_alerted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    due_idx: index("agent_sandbox_backup_health_due_idx").on(
      table.next_attempt_at,
      table.last_attempt_started_at,
    ),
    lease_idx: index("agent_sandbox_backup_health_lease_idx").on(table.lease_expires_at),
    capability_idx: index("agent_sandbox_backup_health_capability_idx").on(table.capability),
    capability_valid: check(
      "agent_sandbox_backup_health_capability_check",
      sql`${table.capability} IN ('unknown', 'supported', 'unsupported')`,
    ),
    outcome_valid: check(
      "agent_sandbox_backup_health_outcome_check",
      sql`${table.last_outcome} IS NULL OR ${table.last_outcome} IN (
        'in_progress',
        'success',
        'unsupported',
        'unavailable',
        'failed',
        'enqueue_failed',
        'image_changed',
        'generation_changed'
      )`,
    ),
    attempt_pair: check(
      "agent_sandbox_backup_health_attempt_pair_check",
      sql`(
        ${table.attempt_token} IS NULL
        AND ${table.attempt_job_id} IS NULL
        AND ${table.attempt_job_started_at} IS NULL
      ) OR (
        ${table.attempt_token} IS NOT NULL
        AND ${table.attempt_job_id} IS NOT NULL
        AND ${table.attempt_job_started_at} IS NOT NULL
      )`,
    ),
    lease_pair: check(
      "agent_sandbox_backup_health_lease_pair_check",
      sql`(
        ${table.lease_token} IS NULL
        AND ${table.lease_expires_at} IS NULL
      ) OR (
        ${table.lease_token} IS NOT NULL
        AND ${table.lease_expires_at} IS NOT NULL
      )`,
    ),
    failures_nonnegative: check(
      "agent_sandbox_backup_health_failures_nonnegative_check",
      sql`${table.consecutive_failures} >= 0`,
    ),
    unsupported_requires_identity: check(
      "agent_sandbox_backup_health_unsupported_identity_check",
      sql`${table.capability} <> 'unsupported' OR ${table.image_identity} IS NOT NULL`,
    ),
  }),
);

export type AgentSandboxBackupHealth = InferSelectModel<typeof agentSandboxBackupHealth>;
export type NewAgentSandboxBackupHealth = InferInsertModel<typeof agentSandboxBackupHealth>;
