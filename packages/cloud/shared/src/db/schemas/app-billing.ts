/** Owns app-scoped billing registration, immutable offers, trial eligibility and delivery receipts. */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { billingEligibilityPrincipals } from "./billing-identities";
import { organizations } from "./organizations";
import { users } from "./users";

export interface AppPlanEntitlements {
  features: string[];
  completionsRpm: number;
  embeddingsRpm: number;
  standardRpm: number;
  strictRpm: number;
}

export const billingMerchants = pgTable(
  "billing_merchants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    provider_account_key: text("provider_account_key").notNull(),
    stripe_account_id: text("stripe_account_id"),
    connection_revision: bigint("connection_revision", { mode: "number" }).notNull().default(1),
    disconnected_at: timestamp("disconnected_at", { withTimezone: true }),
    livemode: boolean("livemode").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actual_account_unique: uniqueIndex("billing_merchants_actual_account_mode_idx")
      .on(t.stripe_account_id, t.livemode)
      .where(sql`${t.stripe_account_id} IS NOT NULL`),
    connection_check: check(
      "billing_merchants_connection_check",
      sql`${t.connection_revision} > 0 AND (${t.stripe_account_id} IS NULL OR ${t.stripe_account_id} ~ '^acct_[A-Za-z0-9]+$') AND (${t.provider_account_key} = 'platform' OR ${t.stripe_account_id} IS NULL OR ${t.provider_account_key} = ${t.stripe_account_id}) AND (${t.disconnected_at} IS NULL OR NOT ${t.enabled})`,
    ),
    mode_unique: uniqueIndex("billing_merchants_id_mode_idx").on(t.id, t.livemode),
    account_unique: uniqueIndex("billing_merchants_account_mode_idx").on(
      t.provider_account_key,
      t.livemode,
    ),
    provider_check: check(
      "billing_merchants_provider_check",
      sql`${t.provider_account_key} = 'platform' OR ${t.provider_account_key} ~ '^acct_[A-Za-z0-9]+$'`,
    ),
  }),
);

export const appBillingAccounts = pgTable(
  "app_billing_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "restrict" }),
    display_name: text("display_name").notNull(),
    external_account_key: text("external_account_key").notNull(),
    external_reference: text("external_reference"),
    eligibility_principal_id: uuid("eligibility_principal_id")
      .notNull()
      .references(() => billingEligibilityPrincipals.id, { onDelete: "restrict" }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    app_key_unique: uniqueIndex("app_billing_accounts_app_key_idx").on(
      t.app_id,
      t.external_account_key,
    ),
    tenant_unique: uniqueIndex("app_billing_accounts_id_app_idx").on(t.id, t.app_id),
    external_reference_check: check(
      "app_billing_accounts_external_reference_check",
      sql`${t.external_reference} IS NULL OR length(btrim(${t.external_reference})) BETWEEN 1 AND 200`,
    ),
    key_check: check(
      "app_billing_accounts_key_check",
      sql`length(btrim(${t.external_account_key})) BETWEEN 1 AND 200`,
    ),
  }),
);

export const appBillingMembers = pgTable(
  "app_billing_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id").notNull(),
    billing_account_id: uuid("billing_account_id").notNull(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: text("role").$type<"administrator" | "member">().notNull(),
    livemode: boolean("livemode"),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    account_fk: foreignKey({
      columns: [t.billing_account_id, t.app_id],
      foreignColumns: [appBillingAccounts.id, appBillingAccounts.app_id],
      name: "app_billing_members_account_fk",
    }).onDelete("restrict"),
    role_check: check(
      "app_billing_members_role_check",
      sql`${t.role} IN ('administrator','member')`,
    ),
    member_unique: uniqueIndex("app_billing_members_member_idx")
      .on(t.billing_account_id, t.user_id)
      .where(sql`${t.livemode} IS NULL`),
    environment_unique: uniqueIndex("app_billing_members_environment_idx")
      .on(t.billing_account_id, t.user_id, t.livemode)
      .where(sql`${t.livemode} IS NOT NULL`),
  }),
);

