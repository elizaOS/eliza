import type {
  ApprovalConfig,
  PolicyExposureConfig,
  PolicyResult,
  PolicyTemplate,
  SecretRoutePreset,
  TenantFeatureFlags,
  TenantTheme,
} from "@stwd/shared";
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export interface TenantEmailConfig {
  /**
   * Per-tenant Resend provider config. Optional — a tenant can also leave
   * this entirely empty and only set `magicLinkBaseUrl` to override the
   * magic-link target while continuing to use the global RESEND_API_KEY.
   */
  provider?: "resend";
  apiKeyEncrypted?: string;
  from?: string;
  replyTo?: string;
  templateId?: string;
  subjectOverride?: string;
  /**
   * Optional override for the magic-link `baseUrl`. When set, magic links
   * will be built against this URL (e.g. "https://waifu.fun") instead of
   * Steward's APP_URL. Lets third-party apps own their own email-callback
   * landing page and call POST /auth/email/verify directly to mint a JWT.
   *
   * If unset, falls back to APP_URL and Steward handles the callback via
   * its built-in GET /auth/callback/email handler (which redirects to
   * EMAIL_AUTH_REDIRECT_BASE_URL/login). Existing tenants are unaffected.
   */
  magicLinkBaseUrl?: string;
  /**
   * Optional path on `magicLinkBaseUrl` that the magic link points at.
   * Defaults to "/auth/email/verify" when `magicLinkBaseUrl` is set.
   * Has no effect when `magicLinkBaseUrl` is unset.
   */
  magicLinkCallbackPath?: string;
}

export const chainFamilyEnum = pgEnum("chain_family", ["evm", "solana"]);

export const policyTypeEnum = pgEnum("policy_type", [
  "spending-limit",
  "approved-addresses",
  "auto-approve-threshold",
  "time-window",
  "rate-limit",
  "allowed-chains",
  "reputation-threshold",
  "reputation-scaling",
]);

export const transactionStatusEnum = pgEnum("transaction_status", [
  "pending",
  "approved",
  "rejected",
  "signed",
  "broadcast",
  "confirmed",
  "failed",
]);

export const approvalQueueStatusEnum = pgEnum("approval_queue_status", [
  "pending",
  "approved",
  "rejected",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => sql`now()`),
};

export const tenants = pgTable("tenants", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  apiKeyHash: text("api_key_hash").notNull(),
  ownerAddress: varchar("owner_address", { length: 128 }),
  ...timestamps,
});

export const tenantConfigs = pgTable("tenant_configs", {
  tenantId: varchar("tenant_id", { length: 64 })
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  displayName: varchar("display_name", { length: 255 }),
  emailConfig: jsonb("email_config").$type<TenantEmailConfig>(),
  policyExposure: jsonb("policy_exposure").$type<PolicyExposureConfig>().notNull().default({}),
  policyTemplates: jsonb("policy_templates").$type<PolicyTemplate[]>().notNull().default([]),
  secretRoutePresets: jsonb("secret_route_presets")
    .$type<SecretRoutePreset[]>()
    .notNull()
    .default([]),
  approvalConfig: jsonb("approval_config").$type<ApprovalConfig>().notNull().default({}),
  featureFlags: jsonb("feature_flags").$type<TenantFeatureFlags>().notNull().default({}),
  theme: jsonb("theme").$type<TenantTheme>(),
  /** Allowed CORS origins for this tenant. Empty = fall back to wildcard (*). */
  allowedOrigins: text("allowed_origins").array().notNull().default([]),
  /** Controls how users can join: 'open' | 'invite' | 'closed'. Default 'open' for backward compat. */
  joinMode: varchar("join_mode", { length: 16 }).notNull().default("open"),
  ...timestamps,
});

export const agents = pgTable(
  "agents",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    walletAddress: varchar("wallet_address", { length: 128 }).notNull(),
    platformId: varchar("platform_id", { length: 255 }),
    erc8004TokenId: varchar("erc8004_token_id", { length: 255 }),
    ownerUserId: uuid("owner_user_id"),
    walletType: varchar("wallet_type", { length: 32 }).default("agent"),
    ...timestamps,
  },
  (table) => ({
    tenantIdIdx: index("agents_tenant_id_idx").on(table.tenantId),
  }),
);

export const encryptedKeys = pgTable(
  "encrypted_keys",
  {
    agentId: varchar("agent_id", { length: 64 })
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    salt: text("salt").notNull(),
  },
  (table) => ({
    agentIdUniqueIdx: uniqueIndex("encrypted_keys_agent_id_idx").on(table.agentId),
  }),
);

/**
 * Multi-chain wallet addresses for each agent.
 * One row per (agentId, chainFamily) pair.
 * New agents get both 'evm' and 'solana' rows from a single createAgent call.
 * Legacy agents (EVM-only) have no rows here; fall back to agents.walletAddress.
 */
