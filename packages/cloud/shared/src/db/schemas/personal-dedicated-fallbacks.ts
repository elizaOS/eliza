/** Durable, revision-fenced Dedicated-to-Shared fallback transitions for personal agents (#25146). */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * One row per withdrawal interval. An account with no open interval (none,
 * or its latest is `recovered`) is `dedicated_active`:
 * dedicated_active → fallback_pending → shared_active → recovery_pending → recovered.
 */
export const PERSONAL_DEDICATED_FALLBACK_STATES = [
  "fallback_pending",
  "shared_active",
  "recovery_pending",
  "recovered",
] as const;
export type PersonalDedicatedFallbackState = (typeof PERSONAL_DEDICATED_FALLBACK_STATES)[number];

export const PERSONAL_DEDICATED_FALLBACK_REASONS = [
  /** Confirmed unfunded billing stop (legacy credit funding). */
  "billing_suspended",
  /** Paid plan payment failed past its grace period (`past_due`/`unpaid`). */
  "subscription_payment_failed",
  /** Paid plan ended: canceled (including at period end) or expired. */
  "subscription_ended",
] as const;
export type PersonalDedicatedFallbackReason = (typeof PERSONAL_DEDICATED_FALLBACK_REASONS)[number];

export const personalDedicatedFallbacks = pgTable(
  "personal_dedicated_fallbacks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").notNull(),
    /** Canonical `personal:` Shared identity. Account authority stays stable. */
    source_agent_id: text("source_agent_id").notNull(),
    dedicated_agent_id: uuid("dedicated_agent_id").notNull(),
    /** Monotonic per account; a new withdrawal never reopens an older interval. */
    generation: integer("generation").notNull(),
    state: text("state").$type<PersonalDedicatedFallbackState>().notNull(),
    reason: text("reason").$type<PersonalDedicatedFallbackReason>().notNull(),
    /** Advances on every transition; effects and route commits compare-and-swap on it. */
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    /** The provider-confirmed billing stop that withdrew access (`billing_suspended`). */
    stop_intent_id: uuid("stop_intent_id"),
    /** Organization entitlement projection revision that withdrew access (plan reasons). */
    entitlement_revision: bigint("entitlement_revision", { mode: "number" }),
    /** Organization entitlement projection revision that restored access. */
    recovery_entitlement_revision: bigint("recovery_entitlement_revision", { mode: "number" }),
    /**
     * The Dedicated runtime is preserved (stopped) until this deadline; the
     * funding-retention clock (#22967) removes its container after it.
     */
    retain_until: timestamp("retain_until", { withTimezone: true }),
    /** Billing stop admitted for a running Dedicated runtime when access was withdrawn. */
    suspend_job_id: uuid("suspend_job_id"),
    /** Resume admitted for the same Dedicated runtime when access was restored. */
    resume_job_id: uuid("resume_job_id"),
    /**
     * Separately scoped Shared journal for this interval only. It is never the
     * canonical room, so Shared cannot read Dedicated or pre-upgrade history.
     */
    journal_room_id: text("journal_room_id").notNull(),
    activated_at: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    recovery_requested_at: timestamp("recovery_requested_at", { withTimezone: true }),
    recovered_at: timestamp("recovered_at", { withTimezone: true }),
    /** Complete journal message count reconciled into Dedicated before routing returned. */
    reconciled_message_count: integer("reconciled_message_count"),
    reconciled_inserted_count: integer("reconciled_inserted_count"),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    generation_unique: uniqueIndex("personal_dedicated_fallbacks_generation_unique").on(
      table.organization_id,
      table.user_id,
      table.source_agent_id,
      table.generation,
    ),
    open_unique: uniqueIndex("personal_dedicated_fallbacks_open_unique")
      .on(table.organization_id, table.user_id, table.source_agent_id)
      .where(sql`${table.state} <> 'recovered'`),
    journal_unique: uniqueIndex("personal_dedicated_fallbacks_journal_unique").on(
      table.journal_room_id,
    ),
    dedicated_idx: index("personal_dedicated_fallbacks_dedicated_idx").on(table.dedicated_agent_id),
    open_dedicated_idx: index("personal_dedicated_fallbacks_open_dedicated_idx")
      .on(table.dedicated_agent_id, table.state)
      .where(sql`${table.state} <> 'recovered'`),
    state_check: check(
      "personal_dedicated_fallbacks_state_check",
      sql`(${table.state} IN ('fallback_pending', 'shared_active') AND ${table.recovered_at} IS NULL AND ${table.recovery_requested_at} IS NULL)
        OR (${table.state} = 'recovery_pending' AND ${table.recovered_at} IS NULL AND ${table.recovery_requested_at} IS NOT NULL)
        OR (${table.state} = 'recovered' AND ${table.recovered_at} IS NOT NULL)`,
    ),
    reason_check: check(
      "personal_dedicated_fallbacks_reason_check",
      sql`(${table.reason} = 'billing_suspended' AND ${table.stop_intent_id} IS NOT NULL)
        OR (${table.reason} IN ('subscription_payment_failed', 'subscription_ended')
          AND ${table.entitlement_revision} IS NOT NULL AND ${table.retain_until} IS NOT NULL)`,
    ),
    revision_check: check(
      "personal_dedicated_fallbacks_revision_check",
      sql`${table.revision} >= 1
        AND (${table.reconciled_message_count} IS NULL OR ${table.reconciled_message_count} >= 0)
        AND (${table.reconciled_inserted_count} IS NULL OR ${table.reconciled_inserted_count} >= 0)`,
    ),
    generation_check: check(
      "personal_dedicated_fallbacks_generation_check",
      sql`${table.generation} >= 1`,
    ),
  }),
);

export type PersonalDedicatedFallback = InferSelectModel<typeof personalDedicatedFallbacks>;
export type NewPersonalDedicatedFallback = InferInsertModel<typeof personalDedicatedFallbacks>;
