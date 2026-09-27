/** Durable organization holds created by final payment reversals (a lost chargeback). */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export type PaymentReversalHoldReason = "chargeback_lost";

export const organizationPaymentReversalHolds = pgTable(
  "organization_payment_reversal_holds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reason: text("reason").$type<PaymentReversalHoldReason>().notNull(),
    stripe_dispute_id: text("stripe_dispute_id").notNull(),
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
    active_organization_idx: index("organization_payment_reversal_holds_active_idx")
      .on(table.organization_id)
      .where(sql`${table.released_at} IS NULL`),
    reason_check: check(
      "organization_payment_reversal_holds_reason_check",
      sql`${table.reason} IN ('chargeback_lost')`,
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
