/**
 * Defines durable, tenant-scoped Stripe Customer creation attempts and their provider receipts.
 */
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const STRIPE_CUSTOMER_ATTEMPT_STATUSES = [
  "prepared",
  "provider_started",
  "provider_ambiguous",
  "bound",
  "quarantined",
  "abandoned",
] as const;
export type StripeCustomerAttemptStatus = (typeof STRIPE_CUSTOMER_ATTEMPT_STATUSES)[number];

export const stripeCustomerAttempts = pgTable(
  "stripe_customer_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    generation: integer("generation").notNull(),
    request_digest: text("request_digest").notNull(),
    caller_intent: text("caller_intent").notNull(),
    provider: text("provider").notNull().default("stripe"),
    idempotency_key: text("idempotency_key").notNull(),
    status: text("status").$type<StripeCustomerAttemptStatus>().notNull().default("prepared"),
    provider_customer_id: text("provider_customer_id"),
    provider_receipt: jsonb("provider_receipt").$type<Record<string, unknown>>(),
    provider_started_at: timestamp("provider_started_at", { withTimezone: true }),
    bound_at: timestamp("bound_at", { withTimezone: true }),
    lease_token: uuid("lease_token"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    ambiguous_reason: text("ambiguous_reason"),
    provider_livemode: boolean("provider_livemode"),
    resolved_by: text("resolved_by"),
    resolution_reason: text("resolution_reason"),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organization_generation_unique: uniqueIndex("stripe_customer_attempts_org_generation_idx").on(
      table.organization_id,
      table.generation,
    ),
    id_organization_unique: uniqueIndex("stripe_customer_attempts_id_org_idx").on(
      table.id,
      table.organization_id,
    ),
    idempotency_key_unique: uniqueIndex("stripe_customer_attempts_idempotency_key_idx").on(
      table.idempotency_key,
    ),
    provider_customer_unique: uniqueIndex("stripe_customer_attempts_provider_customer_idx")
      .on(table.provider_customer_id)
      .where(sql`${table.provider_customer_id} IS NOT NULL`),
    active_organization_unique: uniqueIndex("stripe_customer_attempts_active_org_idx")
      .on(table.organization_id)
      .where(sql`${table.status} IN ('prepared','provider_started','provider_ambiguous','bound')`),
    status_lease_idx: index("stripe_customer_attempts_status_lease_idx").on(
      table.status,
      table.lease_expires_at,
    ),
    generation_check: check(
      "stripe_customer_attempts_generation_check",
      sql`${table.generation} > 0`,
    ),
    digest_check: check(
      "stripe_customer_attempts_digest_check",
      sql`${table.request_digest} ~ '^[0-9a-f]{64}$'`,
    ),
    provider_check: check(
      "stripe_customer_attempts_provider_check",
      sql`${table.provider} = 'stripe'`,
    ),
    caller_intent_check: check(
      "stripe_customer_attempts_caller_intent_check",
      sql`${table.caller_intent} IN ('payment_method','interactive_checkout','credit_checkout','auto_top_up')`,
    ),
    status_check: check(
      "stripe_customer_attempts_status_check",
      sql`${table.status} IN ('prepared','provider_started','provider_ambiguous','bound','quarantined','abandoned')`,
    ),
    bound_shape_check: check(
      "stripe_customer_attempts_bound_shape_check",
      sql`(${table.status} = 'bound' AND ${table.provider_customer_id} IS NOT NULL AND ${table.provider_receipt} IS NOT NULL AND ${table.provider_livemode} IS NOT NULL AND ${table.bound_at} IS NOT NULL AND ${table.lease_token} IS NULL AND ${table.lease_expires_at} IS NULL) OR (${table.status} <> 'bound' AND ${table.provider_customer_id} IS NULL AND ${table.provider_receipt} IS NULL AND ${table.provider_livemode} IS NULL AND ${table.bound_at} IS NULL)`,
    ),
    progress_shape_check: check(
      "stripe_customer_attempts_progress_shape_check",
      sql`(${table.status} = 'prepared' AND ${table.provider_started_at} IS NULL) OR (${table.status} <> 'prepared' AND ${table.provider_started_at} IS NOT NULL)`,
    ),
    resolution_shape_check: check(
      "stripe_customer_attempts_resolution_shape_check",
      sql`(${table.status} = 'abandoned' AND ${table.resolved_by} IS NOT NULL AND ${table.resolution_reason} IS NOT NULL AND ${table.resolved_at} IS NOT NULL) OR (${table.status} <> 'abandoned')`,
    ),
  }),
);

