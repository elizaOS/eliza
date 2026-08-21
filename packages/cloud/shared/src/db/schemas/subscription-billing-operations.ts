/** Defines durable subscription commands, deletion fences, provider-event receipts, and incidents. */
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { billingSubscriptionRevisions, billingSubscriptions } from "./billing-subscriptions";
import { organizations } from "./organizations";
import { users } from "./users";

export const BILLING_SUBSCRIPTION_COMMAND_KINDS = [
  "upgrade",
  "downgrade",
  "cancel",
  "resume",
] as const;
export type BillingSubscriptionCommandKind = (typeof BILLING_SUBSCRIPTION_COMMAND_KINDS)[number];

export const BILLING_SUBSCRIPTION_COMMAND_STATUSES = [
  "queued",
  "processing",
  "provider_ambiguous",
  "succeeded",
  "failed",
  "superseded",
] as const;
export type BillingSubscriptionCommandStatus =
  (typeof BILLING_SUBSCRIPTION_COMMAND_STATUSES)[number];

export const billingSubscriptionCommands = pgTable(
  "billing_subscription_commands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    subscription_id: uuid("subscription_id").notNull(),
    requested_by_user_id: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: text("kind").$type<BillingSubscriptionCommandKind>().notNull(),
    target_plan_key: text("target_plan_key").$type<"plus_monthly" | "pro_monthly">(),
    expected_subscription_revision: bigint("expected_subscription_revision", {
      mode: "number",
    }).notNull(),
    idempotency_key: text("idempotency_key").notNull(),
    stripe_idempotency_key: text("stripe_idempotency_key").notNull(),
    request_digest: text("request_digest").notNull(),
    status: text("status").$type<BillingSubscriptionCommandStatus>().notNull().default("queued"),
    attempt_count: integer("attempt_count").notNull().default(0),
    lease_token: uuid("lease_token"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    provider_started_at: timestamp("provider_started_at", { withTimezone: true }),
    provider_response_digest: text("provider_response_digest"),
    error_code: text("error_code"),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subscription_tenant_fk: foreignKey({
      columns: [table.subscription_id, table.organization_id],
      foreignColumns: [billingSubscriptions.id, billingSubscriptions.organization_id],
      name: "billing_subscription_commands_subscription_tenant_fk",
    }).onDelete("restrict"),
    id_organization_unique: uniqueIndex("billing_subscription_commands_id_org_idx").on(
      table.id,
      table.organization_id,
    ),
    organization_idempotency_unique: uniqueIndex(
      "billing_subscription_commands_org_idempotency_idx",
    ).on(table.organization_id, table.idempotency_key),
    stripe_idempotency_unique: uniqueIndex(
      "billing_subscription_commands_stripe_idempotency_idx",
    ).on(table.stripe_idempotency_key),
    status_lease_idx: index("billing_subscription_commands_status_lease_idx").on(
      table.status,
      table.lease_expires_at,
    ),
    organization_created_idx: index("billing_subscription_commands_org_created_idx").on(
      table.organization_id,
      table.created_at,
    ),
    intent_check: check(
      "billing_subscription_commands_intent_check",
      sql`(${table.kind} IN ('upgrade','downgrade') AND ${table.target_plan_key} IN ('plus_monthly','pro_monthly')) OR (${table.kind} IN ('cancel','resume') AND ${table.target_plan_key} IS NULL)`,
    ),
    idempotency_check: check(
      "billing_subscription_commands_idempotency_check",
      sql`${table.idempotency_key} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' AND ${table.stripe_idempotency_key} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$' AND ${table.request_digest} ~ '^[0-9a-f]{64}$'`,
    ),
    revision_check: check(
      "billing_subscription_commands_revision_check",
      sql`${table.expected_subscription_revision} > 0 AND ${table.attempt_count} >= 0`,
    ),
    lease_check: check(
      "billing_subscription_commands_lease_check",
      sql`(${table.lease_token} IS NULL) = (${table.lease_expires_at} IS NULL)`,
    ),
    digest_check: check(
      "billing_subscription_commands_provider_digest_check",
      sql`${table.provider_response_digest} IS NULL OR ${table.provider_response_digest} ~ '^[0-9a-f]{64}$'`,
    ),
    status_shape_check: check(
      "billing_subscription_commands_status_shape_check",
      sql`(${table.status} = 'queued' AND ${table.lease_token} IS NULL AND ${table.provider_started_at} IS NULL AND ${table.provider_response_digest} IS NULL AND ${table.error_code} IS NULL AND ${table.completed_at} IS NULL) OR (${table.status} = 'processing' AND ${table.lease_token} IS NOT NULL AND ${table.error_code} IS NULL AND ${table.completed_at} IS NULL) OR (${table.status} = 'provider_ambiguous' AND ${table.lease_token} IS NULL AND ${table.provider_started_at} IS NOT NULL AND ${table.provider_response_digest} IS NULL AND ${table.error_code} IS NOT NULL AND ${table.completed_at} IS NULL) OR (${table.status} = 'succeeded' AND ${table.lease_token} IS NULL AND ${table.provider_started_at} IS NOT NULL AND ${table.provider_response_digest} IS NOT NULL AND ${table.error_code} IS NULL AND ${table.completed_at} IS NOT NULL) OR (${table.status} = 'failed' AND ${table.lease_token} IS NULL AND ${table.error_code} IS NOT NULL AND ${table.completed_at} IS NOT NULL) OR (${table.status} = 'superseded' AND ${table.lease_token} IS NULL AND ${table.provider_started_at} IS NULL AND ${table.provider_response_digest} IS NULL AND ${table.error_code} IS NOT NULL AND ${table.completed_at} IS NOT NULL)`,
    ),
  }),
);

