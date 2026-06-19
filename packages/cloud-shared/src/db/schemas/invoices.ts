import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Invoices table schema.
 *
 * Stores Stripe invoice records with credit purchase tracking.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id").notNull(),

    stripe_invoice_id: text("stripe_invoice_id").notNull().unique(),
    stripe_customer_id: text("stripe_customer_id").notNull(),
    stripe_payment_intent_id: text("stripe_payment_intent_id"),

    amount_due: numeric("amount_due", { precision: 10, scale: 2 }).notNull(),
    amount_paid: numeric("amount_paid", { precision: 10, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("usd"),

    status: text("status").notNull(),
    invoice_type: text("invoice_type").notNull(),

    invoice_number: text("invoice_number"),
    invoice_pdf: text("invoice_pdf"),
    hosted_invoice_url: text("hosted_invoice_url"),

    credits_added: numeric("credits_added", { precision: 10, scale: 2 }),

    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),

    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    due_date: timestamp("due_date"),
    paid_at: timestamp("paid_at"),
  },
  (table) => ({
    org_idx: index("invoices_organization_idx").on(table.organization_id),
    stripe_invoice_idx: index("invoices_stripe_invoice_idx").on(table.stripe_invoice_id),
    status_idx: index("invoices_status_idx").on(table.status),
  }),
);

export type Invoice = InferSelectModel<typeof invoices>;
export type NewInvoice = InferInsertModel<typeof invoices>;
