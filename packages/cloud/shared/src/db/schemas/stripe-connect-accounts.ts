/**
 * Stripe Connect accounts (#8922) — fiat payout rail for creator earnings.
 *
 * One row per creator (user) who has begun Stripe Connect onboarding. The
 * connected `stripe_connect_account_id` is the destination for `transfers.create`
 * when a creator withdraws earnings as fiat instead of on-chain elizaOS tokens.
 * Payout status is advanced by `transfer.created` / `payout.paid` webhooks.
 *
 * This table holds only the linkage + capability flags; the money math lives in
 * the existing redeemable-earnings ledger (the single source of truth for
 * balances) — this never duplicates a balance.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/** Lifecycle of a connected account, mirrored from Stripe capability flags. */
export const stripeConnectStatusEnum = pgEnum("stripe_connect_status", [
  "pending", // account created, onboarding not finished
  "active", // charges + payouts enabled
  "restricted", // Stripe needs more info
  "disabled", // rejected / disabled
]);

export type StripeConnectStatus = "pending" | "active" | "restricted" | "disabled";

export const stripeConnectAccounts = pgTable(
  "stripe_connect_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    user_id: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    stripe_connect_account_id: text("stripe_connect_account_id").notNull().unique(),
    status: stripeConnectStatusEnum("status").notNull().default("pending"),
    charges_enabled: boolean("charges_enabled").notNull().default(false),
    payouts_enabled: boolean("payouts_enabled").notNull().default(false),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    account_idx: index("stripe_connect_accounts_account_idx").on(table.stripe_connect_account_id),
  }),
);

export type StripeConnectAccount = InferSelectModel<typeof stripeConnectAccounts>;
export type NewStripeConnectAccount = InferInsertModel<typeof stripeConnectAccounts>;
