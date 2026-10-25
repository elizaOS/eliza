/** Defines unconfigured individual app billing accounts, separate from infrastructure funding and subscription lifecycle authority. */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apps, appUsers } from "./apps";

export const appBillingRegistrations = pgTable(
  "app_billing_registrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id").notNull(),
    owner_organization_id: uuid("owner_organization_id").notNull(),
    infrastructure_payer_organization_id: uuid("infrastructure_payer_organization_id").notNull(),
    registered_by_user_id: uuid("registered_by_user_id").notNull(),
    provider_environment: text("provider_environment").$type<"test" | "live">().notNull(),
    merchant_state: text("merchant_state")
      .$type<"unconfigured">()
      .notNull()
      .default("unconfigured"),
    policy_state: text("policy_state").$type<"unconfigured">().notNull().default("unconfigured"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    app_owner_fk: foreignKey({
      columns: [table.app_id, table.owner_organization_id, table.registered_by_user_id],
      foreignColumns: [apps.id, apps.organization_id, apps.created_by_user_id],
      name: "app_billing_registrations_owner_fk",
    }).onDelete("cascade"),
    app_environment_unique: uniqueIndex("app_billing_registrations_app_environment_idx").on(
      table.app_id,
      table.provider_environment,
    ),
    id_app_unique: uniqueIndex("app_billing_registrations_id_app_idx").on(table.id, table.app_id),
    state_check: check(
      "app_billing_registrations_state_check",
      sql`${table.merchant_state} = 'unconfigured' AND ${table.policy_state} = 'unconfigured' AND ${table.provider_environment} IN ('test','live') AND ${table.infrastructure_payer_organization_id} = ${table.owner_organization_id}`,
    ),
  }),
);

export const appSubscriberAccounts = pgTable(
  "app_subscriber_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    registration_id: uuid("registration_id").notNull(),
    app_id: uuid("app_id").notNull(),
    subscriber_user_id: uuid("subscriber_user_id").notNull(),
    account_kind: text("account_kind").$type<"individual">().notNull().default("individual"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    registration_fk: foreignKey({
      columns: [table.registration_id, table.app_id],
      foreignColumns: [appBillingRegistrations.id, appBillingRegistrations.app_id],
      name: "app_subscriber_accounts_registration_fk",
    }).onDelete("cascade"),
    consent_fk: foreignKey({
      columns: [table.app_id, table.subscriber_user_id],
      foreignColumns: [appUsers.app_id, appUsers.user_id],
      name: "app_subscriber_accounts_consent_fk",
    }).onDelete("cascade"),
    subscriber_unique: uniqueIndex("app_subscriber_accounts_subscriber_idx").on(
      table.registration_id,
      table.subscriber_user_id,
    ),
    kind_check: check(
      "app_subscriber_accounts_kind_check",
      sql`${table.account_kind} = 'individual'`,
    ),
  }),
);
