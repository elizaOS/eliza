/** Persists revision-bound cancellation notice intent and submission attempts; provider acceptance remains distinct from recipient delivery. */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { billingSubscriptionRevisions } from "./billing-subscriptions";
export const subscriptionNoticeIntents = pgTable(
  "subscription_notice_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id").notNull(),
    subscription_id: uuid("subscription_id").notNull(),
    source_revision: bigint("source_revision", { mode: "number" }).notNull(),
    kind: text("kind").notNull().default("cancel_effective"),
    state: text("state").notNull().default("policy_unavailable"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    last_inspected_at: timestamp("last_inspected_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("subscription_notice_intents_revision_kind_idx").on(
      t.subscription_id,
      t.source_revision,
      t.kind,
    ),
    uniqueIndex("subscription_notice_intents_id_org_idx").on(t.id, t.organization_id),
    foreignKey({
      columns: [t.subscription_id, t.organization_id, t.source_revision],
      foreignColumns: [
        billingSubscriptionRevisions.subscription_id,
        billingSubscriptionRevisions.organization_id,
        billingSubscriptionRevisions.revision,
      ],
      name: "subscription_notice_intents_source_fk",
    }).onDelete("cascade"),
    check(
      "subscription_notice_intents_shape_check",
      sql`${t.source_revision}>0 AND ${t.kind}='cancel_effective' AND ${t.state} IN ('policy_unavailable','scheduled','dispatching','accepted','rejected','uncertain','unavailable','superseded','reconciliation_required')`,
    ),
  ],
);
export const subscriptionNoticeAttempts = pgTable(
  "subscription_notice_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notice_id: uuid("notice_id").notNull(),
    organization_id: uuid("organization_id").notNull(),
    policy_digest: text("policy_digest").notNull(),
    status: text("status").notNull().default("dispatching"),
    provider: text("provider"),
    message_id: text("message_id"),
    reason: text("reason"),
    started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("subscription_notice_attempts_notice_idx").on(t.notice_id),
    foreignKey({
      columns: [t.notice_id, t.organization_id],
      foreignColumns: [subscriptionNoticeIntents.id, subscriptionNoticeIntents.organization_id],
      name: "subscription_notice_attempts_notice_fk",
    }).onDelete("cascade"),
    check(
      "subscription_notice_attempts_shape_check",
      sql`${t.policy_digest} ~ '^[0-9a-f]{64}$' AND ${t.expires_at}>${t.started_at} AND ${t.status} IN ('dispatching','accepted','rejected','uncertain','unavailable','superseded') AND ((${t.status}='dispatching' AND ${t.completed_at} IS NULL) OR (${t.status}<>'dispatching' AND ${t.completed_at} IS NOT NULL)) AND (${t.status}<>'accepted' OR (${t.provider} IS NOT NULL AND ${t.provider} IN ('smtp','sendgrid') AND ${t.message_id} IS NOT NULL))`,
    ),
  ],
);
