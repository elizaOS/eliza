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
import { organizations } from "./organizations";

/**
 * OAuth intents (Wave C).
 *
 * Atomic primitive for create → deliver → await → bind/revoke OAuth flows.
 * Composes with the SensitiveRequestDispatchRegistry for link delivery and
 * publishes callback events to OAuthCallbackBus when a provider redirect
 * lands. State tokens and PKCE verifiers are stored hashed only.
 */
export const OAUTH_INTENT_PROVIDERS = [
  "google",
  "discord",
  "linkedin",
  "linear",
  "shopify",
  "calendly",
] as const;
export type OAuthIntentProvider = (typeof OAUTH_INTENT_PROVIDERS)[number];

export const OAUTH_INTENT_STATUSES = ["pending", "bound", "denied", "expired", "canceled"] as const;
export type OAuthIntentStatus = (typeof OAUTH_INTENT_STATUSES)[number];

export const OAUTH_INTENT_EVENT_NAMES = [
  "oauth.created",
  "oauth.delivered",
  "oauth.callback_received",
  "oauth.bound",
  "oauth.denied",
  "oauth.canceled",
  "oauth.expired",
  "oauth.revoked",
  "callback.dispatched",
  "callback.failed",
] as const;
export type OAuthIntentEventName = (typeof OAUTH_INTENT_EVENT_NAMES)[number];

export const oauthIntents = pgTable(
  "oauth_intents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // agent_id FK enforced in SQL; mirrors payment_requests convention.
    agent_id: uuid("agent_id"),

    provider: text("provider").$type<OAuthIntentProvider>().notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    expected_identity_id: text("expected_identity_id"),

    status: text("status").$type<OAuthIntentStatus>().notNull().default("pending"),

    state_token_hash: text("state_token_hash").notNull(),
    pkce_verifier_hash: text("pkce_verifier_hash"),

    hosted_url: text("hosted_url"),
    callback_url: text("callback_url"),

    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    state_token_hash_unique: uniqueIndex("idx_oauth_intents_state_token_hash").on(
      table.state_token_hash,
    ),
    org_created_idx: index("idx_oauth_intents_org_created").on(
      table.organization_id,
      table.created_at,
    ),
    status_expires_idx: index("idx_oauth_intents_status_expires").on(
      table.status,
      table.expires_at,
    ),
    agent_idx: index("idx_oauth_intents_agent").on(table.agent_id),
    expected_identity_idx: index("idx_oauth_intents_expected_identity").on(
      table.expected_identity_id,
    ),
    provider_check: check(
      "oauth_intents_provider_check",
      sql`${table.provider} IN ('google','discord','linkedin','linear','shopify','calendly')`,
    ),
    status_check: check(
      "oauth_intents_status_check",
      sql`${table.status} IN ('pending','bound','denied','expired','canceled')`,
    ),
  }),
);

export const oauthIntentEvents = pgTable(
  "oauth_intent_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    oauth_intent_id: uuid("oauth_intent_id")
      .notNull()
      .references(() => oauthIntents.id, { onDelete: "cascade" }),
    event_name: text("event_name").$type<OAuthIntentEventName>().notNull(),
    redacted_payload: jsonb("redacted_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    intent_occurred_idx: index("idx_oauth_intent_events_intent").on(
      table.oauth_intent_id,
      table.occurred_at,
    ),
    event_name_check: check(
      "oauth_intent_events_event_name_check",
      sql`${table.event_name} IN (
        'oauth.created','oauth.delivered','oauth.callback_received',
        'oauth.bound','oauth.denied','oauth.canceled','oauth.expired',
        'oauth.revoked','callback.dispatched','callback.failed'
      )`,
    ),
  }),
);

export type OAuthIntentRow = InferSelectModel<typeof oauthIntents>;
export type NewOAuthIntent = InferInsertModel<typeof oauthIntents>;
export type OAuthIntentEventRow = InferSelectModel<typeof oauthIntentEvents>;
export type NewOAuthIntentEvent = InferInsertModel<typeof oauthIntentEvents>;
