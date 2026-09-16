/** Defines funding reservation identity and exact per-source allocation prerequisites. */
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { creditTransactions } from "./credit-transactions";
import { organizations } from "./organizations";
import { subscriptionAllowancePeriods } from "./subscription-allowance-periods";

export const BILLING_FUNDING_RESERVATION_STATUSES = ["reserved", "finalized", "canceled"] as const;
export type BillingFundingReservationStatus = (typeof BILLING_FUNDING_RESERVATION_STATUSES)[number];
export const BILLING_FUNDING_CLASSES = ["allowance_eligible", "cash_only"] as const;
export type BillingFundingClass = (typeof BILLING_FUNDING_CLASSES)[number];
export const BILLING_FUNDING_ALLOCATION_SOURCES = ["allowance", "purchased_credit"] as const;
export type BillingFundingAllocationSource = (typeof BILLING_FUNDING_ALLOCATION_SOURCES)[number];

export const billingFundingReservations = pgTable(
  "billing_funding_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    logical_operation_id: text("logical_operation_id").notNull(),
    request_digest: text("request_digest").notNull(),
    funding_class: text("funding_class").$type<BillingFundingClass>().notNull(),
    requested_amount: numeric("requested_amount", { precision: 16, scale: 6 }).notNull(),
    reserved_amount: numeric("reserved_amount", { precision: 16, scale: 6 }).notNull(),
    uncollected_overage_amount: numeric("uncollected_overage_amount", {
      precision: 16,
      scale: 6,
    })
      .notNull()
      .default("0.000000"),
    status: text("status").$type<BillingFundingReservationStatus>().notNull().default("reserved"),
    settlement_key: text("settlement_key"),
    settlement_digest: text("settlement_digest"),
    cancellation_key: text("cancellation_key"),
    cancellation_digest: text("cancellation_digest"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    finalized_at: timestamp("finalized_at", { withTimezone: true }),
    canceled_at: timestamp("canceled_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    id_organization_unique: uniqueIndex("billing_funding_reservations_id_org_idx").on(
      table.id,
      table.organization_id,
    ),
    organization_operation_unique: uniqueIndex("billing_funding_reservations_org_operation_idx").on(
      table.organization_id,
      table.logical_operation_id,
    ),
    settlement_key_unique: uniqueIndex("billing_funding_reservations_org_settlement_key_idx")
      .on(table.organization_id, table.settlement_key)
      .where(sql`${table.settlement_key} IS NOT NULL`),
    cancellation_key_unique: uniqueIndex("billing_funding_reservations_org_cancellation_key_idx")
      .on(table.organization_id, table.cancellation_key)
      .where(sql`${table.cancellation_key} IS NOT NULL`),
    organization_status_expiry_idx: index("billing_funding_reservations_org_status_expiry_idx").on(
      table.organization_id,
      table.status,
      table.expires_at,
    ),
    identity_check: check(
      "billing_funding_reservations_identity_check",
      sql`${table.logical_operation_id} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' AND ${table.request_digest} ~ '^[0-9a-f]{64}$'`,
    ),
    amount_check: check(
      "billing_funding_reservations_amount_check",
      sql`${table.requested_amount} > 0 AND ${table.reserved_amount} = ${table.requested_amount}`,
    ),
    uncollected_overage_check: check(
      "billing_funding_reservations_uncollected_overage_check",
      sql`${table.uncollected_overage_amount} >= 0 AND (${table.status} = 'finalized' OR ${table.uncollected_overage_amount} = 0)`,
    ),
    funding_class_check: check(
      "billing_funding_reservations_funding_class_check",
      sql`${table.funding_class} IN ('allowance_eligible','cash_only')`,
    ),
    terminal_shape_check: check(
      "billing_funding_reservations_terminal_shape_check",
      sql`(${table.status} = 'reserved' AND ${table.finalized_at} IS NULL AND ${table.canceled_at} IS NULL AND ${table.settlement_key} IS NULL AND ${table.settlement_digest} IS NULL AND ${table.cancellation_key} IS NULL AND ${table.cancellation_digest} IS NULL) OR (${table.status} = 'finalized' AND ${table.finalized_at} IS NOT NULL AND ${table.canceled_at} IS NULL AND ${table.settlement_key} IS NOT NULL AND ${table.settlement_digest} ~ '^[0-9a-f]{64}$' AND ${table.cancellation_key} IS NULL AND ${table.cancellation_digest} IS NULL) OR (${table.status} = 'canceled' AND ${table.canceled_at} IS NOT NULL AND ${table.finalized_at} IS NULL AND ${table.cancellation_key} IS NOT NULL AND ${table.cancellation_digest} ~ '^[0-9a-f]{64}$' AND ${table.settlement_key} IS NULL AND ${table.settlement_digest} IS NULL)`,
    ),
    expiry_check: check(
      "billing_funding_reservations_expiry_check",
      sql`${table.expires_at} > ${table.created_at}`,
    ),
  }),
);

