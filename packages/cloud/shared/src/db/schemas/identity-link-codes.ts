/**
 * Short-lived identity-link challenge codes minted for an authenticated
 * eliza.app session and confirmed from the messaging-channel side. A row binds
 * one pending code to the minting user/org and the platform it may claim;
 * confirmation is single-use — the consuming update flips `status` from
 * `pending` exactly once, which is the replay guard the gateway relies on.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/** Providers a link code can claim; mirrors `IdentityProvider` minus steward. */
export type IdentityLinkCodePlatform = "telegram" | "discord" | "whatsapp" | "phone";

export type IdentityLinkCodeStatus = "pending" | "linked" | "expired";

export const identityLinkCodes = pgTable(
  "identity_link_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull().unique(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    platform: text("platform").$type<IdentityLinkCodePlatform>().notNull(),
    status: text("status").$type<IdentityLinkCodeStatus>().notNull().default("pending"),
    // The platform handle the code was consumed by; written only on confirm.
    platform_id: text("platform_id"),
    expires_at: timestamp("expires_at").notNull(),
    consumed_at: timestamp("consumed_at"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    user_platform_status_idx: index("identity_link_codes_user_platform_status_idx").on(
      table.user_id,
      table.platform,
      table.status,
    ),
    expires_at_idx: index("identity_link_codes_expires_at_idx").on(table.expires_at),
  }),
);

export type IdentityLinkCode = InferSelectModel<typeof identityLinkCodes>;
export type NewIdentityLinkCode = InferInsertModel<typeof identityLinkCodes>;
