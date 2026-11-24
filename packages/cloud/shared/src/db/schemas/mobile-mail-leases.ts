import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { EncryptedField } from "../crypto/field-crypto";
import { apiKeys } from "./api-keys";

export const mobileMailLeases = pgTable(
  "mobile_mail_leases",
  {
    id: uuid("id").primaryKey(),
    session_id: uuid("session_id").notNull().unique(),
    credential_id: uuid("credential_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    refresh_hash: text("refresh_hash").notNull().unique(),
    access_hash: text("access_hash").unique(),
    access_expires_at: timestamp("access_expires_at", { withTimezone: true }),
    idle_expires_at: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
    initial_delivery: jsonb("initial_delivery").$type<EncryptedField>(),
    offered_refresh_hash: text("offered_refresh_hash").unique(),
    offered_access_hash: text("offered_access_hash").unique(),
    offered_access_expires_at: timestamp("offered_access_expires_at", { withTimezone: true }),
    offered_delivery: jsonb("offered_delivery").$type<EncryptedField>(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("mobile_mail_leases_credential_idx").on(table.credential_id),
    check(
      "mobile_mail_leases_access_complete",
      sql`(${table.access_hash} IS NULL) = (${table.access_expires_at} IS NULL)`,
    ),
    check(
      "mobile_mail_leases_offer_complete",
      sql`num_nonnulls(${table.offered_refresh_hash}, ${table.offered_access_hash}, ${table.offered_access_expires_at}, ${table.offered_delivery}) IN (0, 4)`,
    ),
  ],
);

export const spentMobileMailRefreshes = pgTable(
  "spent_mobile_mail_refreshes",
  {
    refresh_hash: text("refresh_hash").primaryKey(),
    lease_id: uuid("lease_id")
      .notNull()
      .references(() => mobileMailLeases.id, { onDelete: "cascade" }),
  },
  (table) => [index("spent_mobile_mail_refreshes_lease_idx").on(table.lease_id)],
);