export type BillingSubscriptionCommand = InferSelectModel<typeof billingSubscriptionCommands>;
export type NewBillingSubscriptionCommand = InferInsertModel<typeof billingSubscriptionCommands>;

export const SUBSCRIPTION_BILLING_FENCE_STATES = [
  "open",
  "deletion_requested",
  "provider_deleted",
  "released",
  "quarantined",
] as const;
export type SubscriptionBillingFenceState = (typeof SUBSCRIPTION_BILLING_FENCE_STATES)[number];

export const subscriptionBillingFences = pgTable(
  "subscription_billing_fences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    subscription_id: uuid("subscription_id").notNull(),
    state: text("state").$type<SubscriptionBillingFenceState>().notNull().default("open"),
    fence_revision: bigint("fence_revision", { mode: "number" }).notNull().default(1),
    provider_object_version: bigint("provider_object_version", { mode: "number" }).notNull(),
    provider_event_id: text("provider_event_id"),
    provider_event_created_at: timestamp("provider_event_created_at", { withTimezone: true }),
    provider_object_digest: text("provider_object_digest").notNull(),
    deletion_requested_at: timestamp("deletion_requested_at", { withTimezone: true }),
    provider_deleted_at: timestamp("provider_deleted_at", { withTimezone: true }),
    released_at: timestamp("released_at", { withTimezone: true }),
    last_reconciled_at: timestamp("last_reconciled_at", { withTimezone: true }),
    next_reconcile_at: timestamp("next_reconcile_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subscription_tenant_fk: foreignKey({
      columns: [table.subscription_id, table.organization_id],
      foreignColumns: [billingSubscriptions.id, billingSubscriptions.organization_id],
      name: "subscription_billing_fences_subscription_tenant_fk",
    }).onDelete("restrict"),
    id_organization_unique: uniqueIndex("subscription_billing_fences_id_org_idx").on(
      table.id,
      table.organization_id,
    ),
    subscription_unique: uniqueIndex("subscription_billing_fences_subscription_idx").on(
      table.subscription_id,
    ),
    provider_event_unique: uniqueIndex("subscription_billing_fences_provider_event_idx")
      .on(table.provider_event_id)
      .where(sql`${table.provider_event_id} IS NOT NULL`),
    state_reconcile_idx: index("subscription_billing_fences_state_reconcile_idx").on(
      table.state,
      table.next_reconcile_at,
    ),
    provider_fence_check: check(
      "subscription_billing_fences_provider_fence_check",
      sql`${table.fence_revision} > 0 AND ${table.provider_object_version} >= 0 AND (${table.provider_event_id} IS NULL) = (${table.provider_event_created_at} IS NULL) AND (${table.provider_event_id} IS NULL OR ${table.provider_event_id} ~ '^evt_[A-Za-z0-9]+$') AND ${table.provider_object_digest} ~ '^[0-9a-f]{64}$'`,
    ),
    state_shape_check: check(
      "subscription_billing_fences_state_shape_check",
      sql`(${table.state} = 'open' AND ${table.deletion_requested_at} IS NULL AND ${table.provider_deleted_at} IS NULL AND ${table.released_at} IS NULL) OR (${table.state} = 'deletion_requested' AND ${table.deletion_requested_at} IS NOT NULL AND ${table.provider_deleted_at} IS NULL AND ${table.released_at} IS NULL) OR (${table.state} = 'provider_deleted' AND ${table.deletion_requested_at} IS NOT NULL AND ${table.provider_deleted_at} IS NOT NULL AND ${table.released_at} IS NULL) OR (${table.state} = 'released' AND ${table.deletion_requested_at} IS NOT NULL AND ${table.provider_deleted_at} IS NOT NULL AND ${table.released_at} IS NOT NULL) OR (${table.state} = 'quarantined' AND ${table.released_at} IS NULL)`,
    ),
  }),
);

