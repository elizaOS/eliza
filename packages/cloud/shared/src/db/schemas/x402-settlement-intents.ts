/**
 * Durable record of one x402 top-up, written before the transfer is settled.
 * A settled top-up whose credit did not finish in the request is finished
 * later from this row, so funds taken on-chain always end in a credit.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const X402_SETTLEMENT_INTENT_STATUSES = ["pending", "settled", "credited"] as const;
export type X402SettlementIntentStatus = (typeof X402_SETTLEMENT_INTENT_STATUSES)[number];

export const x402SettlementIntents = pgTable(
  "x402_settlement_intents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The payment identity: the payer's authorization nonce on one network.
    network: text("network").notNull(),
    payer: text("payer").notNull(),
    nonce: text("nonce").notNull(),
    status: text("status").$type<X402SettlementIntentStatus>().notNull().default("pending"),
    wallet_address: text("wallet_address").notNull(),
    amount_usd: numeric("amount_usd", { precision: 12, scale: 2 }).notNull(),
    transaction: text("transaction"),
    credit_key: text("credit_key"),
    source_id: text("source_id"),
    organization_id: uuid("organization_id"),
    last_error: text("last_error"),
    settled_at: timestamp("settled_at", { withTimezone: true }),
    credited_at: timestamp("credited_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identity_idx: uniqueIndex("x402_settlement_intents_identity_idx").on(
      table.network,
      table.payer,
      table.nonce,
    ),
    settled_idx: index("x402_settlement_intents_settled_idx")
      .on(table.updated_at)
      .where(sql`${table.status} = 'settled'`),
    status_check: check(
      "x402_settlement_intents_status_check",
      sql`${table.status} IN ('pending','settled','credited')`,
    ),
    settled_check: check(
      "x402_settlement_intents_settled_check",
      sql`${table.status} = 'pending' OR (${table.transaction} IS NOT NULL AND ${table.credit_key} IS NOT NULL AND ${table.source_id} IS NOT NULL AND ${table.settled_at} IS NOT NULL)`,
    ),
  }),
);

export type X402SettlementIntent = InferSelectModel<typeof x402SettlementIntents>;
export type NewX402SettlementIntent = InferInsertModel<typeof x402SettlementIntents>;
