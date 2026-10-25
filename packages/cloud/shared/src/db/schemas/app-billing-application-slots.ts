/** Binds explicitly selected native product slots to registered app billing authority without changing prepaid accounts. */
import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { billingMerchants } from "./app-billing";
import { apps } from "./apps";
import { organizations } from "./organizations";

export const appBillingApplicationSlots = pgTable(
  "app_billing_application_slots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slot_key: text("slot_key").notNull(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "restrict" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    merchant_id: uuid("merchant_id")
      .notNull()
      .references(() => billingMerchants.id, { onDelete: "restrict" }),
    livemode: boolean("livemode").notNull(),
    product_family_key: text("product_family_key").notNull(),
    manifest_digest: text("manifest_digest").notNull(),
    disabled_at: timestamp("disabled_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    active_slot: uniqueIndex("app_billing_application_slots_active_idx")
      .on(t.slot_key, t.livemode)
      .where(sql`${t.disabled_at} IS NULL`),
    manifest_unique: uniqueIndex("app_billing_application_slots_manifest_idx").on(
      t.manifest_digest,
    ),
    shape: check(
      "app_billing_application_slots_shape",
      sql`${t.slot_key} ~ '^[a-z][a-z0-9_-]{0,99}$' AND length(btrim(${t.product_family_key})) BETWEEN 1 AND 100 AND ${t.manifest_digest} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
