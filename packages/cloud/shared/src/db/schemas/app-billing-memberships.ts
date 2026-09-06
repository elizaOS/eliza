/** Persists environment-specific membership revisions and immutable backend membership and purchaser administrator receipts. */
import type {
  AppBillingAdministratorsSnapshot,
  AppBillingMembershipChange,
} from "@elizaos/cloud-sdk/app-billing-membership";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appBillingAccounts } from "./app-billing";
import { appClientRegistrations } from "./app-delegations";
import { billingIdentitySubjects } from "./billing-identities";

export const appBillingMembershipStates = pgTable(
  "app_billing_membership_states",
  {
    billing_account_id: uuid("billing_account_id").notNull(),
    app_id: uuid("app_id").notNull(),
    livemode: boolean("livemode").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    key: primaryKey({ columns: [t.billing_account_id, t.livemode] }),
    account: foreignKey({
      columns: [t.billing_account_id, t.app_id],
      foreignColumns: [appBillingAccounts.id, appBillingAccounts.app_id],
      name: "app_billing_membership_states_account_fk",
    }).onDelete("restrict"),
    revision: check("app_billing_membership_states_revision_check", sql`${t.revision} >= 0`),
  }),
);

export const appBillingMembershipOperations = pgTable(
  "app_billing_membership_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id").notNull(),
    billing_account_id: uuid("billing_account_id").notNull(),
    livemode: boolean("livemode").notNull(),
    client_registration_id: uuid("client_registration_id").references(
      () => appClientRegistrations.id,
      { onDelete: "restrict" },
    ),
    operation_kind: text("operation_kind")
      .$type<"member_sync" | "administrator_change">()
      .notNull()
      .default("member_sync"),
    actor_user_id: uuid("actor_user_id").references(() => billingIdentitySubjects.id, {
      onDelete: "restrict",
    }),
    idempotency_key: text("idempotency_key").notNull(),
    request_digest: text("request_digest").notNull(),
    result: jsonb("result")
      .$type<AppBillingMembershipChange | AppBillingAdministratorsSnapshot>()
      .notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    account: foreignKey({
      columns: [t.billing_account_id, t.app_id],
      foreignColumns: [appBillingAccounts.id, appBillingAccounts.app_id],
      name: "app_billing_membership_operations_account_fk",
    }).onDelete("restrict"),
    idempotency: uniqueIndex("app_billing_membership_operations_key_idx").on(
      t.billing_account_id,
      t.livemode,
      t.idempotency_key,
    ),
    authority: check(
      "app_billing_membership_operations_authority_check",
      sql`(${t.operation_kind} = 'member_sync' AND ${t.client_registration_id} IS NOT NULL AND ${t.actor_user_id} IS NULL) OR (${t.operation_kind} = 'administrator_change' AND ${t.actor_user_id} IS NOT NULL)`,
    ),
    digest: check(
      "app_billing_membership_operations_digest_check",
      sql`${t.request_digest} ~ '^[0-9a-f]{64}$' AND ${t.idempotency_key} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'`,
    ),
  }),
);
