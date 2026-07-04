// Defines the ad report shares Drizzle table shape used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { adCampaigns } from "./ad-campaigns";
import { organizations } from "./organizations";

export type AdReportShareStatus = "active" | "revoked";

export const adReportShares = pgTable(
  "ad_report_shares",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    campaign_id: uuid("campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    token_hash: text("token_hash").notNull().unique(),
    status: text("status").$type<AdReportShareStatus>().notNull().default("active"),
    expires_at: timestamp("expires_at").notNull(),
    revoked_at: timestamp("revoked_at"),
    created_by_user_id: uuid("created_by_user_id"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    campaign_idx: index("ad_report_shares_campaign_idx").on(table.campaign_id),
    org_idx: index("ad_report_shares_org_idx").on(table.organization_id),
    token_hash_idx: index("ad_report_shares_token_hash_idx").on(table.token_hash),
    status_idx: index("ad_report_shares_status_idx").on(table.status),
  }),
);

export type AdReportShare = InferSelectModel<typeof adReportShares>;
export type NewAdReportShare = InferInsertModel<typeof adReportShares>;
