/** Append-only subsequent invoice observations; never a second allowance ledger. */
import { integer, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { observeRetainedRenewalAdjustments } from "../../lib/services/renewal-adjustment-observation";
import { organizations } from "./organizations";
import { subscriptionAllowanceTransactions } from "./subscription-allowance-transactions";
export const subscriptionAdjustmentObservations = pgTable(
  "subscription_adjustment_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    grant_id: uuid("grant_id")
      .notNull()
      .references(() => subscriptionAllowanceTransactions.id, { onDelete: "restrict" }),
    request_id: uuid("request_id").notNull(),
    version: integer("version").notNull(),
    previous_id: uuid("previous_id"),
    observation: jsonb("observation")
      .$type<Awaited<ReturnType<typeof observeRetainedRenewalAdjustments>>>()
      .notNull(),
    observed_at: timestamp("observed_at", { withTimezone: true }).notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("subscription_adjustment_request_unique").on(table.grant_id, table.request_id),
    uniqueIndex("subscription_adjustment_version_unique").on(table.grant_id, table.version),
  ],
);
