// Defines the payment requests Drizzle table shape used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * Payment requests (Wave B).
 *
 * Single canonical surface that supersedes app_charges, crypto_payments, and
 * x402_payment_requests. The legacy tables continue to exist alongside this one
 * until Wave H migrates rows and decommissions them.
 *
 * `provider`, `status`, and `event_name` are constrained via SQL CHECK rather
 * than pg enums so providers/statuses/events can be added without ALTER TYPE
 * coordination across deployments.
 */
export const PAYMENT_REQUEST_PROVIDERS = ["stripe", "oxapay", "x402", "wallet_native"] as const;
export type PaymentRequestProvider = (typeof PAYMENT_REQUEST_PROVIDERS)[number];
export const MAX_PAYMENT_REQUEST_LEDGER_CENTS = 99_999_999;

export const PAYMENT_REQUEST_STATUSES = [
  "pending",
  "delivered",
  "settled",
  "failed",
  "expired",
  "canceled",
] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

export const PAYMENT_REQUEST_EVENT_NAMES = [
  "payment.created",
  "payment.delivered",
  "payment.viewed",
  "payment.proof_received",
  "payment.settled",
  "payment.failed",
  "payment.canceled",
  "payment.expired",
  "callback.dispatched",
  "callback.failed",
  "webhook.received",
] as const;
export type PaymentRequestEventName = (typeof PAYMENT_REQUEST_EVENT_NAMES)[number];

export const PAYMENT_PROVIDER_EVENT_DISPOSITIONS = ["settled", "failed"] as const;
export type PaymentProviderEventDisposition = (typeof PAYMENT_PROVIDER_EVENT_DISPOSITIONS)[number];

export const PAYMENT_CALLBACK_STATES = ["pending", "dispatched", "failed", "superseded"] as const;
export type PaymentCallbackState = (typeof PAYMENT_CALLBACK_STATES)[number];

export type PaymentContext =
  | { kind: "any_payer" }
  | { kind: "verified_payer"; scope: "owner" | "owner_or_linked_identity" }
  | { kind: "specific_payer"; payerIdentityId: string };

export const paymentRequests = pgTable(
  "payment_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // agent_id FK enforced in SQL (`agents(id)`); not declared here because the
    // agents table is defined in @elizaos/plugin-sql, not in the cloud schema set.
    agent_id: uuid("agent_id"),
    app_id: uuid("app_id").references(() => apps.id, { onDelete: "set null" }),

    provider: text("provider").$type<PaymentRequestProvider>().notNull(),
    amount_cents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull().default("usd"),
    reason: text("reason"),

    payment_context: jsonb("payment_context")
      .$type<PaymentContext>()
      .notNull()
      .default({ kind: "any_payer" }),
    payer_identity_id: text("payer_identity_id"),
    payer_user_id: uuid("payer_user_id").references(() => users.id, { onDelete: "set null" }),

    status: text("status").$type<PaymentRequestStatus>().notNull().default("pending"),
    hosted_url: text("hosted_url"),
    callback_url: text("callback_url"),
    callback_secret: text("callback_secret"),

    provider_intent: jsonb("provider_intent")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    settled_at: timestamp("settled_at", { withTimezone: true }),
    settlement_tx_ref: text("settlement_tx_ref"),
    settlement_proof: jsonb("settlement_proof").$type<Record<string, unknown>>(),

    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    id_organization_provider_unique: uniqueIndex(
      "payment_requests_id_organization_provider_unique",
    ).on(table.id, table.organization_id, table.provider),
    org_created_idx: index("idx_payment_requests_org_created").on(
      table.organization_id,
      table.created_at,
    ),
    status_expires_idx: index("idx_payment_requests_status_expires").on(
      table.status,
      table.expires_at,
    ),
    provider_intent_gin_idx: index("idx_payment_requests_provider_intent").using(
      "gin",
      table.provider_intent,
    ),
    agent_idx: index("idx_payment_requests_agent").on(table.agent_id),
    provider_check: check(
      "payment_requests_provider_check",
      sql`${table.provider} IN ('stripe','oxapay','x402','wallet_native')`,
    ),
    amount_non_negative: check(
      "payment_requests_amount_non_negative",
      sql`${table.amount_cents} >= 0`,
    ),
    status_check: check(
      "payment_requests_status_check",
      sql`${table.status} IN ('pending','delivered','settled','failed','expired','canceled')`,
    ),
  }),
);

