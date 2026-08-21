/**
 * Defines tenant-scoped subscription authority and its immutable lifecycle revisions.
 */
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const SUBSCRIPTION_PLAN_KEYS = ["plus_monthly", "pro_monthly"] as const;
export type SubscriptionPlanKey = (typeof SUBSCRIPTION_PLAN_KEYS)[number];

export const BILLING_SUBSCRIPTION_STATUSES = [
  "pending",
  "active",
  "grace",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete_expired",
] as const;
export type BillingSubscriptionStatus = (typeof BILLING_SUBSCRIPTION_STATUSES)[number];

export const BILLING_SUBSCRIPTION_REVISION_SOURCES = [
  "checkout",
  "webhook",
  "reconciliation",
  "backfill",
  "admin",
] as const;
export type BillingSubscriptionRevisionSource =
  (typeof BILLING_SUBSCRIPTION_REVISION_SOURCES)[number];

export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    stripe_subscription_id: text("stripe_subscription_id").notNull(),
    stripe_subscription_item_id: text("stripe_subscription_item_id").notNull(),
    plan_key: text("plan_key").$type<SubscriptionPlanKey>().notNull(),
    catalog_version: text("catalog_version").notNull(),
    status: text("status").$type<BillingSubscriptionStatus>().notNull(),
    current_period_start: timestamp("current_period_start", { withTimezone: true }).notNull(),
    current_period_end: timestamp("current_period_end", { withTimezone: true }).notNull(),
    cancel_at_period_end: boolean("cancel_at_period_end").notNull().default(false),
    canceled_at: timestamp("canceled_at", { withTimezone: true }),
    ended_at: timestamp("ended_at", { withTimezone: true }),
    dunning_started_at: timestamp("dunning_started_at", { withTimezone: true }),
    grace_expires_at: timestamp("grace_expires_at", { withTimezone: true }),
    pending_plan_key: text("pending_plan_key").$type<SubscriptionPlanKey>(),
    lifecycle_revision: bigint("lifecycle_revision", { mode: "number" }).notNull(),
    provider_object_version: bigint("provider_object_version", { mode: "number" }).notNull(),
    provider_event_id: text("provider_event_id"),
    provider_event_created_at: timestamp("provider_event_created_at", { withTimezone: true }),
    provider_object_digest: text("provider_object_digest").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    id_organization_unique: uniqueIndex("billing_subscriptions_id_org_idx").on(
      table.id,
      table.organization_id,
    ),
    stripe_subscription_unique: uniqueIndex("billing_subscriptions_stripe_subscription_idx").on(
      table.stripe_subscription_id,
    ),
    stripe_item_unique: uniqueIndex("billing_subscriptions_stripe_item_idx").on(
      table.stripe_subscription_item_id,
    ),
    provider_event_unique: uniqueIndex("billing_subscriptions_provider_event_idx")
      .on(table.provider_event_id)
      .where(sql`${table.provider_event_id} IS NOT NULL`),
    one_live_subscription_per_org: uniqueIndex("billing_subscriptions_live_org_idx")
      .on(table.organization_id)
      .where(sql`${table.status} IN ('pending','active','grace','past_due','unpaid')`),
    organization_updated_idx: index("billing_subscriptions_org_updated_idx").on(
      table.organization_id,
      table.updated_at,
    ),
    status_check: check(
      "billing_subscriptions_status_check",
      sql`${table.status} IN ('pending','active','grace','past_due','unpaid','canceled','incomplete_expired')`,
    ),
    plan_check: check(
      "billing_subscriptions_plan_check",
      sql`${table.plan_key} IN ('plus_monthly','pro_monthly') AND (${table.pending_plan_key} IS NULL OR ${table.pending_plan_key} IN ('plus_monthly','pro_monthly')) AND length(btrim(${table.catalog_version})) > 0`,
    ),
    provider_id_check: check(
      "billing_subscriptions_provider_id_check",
      sql`${table.stripe_subscription_id} ~ '^sub_[A-Za-z0-9]+$' AND ${table.stripe_subscription_item_id} ~ '^si_[A-Za-z0-9]+$' AND (${table.provider_event_id} IS NULL OR ${table.provider_event_id} ~ '^evt_[A-Za-z0-9]+$')`,
    ),
    revision_check: check(
      "billing_subscriptions_revision_check",
      sql`${table.lifecycle_revision} > 0 AND ${table.provider_object_version} >= 0`,
    ),
    period_check: check(
      "billing_subscriptions_period_check",
      sql`${table.current_period_end} > ${table.current_period_start}`,
    ),
    provider_fence_check: check(
      "billing_subscriptions_provider_fence_check",
      sql`(${table.provider_event_id} IS NULL) = (${table.provider_event_created_at} IS NULL) AND ${table.provider_object_digest} ~ '^[0-9a-f]{64}$'`,
    ),
    dunning_check: check(
      "billing_subscriptions_dunning_check",
      sql`${table.grace_expires_at} IS NULL OR (${table.dunning_started_at} IS NOT NULL AND ${table.grace_expires_at} > ${table.dunning_started_at})`,
    ),
    pending_plan_check: check(
      "billing_subscriptions_pending_plan_check",
      sql`${table.pending_plan_key} IS NULL OR ${table.pending_plan_key} <> ${table.plan_key}`,
    ),
  }),
);

