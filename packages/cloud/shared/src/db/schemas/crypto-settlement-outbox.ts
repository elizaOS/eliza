/** Durable post-settlement delivery intents for app callbacks and wallet sweeps. */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cryptoPayments } from "./crypto-payments";

export const appChargeCallbackOutbox = pgTable(
  "app_charge_callback_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    delivery_key: text("delivery_key").notNull(),
    charge_request_id: uuid("charge_request_id")
      .notNull()
      .references(() => cryptoPayments.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payload_digest: text("payload_digest").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claim_token: uuid("claim_token"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    last_error: text("last_error"),
    room_delivered_at: timestamp("room_delivered_at", { withTimezone: true }),
    http_delivered_at: timestamp("http_delivered_at", { withTimezone: true }),
    delivered_at: timestamp("delivered_at", { withTimezone: true }),
    terminal_at: timestamp("terminal_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    delivery_unique: uniqueIndex("app_charge_callback_outbox_delivery_uidx").on(table.delivery_key),
    due_idx: index("app_charge_callback_outbox_due_idx")
      .on(table.next_attempt_at, table.created_at)
      .where(sql`${table.state} IN ('pending', 'processing')`),
  }),
);

export interface EvmSweepReceipt {
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  status: "success";
}

export const cryptoSweepOutbox = pgTable(
  "crypto_sweep_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    payment_id: uuid("payment_id")
      .notNull()
      .references(() => cryptoPayments.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payload_digest: text("payload_digest").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claim_token: uuid("claim_token"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    last_error: text("last_error"),
    prepared_transaction: text("prepared_transaction"),
    evm_sender: text("evm_sender"),
    evm_chain_id: bigint("evm_chain_id", { mode: "bigint" }),
    evm_nonce: bigint("evm_nonce", { mode: "bigint" }),
    evm_confirmed_at: timestamp("evm_confirmed_at", { withTimezone: true }),
    evm_confirmed_receipt: jsonb("evm_confirmed_receipt").$type<EvmSweepReceipt>(),
    sweep_transaction_hash: text("sweep_transaction_hash"),
    prepared_metadata: jsonb("prepared_metadata").$type<Record<string, unknown>>(),
    delivered_at: timestamp("delivered_at", { withTimezone: true }),
    terminal_at: timestamp("terminal_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    payment_unique: uniqueIndex("crypto_sweep_outbox_payment_uidx").on(table.payment_id),
    due_idx: index("crypto_sweep_outbox_due_idx")
      .on(table.next_attempt_at, table.created_at)
      .where(sql`${table.state} IN ('pending', 'processing')`),
    evm_confirmation_check: check(
      "crypto_sweep_outbox_evm_confirmation_check",
      sql`
      (${table.evm_confirmed_at} IS NULL) = (${table.evm_confirmed_receipt} IS NULL)
      AND (${table.evm_confirmed_at} IS NULL OR (${table.state}='delivered' AND ${table.evm_sender} IS NOT NULL))`,
    ),
    evm_recovery_due_idx: index("crypto_sweep_outbox_evm_recovery_due_idx")
      .on(table.next_attempt_at, table.created_at)
      .where(sql`${table.state} IN ('delivered','terminal') AND ${table.evm_confirmed_at} IS NULL
        AND ${table.prepared_transaction} IS NOT NULL AND ${table.prepared_metadata}->>'network' IN ('base','bsc')`),
    evm_legacy_idx: index("crypto_sweep_outbox_evm_legacy_idx")
      .on(sql`(${table.prepared_metadata}->>'network')`, table.id)
      .where(sql`${table.evm_sender} IS NULL AND ${table.prepared_transaction} IS NOT NULL`),
    evm_nonce_unique: uniqueIndex("crypto_sweep_outbox_evm_nonce_uidx")
      .on(table.evm_chain_id, table.evm_sender, table.evm_nonce)
      .where(sql`${table.evm_sender} IS NOT NULL`),
    evm_identity_check: check(
      "crypto_sweep_outbox_evm_identity_check",
      sql`
      num_nonnulls(${table.evm_sender},${table.evm_chain_id},${table.evm_nonce})=0
      OR (num_nonnulls(${table.evm_sender},${table.evm_chain_id},${table.evm_nonce})=3 AND ${table.evm_sender} ~ '^0x[0-9a-f]{40}$' AND ${table.evm_chain_id} > 0
        AND ${table.evm_nonce} >= 0 AND ${table.prepared_transaction} IS NOT NULL)`,
    ),
    prepared_pair_check: check(
      "crypto_sweep_outbox_prepared_pair_check",
      sql`(${table.prepared_transaction} IS NULL)
        = (${table.sweep_transaction_hash} IS NULL)
        AND (${table.prepared_transaction} IS NULL) = (${table.prepared_metadata} IS NULL)`,
    ),
  }),
);

export type AppChargeCallbackOutboxRow = InferSelectModel<typeof appChargeCallbackOutbox>;
export type NewAppChargeCallbackOutboxRow = InferInsertModel<typeof appChargeCallbackOutbox>;
export type CryptoSweepOutboxRow = InferSelectModel<typeof cryptoSweepOutbox>;
export type NewCryptoSweepOutboxRow = InferInsertModel<typeof cryptoSweepOutbox>;