export const paymentRequestEvents = pgTable(
  "payment_request_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    payment_request_id: uuid("payment_request_id")
      .notNull()
      .references(() => paymentRequests.id, { onDelete: "cascade" }),
    event_name: text("event_name").$type<PaymentRequestEventName>().notNull(),
    redacted_payload: jsonb("redacted_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // Provider identity and payload binding make webhook fulfillment durable.
    // These columns are populated only for webhook.received outbox rows.
    provider: text("provider").$type<PaymentRequestProvider>(),
    provider_event_id: text("provider_event_id"),
    provider_tx_ref: text("provider_tx_ref"),
    provider_disposition: text("provider_disposition").$type<PaymentProviderEventDisposition>(),
    payload_digest: text("payload_digest"),
    callback_state: text("callback_state").$type<PaymentCallbackState>(),
    callback_attempts: integer("callback_attempts").notNull().default(0),
    callback_last_error: text("callback_last_error"),
    callback_next_attempt_at: timestamp("callback_next_attempt_at", { withTimezone: true }),
    callback_claimed_until: timestamp("callback_claimed_until", { withTimezone: true }),
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    request_occurred_idx: index("idx_payment_request_events_request").on(
      table.payment_request_id,
      table.occurred_at,
    ),
    provider_event_unique: uniqueIndex("payment_request_events_provider_event_unique")
      .on(table.provider, table.provider_event_id)
      .where(sql`${table.event_name} = 'webhook.received'`),
    settled_provider_tx_unique: uniqueIndex("payment_request_events_settled_provider_tx_unique")
      .on(table.provider, table.provider_tx_ref)
      .where(
        sql`${table.event_name} = 'webhook.received' AND ${table.provider_disposition} = 'settled'`,
      ),
    callback_due_idx: index("payment_request_events_callback_due_idx")
      .on(table.callback_state, table.callback_next_attempt_at)
      .where(sql`${table.event_name} = 'webhook.received'`),
    event_name_check: check(
      "payment_request_events_event_name_check",
      sql`${table.event_name} IN (
        'payment.created','payment.delivered','payment.viewed','payment.proof_received',
        'payment.settled','payment.failed','payment.canceled','payment.expired',
        'callback.dispatched','callback.failed','webhook.received'
      )`,
    ),
    provider_event_shape_check: check(
      "payment_request_events_provider_event_shape_check",
      sql`(${table.event_name} <> 'webhook.received' AND ${table.provider} IS NULL AND ${table.provider_event_id} IS NULL AND ${table.provider_tx_ref} IS NULL AND ${table.provider_disposition} IS NULL AND ${table.payload_digest} IS NULL AND ${table.callback_state} IS NULL)
        OR (${table.event_name} = 'webhook.received' AND ${table.provider} IS NOT NULL AND ${table.provider_event_id} IS NOT NULL AND ${table.provider_tx_ref} IS NOT NULL AND ${table.provider_disposition} IS NOT NULL AND ${table.payload_digest} IS NOT NULL AND ${table.callback_state} IS NOT NULL)`,
    ),
    provider_event_provider_check: check(
      "payment_request_events_provider_event_provider_check",
      sql`${table.provider} IS NULL OR ${table.provider} IN ('stripe','oxapay','x402','wallet_native')`,
    ),
    provider_event_disposition_check: check(
      "payment_request_events_provider_event_disposition_check",
      sql`${table.provider_disposition} IS NULL OR ${table.provider_disposition} IN ('settled','failed')`,
    ),
    callback_state_check: check(
      "payment_request_events_callback_state_check",
      sql`${table.callback_state} IS NULL OR ${table.callback_state} IN ('pending','dispatched','failed','superseded')`,
    ),
  }),
);

export type PaymentRequestRow = InferSelectModel<typeof paymentRequests>;
export type NewPaymentRequest = InferInsertModel<typeof paymentRequests>;
export type PaymentRequestEventRow = InferSelectModel<typeof paymentRequestEvents>;
export type NewPaymentRequestEvent = InferInsertModel<typeof paymentRequestEvents>;
