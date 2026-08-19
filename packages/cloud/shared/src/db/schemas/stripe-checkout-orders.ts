/**
 * Defines the server-owned Stripe Checkout quote and fulfillment authority for organization credits.
 */
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { creditPacks } from "./credit-packs";
import { creditTransactions } from "./credit-transactions";
import { organizations } from "./organizations";
import { users } from "./users";

export const STRIPE_CHECKOUT_ORDER_STATUSES = [
  "quoted",
  "provider_started",
  "delivered",
  "provider_ambiguous",
  "settled",
  "failed",
] as const;
export type StripeCheckoutOrderStatus = (typeof STRIPE_CHECKOUT_ORDER_STATUSES)[number];
export const STRIPE_CHECKOUT_PURCHASE_TYPES = ["custom_amount", "credit_pack"] as const;
export type StripeCheckoutPurchaseType = (typeof STRIPE_CHECKOUT_PURCHASE_TYPES)[number];

export const stripeCheckoutOrders = pgTable(
  "stripe_checkout_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    initiated_by_user_id: uuid("initiated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    client_request_key: text("client_request_key").notNull(),
    request_digest: text("request_digest").notNull(),
    purchase_type: text("purchase_type").$type<StripeCheckoutPurchaseType>().notNull(),
    credit_pack_id: uuid("credit_pack_id").references(() => creditPacks.id, {
      onDelete: "restrict",
    }),
    credits_to_grant: numeric("credits_to_grant", { precision: 16, scale: 6 }).notNull(),
    charge_amount_cents: bigint("charge_amount_cents", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    stripe_customer_id: text("stripe_customer_id"),
    stripe_checkout_session_id: text("stripe_checkout_session_id"),
    stripe_payment_intent_id: text("stripe_payment_intent_id"),
    credit_transaction_id: uuid("credit_transaction_id").references(() => creditTransactions.id, {
      onDelete: "restrict",
    }),
    status: text("status").$type<StripeCheckoutOrderStatus>().notNull().default("quoted"),
    provider_error_code: text("provider_error_code"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    settled_at: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => ({
    organization_created_idx: index("stripe_checkout_orders_org_created_idx").on(
      table.organization_id,
      table.created_at,
    ),
    organization_request_unique: uniqueIndex("stripe_checkout_orders_org_request_idx").on(
      table.organization_id,
      table.client_request_key,
    ),
    status_updated_idx: index("stripe_checkout_orders_status_updated_idx").on(
      table.status,
      table.updated_at,
    ),
    checkout_session_unique: uniqueIndex("stripe_checkout_orders_session_idx")
      .on(table.stripe_checkout_session_id)
      .where(sql`${table.stripe_checkout_session_id} IS NOT NULL`),
    payment_intent_unique: uniqueIndex("stripe_checkout_orders_payment_intent_idx")
      .on(table.stripe_payment_intent_id)
      .where(sql`${table.stripe_payment_intent_id} IS NOT NULL`),
    credit_transaction_unique: uniqueIndex("stripe_checkout_orders_credit_transaction_idx")
      .on(table.credit_transaction_id)
      .where(sql`${table.credit_transaction_id} IS NOT NULL`),
    status_check: check(
      "stripe_checkout_orders_status_check",
      sql`${table.status} IN ('quoted','provider_started','delivered','provider_ambiguous','settled','failed')`,
    ),
    purchase_type_check: check(
      "stripe_checkout_orders_purchase_type_check",
      sql`${table.purchase_type} IN ('custom_amount','credit_pack')`,
    ),
    amount_check: check(
      "stripe_checkout_orders_amount_check",
      sql`${table.credits_to_grant} > 0 AND ${table.credits_to_grant} <= 10000 AND ${table.charge_amount_cents} > 0`,
    ),
    currency_check: check(
      "stripe_checkout_orders_currency_check",
      sql`${table.currency} = lower(${table.currency}) AND ${table.currency} ~ '^[a-z]{3}$'`,
    ),
    request_digest_check: check(
      "stripe_checkout_orders_request_digest_check",
      sql`${table.request_digest} ~ '^[0-9a-f]{64}$'`,
    ),
    request_key_check: check(
      "stripe_checkout_orders_request_key_check",
      sql`${table.client_request_key} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'`,
    ),
    pack_shape_check: check(
      "stripe_checkout_orders_pack_shape_check",
      sql`(${table.purchase_type} = 'credit_pack' AND ${table.credit_pack_id} IS NOT NULL) OR (${table.purchase_type} = 'custom_amount' AND ${table.credit_pack_id} IS NULL)`,
    ),
    settlement_shape_check: check(
      "stripe_checkout_orders_settlement_shape_check",
      sql`(${table.status} = 'settled' AND ${table.stripe_customer_id} IS NOT NULL AND ${table.stripe_checkout_session_id} IS NOT NULL AND ${table.stripe_payment_intent_id} IS NOT NULL AND ${table.credit_transaction_id} IS NOT NULL AND ${table.settled_at} IS NOT NULL) OR (${table.status} <> 'settled' AND ${table.credit_transaction_id} IS NULL AND ${table.settled_at} IS NULL)`,
    ),
    phase_shape_check: check(
      "stripe_checkout_orders_phase_shape_check",
      sql`(${table.status} IN ('quoted','provider_started','provider_ambiguous') AND ${table.stripe_checkout_session_id} IS NULL AND ${table.stripe_payment_intent_id} IS NULL AND (${table.status} = 'quoted' OR ${table.stripe_customer_id} IS NOT NULL)) OR (${table.status} = 'delivered' AND ${table.stripe_customer_id} IS NOT NULL AND ${table.stripe_checkout_session_id} IS NOT NULL AND ${table.stripe_payment_intent_id} IS NULL) OR ${table.status} IN ('settled','failed')`,
    ),
  }),
);

export type StripeCheckoutOrder = InferSelectModel<typeof stripeCheckoutOrders>;
export type NewStripeCheckoutOrder = InferInsertModel<typeof stripeCheckoutOrders>;

export const stripeCheckoutLegacyQuarantine = pgTable(
  "stripe_checkout_legacy_quarantine",
  {
    checkout_session_id: text("checkout_session_id").primaryKey(),
    stripe_payment_intent_id: text("stripe_payment_intent_id").notNull().unique(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    initiated_by_user_id: uuid("initiated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    stripe_customer_id: text("stripe_customer_id"),
    credit_pack_id: uuid("credit_pack_id"),
    claimed_credits: text("claimed_credits"),
    charge_amount_cents: bigint("charge_amount_cents", { mode: "bigint" }),
    currency: text("currency"),
    reason: text("reason").notNull(),
    provider_receipt: jsonb("provider_receipt").$type<Record<string, unknown>>().notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    organization_created_idx: index("stripe_checkout_legacy_quarantine_org_created_idx").on(
      table.organization_id,
      table.created_at,
    ),
  }),
);