export type SubscriptionBillingFence = InferSelectModel<typeof subscriptionBillingFences>;
export type NewSubscriptionBillingFence = InferInsertModel<typeof subscriptionBillingFences>;

export const BILLING_SUBSCRIPTION_EVENT_RECEIPT_STATUSES = [
  "received",
  "processing",
  "applied",
  "ignored",
  "failed",
  "quarantined",
] as const;
export type BillingSubscriptionEventReceiptStatus =
  (typeof BILLING_SUBSCRIPTION_EVENT_RECEIPT_STATUSES)[number];

export const billingSubscriptionEventReceipts = pgTable(
  "billing_subscription_event_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    subscription_id: uuid("subscription_id").notNull(),
    stripe_event_id: text("stripe_event_id").notNull(),
    event_type: text("event_type").notNull(),
    stripe_object_type: text("stripe_object_type").$type<"subscription" | "invoice">().notNull(),
    stripe_object_id: text("stripe_object_id").notNull(),
    livemode: boolean("livemode").notNull(),
    event_created_at: timestamp("event_created_at", { withTimezone: true }).notNull(),
    payload_digest: text("payload_digest").notNull(),
    status: text("status")
      .$type<BillingSubscriptionEventReceiptStatus>()
      .notNull()
      .default("received"),
    attempt_count: integer("attempt_count").notNull().default(0),
    lease_token: uuid("lease_token"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    applied_subscription_revision: bigint("applied_subscription_revision", { mode: "number" }),
    disposition: text("disposition"),
    error_code: text("error_code"),
    processed_at: timestamp("processed_at", { withTimezone: true }),
    received_at: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subscription_tenant_fk: foreignKey({
      columns: [table.subscription_id, table.organization_id],
      foreignColumns: [billingSubscriptions.id, billingSubscriptions.organization_id],
      name: "billing_subscription_event_receipts_subscription_tenant_fk",
    }).onDelete("restrict"),
    applied_revision_tenant_fk: foreignKey({
      columns: [table.subscription_id, table.organization_id, table.applied_subscription_revision],
      foreignColumns: [
        billingSubscriptionRevisions.subscription_id,
        billingSubscriptionRevisions.organization_id,
        billingSubscriptionRevisions.revision,
      ],
      name: "billing_subscription_event_receipts_revision_tenant_fk",
    }).onDelete("restrict"),
    id_organization_unique: uniqueIndex("billing_subscription_event_receipts_id_org_idx").on(
      table.id,
      table.organization_id,
    ),
    stripe_event_unique: uniqueIndex("billing_subscription_event_receipts_event_idx").on(
      table.stripe_event_id,
    ),
    status_lease_idx: index("billing_subscription_event_receipts_status_lease_idx").on(
      table.status,
      table.lease_expires_at,
    ),
    event_shape_check: check(
      "billing_subscription_event_receipts_event_shape_check",
      sql`${table.stripe_event_id} ~ '^evt_[A-Za-z0-9]+$' AND length(btrim(${table.event_type})) > 0 AND ((${table.stripe_object_type} = 'subscription' AND ${table.stripe_object_id} ~ '^sub_[A-Za-z0-9]+$') OR (${table.stripe_object_type} = 'invoice' AND ${table.stripe_object_id} ~ '^in_[A-Za-z0-9]+$')) AND ${table.payload_digest} ~ '^[0-9a-f]{64}$'`,
    ),
    progress_check: check(
      "billing_subscription_event_receipts_progress_check",
      sql`${table.attempt_count} >= 0 AND (${table.lease_token} IS NULL) = (${table.lease_expires_at} IS NULL)`,
    ),
    status_shape_check: check(
      "billing_subscription_event_receipts_status_shape_check",
      sql`(${table.status} = 'received' AND ${table.lease_token} IS NULL AND ${table.applied_subscription_revision} IS NULL AND ${table.disposition} IS NULL AND ${table.error_code} IS NULL AND ${table.processed_at} IS NULL) OR (${table.status} = 'processing' AND ${table.lease_token} IS NOT NULL AND ${table.applied_subscription_revision} IS NULL AND ${table.disposition} IS NULL AND ${table.error_code} IS NULL AND ${table.processed_at} IS NULL) OR (${table.status} = 'applied' AND ${table.lease_token} IS NULL AND ${table.applied_subscription_revision} IS NOT NULL AND ${table.disposition} IS NOT NULL AND ${table.error_code} IS NULL AND ${table.processed_at} IS NOT NULL) OR (${table.status} = 'ignored' AND ${table.lease_token} IS NULL AND ${table.applied_subscription_revision} IS NULL AND ${table.disposition} IS NOT NULL AND ${table.error_code} IS NULL AND ${table.processed_at} IS NOT NULL) OR (${table.status} IN ('failed','quarantined') AND ${table.lease_token} IS NULL AND ${table.applied_subscription_revision} IS NULL AND ${table.error_code} IS NOT NULL AND ${table.processed_at} IS NOT NULL)`,
    ),
  }),
);

