/**
 * Durable native (mobile) App Auth client registrations.
 *
 * Replaces the secret-backed ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON,
 * ELIZA_ANDROID_ASSET_LINKS_JSON, and ELIZA_NATIVE_AUTH_CALLBACKS_JSON
 * deployment bindings.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { BrowserSignInConfiguration } from "../../lib/auth/browser-sign-in";
import { apps } from "./apps";

export const mobileAppAuthClients = pgTable(
  "mobile_app_auth_clients",
  {
    client_id: text("client_id").primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    redirect_uri: text("redirect_uri").notNull(),
    credential_ttl_seconds: integer("credential_ttl_seconds"),
    android_package_name: text("android_package_name"),
    callback_android_package: text("callback_android_package"),
    android_relations: jsonb("android_relations").$type<string[]>(),
    android_cert_fingerprints: jsonb("android_cert_fingerprints").$type<string[]>(),
    browser_sign_in: jsonb("browser_sign_in").$type<BrowserSignInConfiguration>(),
    enabled: boolean("enabled").default(true).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    appIdIdx: index("idx_mobile_app_auth_clients_app_id").on(table.app_id),
    androidPackageIdx: index("idx_mobile_app_auth_clients_android_package")
      .on(table.android_package_name)
      .where(sql`${table.android_package_name} IS NOT NULL`),
    redirectUriIdx: index("idx_mobile_app_auth_clients_redirect_uri").on(table.redirect_uri),
  }),
);

export type MobileAppAuthClient = InferSelectModel<typeof mobileAppAuthClients>;
export type NewMobileAppAuthClient = InferInsertModel<typeof mobileAppAuthClients>;
