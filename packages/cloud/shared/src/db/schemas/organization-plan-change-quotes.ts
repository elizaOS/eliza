/** Immutable, organization-owned upgrade quotes; consumed only by the original durable command. */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { OrganizationUpgradeReview } from "../../lib/services/organization-plan-change-contract";
import { billingIdentitySubjects } from "./billing-identities";
import { billingSubscriptions } from "./billing-subscriptions";
import { organizations } from "./organizations";
import { billingSubscriptionCommands } from "./subscription-billing-operations";

export const organizationPlanChangeQuotes = pgTable(
  "organization_plan_change_quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    actor_id: uuid("actor_id")
      .notNull()
      .references(() => billingIdentitySubjects.id, { onDelete: "restrict" }),
    subscription_id: uuid("subscription_id").notNull(),
    subscription_revision: bigint("subscription_revision", { mode: "number" }).notNull(),
    target_plan_key: text("target_plan_key").notNull(),
    catalog_version: text("catalog_version").notNull(),
    source_digest: text("source_digest").notNull(),
    review_digest: text("review_digest").notNull(),
    review: jsonb("review").$type<OrganizationUpgradeReview>().notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumed_by_command_id: uuid("consumed_by_command_id"),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => ({
    source: foreignKey({
      name: "organization_plan_quote_source_fk",
      columns: [t.subscription_id, t.organization_id],
      foreignColumns: [billingSubscriptions.id, billingSubscriptions.organization_id],
    }).onDelete("restrict"),
    command: foreignKey({
      name: "organization_plan_quote_command_fk",
      columns: [t.consumed_by_command_id, t.organization_id],
      foreignColumns: [billingSubscriptionCommands.id, billingSubscriptionCommands.organization_id],
    }).onDelete("restrict"),
    consumed: uniqueIndex("organization_plan_quote_consumed_idx")
      .on(t.consumed_by_command_id)
      .where(sql`${t.consumed_by_command_id} IS NOT NULL`),
    tenant: index("organization_plan_quote_tenant_idx").on(t.organization_id, t.created_at),
    shape: check(
      "organization_plan_quote_shape",
      sql`${t.subscription_revision}>0 AND ${t.target_plan_key} IN ('plus_monthly','pro_monthly') AND ${t.source_digest} ~ '^[a-f0-9]{64}$' AND ${t.review_digest} ~ '^[a-f0-9]{64}$' AND ${t.expires_at}>${t.created_at} AND (${t.consumed_by_command_id} IS NULL)=(${t.consumed_at} IS NULL)`,
    ),
  }),
);
