/**
 * Defines the provider-neutral receipt projection for settled payment requests.
 * These rows prove provider payment and are deliberately not tax or legal invoices.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { type PaymentRequestProvider, paymentRequests } from "./payment-requests";

export const PAYMENT_REQUEST_RECEIPT_TYPES = ["provider_payment_receipt"] as const;
export type PaymentRequestReceiptType = (typeof PAYMENT_REQUEST_RECEIPT_TYPES)[number];

export const paymentRequestReceipts = pgTable(
  "payment_request_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    payment_request_id: uuid("payment_request_id").notNull(),
    receipt_type: text("receipt_type")
      .$type<PaymentRequestReceiptType>()
      .notNull()
      .default("provider_payment_receipt"),
    provider: text("provider")
      .$type<Extract<PaymentRequestProvider, "stripe" | "oxapay">>()
      .notNull(),
    provider_tx_ref: text("provider_tx_ref").notNull(),
    provider_event_id: text("provider_event_id").notNull(),
    amount_cents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    settled_at: timestamp("settled_at", { withTimezone: true }).notNull(),
    payload_digest: text("payload_digest").notNull(),
    settlement_proof: jsonb("settlement_proof").$type<Record<string, unknown>>().notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    request_unique: unique("payment_request_receipts_request_unique").on(table.payment_request_id),
    receipt_key_unique: unique("payment_request_receipts_key_unique").on(
      table.organization_id,
      table.payment_request_id,
      table.provider,
      table.provider_tx_ref,
    ),
    provider_transaction_unique: unique("payment_request_receipts_provider_transaction_unique").on(
      table.provider,
      table.provider_tx_ref,
    ),
    organization_created_idx: index("payment_request_receipts_org_created_idx").on(
      table.organization_id,
      table.created_at,
    ),
    request_organization_provider_fk: foreignKey({
      name: "payment_request_receipts_request_organization_provider_fkey",
      columns: [table.payment_request_id, table.organization_id, table.provider],
      foreignColumns: [
        paymentRequests.id,
        paymentRequests.organization_id,
        paymentRequests.provider,
      ],
    }).onDelete("restrict"),
    shape_check: check(
      "payment_request_receipts_shape_check",
      sql`(${table.receipt_type} = 'provider_payment_receipt'
        AND ${table.provider} IN ('stripe', 'oxapay')
        AND ${table.amount_cents} > 0
        AND ${table.currency} ~ '^[A-Z]{3,8}$'
        AND ${table.provider_tx_ref} = btrim(${table.provider_tx_ref})
        AND octet_length(${table.provider_tx_ref}) BETWEEN 1 AND 512
        AND ${table.provider_event_id} = btrim(${table.provider_event_id})
        AND octet_length(${table.provider_event_id}) BETWEEN 1 AND 512
        AND ${table.payload_digest} ~ '^[a-f0-9]{64}$') IS TRUE`,
    ),
  }),
);

export type PaymentRequestReceipt = InferSelectModel<typeof paymentRequestReceipts>;
export type NewPaymentRequestReceipt = InferInsertModel<typeof paymentRequestReceipts>;
