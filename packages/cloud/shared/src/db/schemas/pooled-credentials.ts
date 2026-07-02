/**
 * Team credential pool schema (#11332).
 *
 * `pooled_credentials` — one row per provider API key contributed to an
 * organization's shared pool. The key material itself is NEVER stored here:
 * it lives as a `secrets` row (AES-256-GCM envelope encryption, versioning,
 * audit log) referenced by `secret_id`. This table stores only the pool
 * metadata the rotation brain (`AccountPool` in @elizaos/app-core) reads and
 * writes — the columns mirror `LinkedAccountConfig` /
 * `LinkedAccountHealthDetail` / `LinkedAccountUsage` from @elizaos/contracts
 * 1:1 on purpose so the pool maps rows to accounts without translation.
 *
 * `pooled_credential_usage` — per-member daily rollup (org, credential, user,
 * day, calls) so "whose key is draining" and "who is using the pool" are
 * answerable. Replaces the self-host JSONL usage log in cloud.
 */

import type { LinkedAccountHealthDetail, LinkedAccountUsage } from "@elizaos/contracts";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { secrets } from "./secrets";
import { users } from "./users";

export const pooledCredentials = pgTable(
  "pooled_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    /**
     * Direct-API provider id (`anthropic-api`, `openai-api`, `cerebras-api`,
     * ...) — the `LinkedAccountProviderId` direct-API subset. Subscription
     * providers (`anthropic-subscription`, `openai-codex`) are rejected at the
     * API layer (Phase 2 gate); text (not enum) so Phase 2 needs no migration.
     */
    provider: text("provider").notNull(),

    /** Ciphertext lives in the existing secrets vault — never here. */
    secret_id: uuid("secret_id")
      .notNull()
      .references(() => secrets.id, { onDelete: "cascade" }),

    label: text("label").notNull(),

    /** Last 4 chars of the key, captured at contribution for masked display. */
    key_last4: text("key_last4").notNull(),

    /** Contributor. Nullable so removing a user never deletes org keys. */
    contributed_by: uuid("contributed_by").references(() => users.id, {
      onDelete: "set null",
    }),

    /** Lower = higher priority (AccountPool `priority` strategy order). */
    priority: integer("priority").notNull().default(100),
    enabled: boolean("enabled").notNull().default(true),

    /** LinkedAccountHealth: ok | rate-limited | needs-reauth | invalid | unknown */
    health: text("health").notNull().default("ok"),
    health_detail: jsonb("health_detail").$type<LinkedAccountHealthDetail>(),
    usage: jsonb("usage").$type<LinkedAccountUsage>(),

    last_used_at: timestamp("last_used_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("pooled_credentials_org_idx").on(table.organization_id),
    index("pooled_credentials_org_provider_idx").on(table.organization_id, table.provider),
    index("pooled_credentials_contributed_by_idx").on(table.contributed_by),
    /** One pool row per vault secret. */
    uniqueIndex("pooled_credentials_secret_id_idx").on(table.secret_id),
  ],
);

export const pooledCredentialUsage = pgTable(
  "pooled_credential_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    credential_id: uuid("credential_id")
      .notNull()
      .references(() => pooledCredentials.id, { onDelete: "cascade" }),

    /** The member whose workload consumed the credential. */
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** UTC day bucket (YYYY-MM-DD). */
    day: date("day").notNull(),

    calls: integer("calls").notNull().default(0),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("pooled_credential_usage_org_idx").on(table.organization_id),
    index("pooled_credential_usage_credential_idx").on(table.credential_id),
    uniqueIndex("pooled_credential_usage_cred_user_day_idx").on(
      table.credential_id,
      table.user_id,
      table.day,
    ),
  ],
);

export type PooledCredential = InferSelectModel<typeof pooledCredentials>;
export type NewPooledCredential = InferInsertModel<typeof pooledCredentials>;
export type PooledCredentialUsage = InferSelectModel<typeof pooledCredentialUsage>;
export type NewPooledCredentialUsage = InferInsertModel<typeof pooledCredentialUsage>;
