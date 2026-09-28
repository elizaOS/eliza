// Defines the append-only user consent ledger Drizzle table shape.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/** Purposes a user can grant or revoke. Extend deliberately (API + UI contract). */
export const USER_CONSENT_PURPOSES = ["vision_capture"] as const;
export type UserConsentPurpose = (typeof USER_CONSENT_PURPOSES)[number];

/**
 * Append-only consent ledger. Every grant or revocation is a new row; the
 * current decision for a purpose is the latest row. Rows are never updated so
 * the history of what a user agreed to, under which policy version, survives.
 * Rows cascade with the user (private data erased at account deletion) and are
 * included in the portable account export through the user FK.
 */
export const userConsents = pgTable(
  "user_consents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    purpose: text("purpose").$type<UserConsentPurpose>().notNull(),
    granted: boolean("granted").notNull(),
    policy_version: text("policy_version").notNull(),
    /** Where the decision was recorded (e.g. `api`, `privacy_panel`). */
    source: text("source").notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    user_purpose_idx: index("user_consents_user_purpose_idx").on(
      table.user_id,
      table.organization_id,
      table.purpose,
      table.recorded_at,
    ),
    purpose_check: check(
      "user_consents_purpose_check",
      sql`${table.purpose} IN ('vision_capture')`,
    ),
  }),
);

export type UserConsent = InferSelectModel<typeof userConsents>;
export type NewUserConsent = InferInsertModel<typeof userConsents>;
