/** Persists developer-owned, environment-specific notification targets and staged signing-key rotation. */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { organizations } from "./organizations";

export const appBillingNotificationEndpoints = pgTable(
  "app_billing_notification_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "restrict" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    livemode: boolean("livemode").notNull(),
    endpoint_url: text("endpoint_url").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    active_key_id: uuid("active_key_id"),
    active_secret: text("active_secret"),
    pending_key_id: uuid("pending_key_id"),
    pending_secret: text("pending_secret"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    app_mode_unique: uniqueIndex("app_billing_notification_endpoints_app_mode_idx").on(
      t.app_id,
      t.livemode,
    ),
    shape_check: check(
      "app_billing_notification_endpoints_shape_check",
      sql`${t.revision}>0 AND (${t.active_key_id} IS NULL)=(${t.active_secret} IS NULL) AND (${t.pending_key_id} IS NULL)=(${t.pending_secret} IS NULL) AND (NOT ${t.enabled} OR ${t.active_key_id} IS NOT NULL)`,
    ),
  }),
);
