/** Defines the append-only audit ledger for subscription allowance mutations. */
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { billingFundingReservations } from "./billing-funding-reservations";
import { billingSubscriptionRevisions } from "./billing-subscriptions";
import { organizations } from "./organizations";
import { subscriptionAllowancePeriods } from "./subscription-allowance-periods";

export const SUBSCRIPTION_ALLOWANCE_TRANSACTION_KINDS = [
  "grant",
  "reserve",
  "settle",
  "refund",
  "expire",
  "clawback",
  "grant_adjustment",
  "close",
] as const;
export type SubscriptionAllowanceTransactionKind =
  (typeof SUBSCRIPTION_ALLOWANCE_TRANSACTION_KINDS)[number];

export const subscriptionAllowanceTransactions = pgTable(
  "subscription_allowance_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    allowance_period_id: uuid("allowance_period_id").notNull(),
    funding_reservation_id: uuid("funding_reservation_id"),
    source_subscription_id: uuid("source_subscription_id"),
    source_subscription_revision: bigint("source_subscription_revision", { mode: "number" }),
    source_invoice_id: text("source_invoice_id"),
    source_plan_key: text("source_plan_key").$type<"plus_monthly" | "pro_monthly">(),
    source_catalog_version: text("source_catalog_version"),
    sequence: integer("sequence").notNull(),
    kind: text("kind").$type<SubscriptionAllowanceTransactionKind>().notNull(),
    amount: numeric("amount", { precision: 16, scale: 6 }).notNull(),
    remaining_before: numeric("remaining_before", { precision: 16, scale: 6 }).notNull(),
    remaining_after: numeric("remaining_after", { precision: 16, scale: 6 }).notNull(),
    expired_before: numeric("expired_before", { precision: 16, scale: 6 }).notNull(),
    expired_after: numeric("expired_after", { precision: 16, scale: 6 }).notNull(),
    clawed_back_before: numeric("clawed_back_before", { precision: 16, scale: 6 }).notNull(),
    clawed_back_after: numeric("clawed_back_after", { precision: 16, scale: 6 }).notNull(),
    idempotency_key: text("idempotency_key").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    allowance_period_tenant_fk: foreignKey({
      columns: [table.allowance_period_id, table.organization_id],
      foreignColumns: [
        subscriptionAllowancePeriods.id,
        subscriptionAllowancePeriods.organization_id,
      ],
      name: "subscription_allowance_transactions_period_tenant_fk",
    }).onDelete("restrict"),
    funding_reservation_tenant_fk: foreignKey({
      columns: [table.funding_reservation_id, table.organization_id],
      foreignColumns: [billingFundingReservations.id, billingFundingReservations.organization_id],
      name: "subscription_allowance_transactions_reservation_tenant_fk",
    }).onDelete("restrict"),
    source_revision_tenant_fk: foreignKey({
      columns: [
        table.source_subscription_id,
        table.organization_id,
        table.source_subscription_revision,
      ],
      foreignColumns: [
        billingSubscriptionRevisions.subscription_id,
        billingSubscriptionRevisions.organization_id,
        billingSubscriptionRevisions.revision,
      ],
      name: "subscription_allowance_transactions_source_revision_tenant_fk",
    }).onDelete("restrict"),
    organization_idempotency_unique: uniqueIndex(
      "subscription_allowance_transactions_org_idempotency_idx",
    ).on(table.organization_id, table.idempotency_key),
    period_sequence_unique: uniqueIndex(
      "subscription_allowance_transactions_period_sequence_idx",
    ).on(table.allowance_period_id, table.sequence),
    one_grant_per_period: uniqueIndex("subscription_allowance_transactions_period_grant_idx")
      .on(table.allowance_period_id)
      .where(sql`${table.kind} = 'grant'`),
    source_invoice_unique: uniqueIndex("subscription_allowance_transactions_source_invoice_idx")
      .on(table.source_invoice_id)
      .where(sql`${table.source_invoice_id} IS NOT NULL`),
    period_occurred_idx: index("subscription_allowance_transactions_period_occurred_idx").on(
      table.allowance_period_id,
      table.occurred_at,
      table.id,
    ),
    kind_check: check(
      "subscription_allowance_transactions_kind_check",
      sql`${table.kind} IN ('grant','reserve','settle','refund','expire','clawback','grant_adjustment','close')`,
    ),
    amount_check: check(
      "subscription_allowance_transactions_amount_check",
      sql`${table.sequence} > 0 AND ((${table.kind} = 'close' AND ${table.amount} = 0) OR (${table.kind} <> 'close' AND ${table.amount} > 0)) AND ${table.remaining_before} >= 0 AND ${table.remaining_after} >= 0 AND ${table.expired_before} >= 0 AND ${table.expired_after} >= 0 AND ${table.clawed_back_before} >= 0 AND ${table.clawed_back_after} >= 0`,
    ),
    idempotency_key_check: check(
      "subscription_allowance_transactions_idempotency_key_check",
      sql`${table.idempotency_key} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'`,
    ),
    reservation_shape_check: check(
      "subscription_allowance_transactions_reservation_shape_check",
      sql`(${table.kind} IN ('reserve','settle','refund') AND ${table.funding_reservation_id} IS NOT NULL) OR (${table.kind} IN ('grant','expire','clawback','grant_adjustment','close') AND ${table.funding_reservation_id} IS NULL)`,
    ),
    adjustment_source_check: check(
      "subscription_allowance_transactions_adjustment_source_check",
      sql`(${table.kind} = 'grant_adjustment' AND ${table.source_subscription_id} IS NOT NULL AND ${table.source_subscription_revision} IS NOT NULL AND ${table.source_invoice_id} ~ '^in_[A-Za-z0-9]+$' AND ${table.source_plan_key} IN ('plus_monthly','pro_monthly') AND length(btrim(${table.source_catalog_version})) > 0) OR (${table.kind} <> 'grant_adjustment' AND ${table.source_subscription_id} IS NULL AND ${table.source_subscription_revision} IS NULL AND ${table.source_invoice_id} IS NULL AND ${table.source_plan_key} IS NULL AND ${table.source_catalog_version} IS NULL)`,
    ),
    snapshot_transition_check: check(
      "subscription_allowance_transactions_snapshot_transition_check",
      sql`(${table.kind} = 'grant' AND ${table.remaining_before} = 0 AND ${table.remaining_after} = ${table.amount} AND ${table.expired_before} = ${table.expired_after} AND ${table.clawed_back_before} = ${table.clawed_back_after}) OR (${table.kind} = 'grant_adjustment' AND ${table.remaining_after} = ${table.remaining_before} + ${table.amount} AND ${table.expired_before} = ${table.expired_after} AND ${table.clawed_back_before} = ${table.clawed_back_after}) OR (${table.kind} = 'reserve' AND ${table.remaining_after} = ${table.remaining_before} - ${table.amount} AND ${table.expired_before} = ${table.expired_after} AND ${table.clawed_back_before} = ${table.clawed_back_after}) OR (${table.kind} = 'settle' AND ${table.remaining_after} = ${table.remaining_before} AND ${table.expired_before} = ${table.expired_after} AND ${table.clawed_back_before} = ${table.clawed_back_after}) OR (${table.kind} = 'refund' AND (((${table.remaining_after} = ${table.remaining_before} + ${table.amount}) AND ${table.expired_before} = ${table.expired_after}) OR (${table.remaining_after} = ${table.remaining_before} AND ${table.expired_after} = ${table.expired_before} + ${table.amount})) AND ${table.clawed_back_before} = ${table.clawed_back_after}) OR (${table.kind} = 'expire' AND ${table.remaining_after} = ${table.remaining_before} - ${table.amount} AND ${table.expired_after} = ${table.expired_before} + ${table.amount} AND ${table.clawed_back_before} = ${table.clawed_back_after}) OR (${table.kind} = 'clawback' AND ${table.remaining_after} = ${table.remaining_before} - ${table.amount} AND ${table.clawed_back_after} = ${table.clawed_back_before} + ${table.amount} AND ${table.expired_before} = ${table.expired_after}) OR (${table.kind} = 'close' AND ${table.remaining_after} = ${table.remaining_before} AND ${table.remaining_before} = 0 AND ${table.expired_before} = ${table.expired_after} AND ${table.clawed_back_before} = ${table.clawed_back_after})`,
    ),
  }),
);

export type SubscriptionAllowanceTransaction = InferSelectModel<
  typeof subscriptionAllowanceTransactions
>;
export type NewSubscriptionAllowanceTransaction = InferInsertModel<
  typeof subscriptionAllowanceTransactions
>;
