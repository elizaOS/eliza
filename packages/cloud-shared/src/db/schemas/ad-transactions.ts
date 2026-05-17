import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { adCampaigns } from "./ad-campaigns";
import { creditTransactions } from "./credit-transactions";
import { organizations } from "./organizations";

/**
 * Ad transaction type.
 */
export type AdTransactionType = "budget_allocation" | "spend" | "refund" | "adjustment";

/**
 * Ad transactions table schema.
 *
 * Tracks all credit movements related to advertising.
 * Links to credit_transactions for combined credit tracking.
 */
export const adTransactions = pgTable(
  "ad_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    campaign_id: uuid("campaign_id").references(() => adCampaigns.id, {
      onDelete: "set null",
    }),

    // Link to credit transaction for combined tracking
    credit_transaction_id: uuid("credit_transaction_id").references(() => creditTransactions.id, {
      onDelete: "set null",
    }),

    type: text("type").$type<AdTransactionType>().notNull(),

    // Amount in platform currency (e.g., USD spent on ads)
    amount: numeric("amount", { precision: 12, scale: 4 }).notNull(),
    currency: text("currency").notNull().default("USD"),

    // Credits used (includes markup)
    credits_amount: numeric("credits_amount", {
      precision: 12,
      scale: 4,
    }).notNull(),

    description: text("description").notNull(),

    // External reference from ad platform
    external_reference: text("external_reference"),

    metadata: jsonb("metadata")
      .$type<{
        markup_percentage?: number;
        platform_fee?: number;
        sync_source?: string;
      }>()
      .notNull()
      .default({}),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("ad_transactions_organization_idx").on(table.organization_id),
    campaign_idx: index("ad_transactions_campaign_idx").on(table.campaign_id),
    credit_tx_idx: index("ad_transactions_credit_tx_idx").on(table.credit_transaction_id),
    type_idx: index("ad_transactions_type_idx").on(table.type),
    created_at_idx: index("ad_transactions_created_at_idx").on(table.created_at),
    org_type_idx: index("ad_transactions_org_type_idx").on(table.organization_id, table.type),
  }),
);

export type AdTransaction = InferSelectModel<typeof adTransactions>;
export type NewAdTransaction = InferInsertModel<typeof adTransactions>;