export const agentWallets = pgTable(
  "agent_wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    chainFamily: chainFamilyEnum("chain_family").notNull(),
    address: varchar("address", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentChainUniqueIdx: uniqueIndex("agent_wallets_agent_chain_idx").on(
      table.agentId,
      table.chainFamily,
    ),
    agentIdIdx: index("agent_wallets_agent_id_idx").on(table.agentId),
  }),
);

/**
 * Encrypted private keys for each agent+chainFamily combination.
 * Composite PK: (agentId, chainFamily).
 * New agents store both 'evm' and 'solana' rows here.
 * Legacy agents (EVM-only) have no rows here; the vault falls back to `encryptedKeys`.
 */
export const encryptedChainKeys = pgTable(
  "encrypted_chain_keys",
  {
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    chainFamily: chainFamilyEnum("chain_family").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    salt: text("salt").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.chainFamily] }),
  }),
);

export const policies = pgTable("policies", {
  id: varchar("id", { length: 64 }).primaryKey(),
  agentId: varchar("agent_id", { length: 64 })
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  type: policyTypeEnum("type").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
});

export const transactions = pgTable(
  "transactions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    status: transactionStatusEnum("status").notNull(),
    toAddress: varchar("to_address", { length: 128 }).notNull(),
    value: text("value").notNull(),
    data: text("data"),
    chainId: integer("chain_id").notNull(),
    txHash: varchar("tx_hash", { length: 128 }),
    policyResults: jsonb("policy_results").$type<PolicyResult[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => ({
    agentIdIdx: index("transactions_agent_id_idx").on(table.agentId),
  }),
);

export const approvalQueue = pgTable(
  "approval_queue",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    txId: varchar("tx_id", { length: 64 })
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    status: approvalQueueStatusEnum("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: varchar("resolved_by", { length: 255 }),
  },
  (table) => ({
    txIdUniqueIdx: uniqueIndex("approval_queue_tx_id_idx").on(table.txId),
    statusIdx: index("approval_queue_status_idx").on(table.status),
  }),
);

// ─── Webhook configuration table ──────────────────────────────────────────────

export const webhookConfigs = pgTable(
  "webhook_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: jsonb("events").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    maxRetries: integer("max_retries").notNull().default(5),
    retryBackoffMs: integer("retry_backoff_ms").notNull().default(60000),
    description: text("description"),
    ...timestamps,
  },
  (table) => ({
    tenantIdx: index("webhook_configs_tenant_idx").on(table.tenantId),
  }),
);

// ─── Auto-approval rules table ────────────────────────────────────────────────

export const autoApprovalRules = pgTable(
  "auto_approval_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Transactions at or below this amount (in wei) are auto-approved */
    maxAmountWei: text("max_amount_wei").notNull().default("0"),
    /** Auto-deny pending approvals older than N hours (null = never) */
    autoDenyAfterHours: integer("auto_deny_after_hours"),
    /** Transactions above this amount trigger escalation webhook (null = disabled) */
    escalateAboveWei: text("escalate_above_wei"),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  },
  (table) => ({
    tenantIdx: uniqueIndex("auto_approval_rules_tenant_idx").on(table.tenantId),
  }),
);

// ─── Webhook delivery status enum ─────────────────────────────────────────────

export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "pending",
  "delivered",
  "failed",
  "dead",
]);

// ─── Webhook deliveries table ─────────────────────────────────────────────────

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    agentId: text("agent_id"),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    url: text("url").notNull(),
    status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => ({
    statusIdx: index("webhook_deliveries_status_idx").on(table.status),
    nextRetryIdx: index("webhook_deliveries_next_retry_idx").on(table.nextRetryAt),
    tenantIdx: index("webhook_deliveries_tenant_idx").on(table.tenantId),
  }),
);

export const webhookConfigRelations = relations(webhookConfigs, ({ one }) => ({
  tenant: one(tenants, {
    fields: [webhookConfigs.tenantId],
    references: [tenants.id],
  }),
}));

export const autoApprovalRuleRelations = relations(autoApprovalRules, ({ one }) => ({
  tenant: one(tenants, {
    fields: [autoApprovalRules.tenantId],
    references: [tenants.id],
  }),
}));

export const tenantRelations = relations(tenants, ({ many, one }) => ({
  agents: many(agents),
  config: one(tenantConfigs, {
    fields: [tenants.id],
    references: [tenantConfigs.tenantId],
  }),
  webhookConfigs: many(webhookConfigs),
  autoApprovalRule: one(autoApprovalRules, {
    fields: [tenants.id],
    references: [autoApprovalRules.tenantId],
  }),
}));

export const tenantConfigRelations = relations(tenantConfigs, ({ one }) => ({
  tenant: one(tenants, {
    fields: [tenantConfigs.tenantId],
    references: [tenants.id],
  }),
}));

export const agentRelations = relations(agents, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [agents.tenantId],
    references: [tenants.id],
  }),
  encryptedKey: one(encryptedKeys, {
    fields: [agents.id],
    references: [encryptedKeys.agentId],
  }),
  wallets: many(agentWallets),
  chainKeys: many(encryptedChainKeys),
  policies: many(policies),
  transactions: many(transactions),
  approvalQueueEntries: many(approvalQueue),
}));

