/** Stores registered app clients and narrow grants without creating Cloud API credentials. */

import type { AppDelegationScope } from "@elizaos/cloud-sdk/app-delegation";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { organizations } from "./organizations";
import { users } from "./users";

export const appClientRegistrations = pgTable(
  "app_client_registrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    owner_organization_id: uuid("owner_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    billing_environment: text("billing_environment").$type<"test" | "live">().notNull(),
    secret_hashes: jsonb("secret_hashes").$type<string[]>().notNull(),
    billing_return_url: text("billing_return_url"),
    redirect_uris: jsonb("redirect_uris").$type<string[]>().notNull(),
    allowed_scopes: jsonb("allowed_scopes").$type<AppDelegationScope[]>().notNull(),
    revision: integer("revision").notNull().default(1),
    is_active: boolean("is_active").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    id_app: unique("app_client_registrations_id_app_idx").on(table.id, table.app_id),
    environment: check(
      "app_client_registrations_billing_environment_check",
      sql`${table.billing_environment} IN ('test', 'live')`,
    ),
    revision: check("app_client_registrations_revision_check", sql`${table.revision} > 0`),
  }),
);

export const appDelegations = pgTable(
  "app_delegations",
  {
    token_hash: text("token_hash").primaryKey(),
    authorization_code_hash: text("authorization_code_hash").notNull().unique(),
    client_id: uuid("client_id").notNull(),
    app_id: uuid("app_id").notNull(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    consent_id: uuid("consent_id").notNull(),
    organization_id: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    registration_revision: integer("registration_revision").notNull(),
    scopes: jsonb("scopes").$type<AppDelegationScope[]>().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    client: foreignKey({
      columns: [table.client_id, table.app_id],
      foreignColumns: [appClientRegistrations.id, appClientRegistrations.app_id],
      name: "app_delegations_client_app_fk",
    }).onDelete("cascade"),
    digests: check(
      "app_delegations_digest_check",
      sql`${table.token_hash} ~ '^[0-9a-f]{64}$' AND ${table.authorization_code_hash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
