/**
 * Durable first-party mobile Authorization Code + PKCE grants.
 *
 * Grant rows contain only a hash of the opaque code and the public PKCE
 * challenge. A credential stays inactive while the grant is `exchanged`; the
 * client activates it only after durably persisting the returned secret.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apiKeys } from "./api-keys";
import { apps } from "./apps";
import { organizations } from "./organizations";
import { users } from "./users";

export const MOBILE_APP_AUTH_GRANT_STATUSES = ["pending", "exchanged", "acknowledged"] as const;
export type MobileAppAuthGrantStatus = (typeof MOBILE_APP_AUTH_GRANT_STATUSES)[number];

export const MOBILE_APP_AUTH_ENVIRONMENTS = ["staging", "production"] as const;
export type MobileAppAuthEnvironment = (typeof MOBILE_APP_AUTH_ENVIRONMENTS)[number];

export const mobileAppAuthGrants = pgTable(
  "mobile_app_auth_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code_hash: text("code_hash").notNull(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    client_id: text("client_id").notNull(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environment: text("environment").$type<MobileAppAuthEnvironment>().notNull(),
    device_name: text("device_name"),
    redirect_uri: text("redirect_uri").notNull(),
    state_hash: text("state_hash").notNull(),
    code_challenge: text("code_challenge").notNull(),
    code_challenge_method: text("code_challenge_method").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    status: text("status").$type<MobileAppAuthGrantStatus>().notNull().default("pending"),
    credential_id: uuid("credential_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    exchanged_at: timestamp("exchanged_at", { withTimezone: true }),
    acknowledged_at: timestamp("acknowledged_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeHashUnique: uniqueIndex("idx_mobile_app_auth_grants_code_hash").on(table.code_hash),
    expiresStatusIdx: index("idx_mobile_app_auth_grants_expires_status").on(
      table.expires_at,
      table.status,
    ),
    credentialIdx: index("idx_mobile_app_auth_grants_credential")
      .on(table.credential_id)
      .where(sql`${table.credential_id} IS NOT NULL`),
    environmentCheck: check(
      "mobile_app_auth_grants_environment_check",
      sql`${table.environment} IN ('staging','production')`,
    ),
    challengeMethodCheck: check(
      "mobile_app_auth_grants_challenge_method_check",
      sql`${table.code_challenge_method} = 'S256'`,
    ),
    statusCheck: check(
      "mobile_app_auth_grants_status_check",
      sql`${table.status} IN ('pending','exchanged','acknowledged')`,
    ),
  }),
);

export type MobileAppAuthGrant = InferSelectModel<typeof mobileAppAuthGrants>;
export type NewMobileAppAuthGrant = InferInsertModel<typeof mobileAppAuthGrants>;
