/**
 * Durable organization billing holds created by Stripe payment reversals
 * (#22930 Decision A). `reversal_shortfall` rows carry the unrecovered amount
 * a refund or dispute clawback could not take from the balance; `chargeback_lost`
 * rows are historical and were superseded by migration 0492.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { creditTransactions } from "./credit-transactions";
import { organizations } from "./organizations";

export type PaymentReversalHoldReason = "chargeback_lost" | "reversal_shortfall";

export const organizationPaymentReversalHolds = pgTable(
  "organization_payment_reversal_holds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reason: text("reason").$type<PaymentReversalHoldReason>().notNull(),
    stripe_dispute_id: text("stripe_dispute_id"),
    /** The clawback that could not recover the full reversal (reversal_shortfall only). */
    clawback_transaction_id: uuid("clawback_transaction_id").references(
      () => creditTransactions.id,
    ),
    /** Unrecovered reversal amount when the hold was placed (USD). */
    shortfall_usd: numeric("shortfall_usd", { precision: 16, scale: 6 }),
    /** Amount still owed; repayment lowers it and the hold clears at zero. */
    outstanding_usd: numeric("outstanding_usd", { precision: 16, scale: 6 }),
    stripe_charge_id: text("stripe_charge_id"),
    stripe_payment_intent_id: text("stripe_payment_intent_id"),
    amount_cents: bigint("amount_cents", { mode: "number" }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    released_at: timestamp("released_at", { withTimezone: true }),
    released_by: text("released_by"),
    release_reason: text("release_reason"),
  },
  (table) => ({
    dispute_unique: uniqueIndex("organization_payment_reversal_holds_dispute_unique").on(
      table.stripe_dispute_id,
    ),
    clawback_unique: uniqueIndex("organization_payment_reversal_holds_clawback_unique").on(
      table.clawback_transaction_id,
    ),
    active_organization_idx: index("organization_payment_reversal_holds_active_idx")
      .on(table.organization_id)
      .where(sql`${table.released_at} IS NULL`),
    reason_check: check(
      "organization_payment_reversal_holds_reason_check",
      sql`${table.reason} IN ('chargeback_lost', 'reversal_shortfall')`,
    ),
    source_shape_check: check(
      "organization_payment_reversal_holds_source_shape_check",
      sql`(${table.reason} = 'chargeback_lost' AND ${table.stripe_dispute_id} IS NOT NULL
          AND ${table.clawback_transaction_id} IS NULL AND ${table.shortfall_usd} IS NULL AND ${table.outstanding_usd} IS NULL)
        OR (${table.reason} = 'reversal_shortfall' AND ${table.clawback_transaction_id} IS NOT NULL
          AND ${table.shortfall_usd} > 0 AND ${table.outstanding_usd} >= 0 AND ${table.outstanding_usd} <= ${table.shortfall_usd})`,
    ),
    release_shape_check: check(
      "organization_payment_reversal_holds_release_shape_check",
      sql`(${table.released_at} IS NULL AND ${table.released_by} IS NULL AND ${table.release_reason} IS NULL)
        OR (${table.released_at} IS NOT NULL AND ${table.released_by} IS NOT NULL AND ${table.release_reason} IS NOT NULL)`,
    ),
  }),
);

export type OrganizationPaymentReversalHold = InferSelectModel<
  typeof organizationPaymentReversalHolds
>;
export type NewOrganizationPaymentReversalHold = InferInsertModel<
  typeof organizationPaymentReversalHolds
>;
