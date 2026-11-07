/** Grant-level observation scheduling and retained attempts, independent of renewal lifecycle. */
import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { subscriptionAdjustmentObservations } from "./subscription-adjustment-observations";
import { subscriptionAllowanceTransactions } from "./subscription-allowance-transactions";
export const subscriptionAdjustmentScans = pgTable("subscription_adjustment_scans", {
  grant_id: uuid("grant_id")
    .primaryKey()
    .references(() => subscriptionAllowanceTransactions.id, { onDelete: "restrict" }),
  organization_id: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  generation: integer("generation").notNull().default(0),
  failures: integer("failures").notNull().default(0),
  next_due_at: timestamp("next_due_at", { withTimezone: true }).notNull().defaultNow(),
});
export const subscriptionAdjustmentAttempts = pgTable("subscription_adjustment_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  grant_id: uuid("grant_id")
    .notNull()
    .references(() => subscriptionAdjustmentScans.grant_id, { onDelete: "restrict" }),
  organization_id: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  generation: integer("generation").notNull(),
  lease_token: uuid("lease_token").notNull(),
  expected_previous_id: uuid("expected_previous_id").references(
    () => subscriptionAdjustmentObservations.id,
    { onDelete: "restrict" },
  ),
  original_digest: text("original_digest").notNull(),
  started_at: timestamp("started_at", { withTimezone: true }).notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  disposition: text("disposition")
    .$type<"processing" | "recorded" | "failed" | "superseded">()
    .notNull()
    .default("processing"),
  observation_id: uuid("observation_id").references(() => subscriptionAdjustmentObservations.id, {
    onDelete: "restrict",
  }),
  reason: text("reason"),
  completed_at: timestamp("completed_at", { withTimezone: true }),
});
