/** Defines the rebuildable, current organization entitlement projection. */
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appBillingScopes } from "./app-billing";
import { billingSubscriptionRevisions, billingSubscriptions } from "./billing-subscriptions";
import { organizations } from "./organizations";

export const ENTITLEMENT_PLAN_KEYS = ["free", "plus_monthly", "pro_monthly"] as const;
export type EntitlementPlanKey = (typeof ENTITLEMENT_PLAN_KEYS)[number];

export const ORGANIZATION_ENTITLEMENT_STATES = [
  "free",
  "trialing",
  "paused",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "active",
  "grace",
  "past_due",
  "unpaid",
] as const;
export type OrganizationEntitlementState = (typeof ORGANIZATION_ENTITLEMENT_STATES)[number];

export const organizationEntitlements = pgTable(
  "organization_entitlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billing_scope_id: uuid("billing_scope_id"),
    access: text("access").$type<"granted" | "read_only" | "denied">().notNull().default("granted"),
    features: jsonb("features").$type<string[]>().notNull().default([]),
    quantity: integer("quantity").notNull().default(1),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    plan_key: text("plan_key").notNull(),
    state: text("state").$type<OrganizationEntitlementState>().notNull(),
    entitlement_effective: boolean("entitlement_effective").notNull(),
    effective_from: timestamp("effective_from", { withTimezone: true }).notNull(),
    effective_until: timestamp("effective_until", { withTimezone: true }),
    completions_rpm: integer("completions_rpm").notNull(),
    embeddings_rpm: integer("embeddings_rpm").notNull(),
    standard_rpm: integer("standard_rpm").notNull(),
    strict_rpm: integer("strict_rpm").notNull(),
    cloud_characters_ceiling: integer("cloud_characters_ceiling"),
    agent_sandboxes_ceiling: integer("agent_sandboxes_ceiling"),
    containers_ceiling: integer("containers_ceiling"),
    storage_gib_ceiling: integer("storage_gib_ceiling"),
    apps_ceiling: integer("apps_ceiling"),
    catalog_version: text("catalog_version").notNull(),
    projection_revision: bigint("projection_revision", { mode: "number" }).notNull(),
    source_digest: text("source_digest").notNull(),
    source_subscription_id: uuid("source_subscription_id"),
    source_subscription_revision: bigint("source_subscription_revision", {
      mode: "number",
    }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    rebuilt_at: timestamp("rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scope_fk: foreignKey({
      columns: [table.billing_scope_id, table.organization_id],
      foreignColumns: [appBillingScopes.id, appBillingScopes.organization_id],
    }).onDelete("restrict"),
    legacy_unique: uniqueIndex("organization_entitlements_legacy_org_idx")
      .on(table.organization_id)
      .where(sql`${table.billing_scope_id} IS NULL`),
    scope_unique: uniqueIndex("organization_entitlements_scope_idx")
      .on(table.billing_scope_id)
      .where(sql`${table.billing_scope_id} IS NOT NULL`),
    source_subscription_tenant_fk: foreignKey({
      columns: [table.source_subscription_id, table.organization_id],
      foreignColumns: [billingSubscriptions.id, billingSubscriptions.organization_id],
      name: "organization_entitlements_subscription_tenant_fk",
    }).onDelete("restrict"),
    source_revision_tenant_fk: foreignKey({
      columns: [
        table.source_subscription_id,
        table.organization_id,
        table.source_subscription_revision,
      ],
      foreignColumns: [
        billingSubscriptionRevisions.subscription_id,
        billingSubscriptionRevisions.organization_id,
        billingSubscriptionRevisions.revision,
      ],
      name: "organization_entitlements_source_revision_tenant_fk",
    }).onDelete("restrict"),
    plan_state_check: check(
      "organization_entitlements_plan_state_check",
      sql`(${table.billing_scope_id} IS NOT NULL AND ${table.source_subscription_id} IS NOT NULL AND ${table.source_subscription_revision} IS NOT NULL AND ${table.state} IN ('trialing','active','grace','past_due','unpaid','paused','canceled','incomplete','incomplete_expired') AND ${table.access} IN ('granted','read_only','denied') AND ${table.entitlement_effective} = (${table.access} = 'granted')) OR (${table.billing_scope_id} IS NULL AND ${table.plan_key} IN ('free','plus_monthly','pro_monthly') AND ${table.state} IN ('free','active','grace','past_due','unpaid') AND ((${table.plan_key} = 'free' AND ${table.state} = 'free' AND ${table.entitlement_effective} AND (${table.source_subscription_id} IS NULL) = (${table.source_subscription_revision} IS NULL)) OR (${table.plan_key} <> 'free' AND ${table.state} <> 'free' AND ${table.source_subscription_id} IS NOT NULL AND ${table.source_subscription_revision} IS NOT NULL AND (${table.entitlement_effective} = (${table.state} IN ('active','grace'))))))`,
    ),
    effective_bounds_check: check(
      "organization_entitlements_effective_bounds_check",
      sql`${table.effective_until} IS NULL OR ${table.effective_until} > ${table.effective_from}`,
    ),
    rates_check: check(
      "organization_entitlements_rates_check",
      sql`${table.completions_rpm} >= 0 AND ${table.embeddings_rpm} >= 0 AND ${table.standard_rpm} >= 0 AND ${table.strict_rpm} >= 0`,
    ),
    ceilings_check: check(
      "organization_entitlements_ceilings_check",
      sql`(${table.cloud_characters_ceiling} IS NULL OR ${table.cloud_characters_ceiling} >= 0) AND (${table.agent_sandboxes_ceiling} IS NULL OR ${table.agent_sandboxes_ceiling} >= 0) AND (${table.containers_ceiling} IS NULL OR ${table.containers_ceiling} >= 0) AND (${table.storage_gib_ceiling} IS NULL OR ${table.storage_gib_ceiling} >= 0) AND (${table.apps_ceiling} IS NULL OR ${table.apps_ceiling} >= 0)`,
    ),
    revisions_check: check(
      "organization_entitlements_revisions_check",
      sql`${table.projection_revision} >= 0 AND (${table.source_subscription_revision} IS NULL OR ${table.source_subscription_revision} > 0)`,
    ),
    catalog_version_check: check(
      "organization_entitlements_catalog_version_check",
      sql`length(btrim(${table.catalog_version})) > 0`,
    ),
    source_digest_check: check(
      "organization_entitlements_source_digest_check",
      sql`${table.source_digest} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export type OrganizationEntitlement = InferSelectModel<typeof organizationEntitlements>;
export type NewOrganizationEntitlement = InferInsertModel<typeof organizationEntitlements>;
