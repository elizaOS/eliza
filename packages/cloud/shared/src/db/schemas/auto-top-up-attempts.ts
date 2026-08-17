/**
 * Defines the durable auto-top-up attempt ledger used to single-flight provider
 * requests and fence recovery workers before any customer charge is attempted.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { creditTransactions } from "./credit-transactions";
import { organizations } from "./organizations";

export const AUTO_TOP_UP_TRIGGER_SOURCES = [
  "cron",
  "credit_deduction",
  "manual",
  "recovery",
] as const;
export type AutoTopUpTriggerSource = (typeof AUTO_TOP_UP_TRIGGER_SOURCES)[number];

export const AUTO_TOP_UP_ATTEMPT_STATUSES = [
  "claimed",
  "payment_pending",
  "payment_succeeded",
  "credited",
  "canceled",
  "manual_review",
] as const;
export type AutoTopUpAttemptStatus = (typeof AUTO_TOP_UP_ATTEMPT_STATUSES)[number];

export const AUTO_TOP_UP_CONTROL_MODES = ["paused", "durable"] as const;
export type AutoTopUpControlMode = (typeof AUTO_TOP_UP_CONTROL_MODES)[number];

export const AUTO_TOP_UP_LEGACY_QUARANTINE_STATUSES = [
  "unresolved",
  "credited",
  "canceled",
  "manual_review",
] as const;
export type AutoTopUpLegacyQuarantineStatus =
  (typeof AUTO_TOP_UP_LEGACY_QUARANTINE_STATUSES)[number];

export const autoTopUpAttempts = pgTable(
  "auto_top_up_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    trigger_source: text("trigger_source").$type<AutoTopUpTriggerSource>().notNull(),
    status: text("status").$type<AutoTopUpAttemptStatus>().notNull().default("claimed"),
    credit_amount_cents: bigint("credit_amount_cents", { mode: "number" }).notNull(),
    charge_amount_cents: bigint("charge_amount_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("usd"),
    stripe_customer_id_snapshot: text("stripe_customer_id_snapshot").notNull(),
    stripe_payment_method_id_snapshot: text("stripe_payment_method_id_snapshot").notNull(),
    request_metadata: jsonb("request_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    idempotency_key: text("idempotency_key").notNull(),
    stripe_payment_intent_id: text("stripe_payment_intent_id"),
    credit_transaction_id: uuid("credit_transaction_id").references(() => creditTransactions.id),
    covered_balance_decrease_revision: bigint("covered_balance_decrease_revision", {
      mode: "number",
    }),
    provider_status: text("provider_status"),
    attempt_count: integer("attempt_count").notNull().default(0),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    lease_token: uuid("lease_token"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    provider_request_started_at: timestamp("provider_request_started_at", { withTimezone: true }),
    recovery_deadline_at: timestamp("recovery_deadline_at", { withTimezone: true }),
    last_error: text("last_error"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    payment_succeeded_at: timestamp("payment_succeeded_at", { withTimezone: true }),
    credited_at: timestamp("credited_at", { withTimezone: true }),
    canceled_at: timestamp("canceled_at", { withTimezone: true }),
    manual_review_at: timestamp("manual_review_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotency_key_idx: uniqueIndex("auto_top_up_attempts_idempotency_key_idx").on(
      table.idempotency_key,
    ),
    payment_intent_idx: uniqueIndex("auto_top_up_attempts_payment_intent_idx")
      .on(table.stripe_payment_intent_id)
      .where(sql`${table.stripe_payment_intent_id} IS NOT NULL`),
    blocking_org_idx: uniqueIndex("auto_top_up_attempts_blocking_org_idx")
      .on(table.organization_id)
      .where(
        sql`${table.status} IN ('claimed','payment_pending','payment_succeeded','manual_review')`,
      ),
    due_idx: index("auto_top_up_attempts_due_idx")
      .on(table.next_attempt_at, table.lease_expires_at)
      .where(
        sql`${table.status} IN ('claimed','payment_pending','payment_succeeded') AND ${table.next_attempt_at} IS NOT NULL`,
      ),
    org_created_idx: index("auto_top_up_attempts_org_created_idx").on(
      table.organization_id,
      table.created_at,
    ),
    trigger_source_check: check(
      "auto_top_up_attempts_trigger_source_check",
      sql`${table.trigger_source} IN ('cron','credit_deduction','manual','recovery')`,
    ),
    status_check: check(
      "auto_top_up_attempts_status_check",
      sql`${table.status} IN ('claimed','payment_pending','payment_succeeded','credited','canceled','manual_review')`,
    ),
    amount_check: check(
      "auto_top_up_attempts_amount_check",
      sql`${table.credit_amount_cents} BETWEEN 100 AND 100000 AND ${table.charge_amount_cents} BETWEEN ${table.credit_amount_cents} AND 1120000`,
    ),
    currency_check: check(
      "auto_top_up_attempts_currency_check",
      sql`${table.currency} ~ '^[a-z]{3}$'`,
    ),
    attempt_count_check: check(
      "auto_top_up_attempts_attempt_count_check",
      sql`${table.attempt_count} >= 0`,
    ),
    lease_pair_check: check(
      "auto_top_up_attempts_lease_pair_check",
      sql`(${table.lease_token} IS NULL) = (${table.lease_expires_at} IS NULL)`,
    ),
    provider_window_check: check(
      "auto_top_up_attempts_provider_window_check",
      sql`((${table.provider_request_started_at} IS NULL) = (${table.recovery_deadline_at} IS NULL)) AND (${table.recovery_deadline_at} IS NULL OR ${table.recovery_deadline_at} > ${table.provider_request_started_at})`,
    ),
    terminal_check: check(
      "auto_top_up_attempts_terminal_check",
      sql`${table.status} NOT IN ('credited','canceled','manual_review') OR (${table.lease_token} IS NULL AND ${table.next_attempt_at} IS NULL)`,
    ),
    succeeded_check: check(
      "auto_top_up_attempts_succeeded_check",
      sql`${table.status} NOT IN ('payment_succeeded','credited') OR (${table.stripe_payment_intent_id} IS NOT NULL AND ${table.payment_succeeded_at} IS NOT NULL)`,
    ),
    canceled_check: check(
      "auto_top_up_attempts_canceled_check",
      sql`${table.status} <> 'canceled' OR (${table.provider_request_started_at} IS NULL AND ${table.stripe_payment_intent_id} IS NULL) OR (${table.stripe_payment_intent_id} IS NOT NULL AND ${table.provider_status} = 'canceled')`,
    ),
    credited_check: check(
      "auto_top_up_attempts_credited_check",
      sql`${table.status} <> 'credited' OR (${table.credit_transaction_id} IS NOT NULL AND ${table.covered_balance_decrease_revision} IS NOT NULL AND ${table.credited_at} IS NOT NULL)`,
    ),
    covered_revision_check: check(
      "auto_top_up_attempts_covered_revision_check",
      sql`${table.covered_balance_decrease_revision} IS NULL OR ${table.covered_balance_decrease_revision} >= 0`,
    ),
  }),
);

export type AutoTopUpAttemptRow = InferSelectModel<typeof autoTopUpAttempts>;
export type NewAutoTopUpAttempt = InferInsertModel<typeof autoTopUpAttempts>;

/** Singleton cutover authority. There is intentionally no executable legacy mode. */
export const autoTopUpControl = pgTable(
  "auto_top_up_control",
  {
    singleton: boolean("singleton").primaryKey().notNull().default(true),
    mode: text("mode").$type<AutoTopUpControlMode>().notNull().default("paused"),
    paused_at: timestamp("paused_at", { withTimezone: true }).notNull().defaultNow(),
    legacy_reconciled_through: timestamp("legacy_reconciled_through", {
      withTimezone: true,
    }),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singleton_check: check("auto_top_up_control_singleton_check", sql`${table.singleton} = true`),
    mode_check: check("auto_top_up_control_mode_check", sql`${table.mode} IN ('paused','durable')`),
    reconciliation_check: check(
      "auto_top_up_control_reconciliation_check",
      sql`${table.legacy_reconciled_through} IS NULL OR ${table.legacy_reconciled_through} >= ${table.paused_at}`,
    ),
  }),
);

