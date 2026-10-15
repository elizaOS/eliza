/** Defines Cloud-native subscription grant codes and the per-organization grants they publish. */
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export const subscriptionGrantCodes = pgTable(
  "subscription_grant_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** HMAC-SHA256 hex of the normalized code under the server pepper. */
    code_hash: text("code_hash").notNull().unique(),
    family: text("family").notNull().default("alpha_phone"),
    plan_key: text("plan_key")
      .$type<"plus_monthly" | "pro_monthly">()
      .notNull()
      .default("plus_monthly"),
    catalog_version: text("catalog_version").notNull().default("v1"),
    duration_days: integer("duration_days").default(183),
    /** UTC calendar months (month-end clamped); exclusive with duration_days. Both null is lifetime. */
    duration_months: integer("duration_months"),
    /** Refuse redemption while the organization has an open paid subscription. */
    requires_no_paid_plan: boolean("requires_no_paid_plan").notNull().default(false),
    max_redemptions: integer("max_redemptions").notNull(),
    redeemed_count: integer("redeemed_count").notNull().default(0),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    label: text("label"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    disabled_at: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => ({
    hash_check: check(
      "subscription_grant_codes_code_hash_check",
      sql`${table.code_hash} ~ '^[0-9a-f]{64}$'`,
    ),
    single_term_check: check(
      "subscription_grant_codes_single_term_check",
      sql`${table.duration_days} IS NULL OR ${table.duration_months} IS NULL`,
    ),
    count_check: check(
      "subscription_grant_codes_redeemed_count_check",
      sql`${table.redeemed_count} >= 0 AND ${table.redeemed_count} <= ${table.max_redemptions}`,
    ),
  }),
);

export const subscriptionGrants = pgTable(
  "subscription_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    user_id: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    code_id: uuid("code_id")
      .notNull()
      .references(() => subscriptionGrantCodes.id, { onDelete: "restrict" }),
    family: text("family").notNull(),
    plan_key: text("plan_key").$type<"plus_monthly" | "pro_monthly">().notNull(),
    catalog_version: text("catalog_version").notNull(),
    idempotency_key: text("idempotency_key").notNull(),
    starts_at: timestamp("starts_at", { withTimezone: true }).notNull(),
    /** Null denotes a lifetime grant; revocation remains available. */
    ends_at: timestamp("ends_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set once by support revocation; a revoked grant no longer serves. */
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    revoked_reason: text("revoked_reason"),
  },
  (table) => ({
    org_family_unique: unique("subscription_grants_org_family_idx").on(
      table.organization_id,
      table.family,
    ),
    id_org_unique: unique("subscription_grants_id_org_idx").on(table.id, table.organization_id),
    org_window_idx: index("subscription_grants_org_window_idx").on(
      table.organization_id,
      table.ends_at,
    ),
    code_idx: index("subscription_grants_code_idx").on(table.code_id),
    window_check: check(
      "subscription_grants_window_check",
      sql`${table.ends_at} > ${table.starts_at}`,
    ),
    revocation_check: check(
      "subscription_grants_revocation_check",
      sql`(${table.revoked_at} IS NULL) = (${table.revoked_reason} IS NULL)`,
    ),
  }),
);

export type SubscriptionGrantCode = InferSelectModel<typeof subscriptionGrantCodes>;
export type NewSubscriptionGrantCode = InferInsertModel<typeof subscriptionGrantCodes>;
export type SubscriptionGrant = InferSelectModel<typeof subscriptionGrants>;