export const appBillingPlanRevisions = pgTable(
  "app_billing_plan_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "restrict" }),
    merchant_id: uuid("merchant_id")
      .notNull()
      .references(() => billingMerchants.id, { onDelete: "restrict" }),
    product_family_key: text("product_family_key").notNull(),
    plan_key: text("plan_key").notNull(),
    revision: integer("revision").notNull(),
    name: text("name").notNull(),
    amount_cents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    interval: text("interval").$type<"day" | "week" | "month" | "year">().notNull(),
    interval_count: integer("interval_count").notNull().default(1),
    minimum_quantity: integer("minimum_quantity").notNull().default(1),
    maximum_quantity: integer("maximum_quantity").notNull(),
    trial_days: integer("trial_days").notNull().default(7),
    trial_allowance_usd: numeric("trial_allowance_usd", { precision: 16, scale: 6 })
      .notNull()
      .default("0.000000"),
    paid_allowance_usd: numeric("paid_allowance_usd", { precision: 16, scale: 6 })
      .notNull()
      .default("0.000000"),
    expired_access: text("expired_access").$type<"read_only" | "denied">().notNull(),
    entitlements: jsonb("entitlements").$type<AppPlanEntitlements>().notNull(),
    stripe_price_id: text("stripe_price_id").notNull(),
    stripe_product_id: text("stripe_product_id").notNull(),
    published_at: timestamp("published_at", { withTimezone: true }),
    retired_at: timestamp("retired_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    revision_unique: uniqueIndex("app_billing_plan_revisions_key_idx").on(
      t.app_id,
      t.product_family_key,
      t.plan_key,
      t.revision,
    ),
    scope_unique: uniqueIndex("app_billing_plan_revisions_scope_idx").on(
      t.id,
      t.app_id,
      t.merchant_id,
      t.product_family_key,
    ),
    access_check: check(
      "app_billing_plan_revisions_access_check",
      sql`${t.expired_access} IN ('read_only','denied')`,
    ),
    policy_check: check(
      "app_billing_plan_revisions_policy_check",
      sql`${t.revision} > 0 AND ${t.amount_cents} > 0 AND ${t.currency} ~ '^[a-z]{3}$' AND ${t.interval} IN ('day','week','month','year') AND ${t.interval_count} > 0 AND ${t.minimum_quantity} > 0 AND ${t.maximum_quantity} >= ${t.minimum_quantity} AND ${t.trial_days} = 7 AND ${t.trial_allowance_usd} >= 0 AND ${t.paid_allowance_usd} >= 0`,
    ),
    identity_check: check(
      "app_billing_plan_revisions_identity_check",
      sql`${t.stripe_price_id} ~ '^price_[A-Za-z0-9]+$' AND ${t.stripe_product_id} ~ '^prod_[A-Za-z0-9]+$' AND length(btrim(${t.product_family_key})) BETWEEN 1 AND 100 AND length(btrim(${t.plan_key})) BETWEEN 1 AND 100`,
    ),
  }),
);