export type StripeCustomerAttempt = InferSelectModel<typeof stripeCustomerAttempts>;
export type NewStripeCustomerAttempt = InferInsertModel<typeof stripeCustomerAttempts>;

export const stripeCustomerLegacyQuarantines = pgTable(
  "stripe_customer_legacy_quarantines",
  {
    organization_id: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "restrict" }),
    stripe_customer_id: text("stripe_customer_id").notNull().unique(),
    reason: text("reason")
      .notNull()
      .default("pre-authority Stripe Customer requires provider verification"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolved_attempt_id: uuid("resolved_attempt_id"),
    resolved_by: text("resolved_by"),
    resolution_reason: text("resolution_reason"),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    retirement_kind: text("retirement_kind").$type<"missing" | "deleted" | "wrong_tenant">(),
    retirement_receipt: jsonb("retirement_receipt").$type<Record<string, unknown>>(),
    retired_by: text("retired_by"),
    retirement_reason: text("retirement_reason"),
    retired_at: timestamp("retired_at", { withTimezone: true }),
    replacement_attempt_id: uuid("replacement_attempt_id"),
  },
  (table) => ({
    resolved_attempt_tenant_fk: foreignKey({
      columns: [table.resolved_attempt_id, table.organization_id],
      foreignColumns: [stripeCustomerAttempts.id, stripeCustomerAttempts.organization_id],
      name: "stripe_customer_legacy_quarantine_attempt_tenant_fk",
    }).onDelete("restrict"),
    replacement_attempt_tenant_fk: foreignKey({
      columns: [table.replacement_attempt_id, table.organization_id],
      foreignColumns: [stripeCustomerAttempts.id, stripeCustomerAttempts.organization_id],
      name: "stripe_customer_legacy_quarantine_replacement_tenant_fk",
    }).onDelete("restrict"),
    resolution_shape: check(
      "stripe_customer_legacy_quarantine_resolution_shape",
      sql`(${table.resolved_attempt_id} IS NULL AND ${table.resolved_by} IS NULL AND ${table.resolution_reason} IS NULL AND ${table.resolved_at} IS NULL) OR (${table.resolved_attempt_id} IS NOT NULL AND ${table.resolved_by} IS NOT NULL AND ${table.resolution_reason} IS NOT NULL AND ${table.resolved_at} IS NOT NULL)`,
    ),
    retirement_shape: check(
      "stripe_customer_legacy_quarantine_retirement_shape",
      sql`(${table.retirement_kind} IS NULL AND ${table.retirement_receipt} IS NULL AND ${table.retired_by} IS NULL AND ${table.retirement_reason} IS NULL AND ${table.retired_at} IS NULL AND ${table.replacement_attempt_id} IS NULL) OR (${table.retirement_kind} IN ('missing','deleted','wrong_tenant') AND ${table.retirement_receipt} IS NOT NULL AND ${table.retired_by} IS NOT NULL AND ${table.retirement_reason} IS NOT NULL AND ${table.retired_at} IS NOT NULL AND ${table.replacement_attempt_id} IS NOT NULL AND ${table.resolved_attempt_id} IS NOT NULL)`,
    ),
  }),
);

export type StripeCustomerLegacyQuarantine = InferSelectModel<
  typeof stripeCustomerLegacyQuarantines
>;
