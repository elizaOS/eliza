/** Defines non-rollover subscription allowance authority for one paid invoice period. */
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { billingSubscriptionRevisions, billingSubscriptions } from "./billing-subscriptions";
import { organizations } from "./organizations";

export const SUBSCRIPTION_ALLOWANCE_PERIOD_STATES = [
  "open",
  "expired",
  "clawed_back",
  "closed",
] as const;
export type SubscriptionAllowancePeriodState =
  (typeof SUBSCRIPTION_ALLOWANCE_PERIOD_STATES)[number];

export const subscriptionAllowancePeriods = pgTable(
  "subscription_allowance_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    subscription_id: uuid("subscription_id").notNull(),
    subscription_revision: bigint("subscription_revision", { mode: "number" }).notNull(),
    stripe_invoice_id: text("stripe_invoice_id").notNull(),
    plan_key: text("plan_key").$type<"plus_monthly" | "pro_monthly">().notNull(),
    catalog_version: text("catalog_version").notNull(),
    period_start: timestamp("period_start", { withTimezone: true }).notNull(),
    period_end: timestamp("period_end", { withTimezone: true }).notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    state: text("state").$type<SubscriptionAllowancePeriodState>().notNull().default("open"),
    granted_amount: numeric("granted_amount", { precision: 16, scale: 6 }).notNull(),
    remaining_amount: numeric("remaining_amount", { precision: 16, scale: 6 }).notNull(),
    expired_amount: numeric("expired_amount", { precision: 16, scale: 6 })
      .notNull()
      .default("0.000000"),
    clawed_back_amount: numeric("clawed_back_amount", { precision: 16, scale: 6 })
      .notNull()
      .default("0.000000"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subscription_tenant_fk: foreignKey({
      columns: [table.subscription_id, table.organization_id],
      foreignColumns: [billingSubscriptions.id, billingSubscriptions.organization_id],
      name: "subscription_allowance_periods_subscription_tenant_fk",
    }).onDelete("restrict"),
    subscription_revision_tenant_fk: foreignKey({
      columns: [table.subscription_id, table.organization_id, table.subscription_revision],
      foreignColumns: [
        billingSubscriptionRevisions.subscription_id,
        billingSubscriptionRevisions.organization_id,
        billingSubscriptionRevisions.revision,
      ],
      name: "subscription_allowance_periods_revision_tenant_fk",
    }).onDelete("restrict"),
    id_organization_unique: uniqueIndex("subscription_allowance_periods_id_org_idx").on(
      table.id,
      table.organization_id,
    ),
    invoice_unique: uniqueIndex("subscription_allowance_periods_invoice_idx").on(
      table.stripe_invoice_id,
    ),
    subscription_period_unique: uniqueIndex("subscription_allowance_periods_period_idx").on(
      table.subscription_id,
      table.period_start,
      table.period_end,
    ),
    organization_period_idx: index("subscription_allowance_periods_org_period_idx").on(
      table.organization_id,
      table.period_end,
    ),
    invoice_id_check: check(
      "subscription_allowance_periods_invoice_id_check",
      sql`${table.stripe_invoice_id} ~ '^in_[A-Za-z0-9]+$'`,
    ),
    period_check: check(
      "subscription_allowance_periods_period_check",
      sql`${table.period_end} > ${table.period_start} AND ${table.expires_at} = ${table.period_end}`,
    ),
    plan_catalog_check: check(
      "subscription_allowance_periods_plan_catalog_check",
      sql`${table.plan_key} IN ('plus_monthly','pro_monthly') AND length(btrim(${table.catalog_version})) > 0`,
    ),
    state_check: check(
      "subscription_allowance_periods_state_check",
      sql`${table.state} IN ('open','expired','clawed_back','closed')`,
    ),
    amounts_check: check(
      "subscription_allowance_periods_amounts_check",
      sql`${table.granted_amount} > 0 AND ${table.remaining_amount} >= 0 AND ${table.expired_amount} >= 0 AND ${table.clawed_back_amount} >= 0 AND ${table.remaining_amount} + ${table.expired_amount} + ${table.clawed_back_amount} <= ${table.granted_amount}`,
    ),
    terminal_amounts_check: check(
      "subscription_allowance_periods_terminal_amounts_check",
      sql`(${table.state} = 'open') OR (${table.state} = 'expired' AND ${table.remaining_amount} = 0 AND ${table.expired_amount} > 0) OR (${table.state} = 'clawed_back' AND ${table.remaining_amount} = 0 AND ${table.clawed_back_amount} > 0) OR (${table.state} = 'closed' AND ${table.remaining_amount} = 0)`,
    ),
    revision_check: check(
      "subscription_allowance_periods_revision_check",
      sql`${table.subscription_revision} > 0`,
    ),
  }),
);

export type SubscriptionAllowancePeriod = InferSelectModel<typeof subscriptionAllowancePeriods>;
export type NewSubscriptionAllowancePeriod = InferInsertModel<typeof subscriptionAllowancePeriods>;