export const appBillingScopes = pgTable(
  "app_billing_scopes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    command_reconcile_after: timestamp("command_reconcile_after", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reconcile_after: timestamp("reconcile_after", { withTimezone: true }).notNull().defaultNow(),
    reconcile_lease_token: uuid("reconcile_lease_token"),
    reconcile_lease_expires_at: timestamp("reconcile_lease_expires_at", { withTimezone: true }),
    reconcile_error_code: text("reconcile_error_code"),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "restrict" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    billing_account_id: uuid("billing_account_id").notNull(),
    merchant_id: uuid("merchant_id")
      .notNull()
      .references(() => billingMerchants.id, { onDelete: "restrict" }),
    livemode: boolean("livemode").notNull(),
    product_family_key: text("product_family_key").notNull(),
    fenced_at: timestamp("fenced_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reconcile_due_idx: index("app_billing_scopes_reconcile_due_idx").on(t.reconcile_after),
    command_due_idx: index("app_billing_scopes_command_reconcile_due_idx").on(
      t.command_reconcile_after,
    ),
    reconcile_lease_check: check(
      "app_billing_scopes_reconcile_lease_check",
      sql`(${t.reconcile_lease_token} IS NULL)=(${t.reconcile_lease_expires_at} IS NULL)`,
    ),
    merchant_mode_fk: foreignKey({
      columns: [t.merchant_id, t.livemode],
      foreignColumns: [billingMerchants.id, billingMerchants.livemode],
      name: "app_billing_scopes_merchant_mode_fk",
    }).onDelete("restrict"),
    mode_unique: uniqueIndex("app_billing_scopes_id_app_mode_idx").on(t.id, t.app_id, t.livemode),
    account_fk: foreignKey({
      columns: [t.billing_account_id, t.app_id],
      foreignColumns: [appBillingAccounts.id, appBillingAccounts.app_id],
      name: "app_billing_scopes_account_fk",
    }).onDelete("restrict"),
    family_unique: uniqueIndex("app_billing_scopes_family_idx").on(
      t.billing_account_id,
      t.product_family_key,
      t.livemode,
    ),
    tenant_unique: uniqueIndex("app_billing_scopes_id_org_idx").on(t.id, t.organization_id),
    identity_unique: uniqueIndex("app_billing_scopes_identity_idx").on(
      t.id,
      t.app_id,
      t.merchant_id,
      t.product_family_key,
    ),
  }),
);

export const appBillingCustomers = pgTable(
  "app_billing_customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billing_account_id: uuid("billing_account_id")
      .notNull()
      .references(() => appBillingAccounts.id, { onDelete: "restrict" }),
    merchant_id: uuid("merchant_id")
      .notNull()
      .references(() => billingMerchants.id, { onDelete: "restrict" }),
    stripe_customer_id: text("stripe_customer_id").notNull(),
    command_id: uuid("command_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    binding_unique: uniqueIndex("app_billing_customers_binding_idx").on(
      t.billing_account_id,
      t.merchant_id,
    ),
    customer_unique: uniqueIndex("app_billing_customers_provider_idx").on(
      t.merchant_id,
      t.stripe_customer_id,
    ),
    customer_check: check(
      "app_billing_customers_customer_check",
      sql`${t.stripe_customer_id} ~ '^cus_[A-Za-z0-9]+$'`,
    ),
  }),
);

export const appSubscriptionTrials = pgTable(
  "app_subscription_trials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "restrict" }),
    eligibility_principal_id: uuid("eligibility_principal_id")
      .notNull()
      .references(() => billingEligibilityPrincipals.id, { onDelete: "restrict" }),
    billing_scope_id: uuid("billing_scope_id")
      .notNull()
      .references(() => appBillingScopes.id, { onDelete: "restrict" }),
    livemode: boolean("livemode").notNull(),
    command_id: uuid("command_id").notNull(),
    plan_revision_id: uuid("plan_revision_id")
      .notNull()
      .references(() => appBillingPlanRevisions.id, { onDelete: "restrict" }),
    starts_at: timestamp("starts_at", { withTimezone: true }).notNull(),
    ends_at: timestamp("ends_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scope_mode_fk: foreignKey({
      columns: [t.billing_scope_id, t.app_id, t.livemode],
      foreignColumns: [appBillingScopes.id, appBillingScopes.app_id, appBillingScopes.livemode],
      name: "app_subscription_trials_scope_mode_fk",
    }).onDelete("restrict"),
    eligibility_unique: uniqueIndex("app_subscription_trials_eligibility_idx").on(
      t.app_id,
      t.eligibility_principal_id,
      t.livemode,
    ),
    command_unique: uniqueIndex("app_subscription_trials_command_idx").on(t.command_id),
    duration_check: check(
      "app_subscription_trials_duration_check",
      sql`extract(epoch FROM ${t.ends_at} - ${t.starts_at}) = 604800`,
    ),
  }),
);

