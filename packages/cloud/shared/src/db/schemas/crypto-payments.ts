// Defines the crypto payments Drizzle table shape used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * Crypto payments table schema.
 *
 * Stores cryptocurrency payment records for credit purchases via OxaPay.
 */
export const cryptoPayments = pgTable(
  "crypto_payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),

    // Payment address provided by OxaPay for receiving funds
    payment_address: text("payment_address").notNull(),
    // Token contract address (nullable for native tokens)
    token_address: text("token_address"),
    // Token symbol (e.g., USDT, BTC)
    token: text("token").notNull(),
    // Network name (e.g., TRC20, ERC20, BEP20)
    network: text("network").notNull(),

    // Amount expected to be received (in token units)
    expected_amount: text("expected_amount").notNull(),
    // Amount actually received (in token units)
    received_amount: text("received_amount"),
    // Credits to add to the organization upon payment confirmation
    credits_to_add: text("credits_to_add").notNull(),

    transaction_hash: text("transaction_hash"),
    block_number: text("block_number"),

    status: text("status").notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    confirmed_at: timestamp("confirmed_at"),
    expires_at: timestamp("expires_at").notNull(),

    // Stores OxaPay-specific data: oxapay_track_id, pay_link, fiat_currency, fiat_amount
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  },
  (table) => ({
    org_idx: index("crypto_payments_organization_id_idx").on(table.organization_id),
    user_idx: index("crypto_payments_user_id_idx").on(table.user_id),
    payment_address_idx: index("crypto_payments_payment_address_idx").on(table.payment_address),
    status_idx: index("crypto_payments_status_idx").on(table.status),
    // Uniqueness on transaction_hash is enforced by a PARTIAL unique index
    // scoped to active statuses ('pending','broadcast','confirmed'), managed
    // via migration 0131_partial_unique_tx_hash.sql. Drizzle's schema DSL
    // cannot express the partial WHERE clause cleanly, so we expose a plain
    // (non-unique) lookup index here and let the migration own the constraint.
    tx_hash_idx: index("crypto_payments_transaction_hash_idx").on(table.transaction_hash),
    network_idx: index("crypto_payments_network_idx").on(table.network),
    created_idx: index("crypto_payments_created_at_idx").on(table.created_at),
    expires_idx: index("crypto_payments_expires_at_idx").on(table.expires_at),
    // GIN index for efficient JSONB queries on oxapay_track_id
    metadata_gin_idx: index("crypto_payments_metadata_gin_idx").using("gin", table.metadata),
  }),
);

export type CryptoPayment = InferSelectModel<typeof cryptoPayments>;
export type NewCryptoPayment = InferInsertModel<typeof cryptoPayments>;
