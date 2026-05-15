import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Affiliate configuration and codes table.
 * Users can create an affiliate code to earn revenue on referred users.
 */
export const affiliateCodes = pgTable(
  "affiliate_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    code: text("code").notNull().unique(),
    parent_referral_id: uuid("parent_referral_id").references(
      (): AnyPgColumn => affiliateCodes.id,
      {
        onDelete: "set null",
      },
    ),
    markup_percent: numeric("markup_percent", { precision: 6, scale: 2 })
      .notNull()
      .default("20.00"), // Default 20% markup
    is_active: boolean("is_active").default(true).notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    user_idx: index("affiliate_codes_user_idx").on(table.user_id),
    code_idx: index("affiliate_codes_code_idx").on(table.code),
    // Ensure markup is between 0 and 1000% to match API validation and migration 0029
    markup_percent_range: check(
      "markup_percent_range",
      sql`${table.markup_percent} >= 0 AND ${table.markup_percent} <= 1000`,
    ),
  }),
);

/**
 * Tracks which affiliate code a user was referred by.
 * One user can only be referred by one affiliate code.
 */
export const userAffiliates = pgTable(
  "user_affiliates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    affiliate_code_id: uuid("affiliate_code_id")
      .notNull()
      .references(() => affiliateCodes.id, { onDelete: "cascade" }),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    user_unique: uniqueIndex("user_affiliates_user_idx").on(table.user_id),
    affiliate_idx: index("user_affiliates_affiliate_idx").on(table.affiliate_code_id),
  }),
);

export type AffiliateCode = InferSelectModel<typeof affiliateCodes>;
export type NewAffiliateCode = InferInsertModel<typeof affiliateCodes>;
export type UserAffiliate = InferSelectModel<typeof userAffiliates>;
export type NewUserAffiliate = InferInsertModel<typeof userAffiliates>;