export type BillingSubscriptionEventReceipt = InferSelectModel<
  typeof billingSubscriptionEventReceipts
>;
export type NewBillingSubscriptionEventReceipt = InferInsertModel<
  typeof billingSubscriptionEventReceipts
>;

export const BILLING_SUBSCRIPTION_INCIDENT_KINDS = [
  "provider_unavailable",
  "provider_timeout",
  "provider_drift",
  "command_ambiguous",
  "event_processing",
  "reconciliation",
  "deletion_fence",
] as const;
export type BillingSubscriptionIncidentKind = (typeof BILLING_SUBSCRIPTION_INCIDENT_KINDS)[number];
export const BILLING_SUBSCRIPTION_INCIDENT_SEVERITIES = ["warning", "error", "critical"] as const;
export type BillingSubscriptionIncidentSeverity =
  (typeof BILLING_SUBSCRIPTION_INCIDENT_SEVERITIES)[number];
export const BILLING_SUBSCRIPTION_INCIDENT_STATUSES = ["open", "resolved"] as const;
export type BillingSubscriptionIncidentStatus =
  (typeof BILLING_SUBSCRIPTION_INCIDENT_STATUSES)[number];

export const billingSubscriptionIncidents = pgTable(
  "billing_subscription_incidents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    subscription_id: uuid("subscription_id").notNull(),
    command_id: uuid("command_id"),
    event_receipt_id: uuid("event_receipt_id"),
    kind: text("kind").$type<BillingSubscriptionIncidentKind>().notNull(),
    severity: text("severity").$type<BillingSubscriptionIncidentSeverity>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").$type<BillingSubscriptionIncidentStatus>().notNull().default("open"),
    occurrence_count: integer("occurrence_count").notNull().default(1),
    context: jsonb("context").$type<Record<string, unknown>>().notNull(),
    first_observed_at: timestamp("first_observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    last_observed_at: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
    next_retry_at: timestamp("next_retry_at", { withTimezone: true }),
    resolved_by_user_id: uuid("resolved_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    resolution: text("resolution"),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subscription_tenant_fk: foreignKey({
      columns: [table.subscription_id, table.organization_id],
      foreignColumns: [billingSubscriptions.id, billingSubscriptions.organization_id],
      name: "billing_subscription_incidents_subscription_tenant_fk",
    }).onDelete("restrict"),
    command_tenant_fk: foreignKey({
      columns: [table.command_id, table.organization_id],
      foreignColumns: [billingSubscriptionCommands.id, billingSubscriptionCommands.organization_id],
      name: "billing_subscription_incidents_command_tenant_fk",
    }).onDelete("restrict"),
    receipt_tenant_fk: foreignKey({
      columns: [table.event_receipt_id, table.organization_id],
      foreignColumns: [
        billingSubscriptionEventReceipts.id,
        billingSubscriptionEventReceipts.organization_id,
      ],
      name: "billing_subscription_incidents_receipt_tenant_fk",
    }).onDelete("restrict"),
    id_organization_unique: uniqueIndex("billing_subscription_incidents_id_org_idx").on(
      table.id,
      table.organization_id,
    ),
    open_fingerprint_unique: uniqueIndex("billing_subscription_incidents_open_fingerprint_idx")
      .on(table.organization_id, table.subscription_id, table.fingerprint)
      .where(sql`${table.status} = 'open'`),
    status_retry_idx: index("billing_subscription_incidents_status_retry_idx").on(
      table.status,
      table.next_retry_at,
    ),
    vocabulary_check: check(
      "billing_subscription_incidents_vocabulary_check",
      sql`${table.kind} IN ('provider_unavailable','provider_timeout','provider_drift','command_ambiguous','event_processing','reconciliation','deletion_fence') AND ${table.severity} IN ('warning','error','critical') AND ${table.status} IN ('open','resolved')`,
    ),
    fingerprint_check: check(
      "billing_subscription_incidents_fingerprint_check",
      sql`${table.fingerprint} ~ '^[0-9a-f]{64}$' AND ${table.occurrence_count} > 0 AND ${table.last_observed_at} >= ${table.first_observed_at}`,
    ),
    resolution_shape_check: check(
      "billing_subscription_incidents_resolution_shape_check",
      sql`(${table.status} = 'open' AND ${table.resolved_by_user_id} IS NULL AND ${table.resolution} IS NULL AND ${table.resolved_at} IS NULL) OR (${table.status} = 'resolved' AND ${table.resolution} IS NOT NULL AND ${table.resolved_at} IS NOT NULL)`,
    ),
  }),
);

export type BillingSubscriptionIncident = InferSelectModel<typeof billingSubscriptionIncidents>;
export type NewBillingSubscriptionIncident = InferInsertModel<typeof billingSubscriptionIncidents>;
