/**
 * First-committed-wins settlement authority for one MCP purchase (#22961).
 *
 * One MCP proxy call debits the buyer once and must credit every payout leg
 * exactly once. Before this table nothing linked the buyer debit to the
 * affiliate/creator legs: the creator earning was keyed on the constant MCP id
 * with no dedupe, the creator org-credit and usage rows had no idempotency at
 * all, and a settlement retry (Worker lost response, redelivery) replayed
 * every leg. This row is the single authoritative receipt: `payment_event_id`
 * is the canonical identity of the economic event (the precharge credit
 * transaction for credits purchases, the provider payment id for x402), unique
 * per payment type, and each payout leg carries the resulting settlement id in
 * its own idempotency key. Column comments below are the economic invariant
 * contract; `user-mcps.ts` enforces replay equality before resuming legs.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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
import { userMcps } from "./user-mcps";

/**
 * Immutable economics snapshot for the settlement, copied from the completed
 * precharge receipt at claim time (canonical USD micro-grid values, matching
 * the `mcp_usage` receipt columns).
 */
export const mcpSettlements = pgTable(
  "mcp_settlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Buyer leg: the credit transaction that debited the buyer (credits purchases). */
    buyer_credit_transaction_id: uuid("buyer_credit_transaction_id"),
    buyer_organization_id: uuid("buyer_organization_id").notNull(),
    buyer_user_id: uuid("buyer_user_id"),

    mcp_id: uuid("mcp_id").notNull(),
    tool_name: text("tool_name").notNull(),

    /** 'credits' | 'x402' — the payment rail that funded this settlement. */
    payment_type: text("payment_type").notNull(),
    /**
     * Canonical identity of the economic event: the precharge credit
     * transaction id for 'credits', the provider payment id for 'x402'. A
     * retry of the same event reuses this key and dedupes; the same key with
     * different economics is rejected as a replay mismatch.
     */
    payment_event_id: text("payment_event_id").notNull(),

    affiliate_owner_id: uuid("affiliate_owner_id"),
    affiliate_code_id: uuid("affiliate_code_id"),

    creator_organization_id: uuid("creator_organization_id").notNull(),
    creator_user_id: uuid("creator_user_id"),

    base_amount_usd: numeric("base_amount_usd", { precision: 18, scale: 6 }).notNull(),
    affiliate_fee_usd: numeric("affiliate_fee_usd", { precision: 18, scale: 6 }).notNull(),
    platform_fee_usd: numeric("platform_fee_usd", { precision: 18, scale: 6 }).notNull(),
    /** Buyer debit: must equal base + affiliate fee + platform fee (check below). */
    total_amount_usd: numeric("total_amount_usd", { precision: 18, scale: 6 }).notNull(),

    creator_earnings_usd: numeric("creator_earnings_usd", { precision: 18, scale: 6 }).notNull(),
    platform_earnings_usd: numeric("platform_earnings_usd", { precision: 18, scale: 6 }).notNull(),

    /** x402 rail: the provider-payment USD amount that funded this purchase. */
    x402_amount_usd: numeric("x402_amount_usd", { precision: 18, scale: 6 }).notNull().default("0"),

    /** 'settling' while legs apply; 'settled' is the terminal success receipt. */
    status: text("status").notNull().default("settling"),

    /** Completed-leg linkage: set as each leg commits, read by recovery replays. */
    affiliate_ledger_entry_id: uuid("affiliate_ledger_entry_id"),
    creator_credit_transaction_id: uuid("creator_credit_transaction_id"),
    creator_ledger_entry_id: uuid("creator_ledger_entry_id"),
    mcp_usage_id: uuid("mcp_usage_id"),

    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settled_at: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => ({
    // One receipt per economic event per rail: the replay/duplicate gate.
    payment_event_uidx: uniqueIndex("mcp_settlements_payment_event_uidx").on(
      table.payment_type,
      table.payment_event_id,
    ),
    mcp_idx: index("mcp_settlements_mcp_idx").on(table.mcp_id),
    buyer_org_idx: index("mcp_settlements_buyer_org_idx").on(table.buyer_organization_id),
    // Sweep-support partial indexes (#22961 round-4): declared here so test
    // databases pushed via drizzle-kit carry the same indexes the migration
    // creates in deployed environments (the pg_indexes parity assertion in
    // mcp-settlement-balanced-ledger.test.ts guards the match, #27992).
    resume_due_idx: index("mcp_settlements_resume_due_idx")
      .on(table.created_at)
      .where(sql`${table.status} = 'settling'`),
    buyer_tenant_fk: foreignKey({
      name: "mcp_settlements_buyer_tenant_fk",
      columns: [table.buyer_credit_transaction_id, table.buyer_organization_id],
      foreignColumns: [creditTransactions.id, creditTransactions.organization_id],
    }).onDelete("restrict"),
    mcp_fk: foreignKey({
      name: "mcp_settlements_mcp_fk",
      columns: [table.mcp_id],
      foreignColumns: [userMcps.id],
    }).onDelete("restrict"),
    creator_org_fk: foreignKey({
      name: "mcp_settlements_creator_org_fk",
      columns: [table.creator_organization_id],
      foreignColumns: [organizations.id],
    }).onDelete("restrict"),
    receipt_check: check(
      "mcp_settlements_receipt_check",
      sql`${table.base_amount_usd} >= 0 AND ${table.affiliate_fee_usd} >= 0 AND ${table.platform_fee_usd} >= 0 AND ${table.total_amount_usd} = ${table.base_amount_usd} + ${table.affiliate_fee_usd} + ${table.platform_fee_usd} AND ${table.total_amount_usd}::text <> 'NaN' AND ${table.creator_earnings_usd} >= 0 AND ${table.platform_earnings_usd} >= 0 AND ${table.creator_earnings_usd}::text <> 'NaN' AND ${table.platform_earnings_usd}::text <> 'NaN'`,
    ),
    status_check: check(
      "mcp_settlements_status_check",
      sql`${table.status} IN ('settling', 'settled')`,
    ),
    x402_check: check(
      "mcp_settlements_x402_check",
      sql`${table.x402_amount_usd} >= 0 AND (${table.payment_type} <> 'x402' OR ${table.x402_amount_usd} > 0)`,
    ),
    rail_shape_check: check(
      "mcp_settlements_rail_shape_check",
      sql`(${table.payment_type} = 'credits' AND ${table.buyer_credit_transaction_id} IS NOT NULL) OR (${table.payment_type} <> 'credits' AND ${table.buyer_credit_transaction_id} IS NULL)`,
    ),
    terminal_shape_check: check(
      "mcp_settlements_terminal_shape_check",
      sql`(${table.status} = 'settling' AND ${table.settled_at} IS NULL) OR (${table.status} = 'settled' AND ${table.settled_at} IS NOT NULL)`,
    ),
  }),
);

export type McpSettlement = typeof mcpSettlements.$inferSelect;
export type NewMcpSettlement = typeof mcpSettlements.$inferInsert;
