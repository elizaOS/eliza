import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
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
    amount: numeric("amount", { precision: 12, scale: 6 }).notNull(),
    type: text("type").notNull(),
    description: text("description"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    stripe_payment_intent_id: text("stripe_payment_intent_id"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("credit_transactions_organization_idx").on(table.organization_id),
    user_idx: index("credit_transactions_user_idx").on(table.user_id),
    type_idx: index("credit_transactions_type_idx").on(table.type),
    created_at_idx: index("credit_transactions_created_at_idx").on(table.created_at),
    stripe_payment_intent_idx: uniqueIndex("credit_transactions_stripe_payment_intent_idx").on(
      table.stripe_payment_intent_id,
    ),
  }),
);

// Type inference
export type CreditTransaction = InferSelectModel<typeof creditTransactions>;
export type NewCreditTransaction = InferInsertModel<typeof creditTransactions>;
