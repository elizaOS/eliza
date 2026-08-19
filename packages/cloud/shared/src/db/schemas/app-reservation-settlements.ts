/** Defines immutable terminal receipts for app-inference reservation settlement. */

import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { creditTransactions } from "./credit-transactions";
import { organizations } from "./organizations";

/**
 * First-committed-wins authority for an app-chat hold. Identity and economics
 * are copied from immutable reservation facts so later delivery replays them.
 */
export const appReservationSettlements = pgTable(
  "app_reservation_settlements",
  {
    reservation_transaction_id: uuid("reservation_transaction_id").primaryKey(),
    organization_id: uuid("organization_id").notNull(),
    app_id: uuid("app_id").notNull(),
    user_id: uuid("user_id").notNull(),
    creator_user_id: uuid("creator_user_id"),
    terminal_source: text("terminal_source").notNull(),
    outcome: text("outcome").notNull(),
    reserved_base_cost: numeric("reserved_base_cost", { precision: 16, scale: 6 }).notNull(),
    actual_base_cost: numeric("actual_base_cost", { precision: 16, scale: 6 }).notNull(),
    markup_percentage: numeric("markup_percentage", { precision: 12, scale: 6 }).notNull(),
    reserved_total_cost: numeric("reserved_total_cost", { precision: 16, scale: 6 }).notNull(),
    actual_total_cost: numeric("actual_total_cost", { precision: 16, scale: 6 }).notNull(),
    organization_adjustment: numeric("organization_adjustment", {
      precision: 16,
      scale: 6,
    }).notNull(),
    creator_adjustment: numeric("creator_adjustment", { precision: 16, scale: 6 }).notNull(),
    platform_adjustment: numeric("platform_adjustment", { precision: 16, scale: 6 }).notNull(),
    credit_transaction_id: uuid("credit_transaction_id"),
    redeemable_ledger_entry_id: uuid("redeemable_ledger_entry_id"),
    app_earnings_transaction_id: uuid("app_earnings_transaction_id"),
    settled_at: timestamp("settled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organization_fk: foreignKey({
      name: "app_reservation_settlements_organization_fk",
      columns: [table.organization_id],
      foreignColumns: [organizations.id],
    }).onDelete("restrict"),
    reservation_tenant_fk: foreignKey({
      name: "app_reservation_settlements_reservation_tenant_fk",
      columns: [table.reservation_transaction_id, table.organization_id],
      foreignColumns: [creditTransactions.id, creditTransactions.organization_id],
    }).onDelete("restrict"),
    adjustment_tenant_fk: foreignKey({
      name: "app_reservation_settlements_adjustment_tenant_fk",
      columns: [table.credit_transaction_id, table.organization_id],
      foreignColumns: [creditTransactions.id, creditTransactions.organization_id],
    }).onDelete("restrict"),
    source_check: check(
      "app_reservation_settlements_source_check",
      sql`${table.terminal_source} IN ('provider','stale_sweep')`,
    ),
    outcome_check: check(
      "app_reservation_settlements_outcome_check",
      sql`${table.outcome} IN ('refund','overage','uncollected_overage','none')`,
    ),
    economics_check: check(
      "app_reservation_settlements_economics_check",
      sql`${table.reserved_base_cost} >= 0 AND ${table.actual_base_cost} >= 0 AND ${table.markup_percentage} >= 0 AND ${table.reserved_total_cost} >= 0 AND ${table.actual_total_cost} >= 0`,
    ),
    org_time_idx: index("app_reservation_settlements_org_time_idx").on(
      table.organization_id,
      table.settled_at,
    ),
  }),
);

export type AppReservationSettlement = InferSelectModel<typeof appReservationSettlements>;
export type NewAppReservationSettlement = InferInsertModel<typeof appReservationSettlements>;

/** Fail-closed terminal markers for pre-authority rows whose economics cannot be reconstructed. */
export const appReservationSettlementQuarantines = pgTable(
  "app_reservation_settlement_quarantines",
  {
    reservation_transaction_id: uuid("reservation_transaction_id").primaryKey(),
    organization_id: uuid("organization_id").notNull(),
    app_id: text("app_id").notNull(),
    user_id: text("user_id").notNull(),
    creator_user_id: text("creator_user_id"),
    reason: text("reason").notNull(),
    quarantined_at: timestamp("quarantined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organization_fk: foreignKey({
      name: "app_reservation_settlement_quarantines_organization_fk",
      columns: [table.organization_id],
      foreignColumns: [organizations.id],
    }).onDelete("restrict"),
    reservation_tenant_fk: foreignKey({
      name: "app_reservation_settlement_quarantines_reservation_tenant_fk",
      columns: [table.reservation_transaction_id, table.organization_id],
      foreignColumns: [creditTransactions.id, creditTransactions.organization_id],
    }).onDelete("restrict"),
    reason_check: check(
      "app_reservation_settlement_quarantines_reason_check",
      sql`${table.reason} = 'pre_authority_economics_unreconstructable'`,
    ),
  }),
);
