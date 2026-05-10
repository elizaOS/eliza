import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { adCampaigns } from "./ad-campaigns";

/**
 * Creative type.
 */
export type CreativeType = "image" | "video" | "carousel";

/**
 * Creative status.
 */
export type CreativeStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "active"
  | "paused";

/**
 * Call to action types.
 */
export type CallToAction =
  | "learn_more"
  | "shop_now"
  | "sign_up"
  | "download"
  | "contact_us"
  | "get_offer"
  | "book_now"
  | "watch_more"
  | "apply_now"
  | "subscribe";

/**
 * Ad creatives table schema.
 *
 * Stores ad creatives (images, videos, carousels) for campaigns.
 * Links to media from generations or uploads.
 */
export const adCreatives = pgTable(
  "ad_creatives",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    campaign_id: uuid("campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),

    // External creative ID from the ad platform
    external_creative_id: text("external_creative_id"),

    name: text("name").notNull(),

    type: text("type").$type<CreativeType>().notNull(),

    status: text("status").$type<CreativeStatus>().notNull().default("draft"),

    // Ad copy
    headline: text("headline"),
    primary_text: text("primary_text"),
    description: text("description"),
    call_to_action: text("call_to_action").$type<CallToAction>(),
    destination_url: text("destination_url"),

    // Media references - array of generation_id or upload_id with type
    media: jsonb("media")
      .$type<
        Array<{
          id: string;
          source: "generation" | "upload";
          url: string;
          providerAssetId?: string;
          thumbnail_url?: string;
          type: "image" | "video";
          order: number;
        }>
      >()
      .notNull()
      .default([]),

    // Platform-specific fields
    metadata: jsonb("metadata")
      .$type<{
        // Meta-specific
        facebook_page_id?: string;
        instagram_account_id?: string;
        // TikTok-specific
        tiktok_identity_id?: string;
        tiktok_identity_type?: string;
        // Review feedback
        rejection_reason?: string;
        review_feedback?: string;
        // Performance
        relevance_score?: number;
        quality_ranking?: string;
        // Timestamps
        submitted_at?: string;
        approved_at?: string;
        rejected_at?: string;
      }>()
      .notNull()
      .default({}),

    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    campaign_idx: index("ad_creatives_campaign_idx").on(table.campaign_id),
    type_idx: index("ad_creatives_type_idx").on(table.type),
    status_idx: index("ad_creatives_status_idx").on(table.status),
    external_id_idx: index("ad_creatives_external_id_idx").on(table.external_creative_id),
    created_at_idx: index("ad_creatives_created_at_idx").on(table.created_at),
  }),
);

export type AdCreative = InferSelectModel<typeof adCreatives>;
export type NewAdCreative = InferInsertModel<typeof adCreatives>;
