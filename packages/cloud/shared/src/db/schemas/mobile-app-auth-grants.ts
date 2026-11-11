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
    /**
     * When the owner's interactive sign-in that this grant descends from was
     * approved. Set on a sign-in grant and copied forward by key renewal. No
     * renewal code is issued after this time plus the absolute renewal cap,
     * and no credential of the sign-in expires later than that: a successor's
     * expiry is clamped to it. A grant without it (issued before the column
     * existed) counts from `created_at`.
     */
    session_started_at: timestamp("session_started_at", { withTimezone: true }),
    /**
     * The sign-in this grant belongs to. A sign-in grant gets a fresh id and
     * every renewal grant copies its predecessor's, so revoking a device can
     * retire every credential renewed from it. A grant without it (issued
     * before the column existed) is its own session; its first renewal stamps
     * the grant's own `id` here.
     */
    session_id: uuid("session_id"),
    /**
     * Renewal grants only: the credential that asked for this successor. Not
     * a foreign key, so the link never silently clears: exchange and
     * acknowledgement re-read that row and refuse unless it is still active.
     */
    renewed_from_credential_id: uuid("renewed_from_credential_id"),
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
    sessionIdx: index("idx_mobile_app_auth_grants_session")
      .on(table.session_id)
      .where(sql`${table.session_id} IS NOT NULL`),
    renewedFromIdx: index("idx_mobile_app_auth_grants_renewed_from")
      .on(table.renewed_from_credential_id)
      .where(sql`${table.renewed_from_credential_id} IS NOT NULL`),
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
