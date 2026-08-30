// Defines the credit transactions Drizzle table shape used by cloud repositories and services.
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * Credit transactions table schema.
 *
 * Tracks all credit-related transactions including purchases, deductions, and adjustments.
 */
export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    amount: numeric("amount", { precision: 16, scale: 6 }).notNull(),
    type: text("type").notNull(),
    description: text("description"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    stripe_payment_intent_id: text("stripe_payment_intent_id"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    settled_at: timestamp("settled_at"),
  },
  (table) => ({
    organization_idx: index("credit_transactions_organization_idx").on(table.organization_id),
    user_idx: index("credit_transactions_user_idx").on(table.user_id),
    type_idx: index("credit_transactions_type_idx").on(table.type),
    created_at_idx: index("credit_transactions_created_at_idx").on(table.created_at),
    unsettled_reservations_idx: index("credit_transactions_unsettled_reservations_idx")
      .on(table.created_at)
      .where(
        sql`${table.type} = 'debit' AND (( ${table.metadata}->>'type' = 'reservation' AND ${table.metadata}->>'settlement_marker' = 'credit_reservation_v1') OR (${table.metadata}->>'type' = 'app_chat_reservation' AND ${table.metadata}->>'settlement_marker' = 'app_chat_reservation_v1')) AND ${table.settled_at} IS NULL`,
      ),
    app_usage_projection_source_idx: index("credit_transactions_app_usage_projection_source_idx")
      .on(table.created_at, table.id)
      .where(
        sql`${table.type} = 'debit' AND ${table.metadata}->>'appUsageProjectionVersion' = '1'`,
      ),
    // Sweep-support partial index (#22961 round-4): the every-minute orphan
    // sweep filters debit rows by the mcp_precharge marker; declared here so
    // test databases pushed via drizzle-kit carry the same index the migration
    // creates in deployed environments (pg_indexes parity, #27992).
    mcp_precharge_idx: index("credit_transactions_mcp_precharge_idx")
      .on(table.created_at)
      .where(sql`${table.type} = 'debit' AND ${table.metadata}->>'mcp_precharge' = 'v1'`),
    // Refund-linkage partial indexes (#27992 r2 F3): the sweep's correlated
    // refund sums aggregate refund rows by either linkage arm; without an
    // expression index each sum scans the full refund population per examined
    // candidate on the every-minute recovery cron. Both arms are partial on
    // type='refund' so only the refund subset is indexed.
    mcp_precharge_refund_link_idx: index("credit_transactions_mcp_precharge_refund_link_idx")
      .on(sql`(${table.metadata}->>'mcp_precharge_refund_for')`)
      .where(
        sql`${table.type} = 'refund' AND ${table.metadata}->>'mcp_precharge_refund_for' IS NOT NULL`,
      ),
    reservation_refund_link_idx: index("credit_transactions_reservation_refund_link_idx")
      .on(sql`(${table.metadata}->>'reservation_transaction_id')`)
      .where(
        sql`${table.type} = 'refund' AND ${table.metadata}->>'reservation_transaction_id' IS NOT NULL`,
      ),
    stripe_payment_intent_idx: uniqueIndex("credit_transactions_stripe_payment_intent_idx").on(
      table.stripe_payment_intent_id,
    ),
    tenant_identity_unique: unique("credit_transactions_id_organization_unique").on(
      table.id,
      table.organization_id,
    ),
  }),
);

// Type inference
export type CreditTransaction = InferSelectModel<typeof creditTransactions>;
export type NewCreditTransaction = InferInsertModel<typeof creditTransactions>;