export const billingFundingAllocations = pgTable(
  "billing_funding_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id").notNull(),
    reservation_id: uuid("reservation_id").notNull(),
    sequence: integer("sequence").notNull(),
    source: text("source").$type<BillingFundingAllocationSource>().notNull(),
    allowance_period_id: uuid("allowance_period_id"),
    purchased_credit_reservation_transaction_id: uuid(
      "purchased_credit_reservation_transaction_id",
    ),
    purchased_credit_settlement_transaction_id: uuid("purchased_credit_settlement_transaction_id"),
    purchased_credit_refund_transaction_id: uuid("purchased_credit_refund_transaction_id"),
    reserved_amount: numeric("reserved_amount", { precision: 16, scale: 6 }).notNull(),
    finalized_amount: numeric("finalized_amount", { precision: 16, scale: 6 })
      .notNull()
      .default("0.000000"),
    released_amount: numeric("released_amount", { precision: 16, scale: 6 })
      .notNull()
      .default("0.000000"),
    expired_refund_amount: numeric("expired_refund_amount", { precision: 16, scale: 6 })
      .notNull()
      .default("0.000000"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    id_organization_unique: uniqueIndex("billing_funding_allocations_id_org_idx").on(
      table.id,
      table.organization_id,
    ),
    reservation_tenant_fk: foreignKey({
      columns: [table.reservation_id, table.organization_id],
      foreignColumns: [billingFundingReservations.id, billingFundingReservations.organization_id],
      name: "billing_funding_allocations_reservation_tenant_fk",
    }).onDelete("restrict"),
    allowance_period_tenant_fk: foreignKey({
      columns: [table.allowance_period_id, table.organization_id],
      foreignColumns: [
        subscriptionAllowancePeriods.id,
        subscriptionAllowancePeriods.organization_id,
      ],
      name: "billing_funding_allocations_allowance_period_tenant_fk",
    }).onDelete("restrict"),
    purchased_reservation_tenant_fk: foreignKey({
      columns: [table.purchased_credit_reservation_transaction_id, table.organization_id],
      foreignColumns: [creditTransactions.id, creditTransactions.organization_id],
      name: "billing_funding_allocations_credit_reserve_tenant_fk",
    }).onDelete("restrict"),
    purchased_settlement_tenant_fk: foreignKey({
      columns: [table.purchased_credit_settlement_transaction_id, table.organization_id],
      foreignColumns: [creditTransactions.id, creditTransactions.organization_id],
      name: "billing_funding_allocations_credit_settle_tenant_fk",
    }).onDelete("restrict"),
    purchased_refund_tenant_fk: foreignKey({
      columns: [table.purchased_credit_refund_transaction_id, table.organization_id],
      foreignColumns: [creditTransactions.id, creditTransactions.organization_id],
      name: "billing_funding_allocations_credit_refund_tenant_fk",
    }).onDelete("restrict"),
    reservation_sequence_unique: uniqueIndex("billing_funding_allocations_reservation_seq_idx").on(
      table.reservation_id,
      table.sequence,
    ),
    purchased_reservation_unique: uniqueIndex("billing_funding_allocations_credit_reserve_idx")
      .on(table.purchased_credit_reservation_transaction_id)
      .where(sql`${table.purchased_credit_reservation_transaction_id} IS NOT NULL`),
    purchased_settlement_unique: uniqueIndex("billing_funding_allocations_credit_settle_idx")
      .on(table.purchased_credit_settlement_transaction_id)
      .where(sql`${table.purchased_credit_settlement_transaction_id} IS NOT NULL`),
    purchased_refund_unique: uniqueIndex("billing_funding_allocations_credit_refund_idx")
      .on(table.purchased_credit_refund_transaction_id)
      .where(sql`${table.purchased_credit_refund_transaction_id} IS NOT NULL`),
    amount_check: check(
      "billing_funding_allocations_amount_check",
      sql`${table.sequence} > 0 AND ${table.reserved_amount} > 0 AND ${table.finalized_amount} >= 0 AND ${table.released_amount} >= 0 AND ${table.expired_refund_amount} >= 0 AND ${table.finalized_amount} + ${table.released_amount} + ${table.expired_refund_amount} <= ${table.reserved_amount}`,
    ),
    source_shape_check: check(
      "billing_funding_allocations_source_shape_check",
      sql`(${table.source} = 'allowance' AND ${table.allowance_period_id} IS NOT NULL AND ${table.purchased_credit_reservation_transaction_id} IS NULL AND ${table.purchased_credit_settlement_transaction_id} IS NULL AND ${table.purchased_credit_refund_transaction_id} IS NULL) OR (${table.source} = 'purchased_credit' AND ${table.allowance_period_id} IS NULL AND ${table.purchased_credit_reservation_transaction_id} IS NOT NULL)`,
    ),
  }),
);

export type BillingFundingReservation = InferSelectModel<typeof billingFundingReservations>;
export type NewBillingFundingReservation = InferInsertModel<typeof billingFundingReservations>;
export type BillingFundingAllocation = InferSelectModel<typeof billingFundingAllocations>;
export type NewBillingFundingAllocation = InferInsertModel<typeof billingFundingAllocations>;
