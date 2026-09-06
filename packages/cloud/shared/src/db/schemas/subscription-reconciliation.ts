/** Persists due observation work and lease-fenced reconciliation receipts without fabricating Stripe events or user commands. */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { billingSubscriptionRevisions, billingSubscriptions } from "./billing-subscriptions";
export const subscriptionReconciliationScans = pgTable(
  "subscription_reconciliation_scans",
  {
    organization_id: uuid("organization_id").notNull(),
    subscription_id: uuid("subscription_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull().default(0),
    failures: integer("failures").notNull().default(0),
    next_due_at: timestamp("next_due_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organization_id, t.subscription_id] }),
    foreignKey({
      columns: [t.subscription_id, t.organization_id],
      foreignColumns: [billingSubscriptions.id, billingSubscriptions.organization_id],
      name: "subscription_reconciliation_scan_source_fk",
    }).onDelete("cascade"),
    check("subscription_reconciliation_scan_shape", sql`${t.generation}>=0 AND ${t.failures}>=0`),
  ],
);
export const subscriptionReconciliationAttempts = pgTable(
  "subscription_reconciliation_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id").notNull(),
    subscription_id: uuid("subscription_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    expected_revision: bigint("expected_revision", { mode: "number" }).notNull(),
    expected_projection_revision: bigint("expected_projection_revision", { mode: "number" }),
    identity_digest: text("identity_digest").notNull(),
    lease_token: uuid("lease_token").notNull(),
    started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    disposition: text("disposition")
      .$type<
        | "processing"
        | "applied"
        | "no_change"
        | "unsupported"
        | "unavailable"
        | "stale"
        | "superseded"
        | "deletion_owned"
      >()
      .notNull()
      .default("processing"),
    observation_digest: text("observation_digest"),
    observed_revision: bigint("observed_revision", { mode: "number" }),
    result_revision: bigint("result_revision", { mode: "number" }),
    reason: text("reason"),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("subscription_reconciliation_attempt_generation").on(
      t.organization_id,
      t.subscription_id,
      t.generation,
    ),
    uniqueIndex("subscription_reconciliation_attempt_result")
      .on(t.organization_id, t.subscription_id, t.result_revision)
      .where(sql`${t.disposition}='applied'`),
    foreignKey({
      columns: [t.subscription_id, t.organization_id, t.expected_revision],
      foreignColumns: [
        billingSubscriptionRevisions.subscription_id,
        billingSubscriptionRevisions.organization_id,
        billingSubscriptionRevisions.revision,
      ],
      name: "subscription_reconciliation_attempt_source_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.subscription_id, t.organization_id, t.result_revision],
      foreignColumns: [
        billingSubscriptionRevisions.subscription_id,
        billingSubscriptionRevisions.organization_id,
        billingSubscriptionRevisions.revision,
      ],
      name: "subscription_reconciliation_attempt_result_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.subscription_id, t.organization_id, t.observed_revision],
      foreignColumns: [
        billingSubscriptionRevisions.subscription_id,
        billingSubscriptionRevisions.organization_id,
        billingSubscriptionRevisions.revision,
      ],
      name: "subscription_reconciliation_attempt_observed_fk",
    }).onDelete("cascade"),
    check(
      "subscription_reconciliation_attempt_shape",
      sql`${t.generation}>0 AND ${t.expected_revision}>0 AND (${t.expected_projection_revision} IS NULL OR ${t.expected_projection_revision}>=0) AND ${t.identity_digest} ~ '^[0-9a-f]{64}$' AND ${t.expires_at}>${t.started_at} AND ${t.disposition} IN ('processing','applied','no_change','unsupported','unavailable','stale','superseded','deletion_owned') AND ((${t.disposition}='processing' AND ${t.completed_at} IS NULL AND ${t.observation_digest} IS NULL AND ${t.result_revision} IS NULL AND ${t.observed_revision} IS NULL AND ${t.reason} IS NULL) OR (${t.disposition}<>'processing' AND ${t.completed_at} IS NOT NULL AND ${t.completed_at}>=${t.started_at})) AND ((${t.disposition}='applied' AND ${t.result_revision} IS NOT NULL AND ${t.result_revision}=${t.expected_revision}+1 AND ${t.observation_digest} IS NOT NULL AND ${t.observation_digest} ~ '^[0-9a-f]{64}$' AND ${t.observed_revision} IS NOT NULL AND ${t.observed_revision}=${t.result_revision}) OR (${t.disposition}<>'applied' AND ${t.result_revision} IS NULL)) AND (${t.observation_digest} IS NULL OR ${t.observation_digest} ~ '^[0-9a-f]{64}$') AND (${t.disposition} IN ('processing','applied','no_change') OR ${t.reason} IS NOT NULL) AND (${t.disposition}<>'no_change' OR (${t.observed_revision} IS NOT NULL AND ${t.observed_revision}>0 AND ${t.observation_digest} IS NOT NULL))`,
    ),
  ],
);
export type SubscriptionReconciliationAttempt =
  typeof subscriptionReconciliationAttempts.$inferSelect;
