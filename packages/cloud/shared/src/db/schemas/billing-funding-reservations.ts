/** Defines exact tenant-scoped allowance and purchased-credit funding reservations. */
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

export const BILLING_FUNDING_RESERVATION_STATUSES = [
  "reserved",
  "settled",
  "partially_refunded",
  "refunded",
] as const;
export type BillingFundingReservationStatus = (typeof BILLING_FUNDING_RESERVATION_STATUSES)[number];
export const BILLING_FUNDING_CLASSES = ["allowance_eligible", "cash_only"] as const;
export type BillingFundingClass = (typeof BILLING_FUNDING_CLASSES)[number];
export const BILLING_FUNDING_RESERVATION_PHASES = ["initial", "overage"] as const;
export type BillingFundingReservationPhase = (typeof BILLING_FUNDING_RESERVATION_PHASES)[number];

export const billingFundingReservations = pgTable(
  "billing_funding_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    logical_operation_id: text("logical_operation_id").notNull(),
    funding_class: text("funding_class").$type<BillingFundingClass>().notNull(),
    requested_amount: numeric("requested_amount", { precision: 16, scale: 6 }).notNull(),
    allowance_amount: numeric("allowance_amount", { precision: 16, scale: 6 }).notNull(),
    purchased_credit_amount: numeric("purchased_credit_amount", {
      precision: 16,
      scale: 6,
    }).notNull(),
    allowance_period_id: uuid("allowance_period_id"),
    settled_allowance_amount: numeric("settled_allowance_amount", {
      precision: 16,
      scale: 6,
    })
      .notNull()
      .default("0.000000"),
    settled_purchased_credit_amount: numeric("settled_purchased_credit_amount", {
      precision: 16,
      scale: 6,
    })
      .notNull()
      .default("0.000000"),
    refunded_allowance_amount: numeric("refunded_allowance_amount", {
      precision: 16,
      scale: 6,
    })
      .notNull()
      .default("0.000000"),
    refunded_purchased_credit_amount: numeric("refunded_purchased_credit_amount", {
      precision: 16,
      scale: 6,
    })
      .notNull()
      .default("0.000000"),
    purchased_credit_reservation_transaction_id: uuid(
      "purchased_credit_reservation_transaction_id",
    ),
    purchased_credit_settlement_transaction_id: uuid("purchased_credit_settlement_transaction_id"),
    purchased_credit_refund_transaction_id: uuid("purchased_credit_refund_transaction_id"),
    status: text("status").$type<BillingFundingReservationStatus>().notNull().default("reserved"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    settled_at: timestamp("settled_at", { withTimezone: true }),
    closed_at: timestamp("closed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    reservation_phase: text("reservation_phase")
      .$type<BillingFundingReservationPhase>()
      .notNull()
      .default("initial"),
    phase_sequence: integer("phase_sequence").notNull().default(0),
    parent_reservation_id: uuid("parent_reservation_id"),
    root_reservation_id: uuid("root_reservation_id"),
  },
  (table) => ({
    allowance_period_tenant_fk: foreignKey({
      columns: [table.allowance_period_id, table.organization_id],
      foreignColumns: [
        subscriptionAllowancePeriods.id,
        subscriptionAllowancePeriods.organization_id,
      ],
      name: "billing_funding_reservations_allowance_period_tenant_fk",
    }).onDelete("restrict"),
    parent_reservation_tenant_fk: foreignKey({
      columns: [table.parent_reservation_id, table.organization_id],
      foreignColumns: [table.id, table.organization_id],
      name: "billing_funding_reservations_parent_tenant_fk",
    }).onDelete("restrict"),
    root_reservation_tenant_fk: foreignKey({
      columns: [table.root_reservation_id, table.organization_id],
      foreignColumns: [table.id, table.organization_id],
      name: "billing_funding_reservations_root_tenant_fk",
    }).onDelete("restrict"),
    purchased_credit_reservation_tenant_fk: foreignKey({
      columns: [table.purchased_credit_reservation_transaction_id, table.organization_id],
      foreignColumns: [creditTransactions.id, creditTransactions.organization_id],
      name: "billing_funding_reservations_credit_reserve_tenant_fk",
    }).onDelete("restrict"),
    purchased_credit_settlement_tenant_fk: foreignKey({
      columns: [table.purchased_credit_settlement_transaction_id, table.organization_id],
      foreignColumns: [creditTransactions.id, creditTransactions.organization_id],
      name: "billing_funding_reservations_credit_settle_tenant_fk",
    }).onDelete("restrict"),
    purchased_credit_refund_tenant_fk: foreignKey({
      columns: [table.purchased_credit_refund_transaction_id, table.organization_id],
      foreignColumns: [creditTransactions.id, creditTransactions.organization_id],
      name: "billing_funding_reservations_credit_refund_tenant_fk",
    }).onDelete("restrict"),
    id_organization_unique: uniqueIndex("billing_funding_reservations_id_org_idx").on(
      table.id,
      table.organization_id,
    ),
    organization_operation_unique: uniqueIndex("billing_funding_reservations_org_operation_idx").on(
      table.organization_id,
      table.logical_operation_id,
    ),
    root_phase_sequence_unique: uniqueIndex("billing_funding_reservations_root_phase_sequence_idx")
      .on(table.organization_id, table.root_reservation_id, table.phase_sequence)
      .where(sql`${table.reservation_phase} = 'overage'`),
    organization_status_expiry_idx: index("billing_funding_reservations_org_status_expiry_idx").on(
      table.organization_id,
      table.status,
      table.expires_at,
    ),
    operation_id_check: check(
      "billing_funding_reservations_operation_id_check",
      sql`${table.logical_operation_id} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'`,
    ),
    status_check: check(
      "billing_funding_reservations_status_check",
      sql`${table.status} IN ('reserved','settled','partially_refunded','refunded') AND ${table.funding_class} IN ('allowance_eligible','cash_only')`,
    ),
    phase_shape_check: check(
      "billing_funding_reservations_phase_shape_check",
      sql`(${table.reservation_phase} = 'initial' AND ${table.phase_sequence} = 0 AND ${table.parent_reservation_id} IS NULL AND ${table.root_reservation_id} IS NULL) OR (${table.reservation_phase} = 'overage' AND ${table.phase_sequence} > 0 AND ${table.parent_reservation_id} IS NOT NULL AND ${table.root_reservation_id} IS NOT NULL AND ${table.parent_reservation_id} <> ${table.id} AND ${table.root_reservation_id} <> ${table.id})`,
    ),
    allocation_check: check(
      "billing_funding_reservations_allocation_check",
      sql`${table.requested_amount} > 0 AND ${table.allowance_amount} >= 0 AND ${table.purchased_credit_amount} >= 0 AND ${table.allowance_amount} + ${table.purchased_credit_amount} = ${table.requested_amount} AND ((${table.allowance_amount} = 0 AND ${table.allowance_period_id} IS NULL) OR (${table.allowance_amount} > 0 AND ${table.allowance_period_id} IS NOT NULL)) AND (${table.funding_class} = 'allowance_eligible' OR (${table.funding_class} = 'cash_only' AND ${table.allowance_amount} = 0))`,
    ),
    settlement_amounts_check: check(
      "billing_funding_reservations_settlement_amounts_check",
      sql`${table.settled_allowance_amount} >= 0 AND ${table.settled_purchased_credit_amount} >= 0 AND ${table.refunded_allowance_amount} >= 0 AND ${table.refunded_purchased_credit_amount} >= 0 AND ${table.refunded_allowance_amount} <= ${table.settled_allowance_amount} AND ${table.settled_allowance_amount} <= ${table.allowance_amount} AND ${table.refunded_purchased_credit_amount} <= ${table.settled_purchased_credit_amount} AND ${table.settled_purchased_credit_amount} <= ${table.purchased_credit_amount}`,
    ),
    purchased_credit_reference_check: check(
      "billing_funding_reservations_credit_reference_check",
      sql`((${table.purchased_credit_amount} = 0 AND ${table.purchased_credit_reservation_transaction_id} IS NULL) OR (${table.purchased_credit_amount} > 0 AND ${table.purchased_credit_reservation_transaction_id} IS NOT NULL)) AND ((${table.settled_purchased_credit_amount} = 0 AND ${table.purchased_credit_settlement_transaction_id} IS NULL) OR (${table.settled_purchased_credit_amount} > 0 AND ${table.purchased_credit_settlement_transaction_id} IS NOT NULL)) AND ((${table.refunded_purchased_credit_amount} = 0 AND ${table.purchased_credit_refund_transaction_id} IS NULL) OR (${table.refunded_purchased_credit_amount} > 0 AND ${table.purchased_credit_refund_transaction_id} IS NOT NULL))`,
    ),
    terminal_shape_check: check(
      "billing_funding_reservations_terminal_shape_check",
      sql`(${table.status} = 'reserved' AND ${table.settled_at} IS NULL AND ${table.closed_at} IS NULL AND ${table.settled_allowance_amount} = 0 AND ${table.settled_purchased_credit_amount} = 0 AND ${table.refunded_allowance_amount} = 0 AND ${table.refunded_purchased_credit_amount} = 0) OR (${table.status} = 'settled' AND ${table.settled_at} IS NOT NULL AND ${table.closed_at} IS NULL AND ${table.settled_allowance_amount} + ${table.settled_purchased_credit_amount} > 0 AND ${table.refunded_allowance_amount} = 0 AND ${table.refunded_purchased_credit_amount} = 0) OR (${table.status} = 'partially_refunded' AND ${table.settled_at} IS NOT NULL AND ${table.closed_at} IS NULL AND ${table.refunded_allowance_amount} + ${table.refunded_purchased_credit_amount} > 0 AND (${table.refunded_allowance_amount} < ${table.settled_allowance_amount} OR ${table.refunded_purchased_credit_amount} < ${table.settled_purchased_credit_amount})) OR (${table.status} = 'refunded' AND ${table.settled_at} IS NOT NULL AND ${table.closed_at} IS NOT NULL AND ${table.refunded_allowance_amount} = ${table.settled_allowance_amount} AND ${table.refunded_purchased_credit_amount} = ${table.settled_purchased_credit_amount} AND ${table.refunded_allowance_amount} + ${table.refunded_purchased_credit_amount} > 0)`,
    ),
    expiry_check: check(
      "billing_funding_reservations_expiry_check",
      sql`${table.expires_at} > ${table.created_at}`,
    ),
  }),
);

export type BillingFundingReservation = InferSelectModel<typeof billingFundingReservations>;
export type NewBillingFundingReservation = InferInsertModel<typeof billingFundingReservations>;
