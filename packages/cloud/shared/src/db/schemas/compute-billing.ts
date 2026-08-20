/**
 * Immutable tenant-bound receipts for elapsed managed-agent compute charges.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { creditTransactions } from "./credit-transactions";
import { organizations } from "./organizations";

export const agentBillingRecords = pgTable(
  "agent_billing_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    sandbox_id: uuid("sandbox_id").notNull(),
    sandbox_status: text("sandbox_status").notNull(),
    billing_period_start: timestamp("billing_period_start", { withTimezone: true }).notNull(),
    billing_period_end: timestamp("billing_period_end", { withTimezone: true }).notNull(),
    hourly_rate: numeric("hourly_rate", { precision: 16, scale: 6 }).notNull(),
    amount: numeric("amount", { precision: 16, scale: 6 }).notNull(),
    rate_segments: jsonb("rate_segments")
      .$type<
        Array<{
          state: string;
          ratePerHour: string;
          startedAt: string;
          endedAt: string;
          amount: string;
        }>
      >()
      .default([])
      .notNull(),
    credit_transaction_id: uuid("credit_transaction_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    credit_transaction_tenant_fk: foreignKey({
      columns: [table.credit_transaction_id, table.organization_id],
      foreignColumns: [creditTransactions.id, creditTransactions.organization_id],
      name: "agent_billing_records_credit_transaction_tenant_fk",
    }).onDelete("restrict"),
    tenant_period_unique: uniqueIndex("agent_billing_records_tenant_period_unique").on(
      table.organization_id,
      table.sandbox_id,
      table.billing_period_start,
    ),
    sandbox_period_end_idx: index("agent_billing_records_sandbox_period_end_idx").on(
      table.sandbox_id,
      table.billing_period_end,
    ),
    positive_period_check: check(
      "agent_billing_records_positive_period_check",
      sql`${table.billing_period_end} > ${table.billing_period_start}`,
    ),
    nonnegative_amount_check: check(
      "agent_billing_records_nonnegative_amount_check",
      sql`${table.amount} >= 0 AND ${table.hourly_rate} >= 0`,
    ),
  }),
);

export type AgentBillingRecord = InferSelectModel<typeof agentBillingRecords>;
export type NewAgentBillingRecord = InferInsertModel<typeof agentBillingRecords>;
