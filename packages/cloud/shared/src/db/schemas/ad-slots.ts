/**
 * Ad Inventory / SSP schema (#10687).
 *
 * Lets a miniapp act as an ad **publisher**: define ad slots on its own surface,
 * set a floor price, and earn when ads are served into them. The serve path
 * picks an eligible active campaign creative, debits the advertiser's pre-funded
 * campaign credits, and credits the publisher's redeemable earnings (source
 * `ad_revenue`). Impression/click events are logged for attribution + are the
 * idempotency key for revenue movement.
 *
 * Money model reuses existing rails only: advertiser budget = `ad_campaigns`
 * credits_allocated/credits_spent; publisher payout = `redeemable_earnings`.
 */

import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { adCampaigns } from "./ad-campaigns";
import { adCreatives } from "./ad-creatives";
import { apps } from "./apps";
import { organizations } from "./organizations";

export type AdSlotFormat = "banner" | "native" | "interstitial" | "feed";
export type AdSlotStatus = "active" | "paused";
export type AdSlotEventType = "impression" | "click";

/** A publisher-owned ad placement on a miniapp surface. */
export const adSlots = pgTable(
  "ad_slots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    format: text("format").$type<AdSlotFormat>().notNull(),
    status: text("status").$type<AdSlotStatus>().notNull().default("active"),

    /**
     * Minimum price the publisher accepts, in USD per 1000 impressions (CPM).
     * The advertiser debit happens at the credits ledger's scale-2 (whole
     * cents), so a slot only fills when its per-impression price is at least
     * $0.01 — i.e. a floor CPM of at least $10. The default is that minimum.
     */
    floor_cpm: numeric("floor_cpm", { precision: 10, scale: 4 }).notNull().default("10.0000"),

    total_impressions: integer("total_impressions").notNull().default(0),
    total_clicks: integer("total_clicks").notNull().default(0),
    total_revenue: numeric("total_revenue", { precision: 12, scale: 6 })
      .notNull()
      .default("0.000000"),

    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    app_idx: index("ad_slots_app_idx").on(table.app_id),
    org_idx: index("ad_slots_org_idx").on(table.organization_id),
    status_idx: index("ad_slots_status_idx").on(table.status),
  }),
);

/**
 * One impression/click event on a slot. `impression_id` is the client-facing
 * opaque token returned by serve; a click references it, and it is the unique
 * idempotency key so a replayed serve/click can't move money twice.
 */
export const adSlotEvents = pgTable(
  "ad_slot_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slot_id: uuid("slot_id")
      .notNull()
      .references(() => adSlots.id, { onDelete: "cascade" }),
    campaign_id: uuid("campaign_id").references(() => adCampaigns.id, {
      onDelete: "set null",
    }),
    creative_id: uuid("creative_id").references(() => adCreatives.id, {
      onDelete: "set null",
    }),

    type: text("type").$type<AdSlotEventType>().notNull(),
    /** Opaque per-impression token (also the revenue idempotency key). */
    impression_id: text("impression_id").notNull(),
    /** Revenue attributed to this event (publisher share of the served price). */
    revenue: numeric("revenue", { precision: 12, scale: 6 }).notNull().default("0.000000"),
    /**
     * When the publisher earnings credit for this impression settled. NULL on
     * an impression with revenue means the payout is pending — the impression
     * row (written in the same transaction as the advertiser debit) is the
     * durable pending-payout record, settled idempotently after commit and
     * retried on subsequent serves. Never NULL-and-forgotten: unsettled rows
     * are visible drift by construction.
     */
    payout_settled_at: timestamp("payout_settled_at"),

    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    slot_idx: index("ad_slot_events_slot_idx").on(table.slot_id),
    campaign_idx: index("ad_slot_events_campaign_idx").on(table.campaign_id),
    // Cheap pending-payout scan: only unsettled impressions are indexed.
    unsettled_payout_idx: index("ad_slot_events_unsettled_payout_idx")
      .on(table.created_at)
      .where(sql`${table.payout_settled_at} IS NULL AND ${table.type} = 'impression'`),
    // (impression_id, type) is unique — the backstop that makes an impression /
    // click record (and its money movement) exactly-once.
    event_unique: uniqueIndex("ad_slot_events_impression_type_idx").on(
      table.impression_id,
      table.type,
    ),
  }),
);

export type AdSlot = InferSelectModel<typeof adSlots>;
export type NewAdSlot = InferInsertModel<typeof adSlots>;
export type AdSlotEvent = InferSelectModel<typeof adSlotEvents>;
export type NewAdSlotEvent = InferInsertModel<typeof adSlotEvents>;
