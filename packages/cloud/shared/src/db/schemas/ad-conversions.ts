/**
 * First-party advertising attribution (#11598).
 *
 * `ad_attribution_links` stores deterministic UTM destination URLs generated
 * server-side for a campaign. `ad_conversion_events` records pixel/webhook
 * conversions against a signed campaign token and dedupes replayed events.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { adCampaigns } from "./ad-campaigns";
import { adCreatives } from "./ad-creatives";
import { apps } from "./apps";
import { organizations } from "./organizations";

export type AdConversionEventType =
  | "conversion"
  | "purchase"
  | "signup"
  | "lead"
  | "install"
  | "custom";

export const adAttributionLinks = pgTable(
  "ad_attribution_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    campaign_id: uuid("campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    creative_id: uuid("creative_id").references(() => adCreatives.id, {
      onDelete: "set null",
    }),
    app_id: uuid("app_id").references(() => apps.id, { onDelete: "set null" }),
    destination_url: text("destination_url").notNull(),
    utm_url: text("utm_url").notNull(),
    utm_source: text("utm_source").notNull(),
    utm_medium: text("utm_medium").notNull(),
    utm_campaign: text("utm_campaign").notNull(),
    utm_content: text("utm_content"),
    utm_term: text("utm_term"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    org_idx: index("ad_attribution_links_org_idx").on(table.organization_id),
    campaign_idx: index("ad_attribution_links_campaign_idx").on(table.campaign_id),
    deterministic_idx: unique("ad_attribution_links_deterministic_idx")
      .on(
        table.campaign_id,
        table.creative_id,
        table.destination_url,
        table.utm_source,
        table.utm_medium,
        table.utm_campaign,
        table.utm_content,
        table.utm_term,
      )
      .nullsNotDistinct(),
  }),
);

export const adConversionEvents = pgTable(
  "ad_conversion_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    campaign_id: uuid("campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    app_id: uuid("app_id").references(() => apps.id, { onDelete: "set null" }),
    creative_id: uuid("creative_id").references(() => adCreatives.id, {
      onDelete: "set null",
    }),
    event_type: text("event_type").$type<AdConversionEventType>().notNull(),
    dedupe_key: text("dedupe_key").notNull(),
    value: numeric("value", { precision: 12, scale: 2 }),
    currency: text("currency").notNull().default("USD"),
    source_url: text("source_url"),
    referrer: text("referrer"),
    user_agent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    occurred_at: timestamp("occurred_at").notNull().defaultNow(),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    org_idx: index("ad_conversion_events_org_idx").on(table.organization_id),
    campaign_idx: index("ad_conversion_events_campaign_idx").on(table.campaign_id),
    app_idx: index("ad_conversion_events_app_idx").on(table.app_id),
    occurred_at_idx: index("ad_conversion_events_occurred_at_idx").on(table.occurred_at),
    dedupe_idx: uniqueIndex("ad_conversion_events_dedupe_idx").on(
      table.campaign_id,
      table.event_type,
      table.dedupe_key,
    ),
  }),
);

export type AdAttributionLink = InferSelectModel<typeof adAttributionLinks>;
export type NewAdAttributionLink = InferInsertModel<typeof adAttributionLinks>;
export type AdConversionEvent = InferSelectModel<typeof adConversionEvents>;
export type NewAdConversionEvent = InferInsertModel<typeof adConversionEvents>;
