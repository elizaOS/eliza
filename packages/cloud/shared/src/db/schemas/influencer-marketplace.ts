/**
 * Influencer marketing marketplace (#10687).
 *
 * A two-sided marketplace: creators publish an influencer profile (reach, niche,
 * rate card); advertisers book them with an escrowed offer. Money is held via
 * existing rails — the advertiser's org credits are debited when the offer is
 * funded, released to the influencer's `redeemable_earnings` on approval, or
 * refunded to the advertiser on rejection/cancel. Every money move is idempotent
 * on the booking id and finalized by an atomic status CAS, so it happens once.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export type InfluencerProfileStatus = "active" | "inactive";

/** Where the influencer's audience lives + its size. */
export interface InfluencerPlatform {
  platform: string; // "x" | "instagram" | "tiktok" | "youtube" | "farcaster" | ...
  handle: string;
  followers: number;
}

/**
 * Booking lifecycle (advertiser ⇄ influencer):
 *   funding   → booking intent recorded; escrow debit not yet confirmed
 *   offered   → escrow debited from the advertiser's org credits; offer live
 *   accepted  → influencer accepted
 *   delivered → influencer submitted the deliverable
 *   approved  → advertiser approved; escrow released to influencer earnings (paid)
 *   rejected  → influencer declined (from offered or accepted) / advertiser
 *               rejected the deliverable (refunded)
 *   cancelled → advertiser cancelled before acceptance (refunded)
 */
export type InfluencerBookingStatus =
  | "funding"
  | "offered"
  | "accepted"
  | "delivered"
  // Intermediate CLAIM states for the `delivered` money fork (#11116): exactly
  // one of approve/rejectDeliverable can CAS `delivered` → `approving`/`refunding`,
  // so only the winner moves money. A crash in the claim→money→finalize window
  // leaves the booking here for the same operation to resume (money ops are
  // idempotent). `status` is a plain text column, so this needs no migration.
  | "approving"
  | "refunding"
  | "approved"
  | "rejected"
  | "cancelled";

export const influencerProfiles = pgTable(
  "influencer_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    display_name: text("display_name").notNull(),
    niche: text("niche"),
    bio: text("bio"),
    platforms: jsonb("platforms").$type<InfluencerPlatform[]>().notNull().default([]),
    /** Free-form rate card, e.g. { post: 250, story: 100, currency: "USD" }. */
    rate_card: jsonb("rate_card").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<InfluencerProfileStatus>().notNull().default("active"),

    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    user_idx: index("influencer_profiles_user_idx").on(table.user_id),
    org_idx: index("influencer_profiles_org_idx").on(table.organization_id),
    status_idx: index("influencer_profiles_status_idx").on(table.status),
  }),
);

export const influencerBookings = pgTable(
  "influencer_bookings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    advertiser_org_id: uuid("advertiser_org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    influencer_profile_id: uuid("influencer_profile_id")
      .notNull()
      .references(() => influencerProfiles.id, { onDelete: "cascade" }),
    /** Denormalized payout target (the profile owner at booking time). */
    influencer_user_id: uuid("influencer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    brief: text("brief").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    status: text("status").$type<InfluencerBookingStatus>().notNull().default("offered"),
    deliverable_url: text("deliverable_url"),
    /** Client-supplied create key: a retried create reuses the row instead of funding twice. */
    idempotency_key: text("idempotency_key"),
    /** The escrow debit `credit_transactions.id` recorded when funding committed. */
    escrow_transaction_id: uuid("escrow_transaction_id"),

    created_by_user_id: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
    resolved_at: timestamp("resolved_at"),
  },
  (table) => ({
    advertiser_idx: index("influencer_bookings_advertiser_idx").on(table.advertiser_org_id),
    profile_idx: index("influencer_bookings_profile_idx").on(table.influencer_profile_id),
    status_idx: index("influencer_bookings_status_idx").on(table.status),
    /** DB-level dedupe gate for client create retries (NULLs exempt). */
    idempotency_key_uidx: uniqueIndex("influencer_bookings_idempotency_key_uidx").on(
      table.idempotency_key,
    ),
  }),
);

export type InfluencerProfile = InferSelectModel<typeof influencerProfiles>;
export type NewInfluencerProfile = InferInsertModel<typeof influencerProfiles>;
export type InfluencerBooking = InferSelectModel<typeof influencerBookings>;
export type NewInfluencerBooking = InferInsertModel<typeof influencerBookings>;
