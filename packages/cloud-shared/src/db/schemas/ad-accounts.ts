import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { secrets } from "./secrets";
import { users } from "./users";

/**
 * Ad platform type.
 */
export type AdPlatform = "meta" | "google" | "tiktok";

/**
 * Ad account status.
 */
export type AdAccountStatus = "active" | "suspended" | "disconnected" | "pending";

/**
 * Ad accounts table schema.
 *
 * Stores connected advertising platform accounts for an organization.
 * Each organization can have multiple ad accounts per platform.
 */
export const adAccounts = pgTable(
  "ad_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    connected_by_user_id: uuid("connected_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    platform: text("platform").$type<AdPlatform>().notNull(),

    // External account identifier from the ad platform
    external_account_id: text("external_account_id").notNull(),
    account_name: text("account_name").notNull(),

    // Encrypted tokens stored in secrets table
    access_token_secret_id: uuid("access_token_secret_id").references(() => secrets.id, {
      onDelete: "set null",
    }),
    refresh_token_secret_id: uuid("refresh_token_secret_id").references(() => secrets.id, {
      onDelete: "set null",
    }),

    // Token expiration tracking
    token_expires_at: timestamp("token_expires_at"),

    status: text("status").$type<AdAccountStatus>().notNull().default("active"),

    // Platform-specific metadata
    metadata: jsonb("metadata")
      .$type<{
        // Meta-specific
        business_id?: string;
        page_ids?: string[];
        instagram_account_ids?: string[];
        // Google-specific
        manager_customer_id?: string;
        currency_code?: string;
        timezone?: string;
        // TikTok-specific
        advertiser_id?: string;
        // Common
        permissions?: string[];
        last_sync_at?: string;
      }>()
      .notNull()
      .default({}),

    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("ad_accounts_organization_idx").on(table.organization_id),
    platform_idx: index("ad_accounts_platform_idx").on(table.platform),
    org_platform_idx: index("ad_accounts_org_platform_idx").on(
      table.organization_id,
      table.platform,
    ),
    external_id_idx: index("ad_accounts_external_id_idx").on(table.external_account_id),
    status_idx: index("ad_accounts_status_idx").on(table.status),
  }),
);

export type AdAccount = InferSelectModel<typeof adAccounts>;
export type NewAdAccount = InferInsertModel<typeof adAccounts>;