/** Reconciliation-only quarantine for PaymentIntents created by removed legacy code. */
export const autoTopUpLegacyPaymentQuarantine = pgTable(
  "auto_top_up_legacy_payment_quarantine",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stripe_payment_intent_id: text("stripe_payment_intent_id").notNull(),
    provider_status: text("provider_status").notNull(),
    credit_amount_cents: bigint("credit_amount_cents", { mode: "number" }).notNull(),
    status: text("status").$type<AutoTopUpLegacyQuarantineStatus>().notNull().default("unresolved"),
    credit_transaction_id: uuid("credit_transaction_id").references(() => creditTransactions.id),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    discovered_at: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    payment_intent_idx: uniqueIndex("auto_top_up_legacy_quarantine_pi_idx").on(
      table.stripe_payment_intent_id,
    ),
    org_status_idx: index("auto_top_up_legacy_quarantine_org_status_idx").on(
      table.organization_id,
      table.status,
    ),
    status_check: check(
      "auto_top_up_legacy_quarantine_status_check",
      sql`${table.status} IN ('unresolved','credited','canceled','manual_review')`,
    ),
    resolution_check: check(
      "auto_top_up_legacy_quarantine_resolution_check",
      sql`((${table.status} IN ('credited','canceled')) = (${table.resolved_at} IS NOT NULL)) AND ((${table.status} = 'credited') = (${table.credit_transaction_id} IS NOT NULL)) AND (${table.status} <> 'credited' OR ${table.provider_status} = 'succeeded') AND (${table.status} <> 'canceled' OR ${table.provider_status} = 'canceled')`,
    ),
    amount_check: check(
      "auto_top_up_legacy_quarantine_amount_check",
      sql`${table.credit_amount_cents} BETWEEN 100 AND 100000`,
    ),
  }),
);

export type AutoTopUpControlRow = InferSelectModel<typeof autoTopUpControl>;
export type AutoTopUpLegacyPaymentQuarantineRow = InferSelectModel<
  typeof autoTopUpLegacyPaymentQuarantine
>;