export const appSubscriptionOutbox = pgTable(
  "app_subscription_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billing_scope_id: uuid("billing_scope_id")
      .notNull()
      .references(() => appBillingScopes.id, { onDelete: "restrict" }),
    subscription_id: uuid("subscription_id").notNull(),
    subscription_revision: bigint("subscription_revision", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
    state: text("state")
      .$type<"pending" | "processing" | "delivered" | "terminal">()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lease_token: uuid("lease_token"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    error_code: text("error_code"),
    endpoint_revision: integer("endpoint_revision"),
    delivered_at: timestamp("delivered_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    delivery_check: check(
      "app_subscription_outbox_delivery_check",
      sql`${t.attempts}>=0 AND (${t.lease_token} IS NULL)=(${t.lease_expires_at} IS NULL) AND (${t.state}='processing')=(${t.lease_token} IS NOT NULL) AND (${t.state}='delivered')=(${t.delivered_at} IS NOT NULL) AND ${t.state} IN ('pending','processing','delivered','terminal')`,
    ),
    due_idx: index("app_subscription_outbox_due_idx")
      .on(t.next_attempt_at, t.created_at)
      .where(sql`${t.state} IN ('pending','processing')`),
    transition_unique: uniqueIndex("app_subscription_outbox_transition_idx").on(
      t.subscription_id,
      t.subscription_revision,
      t.kind,
    ),
    revision_check: check(
      "app_subscription_outbox_revision_check",
      sql`${t.subscription_revision} > 0`,
    ),
  }),
);

export type AppBillingPlanRevision = typeof appBillingPlanRevisions.$inferSelect;
export type AppTrialClaim = typeof appSubscriptionTrials.$inferSelect;

/** Records qualified paid periods even for plans whose included allowance is zero. */
export const appSubscriptionPaidPeriods = pgTable(
  "app_subscription_paid_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billing_scope_id: uuid("billing_scope_id")
      .notNull()
      .references(() => appBillingScopes.id, { onDelete: "restrict" }),
    subscription_id: uuid("subscription_id").notNull(),
    plan_revision_id: uuid("plan_revision_id")
      .notNull()
      .references(() => appBillingPlanRevisions.id, { onDelete: "restrict" }),
    merchant_key: text("merchant_key").notNull(),
    livemode: boolean("livemode").notNull(),
    stripe_invoice_id: text("stripe_invoice_id").notNull(),
    stripe_price_id: text("stripe_price_id").notNull(),
    quantity: integer("quantity").notNull(),
    period_start: timestamp("period_start", { withTimezone: true }).notNull(),
    period_end: timestamp("period_end", { withTimezone: true }).notNull(),
    provider_digest: text("provider_digest").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invoice_unique: uniqueIndex("app_subscription_paid_periods_invoice_idx").on(
      t.merchant_key,
      t.livemode,
      t.stripe_invoice_id,
    ),
    source_check: check(
      "app_subscription_paid_periods_source_check",
      sql`${t.stripe_invoice_id} ~ '^in_[A-Za-z0-9]+$' AND ${t.stripe_price_id} ~ '^price_[A-Za-z0-9]+$' AND ${t.quantity} > 0 AND ${t.period_end} > ${t.period_start} AND ${t.provider_digest} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const appBillingSeats = pgTable(
  "app_billing_seats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billing_scope_id: uuid("billing_scope_id")
      .notNull()
      .references(() => appBillingScopes.id, { onDelete: "restrict" }),
    subject: text("subject").notNull(),
    idempotency_key: text("idempotency_key").notNull(),
    assigned_at: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    active_subject_unique: uniqueIndex("app_billing_seats_active_subject_idx")
      .on(t.billing_scope_id, t.subject)
      .where(sql`${t.revoked_at} IS NULL`),
    operation_unique: uniqueIndex("app_billing_seats_operation_idx").on(
      t.billing_scope_id,
      t.idempotency_key,
    ),
    subject_check: check(
      "app_billing_seats_subject_check",
      sql`length(btrim(${t.subject})) BETWEEN 1 AND 200 AND length(btrim(${t.idempotency_key})) BETWEEN 8 AND 128`,
    ),
  }),
);