export const encryptedKeyRelations = relations(encryptedKeys, ({ one }) => ({
  agent: one(agents, {
    fields: [encryptedKeys.agentId],
    references: [agents.id],
  }),
}));

export const policyRelations = relations(policies, ({ one }) => ({
  agent: one(agents, {
    fields: [policies.agentId],
    references: [agents.id],
  }),
}));

export const transactionRelations = relations(transactions, ({ one }) => ({
  agent: one(agents, {
    fields: [transactions.agentId],
    references: [agents.id],
  }),
  approvalQueueEntry: one(approvalQueue, {
    fields: [transactions.id],
    references: [approvalQueue.txId],
  }),
}));

export const approvalQueueRelations = relations(approvalQueue, ({ one }) => ({
  agent: one(agents, {
    fields: [approvalQueue.agentId],
    references: [agents.id],
  }),
  transaction: one(transactions, {
    fields: [approvalQueue.txId],
    references: [transactions.id],
  }),
}));

export const agentWalletRelations = relations(agentWallets, ({ one }) => ({
  agent: one(agents, {
    fields: [agentWallets.agentId],
    references: [agents.id],
  }),
}));

export const encryptedChainKeyRelations = relations(encryptedChainKeys, ({ one }) => ({
  agent: one(agents, {
    fields: [encryptedChainKeys.agentId],
    references: [agents.id],
  }),
}));

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type TenantConfigRow = typeof tenantConfigs.$inferSelect;
export type NewTenantConfigRow = typeof tenantConfigs.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type EncryptedKey = typeof encryptedKeys.$inferSelect;
export type NewEncryptedKey = typeof encryptedKeys.$inferInsert;
export type Policy = typeof policies.$inferSelect;
export type NewPolicy = typeof policies.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type ApprovalQueueEntry = typeof approvalQueue.$inferSelect;
export type NewApprovalQueueEntry = typeof approvalQueue.$inferInsert;
export type AgentWallet = typeof agentWallets.$inferSelect;
export type NewAgentWallet = typeof agentWallets.$inferInsert;
export type EncryptedChainKey = typeof encryptedChainKeys.$inferSelect;
export type NewEncryptedChainKey = typeof encryptedChainKeys.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
export type WebhookConfig = typeof webhookConfigs.$inferSelect;
export type NewWebhookConfig = typeof webhookConfigs.$inferInsert;
export type AutoApprovalRule = typeof autoApprovalRules.$inferSelect;
export type NewAutoApprovalRule = typeof autoApprovalRules.$inferInsert;

// ─── Secret Vault tables ──────────────────────────────────────────────────────

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    salt: text("salt").notNull(),
    version: integer("version").notNull().default(1),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantNameVersion: uniqueIndex("secrets_tenant_name_version_idx").on(
      table.tenantId,
      table.name,
      table.version,
    ),
    tenantIdx: index("secrets_tenant_idx").on(table.tenantId),
  }),
);

export const secretRoutes = pgTable(
  "secret_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull(),
    secretId: uuid("secret_id").notNull(),
    hostPattern: varchar("host_pattern", { length: 512 }).notNull(),
    pathPattern: varchar("path_pattern", { length: 512 }).default("/*"),
    method: varchar("method", { length: 10 }).default("*"),
    injectAs: varchar("inject_as", { length: 50 }).notNull(),
    injectKey: varchar("inject_key", { length: 255 }).notNull(),
    injectFormat: varchar("inject_format", { length: 255 }).default("{value}"),
    priority: integer("priority").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index("secret_routes_tenant_idx").on(table.tenantId),
    secretIdx: index("secret_routes_secret_idx").on(table.secretId),
    hostIdx: index("secret_routes_host_idx").on(table.hostPattern),
  }),
);

export const secretRelations = relations(secrets, ({ many }) => ({
  routes: many(secretRoutes),
}));

export const secretRouteRelations = relations(secretRoutes, ({ one }) => ({
  secret: one(secrets, {
    fields: [secretRoutes.secretId],
    references: [secrets.id],
  }),
}));

export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;
export type SecretRoute = typeof secretRoutes.$inferSelect;
export type NewSecretRoute = typeof secretRoutes.$inferInsert;

// ─── Proxy Audit Log ─────────────────────────────────────────────────────────

export const proxyAuditLog = pgTable(
  "proxy_audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentId: text("agent_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    targetHost: varchar("target_host", { length: 512 }).notNull(),
    targetPath: varchar("target_path", { length: 512 }).notNull(),
    method: varchar("method", { length: 10 }).notNull(),
    statusCode: integer("status_code").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index("proxy_audit_log_tenant_idx").on(table.tenantId),
    agentIdx: index("proxy_audit_log_agent_idx").on(table.agentId),
    createdAtIdx: index("proxy_audit_log_created_at_idx").on(table.createdAt),
  }),
);

export type ProxyAuditLogEntry = typeof proxyAuditLog.$inferSelect;
export type NewProxyAuditLogEntry = typeof proxyAuditLog.$inferInsert;
