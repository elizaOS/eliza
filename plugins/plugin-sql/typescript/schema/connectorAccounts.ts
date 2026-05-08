import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";

export const connectorAccountsTable = pgTable(
  "connector_accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`).notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /**
     * Provider-scoped stable account identity. Callers should prefer provider
     * account id; email/handle are acceptable fallbacks when no id exists.
     */
    accountKey: text("account_key").notNull(),
    externalId: text("external_id"),
    displayName: text("display_name"),
    username: text("username"),
    email: text("email"),
    role: text("role").notNull().default("OWNER"),
    purpose: jsonb("purpose").$type<string[]>().default(sql`'["messaging"]'::jsonb`).notNull(),
    accessGate: text("access_gate").notNull().default("open"),
    status: text("status").notNull().default("connected"),
    scopes: jsonb("scopes").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    profile: jsonb("profile").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }).default(sql`now()`).notNull(),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    uniqueIndex("connector_accounts_agent_provider_account_key_uniq").on(
      table.agentId,
      table.provider,
      table.accountKey
    ),
    uniqueIndex("connector_accounts_agent_provider_external_uniq").on(
      table.agentId,
      table.provider,
      table.externalId
    ),
    index("connector_accounts_agent_provider_idx").on(table.agentId, table.provider),
    index("connector_accounts_status_idx").on(table.status),
    index("connector_accounts_updated_idx").on(table.updatedAt),
  ]
);

export const connectorAccountCredentialsTable = pgTable(
  "connector_account_credentials",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`).notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectorAccountsTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    credentialType: text("credential_type").notNull(),
    /** Pointer to @elizaos/vault or a password-manager-backed vault entry. */
    vaultRef: text("vault_ref").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    uniqueIndex("connector_account_credentials_account_type_uniq").on(
      table.accountId,
      table.credentialType
    ),
    uniqueIndex("connector_account_credentials_agent_provider_ref_uniq").on(
      table.agentId,
      table.provider,
      table.vaultRef
    ),
    index("connector_account_credentials_agent_provider_idx").on(table.agentId, table.provider),
    index("connector_account_credentials_expires_idx").on(table.expiresAt),
  ]
);

export const connectorAccountAuditEventsTable = pgTable(
  "connector_account_audit_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`).notNull(),
    accountId: uuid("account_id").references(() => connectorAccountsTable.id, {
      onDelete: "set null",
    }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    index("connector_account_audit_agent_provider_idx").on(table.agentId, table.provider),
    index("connector_account_audit_account_idx").on(table.accountId),
    index("connector_account_audit_action_idx").on(table.action),
    index("connector_account_audit_created_idx").on(table.createdAt),
  ]
);

export const oauthFlowsTable = pgTable(
  "oauth_flows",
  {
    /** SHA-256 hex of the plaintext OAuth state. Plaintext state is never stored. */
    stateHash: text("state_hash").primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    accountId: uuid("account_id").references(() => connectorAccountsTable.id, {
      onDelete: "set null",
    }),
    redirectUri: text("redirect_uri"),
    /** Optional vault ref for PKCE code verifier or provider-specific transient secret. */
    codeVerifierRef: text("code_verifier_ref"),
    scopes: jsonb("scopes").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedBy: text("consumed_by"),
  },
  (table) => [
    index("oauth_flows_agent_provider_idx").on(table.agentId, table.provider),
    index("oauth_flows_account_idx").on(table.accountId),
    index("oauth_flows_expires_idx").on(table.expiresAt),
    index("oauth_flows_consumed_idx").on(table.consumedAt),
  ]
);