export type BillingSubscription = InferSelectModel<typeof billingSubscriptions>;
export type NewBillingSubscription = InferInsertModel<typeof billingSubscriptions>;

export const billingSubscriptionRevisions = pgTable(
  "billing_subscription_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    subscription_id: uuid("subscription_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    source: text("source").$type<BillingSubscriptionRevisionSource>().notNull(),
    stripe_subscription_id: text("stripe_subscription_id").notNull(),
    stripe_subscription_item_id: text("stripe_subscription_item_id").notNull(),
    plan_key: text("plan_key").$type<SubscriptionPlanKey>().notNull(),
    catalog_version: text("catalog_version").notNull(),
    status: text("status").$type<BillingSubscriptionStatus>().notNull(),
    current_period_start: timestamp("current_period_start", { withTimezone: true }).notNull(),
    current_period_end: timestamp("current_period_end", { withTimezone: true }).notNull(),
    cancel_at_period_end: boolean("cancel_at_period_end").notNull(),
    canceled_at: timestamp("canceled_at", { withTimezone: true }),
    ended_at: timestamp("ended_at", { withTimezone: true }),
    dunning_started_at: timestamp("dunning_started_at", { withTimezone: true }),
    grace_expires_at: timestamp("grace_expires_at", { withTimezone: true }),
    pending_plan_key: text("pending_plan_key").$type<SubscriptionPlanKey>(),
    provider_object_version: bigint("provider_object_version", { mode: "number" }).notNull(),
    provider_event_id: text("provider_event_id"),
    provider_event_created_at: timestamp("provider_event_created_at", { withTimezone: true }),
    provider_object_digest: text("provider_object_digest").notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subscription_tenant_fk: foreignKey({
      columns: [table.subscription_id, table.organization_id],
      foreignColumns: [billingSubscriptions.id, billingSubscriptions.organization_id],
      name: "billing_subscription_revisions_subscription_tenant_fk",
    }).onDelete("restrict"),
    id_organization_unique: uniqueIndex("billing_subscription_revisions_id_org_idx").on(
      table.id,
      table.organization_id,
    ),
    subscription_revision_unique: uniqueIndex("billing_subscription_revisions_revision_idx").on(
      table.subscription_id,
      table.revision,
    ),
    subscription_provider_version_unique: uniqueIndex(
      "billing_subscription_revisions_provider_version_idx",
    ).on(table.subscription_id, table.provider_object_version),
    subscription_organization_revision_unique: uniqueIndex(
      "billing_subscription_revisions_subscription_org_revision_idx",
    ).on(table.subscription_id, table.organization_id, table.revision),
    provider_event_unique: uniqueIndex("billing_subscription_revisions_provider_event_idx")
      .on(table.provider_event_id)
      .where(sql`${table.provider_event_id} IS NOT NULL`),
    organization_recorded_idx: index("billing_subscription_revisions_org_recorded_idx").on(
      table.organization_id,
      table.recorded_at,
    ),
    source_check: check(
      "billing_subscription_revisions_source_check",
      sql`${table.source} IN ('checkout','webhook','reconciliation','backfill','admin')`,
    ),
    status_check: check(
      "billing_subscription_revisions_status_check",
      sql`${table.status} IN ('pending','active','grace','past_due','unpaid','canceled','incomplete_expired')`,
    ),
    plan_check: check(
      "billing_subscription_revisions_plan_check",
      sql`${table.plan_key} IN ('plus_monthly','pro_monthly') AND (${table.pending_plan_key} IS NULL OR ${table.pending_plan_key} IN ('plus_monthly','pro_monthly')) AND (${table.pending_plan_key} IS NULL OR ${table.pending_plan_key} <> ${table.plan_key}) AND length(btrim(${table.catalog_version})) > 0`,
    ),
    provider_id_check: check(
      "billing_subscription_revisions_provider_id_check",
      sql`${table.stripe_subscription_id} ~ '^sub_[A-Za-z0-9]+$' AND ${table.stripe_subscription_item_id} ~ '^si_[A-Za-z0-9]+$' AND (${table.provider_event_id} IS NULL OR ${table.provider_event_id} ~ '^evt_[A-Za-z0-9]+$')`,
    ),
    revision_check: check(
      "billing_subscription_revisions_revision_check",
      sql`${table.revision} > 0 AND ${table.provider_object_version} >= 0`,
    ),
    period_check: check(
      "billing_subscription_revisions_period_check",
      sql`${table.current_period_end} > ${table.current_period_start}`,
    ),
    provider_fence_check: check(
      "billing_subscription_revisions_provider_fence_check",
      sql`(${table.provider_event_id} IS NULL) = (${table.provider_event_created_at} IS NULL) AND ${table.provider_object_digest} ~ '^[0-9a-f]{64}$'`,
    ),
    dunning_check: check(
      "billing_subscription_revisions_dunning_check",
      sql`${table.grace_expires_at} IS NULL OR (${table.dunning_started_at} IS NOT NULL AND ${table.grace_expires_at} > ${table.dunning_started_at})`,
    ),
  }),
);

export type BillingSubscriptionRevision = InferSelectModel<typeof billingSubscriptionRevisions>;
export type NewBillingSubscriptionRevision = InferInsertModel<typeof billingSubscriptionRevisions>;
