import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { type AdPlatform, adAccounts } from "./ad-accounts";
import { apps } from "./apps";
import { organizations } from "./organizations";

/**
 * Campaign status.
 */
export type CampaignStatus =
  | "draft"
  | "pending"
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "archived";

/**
 * Campaign objective.
 */
export type CampaignObjective =
  | "awareness"
  | "traffic"
  | "engagement"
  | "leads"
  | "app_promotion"
  | "sales"
  | "conversions";

/**
 * Budget type.
 */
export type BudgetType = "daily" | "lifetime";

/**
 * Ad campaigns table schema.
 *
 * Stores advertising campaigns created through the platform.
 * Campaigns are linked to ad accounts and can optionally promote apps.
 */
export const adCampaigns = pgTable(
  "ad_campaigns",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    ad_account_id: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),

    // External campaign ID from the ad platform
    external_campaign_id: text("external_campaign_id"),

    name: text("name").notNull(),

    platform: text("platform").$type<AdPlatform>().notNull(),

    objective: text("objective").$type<CampaignObjective>().notNull(),

    status: text("status").$type<CampaignStatus>().notNull().default("draft"),

    budget_type: text("budget_type").$type<BudgetType>().notNull(),
    budget_amount: numeric("budget_amount", { precision: 12, scale: 2 }).notNull().default("0.00"),
    budget_currency: text("budget_currency").notNull().default("USD"),

    // Credits allocated for this campaign (in our system)
    credits_allocated: numeric("credits_allocated", { precision: 12, scale: 2 })
      .notNull()
      .default("0.00"),
    credits_spent: numeric("credits_spent", { precision: 12, scale: 2 }).notNull().default("0.00"),

    // Schedule
    start_date: timestamp("start_date"),
    end_date: timestamp("end_date"),

    // Targeting configuration
    targeting: jsonb("targeting")
      .$type<{
        locations?: string[];
        age_min?: number;
        age_max?: number;
        genders?: ("male" | "female" | "all")[];
        interests?: string[];
        behaviors?: string[];
        custom_audiences?: string[];
        excluded_audiences?: string[];
        placements?: string[];
        languages?: string[];
      }>()
      .notNull()
      .default({}),

    // Performance metrics (synced from platform)
    total_spend: numeric("total_spend", { precision: 12, scale: 2 }).notNull().default("0.00"),
    total_impressions: integer("total_impressions").notNull().default(0),
    total_clicks: integer("total_clicks").notNull().default(0),
    total_conversions: integer("total_conversions").notNull().default(0),

    // If promoting an app through our platform
    app_id: uuid("app_id").references(() => apps.id, { onDelete: "set null" }),

    metadata: jsonb("metadata")
      .$type<{
        external_ad_set_ids?: string[];
        external_ad_ids?: string[];
        optimization_goal?: string;
        bid_strategy?: string;
        last_sync_at?: string;
        error_message?: string;
      }>()
      .notNull()
      .default({}),

    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("ad_campaigns_organization_idx").on(table.organization_id),
    ad_account_idx: index("ad_campaigns_ad_account_idx").on(table.ad_account_id),
    platform_idx: index("ad_campaigns_platform_idx").on(table.platform),
    status_idx: index("ad_campaigns_status_idx").on(table.status),
    external_id_idx: index("ad_campaigns_external_id_idx").on(table.external_campaign_id),
    app_idx: index("ad_campaigns_app_idx").on(table.app_id),
    created_at_idx: index("ad_campaigns_created_at_idx").on(table.created_at),
    org_status_idx: index("ad_campaigns_org_status_idx").on(table.organization_id, table.status),
  }),
);

export type AdCampaign = InferSelectModel<typeof adCampaigns>;
export type NewAdCampaign = InferInsertModel<typeof adCampaigns>;
