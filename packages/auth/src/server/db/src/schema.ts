/** Defines the persisted identity, wallet, policy and audit schema used by service migrations and queries. */
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  ApprovalConfig,
  PolicyExposureConfig,
  PolicyResult,
  PolicyTemplate,
  SecretRoutePreset,
  TenantAppClientEmbeddedWalletConfig,
  TenantAuthAbuseConfig,
  TenantFeatureFlags,
  TenantGasSponsorshipConfig,
  TenantOidcProviderConfig,
  TenantTestAccountConfig,
  TenantTheme,
} from "../../shared/src/index.ts";

// ─── Tenant isolation posture (SEC-169) ──────────────────────────────────────
//
// Tenant isolation is enforced ENTIRELY at the application layer: every query
// filters `tenant_id` in code, and the API/proxy resolve the tenant from an
// authenticated credential — never from caller-supplied input. No Postgres
// Row-Level Security is enabled on any table (`isRLSEnabled: false`
// throughout drizzle/meta). Consequence: a single app-layer query bug that
// drops the tenant predicate is a cross-tenant data leak; the database would
// not catch it.
//
// RLS activation is tracked by SEC-169. The executable transaction-context
// primitive, complete policy inventory, and rollout gates live in
// `tenant-rls-context.ts`, `rls-inventory.ts`, and
// `docs/security/database-rls-rollout.mdx`. Enabling it safely requires all of
// the following, and shipping half of it is worse than none:
//   1. a per-request `SET LOCAL app.tenant_id` inside EVERY transaction (the
//      pooled postgres-js role is shared by all tenants, so the GUC must be
//      set on the checked-out connection for exactly the unit of work);
//   2. `ENABLE` + `FORCE ROW LEVEL SECURITY` so the table-owning app role is
//      also subject to policy, plus a break-glass role for migrations and
//      cross-tenant jobs (audit archival, billing rollups);
//   3. a policy matrix review for tables with legitimate cross-tenant reads
//      (e.g. `tenants` lookup by API-key hash at auth time — before any
//      tenant context exists);
//   4. PGLite/Workers parity: the embedded and neon-http runtimes must honor
//      the same GUC discipline, or dev/prod behavior diverges.
// App-layer predicates are the current isolation boundary while RLS is disabled;
// treat any change that relaxes a `tenant_id`
// predicate as a security review trigger.

// Postgres BYTEA column. Typed as Uint8Array to avoid the Node `Buffer` vs
// Cloudflare workers-types Buffer conflict that bites when both type packs
// are in scope. The runtime value is whatever the driver returns; callers
// normalize it (see packages/api/src/services/audit.ts toU8 helper).
const bytea = customType<{ data: Uint8Array; default: false; notNull: false }>({
  dataType() {
    return "bytea";
  },
});

export interface TenantEmailConfig {
  /**
   * Per-tenant Resend provider config. Optional - a tenant can also leave
   * this entirely empty and only set `magicLinkBaseUrl` to override the
   * magic-link target while continuing to use the global RESEND_API_KEY.
   */
  provider?: "resend";
  apiKeyEncrypted?: string;
  from?: string;
  replyTo?: string;
  /**
   * Display brand used by the built-in magic-link and OTP templates. This
   * keeps shared-provider tenants branded without requiring raw HTML
   * templates. Defaults to "Steward" when unset.
   */
  brandName?: string;
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
  /**
   * Optional deployer-supplied raw email templates (subject/text/html with
   * `{{placeholder}}` substitution). This is how a hosted Steward instance
   * carries tenant-specific branded auth emails as CONFIG rather than code:
   * the OSS repo ships only the substitution mechanism, the branded markup
   * lives here in the deployer's database. Takes precedence over
   * `templateId` resolution when set.
   */
  templates?: {
    magicLink?: { subject: string; text: string; html: string };
    otp?: { subject: string; text: string; html: string };
  };
}

export const chainFamilyEnum = pgEnum("chain_family", [
  "evm",
  "solana",
  "bitcoin",
  "monero",
]);

// Migration 0082 governed provider route authority mode. `legacy` is the direct
// direct-proxy credential path; `governed_v2` = decrypt/inject only reachable via
// a claimed v2 execution authorization (dispatchGovernedExecution). A route is
// never both. Default `legacy` => migration 0082 changes nothing at deploy (X9).
export const secretRouteAuthorityModeEnum = pgEnum(
  "secret_route_authority_mode",
  ["legacy", "governed_v2"],
);

export const policyTypeEnum = pgEnum("policy_type", [
  "spending-limit",
  "approved-addresses",
  "auto-approve-threshold",
  "time-window",
  "rate-limit",
  "allowed-chains",
  "condition-set",
  "aggregation",
  "contract-allowlist",
  "typed-data",
  "raw-signing-chain",
  "reputation-threshold",
  "reputation-scaling",
  "venue-allowlist",
  "leverage-cap",
]);

export const transactionStatusEnum = pgEnum("transaction_status", [
  "pending",
  "approved",
  "rejected",
  "signed",
  "broadcast",
  "confirmed",
  "failed",
  "outcome_unknown",
]);

export const approvalQueueStatusEnum = pgEnum("approval_queue_status", [
  "pending",
  "approved",
  "rejected",
  // Migration 0081 provider-action arm lifecycle statuses. The transaction
  // arm only ever uses pending/approved/rejected.
  "expired",
  "stale",
  "consumed",
]);

export const executionAuthorizationStatusEnum = pgEnum(
  "execution_authorization_status",
  ["active", "consumed", "expired", "revoked"],
);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => sql`now()`),
};

export const tenants = pgTable(
  "tenants",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    apiKeyHash: text("api_key_hash").notNull(),
    ownerAddress: varchar("owner_address", { length: 128 }),
    ...timestamps,
  },
  (table) => ({
    apiKeyHashUnique: uniqueIndex("tenants_api_key_hash_unique_idx").on(
      table.apiKeyHash,
    ),
    ownerAddressUnique: uniqueIndex("tenants_owner_address_unique")
      .on(table.ownerAddress)
      .where(sql`${table.ownerAddress} is not null`),
  }),
);

export const tenantConfigs = pgTable("tenant_configs", {
  tenantId: varchar("tenant_id", { length: 64 })
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  displayName: varchar("display_name", { length: 255 }),
  emailConfig: jsonb("email_config").$type<TenantEmailConfig>(),
  policyExposure: jsonb("policy_exposure")
    .$type<PolicyExposureConfig>()
    .notNull()
    .default({}),
  policyTemplates: jsonb("policy_templates")
    .$type<PolicyTemplate[]>()
    .notNull()
    .default([]),
  secretRoutePresets: jsonb("secret_route_presets")
    .$type<SecretRoutePreset[]>()
    .notNull()
    .default([]),
  approvalConfig: jsonb("approval_config")
    .$type<ApprovalConfig>()
    .notNull()
    .default({}),
  featureFlags: jsonb("feature_flags")
    .$type<TenantFeatureFlags>()
    .notNull()
    .default({}),
  theme: jsonb("theme").$type<TenantTheme>(),
  oidcProviders: jsonb("oidc_providers")
    .$type<TenantOidcProviderConfig[]>()
    .notNull()
    .default([]),
  authAbuseConfig: jsonb("auth_abuse_config")
    .$type<TenantAuthAbuseConfig>()
    .notNull()
    .default({}),
  testAccount: jsonb("test_account")
    .$type<TenantTestAccountConfig>()
    .notNull()
    .default({}),
  gasSponsorshipConfig: jsonb("gas_sponsorship_config")
    .$type<TenantGasSponsorshipConfig>()
    .notNull()
    .default({}),
  /** Allowed CORS origins for this tenant. Empty = fall back to wildcard (*). */
  allowedOrigins: text("allowed_origins").array().notNull().default([]),
  /** OAuth/email redirect URLs for this tenant. Empty = legacy fallback to allowedOrigins. */
  allowedRedirectUrls: text("allowed_redirect_urls")
    .array()
    .notNull()
    .default([]),
  /** Controls how users can join: 'open' | 'invite' | 'closed'. Default invite requires explicit opt-in for public join. */
  joinMode: varchar("join_mode", { length: 16 }).notNull().default("invite"),
  ...timestamps,
});

export const tenantAppClients = pgTable(
  "tenant_app_clients",
  {
    id: varchar("id", { length: 64 }).notNull(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    environment: varchar("environment", { length: 32 })
      .notNull()
      .default("production"),
    enabled: boolean("enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    allowedOrigins: text("allowed_origins").array().notNull().default([]),
    allowedRedirectUrls: text("allowed_redirect_urls")
      .array()
      .notNull()
      .default([]),
    allowedBundleIds: text("allowed_bundle_ids").array().notNull().default([]),
    allowedPackageNames: text("allowed_package_names")
      .array()
      .notNull()
      .default([]),
    loginMethods:
      jsonb("login_methods").$type<TenantAuthAbuseConfig["loginMethods"]>(),
    embeddedWallets:
      jsonb("embedded_wallets").$type<TenantAppClientEmbeddedWalletConfig>(),
    globalWalletEnabled: boolean("global_wallet_enabled")
      .notNull()
      .default(false),
    globalWalletAllowedScopes: text("global_wallet_allowed_scopes")
      .array()
      .notNull()
      .default(["eth_accounts", "personal_sign"]),
    ...timestamps,
  },
  (table) => ({
    tenantClientPk: uniqueIndex("tenant_app_clients_tenant_id_id_idx").on(
      table.tenantId,
      table.id,
    ),
    tenantIdx: index("tenant_app_clients_tenant_id_idx").on(table.tenantId),
  }),
);

export const tenantAppClientSecrets = pgTable(
  "tenant_app_client_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    secretHash: text("secret_hash").notNull(),
    secretPrefix: varchar("secret_prefix", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    tenantClientIdx: index("tenant_app_client_secrets_tenant_client_idx").on(
      table.tenantId,
      table.clientId,
    ),
    statusIdx: index("tenant_app_client_secrets_status_idx").on(table.status),
    appClientFk: foreignKey({
      columns: [table.tenantId, table.clientId],
      foreignColumns: [tenantAppClients.tenantId, tenantAppClients.id],
      name: "tenant_app_client_secrets_client_fk",
    }).onDelete("cascade"),
  }),
);

export const tenantRequestSigningKeys = pgTable(
  "tenant_request_signing_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretAuthTag: text("secret_auth_tag").notNull(),
    secretSalt: text("secret_salt").notNull(),
    secretPrefix: varchar("secret_prefix", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    tenantIdx: index("tenant_request_signing_keys_tenant_idx").on(
      table.tenantId,
    ),
    tenantStatusIdx: index("tenant_request_signing_keys_tenant_status_idx").on(
      table.tenantId,
      table.status,
    ),
  }),
);

export const tenantSsoDomains = pgTable(
  "tenant_sso_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domain: varchar("domain", { length: 255 }).notNull(),
    verificationToken: varchar("verification_token", { length: 128 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    ssoRequired: boolean("sso_required").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    tenantDomainUnique: uniqueIndex("tenant_sso_domains_tenant_domain_idx").on(
      table.tenantId,
      table.domain,
    ),
    tenantCanonicalDomainUnique: uniqueIndex(
      "tenant_sso_domains_tenant_canonical_domain_idx",
    ).on(table.tenantId, sql`lower(trim(trailing '.' from ${table.domain}))`),
    verifiedCanonicalDomainUnique: uniqueIndex(
      "tenant_sso_domains_verified_canonical_domain_idx",
    )
      .on(sql`lower(trim(trailing '.' from ${table.domain}))`)
      .where(sql`${table.status} = 'verified'`),
    domainIdx: index("tenant_sso_domains_domain_idx").on(table.domain),
  }),
);

export const tenantSamlSsoConfigs = pgTable(
  "tenant_saml_sso_configs",
  {
    tenantId: varchar("tenant_id", { length: 64 })
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    idpEntityId: text("idp_entity_id").notNull(),
    idpSsoUrl: text("idp_sso_url").notNull(),
    idpCertPems: text("idp_cert_pems").array().notNull().default([]),
    spEntityId: text("sp_entity_id").notNull(),
    acsUrl: text("acs_url").notNull(),
    nameIdFormat: text("name_id_format"),
    emailAttribute: varchar("email_attribute", { length: 128 })
      .notNull()
      .default("email"),
    groupsAttribute: varchar("groups_attribute", { length: 128 }),
    groupRoleMappings: jsonb("group_role_mappings")
      .$type<Array<{ group: string; role: string }>>()
      .notNull()
      .default([]),
    allowJitProvisioning: boolean("allow_jit_provisioning")
      .notNull()
      .default(false),
    jitDefaultRole: varchar("jit_default_role", { length: 32 })
      .notNull()
      .default("viewer"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    statusIdx: index("tenant_saml_sso_configs_status_idx").on(table.status),
    enabledIdx: index("tenant_saml_sso_configs_enabled_idx").on(table.enabled),
  }),
);

export type TenantSamlSsoConfigRow = typeof tenantSamlSsoConfigs.$inferSelect;
export type TenantSamlSsoConfigInsert =
  typeof tenantSamlSsoConfigs.$inferInsert;

export const tenantSamlAuthnRequests = pgTable(
  "tenant_saml_authn_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    requestId: varchar("request_id", { length: 128 }).notNull(),
    relayState: varchar("relay_state", { length: 128 }).notNull(),
    redirectUri: text("redirect_uri").notNull(),
    appClientId: varchar("app_client_id", { length: 64 }),
    codeChallenge: varchar("code_challenge", { length: 128 }).notNull(),
    codeChallengeMethod: varchar("code_challenge_method", { length: 16 })
      .notNull()
      .default("S256"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    tenantIdx: index("tenant_saml_authn_requests_tenant_idx").on(
      table.tenantId,
    ),
    relayStateUnique: uniqueIndex(
      "tenant_saml_authn_requests_relay_state_idx",
    ).on(table.relayState),
    tenantRequestUnique: uniqueIndex(
      "tenant_saml_authn_requests_tenant_request_idx",
    ).on(table.tenantId, table.requestId),
    expiresAtIdx: index("tenant_saml_authn_requests_expires_at_idx").on(
      table.expiresAt,
    ),
  }),
);

export const tenantSamlAssertionReplays = pgTable(
  "tenant_saml_assertion_replays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    assertionId: varchar("assertion_id", { length: 256 }).notNull(),
    responseId: varchar("response_id", { length: 256 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tenantAssertionUnique: uniqueIndex(
      "tenant_saml_assertion_replays_tenant_assertion_idx",
    ).on(table.tenantId, table.assertionId),
    expiresAtIdx: index("tenant_saml_assertion_replays_expires_at_idx").on(
      table.expiresAt,
    ),
  }),
);

export type TenantSsoDomainRow = typeof tenantSsoDomains.$inferSelect;
export type NewTenantSsoDomainRow = typeof tenantSsoDomains.$inferInsert;

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
    tenantAgentUniqueIdx: uniqueIndex("agents_tenant_id_id_idx").on(
      table.tenantId,
      table.id,
    ),
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
    agentIdUniqueIdx: uniqueIndex("encrypted_keys_agent_id_idx").on(
      table.agentId,
    ),
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
    /**
     * Persisted wallet scope label. Legacy rows may be null; lookups use
     * chainFamily when no scope is supplied.
     */
    venue: text("venue"),
    /** Optional human-readable wallet label. */
    purpose: text("purpose"),
    /** Non-secret address metadata such as Bitcoin network, script type, and derivation path. */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentChainVenueUniqueIdx: uniqueIndex(
      "agent_wallets_agent_chain_venue_idx",
    ).on(table.agentId, table.chainFamily, sql`COALESCE(${table.venue}, '')`),
    /**
     * Partial unique index on the legacy NULL-venue subset.
     * Targeted by importKey()'s upsert (drizzle's onConflictDoUpdate
     * needs a named unique index, not an expression index).
     */
    agentChainLegacyIdx: uniqueIndex("agent_wallets_agent_chain_legacy_idx")
      .on(table.agentId, table.chainFamily)
      .where(sql`${table.venue} IS NULL`),
    agentIdIdx: index("agent_wallets_agent_id_idx").on(table.agentId),
  }),
);

export const vaultSigningFreezes = pgTable(
  "vault_signing_freezes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", { length: 16 }).notNull(),
    agentId: varchar("agent_id", { length: 64 }).references(() => agents.id, {
      onDelete: "cascade",
    }),
    walletId: uuid("wallet_id").references(() => agentWallets.id, {
      onDelete: "cascade",
    }),
    reason: text("reason"),
    createdByType: varchar("created_by_type", { length: 32 })
      .notNull()
      .default("system"),
    createdById: varchar("created_by_id", { length: 128 }),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    liftedByType: varchar("lifted_by_type", { length: 32 }),
    liftedById: varchar("lifted_by_id", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tenantActiveUniqueIdx: uniqueIndex(
      "vault_signing_freezes_tenant_active_idx",
    )
      .on(table.tenantId, table.scopeType)
      .where(sql`${table.scopeType} = 'tenant' and ${table.liftedAt} is null`),
    agentActiveUniqueIdx: uniqueIndex("vault_signing_freezes_agent_active_idx")
      .on(table.tenantId, table.agentId)
      .where(sql`${table.scopeType} = 'agent' and ${table.liftedAt} is null`),
    walletActiveUniqueIdx: uniqueIndex(
      "vault_signing_freezes_wallet_active_idx",
    )
      .on(table.walletId)
      .where(sql`${table.scopeType} = 'wallet' and ${table.liftedAt} is null`),
    tenantScopeIdx: index("vault_signing_freezes_tenant_scope_idx").on(
      table.tenantId,
      table.scopeType,
    ),
    agentIdx: index("vault_signing_freezes_agent_idx").on(table.agentId),
    walletIdx: index("vault_signing_freezes_wallet_idx").on(table.walletId),
  }),
);

/**
 * Globally claims an EVM (address, chain) nonce namespace for exactly one
 * tenant. The counter itself is tenant-scoped for RLS, while this claim keeps
 * duplicate custody of the same address in two tenants from allocating the
 * same on-chain nonce independently.
 */
export const evmWalletNonceOwners = pgTable(
  "evm_wallet_nonce_owners",
  {
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    walletAddress: varchar("wallet_address", { length: 42 }).notNull(),
    chainId: integer("chain_id").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    key: primaryKey({ columns: [table.walletAddress, table.chainId] }),
    tenantWalletChainUniqueIdx: uniqueIndex(
      "evm_wallet_nonce_owners_tenant_key_idx",
    ).on(table.tenantId, table.walletAddress, table.chainId),
    addressCheck: check(
      "evm_wallet_nonce_owners_address_chk",
      sql`${table.walletAddress} ~ '^0x[0-9a-f]{40}$'`,
    ),
  }),
);

export const evmWalletNonces = pgTable(
  "evm_wallet_nonces",
  {
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    walletAddress: varchar("wallet_address", { length: 42 }).notNull(),
    chainId: integer("chain_id").notNull(),
    nextNonce: bigint("next_nonce", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => sql`now()`),
  },
  (table) => ({
    walletChainUniqueIdx: uniqueIndex("evm_wallet_nonces_wallet_chain_idx").on(
      table.tenantId,
      table.walletAddress,
      table.chainId,
    ),
    ownerFk: foreignKey({
      columns: [table.tenantId, table.walletAddress, table.chainId],
      foreignColumns: [
        evmWalletNonceOwners.tenantId,
        evmWalletNonceOwners.walletAddress,
        evmWalletNonceOwners.chainId,
      ],
      name: "evm_wallet_nonces_owner_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * Tracks EVM nonces that have been allocated to an in-flight transaction but
 * not yet confirmed on-chain. A nonce is `allocated` once handed out and is
 * cleared (deleted) on confirmation; on a dropped/failed broadcast it is marked
 * `dropped` so the allocator can reclaim it instead of leaving a permanent hole
 * that wedges the wallet behind a stuck nonce. See `evm-nonce-manager.ts`.
 */
export const evmWalletNonceInflight = pgTable(
  "evm_wallet_nonce_inflight",
  {
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    walletAddress: varchar("wallet_address", { length: 42 }).notNull(),
    chainId: integer("chain_id").notNull(),
    nonce: bigint("nonce", { mode: "number" }).notNull(),
    state: varchar("state", { length: 16 }).notNull().default("allocated"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => sql`now()`),
  },
  (table) => ({
    walletChainNonceUniqueIdx: uniqueIndex(
      "evm_wallet_nonce_inflight_key_idx",
    ).on(table.tenantId, table.walletAddress, table.chainId, table.nonce),
    reclaimIdx: index("evm_wallet_nonce_inflight_reclaim_idx").on(
      table.tenantId,
      table.walletAddress,
      table.chainId,
      table.state,
      table.nonce,
    ),
    ownerFk: foreignKey({
      columns: [table.tenantId, table.walletAddress, table.chainId],
      foreignColumns: [
        evmWalletNonceOwners.tenantId,
        evmWalletNonceOwners.walletAddress,
        evmWalletNonceOwners.chainId,
      ],
      name: "evm_wallet_nonce_inflight_owner_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * Privy-style digital asset accounts group one or more Steward wallet agents
 * into a single balance/accounting resource. This is distinct from the
 * `accounts` identity-graph table in schema-auth.
 */
export const digitalAssetAccounts = pgTable(
  "digital_asset_accounts",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    displayName: varchar("display_name", { length: 255 }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...timestamps,
  },
  (table) => ({
    tenantIdx: index("digital_asset_accounts_tenant_idx").on(table.tenantId),
    tenantAccountUniqueIdx: uniqueIndex(
      "digital_asset_accounts_tenant_id_idx",
    ).on(table.tenantId, table.id),
  }),
);

export const digitalAssetAccountWallets = pgTable(
  "digital_asset_account_wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => digitalAssetAccounts.id, { onDelete: "cascade" }),
    walletAgentId: varchar("wallet_agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    chainFamily: chainFamilyEnum("chain_family"),
    ...timestamps,
  },
  (table) => ({
    tenantAccountIdx: index(
      "digital_asset_account_wallets_tenant_account_idx",
    ).on(table.tenantId, table.accountId),
    walletIdx: index("digital_asset_account_wallets_wallet_idx").on(
      table.walletAgentId,
    ),
    accountWalletAllChainsUniqueIdx: uniqueIndex(
      "digital_asset_account_wallets_account_wallet_all_idx",
    )
      .on(table.accountId, table.walletAgentId)
      .where(sql`${table.chainFamily} is null`),
    accountWalletChainUniqueIdx: uniqueIndex(
      "digital_asset_account_wallets_account_wallet_chain_idx",
    )
      .on(table.accountId, table.walletAgentId, table.chainFamily)
      .where(sql`${table.chainFamily} is not null`),
    tenantWalletAllChainsUniqueIdx: uniqueIndex(
      "digital_asset_account_wallets_tenant_wallet_all_idx",
    )
      .on(table.tenantId, table.walletAgentId)
      .where(sql`${table.chainFamily} is null`),
    tenantWalletChainUniqueIdx: uniqueIndex(
      "digital_asset_account_wallets_tenant_wallet_chain_idx",
    )
      .on(table.tenantId, table.walletAgentId, table.chainFamily)
      .where(sql`${table.chainFamily} is not null`),
    tenantAccountFk: foreignKey({
      columns: [table.tenantId, table.accountId],
      foreignColumns: [digitalAssetAccounts.tenantId, digitalAssetAccounts.id],
      name: "digital_asset_account_wallets_tenant_account_fk",
    }).onDelete("cascade"),
    tenantWalletFk: foreignKey({
      columns: [table.tenantId, table.walletAgentId],
      foreignColumns: [agents.tenantId, agents.id],
      name: "digital_asset_account_wallets_tenant_wallet_fk",
    }).onDelete("cascade"),
  }),
);

export const digitalAssetAccountAggregations = pgTable(
  "digital_asset_account_aggregations",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => digitalAssetAccounts.id, { onDelete: "cascade" }),
    displayName: varchar("display_name", { length: 255 }),
    walletAgentIds: text("wallet_agent_ids").array().notNull().default([]),
    chainFamilies: text("chain_families").array().notNull().default([]),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...timestamps,
  },
  (table) => ({
    tenantAccountIdx: index(
      "digital_asset_account_aggregations_tenant_account_idx",
    ).on(table.tenantId, table.accountId),
    tenantAggregationUniqueIdx: uniqueIndex(
      "digital_asset_account_aggregations_tenant_id_idx",
    ).on(table.tenantId, table.id),
    tenantAccountFk: foreignKey({
      columns: [table.tenantId, table.accountId],
      foreignColumns: [digitalAssetAccounts.tenantId, digitalAssetAccounts.id],
      name: "digital_asset_account_aggregations_tenant_account_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * Wallet ownership and delegated signer metadata for an agent wallet/account.
 * This is an authorization graph, not private-key material: signing routes can
 * use it to expose owners, service signers, quorum members, and scoped
 * delegation policies without changing custody storage.
 */
export const agentSigners = pgTable(
  "agent_signers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    signerType: varchar("signer_type", { length: 32 }).notNull(),
    subjectType: varchar("subject_type", { length: 32 }).notNull(),
    subjectId: varchar("subject_id", { length: 255 }).notNull(),
    address: varchar("address", { length: 128 }),
    /**
     * Authorization-key scheme for this signer's *request* signatures:
     *   "hmac" (default) — symmetric request signing (legacy/interchangeable).
     *   "p256"           — asymmetric ECDSA over secp256r1; `publicKey` holds
     *                      the registered key (Privy authorization-keys parity).
     * The middleware selects the verification path from this column.
     */
    keyType: varchar("key_type", { length: 16 }).notNull().default("hmac"),
    /**
     * Registered P-256 public key when `keyType="p256"`. Accepts base64 SPKI,
     * raw uncompressed `04||X||Y`, or a JWK string (see
     * `@stwd/auth` importP256PublicKey). NULL for HMAC signers.
     */
    publicKey: text("public_key"),
    chainFamily: chainFamilyEnum("chain_family"),
    label: varchar("label", { length: 255 }),
    permissions: text("permissions").array().notNull().default([]),
    policyIds: text("policy_ids").array().notNull().default([]),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    createdBy: varchar("created_by", { length: 255 }),
    ...timestamps,
  },
  (table) => ({
    tenantAgentIdx: index("agent_signers_tenant_agent_idx").on(
      table.tenantId,
      table.agentId,
    ),
    agentStatusIdx: index("agent_signers_agent_status_idx").on(
      table.agentId,
      table.status,
    ),
    agentSubjectUniqueIdx: uniqueIndex("agent_signers_agent_subject_idx").on(
      table.agentId,
      table.subjectType,
      table.subjectId,
    ),
    tenantAgentFk: foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [agents.tenantId, agents.id],
      name: "agent_signers_tenant_agent_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * Threshold signing/quorum policy objects for an agent wallet/account.
 * Member IDs reference `agent_signers.id` logically; they are kept as an
 * ordered text array so quorum membership can be updated atomically.
 */
export const agentKeyQuorums = pgTable(
  "agent_key_quorums",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    threshold: integer("threshold").notNull(),
    memberSignerIds: text("member_signer_ids").array().notNull().default([]),
    /**
     * Nested-quorum children: ordered `agent_key_quorums.id` values that are
     * themselves quorums. A parent quorum is satisfied iff the number of
     * satisfied members (a verified leaf signer in `memberSignerIds` OR a
     * satisfied child quorum in `memberQuorumIds`) is ≥ `threshold`. Recursion
     * is bounded by a hard depth limit with cycle detection (see the
     * authorization-signature middleware); both violations fail closed.
     */
    memberQuorumIds: text("member_quorum_ids").array().notNull().default([]),
    permissions: text("permissions").array().notNull().default([]),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    createdBy: varchar("created_by", { length: 255 }),
    ...timestamps,
  },
  (table) => ({
    tenantAgentIdx: index("agent_key_quorums_tenant_agent_idx").on(
      table.tenantId,
      table.agentId,
    ),
    agentStatusIdx: index("agent_key_quorums_agent_status_idx").on(
      table.agentId,
      table.status,
    ),
    tenantAgentFk: foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [agents.tenantId, agents.id],
      name: "agent_key_quorums_tenant_agent_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * Session signers — labeled, scoped, revocable delegated signing tokens
 * (Privy "session signers" parity). Each row pins a single minted agent JWT
 * (by its `jti`) to an operator-facing label, an optional policy subset, and a
 * bounded expiry. Revocation flips `revokedAt` AND records the jti in the
 * auth revocation store, so the token is rejected even before it expires.
 *
 * Rows are append-only except for `revokedAt`/`lastUsedAt`; there is no
 * `updatedAt` because a session signer is never re-issued in place.
 */
export const sessionSigners = pgTable(
  "session_signers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Unique JWT id of the minted agent token; mirrored into the revocation store. */
    jti: varchar("jti", { length: 64 }).notNull(),
    label: varchar("label", { length: 128 }).notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    /** Subset of the agent's policy ids enforced when this token signs. */
    policyIds: jsonb("policy_ids").$type<string[]>().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    jtiUniqueIdx: uniqueIndex("session_signers_jti_idx").on(table.jti),
    tenantAgentIdx: index("session_signers_tenant_agent_idx").on(
      table.tenantId,
      table.agentId,
    ),
    activeIdx: index("session_signers_active_idx")
      .on(table.agentId)
      .where(sql`${table.revokedAt} IS NULL`),
    tenantAgentFk: foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [agents.tenantId, agents.id],
      name: "session_signers_tenant_agent_fk",
    }).onDelete("cascade"),
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
    /**
     * Surrogate PK so a single (agentId, chainFamily) can have
     * multiple rows, one per venue. The uniqueness invariant moves to
     * `agent_chain_venue_idx` below.
     */
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    chainFamily: chainFamilyEnum("chain_family").notNull(),
    /**
     * Trading venue this key is scoped to (e.g. "hyperliquid").
     * NULL on legacy rows; vault lookups fall back to chainFamily when
     * venue isn't provided.
     */
    venue: text("venue"),
    /** Optional human-readable wallet label. */
    purpose: text("purpose"),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    salt: text("salt").notNull(),
  },
  (table) => ({
    agentChainVenueUniqueIdx: uniqueIndex(
      "encrypted_chain_keys_agent_chain_venue_idx",
    ).on(table.agentId, table.chainFamily, sql`COALESCE(${table.venue}, '')`),
    agentIdIdx: index("encrypted_chain_keys_agent_id_idx").on(table.agentId),
  }),
);

export const policies = pgTable("policies", {
  id: varchar("id", { length: 64 }).primaryKey(),
  agentId: varchar("agent_id", { length: 64 })
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  type: policyTypeEnum("type").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  config: jsonb("config")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
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
    actionType: varchar("action_type", { length: 64 }),
    actionPayload: jsonb("action_payload").$type<Record<string, unknown>>(),
    executionPayloadDigest: varchar("execution_payload_digest", { length: 64 }),
    executionPolicyRevisionHash: varchar("execution_policy_revision_hash", {
      length: 64,
    }),
    executionBackend: varchar("execution_backend", { length: 32 }),
    executionBackendIdentityDigest: varchar(
      "execution_backend_identity_digest",
      { length: 64 },
    ),
    policyResults: jsonb("policy_results")
      .$type<PolicyResult[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    receiptPolledAt: timestamp("receipt_polled_at", { withTimezone: true }),
  },
  (table) => ({
    agentIdIdx: index("transactions_agent_id_idx").on(table.agentId),
    // `value` is a wei amount: must be a non-empty decimal digit string.
    valueIsWei: check(
      "transactions_value_wei_chk",
      sql`${table.value} ~ '^[0-9]+$'`,
    ),
  }),
);

/** Durable reservations for off-chain operator fund movements. Pending rows
 * are intentionally counted: after a venue timeout the transfer may have
 * landed, so excluding it would permit a retry to overspend the policy cap. */
export const operatorTransferReservations = pgTable(
  "operator_transfer_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    rail: varchar("rail", { length: 16 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 256 }).notNull(),
    destination: varchar("destination", { length: 128 }).notNull(),
    amountBaseUnits: text("amount_base_units").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    requestUnique: uniqueIndex("operator_transfer_reservation_request_uidx")
      .on(table.tenantId, table.rail, table.idempotencyKey)
      .where(sql`${table.status} in ('pending', 'final')`),
    agentCreatedIdx: index(
      "operator_transfer_reservation_agent_created_idx",
    ).on(table.tenantId, table.agentId, table.createdAt),
    tenantAgentFk: foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [agents.tenantId, agents.id],
      name: "operator_transfer_reservations_tenant_agent_fk",
    }).onDelete("cascade"),
    railValid: check(
      "operator_transfer_reservation_rail_chk",
      sql`${table.rail} in ('withdraw', 'usd-send')`,
    ),
    amountIsUsdc: check(
      "operator_transfer_reservation_amount_base_units_chk",
      sql`${table.amountBaseUnits} ~ '^[0-9]+$'`,
    ),
    statusValid: check(
      "operator_transfer_reservation_status_chk",
      sql`${table.status} in ('pending', 'final', 'released')`,
    ),
    statusFinalizedShape: check(
      "operator_transfer_reservation_status_finalized_chk",
      sql`(${table.status} = 'pending' and ${table.finalizedAt} is null)
          or (${table.status} in ('final', 'released') and ${table.finalizedAt} is not null)`,
    ),
  }),
);

export const executionAuthorizationNonces = pgTable(
  "execution_authorization_nonces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorizationId: varchar("authorization_id", { length: 64 }).notNull(),
    requestId: varchar("request_id", { length: 64 }).notNull(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    capability: varchar("capability", { length: 64 }).notNull(),
    backend: varchar("backend", { length: 64 }).notNull(),
    backendIdentityDigest: varchar("backend_identity_digest", { length: 64 }),
    payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
    policyRevisionHash: varchar("policy_revision_hash", { length: 64 }),
    approvalId: varchar("approval_id", { length: 64 }),
    nonce: varchar("nonce", { length: 64 }).notNull(),
    signature: text("signature").notNull(),
    idempotencyKey: text("idempotency_key"),
    status: executionAuthorizationStatusEnum("status")
      .notNull()
      .default("active"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // ─── Migration 0082: provider execution authorization v2 extension ──────
    // version=1 rows are the legacy wallet/EVM nonce (all v2 fields null).
    // version=2 rows carry the full provider commitment binding + dispatch
    // state machine. Enforced by exec_auth_nonces_v2_arm_chk (raw SQL, 0082).
    // The v2 fields are the DB-time claim predicate (§2.3) and the reconciler's
    // dispatch-state source of truth (§4).
    version: integer("version").notNull().default(1),
    executionId: varchar("execution_id", { length: 64 }),
    intentId: varchar("intent_id", { length: 64 }),
    workspaceId: uuid("workspace_id"),
    providerAccountId: uuid("provider_account_id"),
    operationId: uuid("operation_id"),
    operationRevision: integer("operation_revision"),
    requestHash: varchar("request_hash", { length: 71 }),
    actionDigest: varchar("action_digest", { length: 71 }),
    grantDependencyHash: varchar("grant_dependency_hash", { length: 71 }),
    routeId: uuid("route_id"),
    routeRevision: integer("route_revision"),
    secretId: uuid("secret_id"),
    secretVersion: integer("secret_version"),
    providerIdempotencyKey: varchar("provider_idempotency_key", {
      length: 255,
    }),
    commitmentHash: varchar("commitment_hash", { length: 71 }),
    keyId: varchar("key_id", { length: 64 }),
    dispatchState: varchar("dispatch_state", { length: 24 })
      .notNull()
      .default("none"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    outcomeRecordedAt: timestamp("outcome_recorded_at", { withTimezone: true }),
  },
  (table) => ({
    authorizationIdUniqueIdx: uniqueIndex(
      "execution_authorization_nonces_auth_id_idx",
    ).on(table.authorizationId),
    nonceUniqueIdx: uniqueIndex("execution_authorization_nonces_nonce_idx").on(
      table.nonce,
    ),
    tenantAgentStatusIdx: index(
      "execution_authorization_nonces_tenant_agent_status_idx",
    ).on(table.tenantId, table.agentId, table.status),
    expiryIdx: index("execution_authorization_nonces_expires_at_idx").on(
      table.expiresAt,
    ),
    // Partial-unique v2 indexes + composite FKs + CHECK constraints are RAW SQL
    // ONLY (0082): drizzle cannot express partial predicates or composite FKs.
    // The migration test asserts they exist after migrate.
    v2IntentUniqIdx: uniqueIndex("exec_auth_nonces_intent_uniq")
      .on(table.intentId)
      .where(sql`version = 2`),
    v2ExecutionUniqIdx: uniqueIndex("exec_auth_nonces_execution_uniq")
      .on(table.executionId)
      .where(sql`version = 2`),
  }),
);

export const sponsoredGasEvents = pgTable(
  "sponsored_gas_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    txId: varchar("tx_id", { length: 64 }).references(() => transactions.id, {
      onDelete: "set null",
    }),
    chainFamily: chainFamilyEnum("chain_family").notNull().default("evm"),
    chainId: integer("chain_id"),
    caip2: varchar("caip2", { length: 64 }),
    provider: varchar("provider", { length: 64 }).notNull(),
    mode: varchar("mode", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("reserved"),
    userOperationHash: varchar("user_operation_hash", { length: 128 }),
    txHash: varchar("tx_hash", { length: 128 }),
    signature: varchar("signature", { length: 128 }),
    reservedUsd: numeric("reserved_usd", { precision: 18, scale: 6 }),
    actualUsd: numeric("actual_usd", { precision: 18, scale: 6 }),
    gasUnits: text("gas_units"),
    gasToken: varchar("gas_token", { length: 64 }),
    requestHash: varchar("request_hash", { length: 128 }),
    error: text("error"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...timestamps,
  },
  (table) => ({
    tenantCreatedIdx: index("sponsored_gas_events_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
    agentCreatedIdx: index("sponsored_gas_events_agent_created_idx").on(
      table.agentId,
      table.createdAt,
    ),
    txUniqueIdx: uniqueIndex("sponsored_gas_events_tenant_tx_id_idx")
      .on(table.tenantId, table.txId)
      .where(sql`${table.txId} is not null`),
    agentTenantFk: foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [agents.tenantId, agents.id],
      name: "sponsored_gas_events_tenant_agent_fk",
    }).onDelete("cascade"),
  }),
);

// Migration 0081 makes approval_queue a discriminated union. The transaction
// arm (approval_kind='transaction') keeps tx_id and its original columns; the
// provider_action arm carries the exact-binding tuple. `tx_id` is now nullable
// (arm CHECK re-requires it for transaction rows). Several invariants (the
// arm CHECK, the decision-shape CHECK, and the partial unique indexes) live in
// 0081 raw SQL and are NOT visible to drizzle-kit.
export const approvalQueue = pgTable(
  "approval_queue",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    txId: varchar("tx_id", { length: 64 }).references(() => transactions.id, {
      onDelete: "cascade",
    }),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    status: approvalQueueStatusEnum("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    requestedByType: varchar("requested_by_type", { length: 32 }),
    requestedById: varchar("requested_by_id", { length: 255 }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: varchar("resolved_by", { length: 255 }),
    resolvedByType: varchar("resolved_by_type", { length: 32 }),
    resolvedById: varchar("resolved_by_id", { length: 255 }),
    // ── Migration 0081 provider-action arm ──
    approvalKind: varchar("approval_kind", { length: 32 })
      .notNull()
      .default("transaction"),
    intentId: varchar("intent_id", { length: 64 }),
    tenantId: varchar("tenant_id", { length: 64 }),
    workspaceId: uuid("workspace_id"),
    requestHash: varchar("request_hash", { length: 71 }),
    actionDigest: varchar("action_digest", { length: 71 }),
    approvalCommitment: jsonb("approval_commitment").$type<
      Record<string, unknown>
    >(),
    approvalCommitmentHash: varchar("approval_commitment_hash", { length: 71 }),
    expectedBindingRevision: integer("expected_binding_revision"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    decision: varchar("decision", { length: 16 }),
    reasonCode: varchar("reason_code", { length: 96 }),
    reason: text("reason"),
    mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
    mfaAgeMsAtDecision: integer("mfa_age_ms_at_decision"),
    decisionIdempotencyKeyHash: varchar("decision_idempotency_key_hash", {
      length: 71,
    }),
    decisionRequestHash: varchar("decision_request_hash", { length: 71 }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedBy: varchar("consumed_by", { length: 64 }),
    // ── Migration 0083 M-of-N quorum arm ──
    // NULL threshold selects the byte-compatible single-approver path.
    // A non-NULL threshold flips the provider-action approval into flat N-of-M
    // quorum: `quorum_threshold` DISTINCT eligible approvals are required before
    // the queue can transition pending -> approved (execute-reachable). Nested
    // quorums are out of scope. `quorum_eligible_user_ids` is the frozen,
    // workspace_approver-scoped eligible set committed at create time.
    // `quorum_approvals_count` is the guarded running tally of DISTINCT approve
    // decisions at the CURRENT binding revision; it is reset to 0 whenever the
    // set is invalidated (staleness bumps binding_revision).
    quorumThreshold: integer("quorum_threshold"),
    quorumEligibleUserIds: uuid("quorum_eligible_user_ids")
      .array()
      .notNull()
      .default([]),
    quorumApprovalsCount: integer("quorum_approvals_count")
      .notNull()
      .default(0),
  },
  (table) => ({
    txIdUniqueIdx: uniqueIndex("approval_queue_tx_id_idx").on(table.txId),
    statusIdx: index("approval_queue_status_idx").on(table.status),
    agentStatusRequestedIdx: index(
      "approval_queue_agent_status_requested_idx",
    ).on(
      table.agentId,
      table.status,
      table.requestedAt.desc(),
      table.id.desc(),
    ),
  }),
);

/**
 * Migration 0083 M-of-N quorum: one row per distinct approver decision on a
 * provider-action approval. The single-approver path never inserts here (it records its
 * lone decision on `approval_queue` directly). Every row binds the EXACT
 * request_hash / action_digest / approval_commitment_hash and the
 * `binding_revision_at_decision` the approval was cast against, so a dependency
 * or payload change (which bumps binding_revision) invalidates the WHOLE
 * collected set, so a stale approval can never count toward a later quorum.
 *
 * Distinctness is a UNIQUE(approval_queue_id, approver_user_id): an approver
 * approving twice is rejected loudly the second time. The requester (agent owner)
 * can never be an eligible approver (enforced at decide time), so requester
 * separation generalizes to "requester never counts toward quorum".
 */
export const providerActionApprovals = pgTable(
  "provider_action_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    approvalQueueId: varchar("approval_queue_id", { length: 64 })
      .notNull()
      .references(() => approvalQueue.id, { onDelete: "cascade" }),
    intentId: varchar("intent_id", { length: 64 }).notNull(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    approverUserId: uuid("approver_user_id").notNull(),
    decision: varchar("decision", { length: 16 }).notNull(),
    bindingRevisionAtDecision: integer(
      "binding_revision_at_decision",
    ).notNull(),
    requestHash: varchar("request_hash", { length: 71 }).notNull(),
    actionDigest: varchar("action_digest", { length: 71 }).notNull(),
    approvalCommitmentHash: varchar("approval_commitment_hash", {
      length: 71,
    }).notNull(),
    decisionIdempotencyKeyHash: varchar("decision_idempotency_key_hash", {
      length: 71,
    }).notNull(),
    decisionRequestHash: varchar("decision_request_hash", {
      length: 71,
    }).notNull(),
    mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
    mfaAgeMsAtDecision: integer("mfa_age_ms_at_decision"),
    reasonCode: varchar("reason_code", { length: 96 }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Distinctness: an approver counts at most once per approval.
    approverUniqueIdx: uniqueIndex(
      "provider_action_approvals_approver_uniq",
    ).on(table.approvalQueueId, table.approverUserId),
    // Cross-action decision-idempotency-key reuse guard (mirrors approval_queue).
    idemUniqueIdx: uniqueIndex("provider_action_approvals_idem_uniq").on(
      table.tenantId,
      table.approverUserId,
      table.decisionIdempotencyKeyHash,
    ),
    queueIdx: index("provider_action_approvals_queue_idx").on(
      table.approvalQueueId,
    ),
    intentIdx: index("provider_action_approvals_intent_idx").on(
      table.tenantId,
      table.intentId,
    ),
    queueFk: foreignKey({
      columns: [table.approvalQueueId],
      foreignColumns: [approvalQueue.id],
      name: "provider_action_approvals_queue_fk",
    }).onDelete("cascade"),
  }),
);

export type ProviderActionApprovalRow =
  typeof providerActionApprovals.$inferSelect;
export type NewProviderActionApprovalRow =
  typeof providerActionApprovals.$inferInsert;

/**
 * First-class Privy-style intents for actions that may require authorization
 * before execution. Transaction-backed approvals keep using transactions +
 * approval_queue, while this table models generic wallet/policy/quorum intents.
 */
export const intents = pgTable(
  "intents",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 64 }).references(() => agents.id, {
      onDelete: "cascade",
    }),
    intentType: varchar("intent_type", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    resourceType: varchar("resource_type", { length: 64 }),
    resourceId: varchar("resource_id", { length: 255 }),
    createdByType: varchar("created_by_type", { length: 32 })
      .notNull()
      .default("api"),
    createdById: varchar("created_by_id", { length: 255 }),
    createdByDisplayName: varchar("created_by_display_name", { length: 255 }),
    authorizationDetails: jsonb("authorization_details")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    executionResult: jsonb("execution_result").$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    authorizedBy: varchar("authorized_by", { length: 255 }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    canceledBy: varchar("canceled_by", { length: 255 }),
    cancellationReason: text("cancellation_reason"),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    expiredBy: varchar("expired_by", { length: 255 }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectedBy: varchar("rejected_by", { length: 255 }),
    rejectionReason: text("rejection_reason"),
    executedBy: varchar("executed_by", { length: 255 }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failedBy: varchar("failed_by", { length: 255 }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
  },
  (table) => ({
    tenantStatusIdx: index("intents_tenant_status_idx").on(
      table.tenantId,
      table.status,
    ),
    tenantCreatedIdx: index("intents_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
    agentIdx: index("intents_agent_idx").on(table.agentId),
    resourceIdx: index("intents_resource_idx").on(
      table.resourceType,
      table.resourceId,
    ),
    tenantAgentFk: foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [agents.tenantId, agents.id],
      name: "intents_tenant_agent_fk",
    }).onDelete("cascade"),
  }),
);

// ─── Standalone policy templates ─────────────────────────────────────────────

export const policyTemplates = pgTable(
  "policy_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    rules: jsonb("rules")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    isDefault: boolean("is_default").notNull().default(false),
    ...timestamps,
  },
  (table) => ({
    tenantIdx: index("policy_templates_tenant_idx").on(table.tenantId),
  }),
);

// ─── Privy-style condition sets ──────────────────────────────────────────────

export const conditionSets = pgTable(
  "condition_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    ownerId: varchar("owner_id", { length: 255 }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...timestamps,
  },
  (table) => ({
    tenantIdx: index("condition_sets_tenant_idx").on(table.tenantId),
    tenantNameUniqueIdx: uniqueIndex("condition_sets_tenant_name_idx").on(
      table.tenantId,
      table.name,
    ),
  }),
);

export const conditionSetItems = pgTable(
  "condition_set_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conditionSetId: uuid("condition_set_id")
      .notNull()
      .references(() => conditionSets.id, { onDelete: "cascade" }),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    label: varchar("label", { length: 255 }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...timestamps,
  },
  (table) => ({
    conditionSetIdx: index("condition_set_items_set_idx").on(
      table.conditionSetId,
    ),
    tenantIdx: index("condition_set_items_tenant_idx").on(table.tenantId),
    setValueUniqueIdx: uniqueIndex("condition_set_items_set_value_idx").on(
      table.conditionSetId,
      table.value,
    ),
  }),
);

export type ConditionSetRow = typeof conditionSets.$inferSelect;
export type NewConditionSetRow = typeof conditionSets.$inferInsert;
export type ConditionSetItemRow = typeof conditionSetItems.$inferSelect;
export type NewConditionSetItemRow = typeof conditionSetItems.$inferInsert;

// ─── ERC-8004 registration and discovery tables ──────────────────────────────

export const agentRegistrations = pgTable(
  "agent_registrations",
  {
    id: serial("id").primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    chainId: integer("chain_id").notNull(),
    tokenId: varchar("token_id", { length: 256 }),
    txHash: varchar("tx_hash", { length: 128 }),
    registryAddress: varchar("registry_address", { length: 64 }).notNull(),
    agentCardUri: text("agent_card_uri"),
    agentCardJson: jsonb("agent_card_json").$type<Record<string, unknown>>(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    ...timestamps,
  },
  (table) => ({
    tenantAgentChainUnique: uniqueIndex(
      "agent_registrations_tenant_agent_chain_idx",
    ).on(table.tenantId, table.agentId, table.chainId),
    tenantIdx: index("agent_registrations_tenant_idx").on(table.tenantId),
    agentIdx: index("agent_registrations_agent_idx").on(table.agentId),
  }),
);

export const reputationCache = pgTable(
  "reputation_cache",
  {
    id: serial("id").primaryKey(),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    chainId: integer("chain_id").notNull(),
    tokenId: varchar("token_id", { length: 256 }).notNull(),
    scoreOnchain: numeric("score_onchain", { precision: 5, scale: 2 })
      .notNull()
      .default("0"),
    scoreInternal: numeric("score_internal", { precision: 5, scale: 2 })
      .notNull()
      .default("0"),
    scoreCombined: numeric("score_combined", { precision: 5, scale: 2 })
      .notNull()
      .default("0"),
    feedbackCount: integer("feedback_count").notNull().default(0),
    lastUpdated: timestamp("last_updated", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentChainUnique: uniqueIndex("reputation_cache_agent_chain_idx").on(
      table.agentId,
      table.chainId,
    ),
    agentIdx: index("reputation_cache_agent_idx").on(table.agentId),
  }),
);

export const registryIndex = pgTable(
  "registry_index",
  {
    id: serial("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    rpcUrl: text("rpc_url").notNull(),
    registryAddress: varchar("registry_address", { length: 64 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    chainUnique: uniqueIndex("registry_index_chain_id_idx").on(table.chainId),
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
    tenantUrlUnique: uniqueIndex("webhook_configs_tenant_url_idx").on(
      table.tenantId,
      table.url,
    ),
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
    // wei thresholds must be non-empty decimal digit strings (escalate is nullable).
    maxAmountIsWei: check(
      "auto_approval_rules_max_amount_wei_chk",
      sql`${table.maxAmountWei} ~ '^[0-9]+$'`,
    ),
    escalateIsWei: check(
      "auto_approval_rules_escalate_above_wei_chk",
      sql`${table.escalateAboveWei} IS NULL OR ${table.escalateAboveWei} ~ '^[0-9]+$'`,
    ),
  }),
);

// ─── Webhook delivery status enum ─────────────────────────────────────────────

export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "pending",
  "processing",
  "delivered",
  "failed",
  "dead",
]);

// ─── Webhook deliveries table ─────────────────────────────────────────────────

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // No tenant FK: isolation is enforced at the app layer (every query scopes by
    // tenant_id) and deliveries may reference platform/system principals.
    tenantId: text("tenant_id").notNull(),
    webhookConfigId: uuid("webhook_config_id").references(
      () => webhookConfigs.id,
      {
        onDelete: "set null",
      },
    ),
    agentId: text("agent_id"),
    eventType: text("event_type").notNull(),
    replayedFromDeliveryId: uuid("replayed_from_delivery_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    url: text("url").notNull(),
    secret: text("secret"),
    events: jsonb("events").$type<string[]>(),
    status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => ({
    statusIdx: index("webhook_deliveries_status_idx").on(table.status),
    nextRetryIdx: index("webhook_deliveries_next_retry_idx").on(
      table.nextRetryAt,
    ),
    tenantIdx: index("webhook_deliveries_tenant_idx").on(table.tenantId),
    webhookConfigIdx: index("webhook_deliveries_webhook_config_idx").on(
      table.webhookConfigId,
    ),
    replayedFromIdx: index("webhook_deliveries_replayed_from_idx").on(
      table.replayedFromDeliveryId,
    ),
  }),
);

export const policyTemplateRelations = relations(
  policyTemplates,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [policyTemplates.tenantId],
      references: [tenants.id],
    }),
  }),
);

export const agentRegistrationRelations = relations(
  agentRegistrations,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [agentRegistrations.tenantId],
      references: [tenants.id],
    }),
    agent: one(agents, {
      fields: [agentRegistrations.agentId],
      references: [agents.id],
    }),
  }),
);

export const reputationCacheRelations = relations(
  reputationCache,
  ({ one }) => ({
    agent: one(agents, {
      fields: [reputationCache.agentId],
      references: [agents.id],
    }),
  }),
);

export const webhookConfigRelations = relations(webhookConfigs, ({ one }) => ({
  tenant: one(tenants, {
    fields: [webhookConfigs.tenantId],
    references: [tenants.id],
  }),
}));

export const autoApprovalRuleRelations = relations(
  autoApprovalRules,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [autoApprovalRules.tenantId],
      references: [tenants.id],
    }),
  }),
);

export const tenantRelations = relations(tenants, ({ many, one }) => ({
  agents: many(agents),
  config: one(tenantConfigs, {
    fields: [tenants.id],
    references: [tenantConfigs.tenantId],
  }),
  policyTemplates: many(policyTemplates),
  agentRegistrations: many(agentRegistrations),
  webhookConfigs: many(webhookConfigs),
  appClients: many(tenantAppClients),
  appClientSecrets: many(tenantAppClientSecrets),
  requestSigningKeys: many(tenantRequestSigningKeys),
  ssoDomains: many(tenantSsoDomains),
  autoApprovalRule: one(autoApprovalRules, {
    fields: [tenants.id],
    references: [autoApprovalRules.tenantId],
  }),
}));

export const tenantAppClientRelations = relations(
  tenantAppClients,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [tenantAppClients.tenantId],
      references: [tenants.id],
    }),
  }),
);

export const tenantAppClientSecretRelations = relations(
  tenantAppClientSecrets,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [tenantAppClientSecrets.tenantId],
      references: [tenants.id],
    }),
    appClient: one(tenantAppClients, {
      fields: [
        tenantAppClientSecrets.tenantId,
        tenantAppClientSecrets.clientId,
      ],
      references: [tenantAppClients.tenantId, tenantAppClients.id],
    }),
  }),
);

export const tenantRequestSigningKeyRelations = relations(
  tenantRequestSigningKeys,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [tenantRequestSigningKeys.tenantId],
      references: [tenants.id],
    }),
  }),
);

export const tenantSsoDomainRelations = relations(
  tenantSsoDomains,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [tenantSsoDomains.tenantId],
      references: [tenants.id],
    }),
  }),
);

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
  intents: many(intents),
  signers: many(agentSigners),
  keyQuorums: many(agentKeyQuorums),
  registrations: many(agentRegistrations),
  reputationEntries: many(reputationCache),
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

export const intentRelations = relations(intents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [intents.tenantId],
    references: [tenants.id],
  }),
  agent: one(agents, {
    fields: [intents.agentId],
    references: [agents.id],
  }),
}));

export const agentWalletRelations = relations(agentWallets, ({ one }) => ({
  agent: one(agents, {
    fields: [agentWallets.agentId],
    references: [agents.id],
  }),
}));

export const agentSignerRelations = relations(agentSigners, ({ one }) => ({
  tenant: one(tenants, {
    fields: [agentSigners.tenantId],
    references: [tenants.id],
  }),
  agent: one(agents, {
    fields: [agentSigners.agentId],
    references: [agents.id],
  }),
}));

export const agentKeyQuorumRelations = relations(
  agentKeyQuorums,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [agentKeyQuorums.tenantId],
      references: [tenants.id],
    }),
    agent: one(agents, {
      fields: [agentKeyQuorums.agentId],
      references: [agents.id],
    }),
  }),
);

export const encryptedChainKeyRelations = relations(
  encryptedChainKeys,
  ({ one }) => ({
    agent: one(agents, {
      fields: [encryptedChainKeys.agentId],
      references: [agents.id],
    }),
  }),
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type TenantConfigRow = typeof tenantConfigs.$inferSelect;
export type NewTenantConfigRow = typeof tenantConfigs.$inferInsert;
export type TenantAppClientRow = typeof tenantAppClients.$inferSelect;
export type NewTenantAppClientRow = typeof tenantAppClients.$inferInsert;
export type TenantAppClientSecretRow =
  typeof tenantAppClientSecrets.$inferSelect;
export type NewTenantAppClientSecretRow =
  typeof tenantAppClientSecrets.$inferInsert;
export type TenantRequestSigningKeyRow =
  typeof tenantRequestSigningKeys.$inferSelect;
export type NewTenantRequestSigningKeyRow =
  typeof tenantRequestSigningKeys.$inferInsert;
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
export type ExecutionAuthorizationNonce =
  typeof executionAuthorizationNonces.$inferSelect;
export type NewExecutionAuthorizationNonce =
  typeof executionAuthorizationNonces.$inferInsert;
export type Intent = typeof intents.$inferSelect;
export type NewIntent = typeof intents.$inferInsert;
export type AgentSigner = typeof agentSigners.$inferSelect;
export type NewAgentSigner = typeof agentSigners.$inferInsert;
export type AgentKeyQuorum = typeof agentKeyQuorums.$inferSelect;
export type NewAgentKeyQuorum = typeof agentKeyQuorums.$inferInsert;
export type SponsoredGasEvent = typeof sponsoredGasEvents.$inferSelect;
export type NewSponsoredGasEvent = typeof sponsoredGasEvents.$inferInsert;
export type AgentWallet = typeof agentWallets.$inferSelect;
export type NewAgentWallet = typeof agentWallets.$inferInsert;
export type EncryptedChainKey = typeof encryptedChainKeys.$inferSelect;
export type NewEncryptedChainKey = typeof encryptedChainKeys.$inferInsert;
export type PolicyTemplateRow = typeof policyTemplates.$inferSelect;
export type NewPolicyTemplateRow = typeof policyTemplates.$inferInsert;
export type AgentRegistration = typeof agentRegistrations.$inferSelect;
export type NewAgentRegistration = typeof agentRegistrations.$inferInsert;
export type ReputationCache = typeof reputationCache.$inferSelect;
export type NewReputationCache = typeof reputationCache.$inferInsert;
export type RegistryIndex = typeof registryIndex.$inferSelect;
export type NewRegistryIndex = typeof registryIndex.$inferInsert;
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
    // No tenant FK: secrets are app-layer scoped by tenant_id; platform-scoped
    // secrets may use non-tenant principals not present in `tenants`.
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tenantNameVersion: uniqueIndex("secrets_tenant_name_version_idx").on(
      table.tenantId,
      table.name,
      table.version,
    ),
    tenantIdx: index("secrets_tenant_idx").on(table.tenantId),
    tenantIdUnique: uniqueIndex("secrets_tenant_id_unique_idx").on(
      table.tenantId,
      table.id,
    ),
  }),
);

export const secretRoutes = pgTable(
  "secret_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull(),
    agentId: varchar("agent_id", { length: 64 }),
    secretId: uuid("secret_id").notNull(),
    hostPattern: varchar("host_pattern", { length: 512 }).notNull(),
    pathPattern: varchar("path_pattern", { length: 512 }).default("/*"),
    method: varchar("method", { length: 10 }).default("*"),
    injectAs: varchar("inject_as", { length: 50 }).notNull(),
    injectKey: varchar("inject_key", { length: 255 }).notNull(),
    injectFormat: varchar("inject_format", { length: 255 }).default("{value}"),
    injectionStrategy: varchar("injection_strategy", { length: 32 })
      .notNull()
      .default("header"),
    injectionConfig: jsonb("injection_config")
      .$type<{ service?: string; region?: string }>()
      .notNull()
      .default({}),
    priority: integer("priority").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    approvalConfig: jsonb("approval_config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // Migration 0081 route revision incremented by route or secret rotation.
    // Bound by the approval commitment so resume can detect route
    // rotation. Maintained by the `secret_routes_bump_authority_revision`
    // BEFORE UPDATE trigger (raw SQL only, not visible to drizzle-kit). Migration
    // 0082 adds authority_mode and provider_operation_id and extends the trigger.
    authorityRevision: integer("authority_revision").notNull().default(1),
    // Migration 0082 governed cutover columns. authority_mode defaults to
    // 'legacy', so a route must be explicitly enrolled. A governed route must
    // name its provider_operation_id (raw-SQL CHECK
    // secret_routes_governed_operation_chk); a legacy route MUST NOT.
    authorityMode: secretRouteAuthorityModeEnum("authority_mode")
      .notNull()
      .default("legacy"),
    providerOperationId: uuid("provider_operation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tenantIdx: index("secret_routes_tenant_idx").on(table.tenantId),
    agentIdx: index("secret_routes_agent_idx").on(table.agentId),
    secretIdx: index("secret_routes_secret_idx").on(table.secretId),
    hostIdx: index("secret_routes_host_idx").on(table.hostPattern),
    tenantIdUnique: uniqueIndex("secret_routes_tenant_id_unique_idx").on(
      table.tenantId,
      table.id,
    ),
  }),
);

// ─── Workspace-scoped provider authority (migration 0079) ────────────────────
//
// ⚠️ RAW-SQL-ONLY INVARIANTS (drift risk — NOT expressible in Drizzle, see
//    drizzle/0079_workspace_provider_authority.sql):
//
//    1. Ownership immutability. A BEFORE UPDATE trigger
//       `steward_reject_provider_scope_move()` is attached to FIVE tables via
//       these triggers, and rejects any UPDATE that changes tenant_id /
//       workspace_id / provider_account_id (RAISE EXCEPTION ... 'immutable',
//       ERRCODE 23514):
//         - workspaces_immutable_owner            (ON workspaces)
//         - provider_accounts_immutable_owner     (ON provider_accounts)
//         - provider_operations_immutable_owner   (ON provider_operations)
//         - provider_role_bindings_immutable_owner(ON provider_role_bindings)
//         - provider_grants_immutable_owner       (ON provider_grants)
//       Drizzle has no trigger DSL, so these live only in raw SQL. Do NOT
//       assume a `drizzle-kit generate` reflects them — it will not, and
//       regenerating without re-adding them silently drops fund-safety guards.
//
//    2. provider_role_bindings_lifetime_check CHECK
//       (not_before IS NULL OR expires_at IS NULL OR expires_at > not_before)
//       is defined in 0079 raw SQL only and is intentionally absent from the
//       providerRoleBindings table below (both bounds are nullable there, so
//       the tri-state predicate is awkward to keep in sync via the Drizzle
//       `check()` helper). It is the counterpart to providerGrants'
//       lifetimeCheck (which IS declared in-schema because expires_at is NOT
//       NULL on grants).
//
//    The regression test `packages/db/src/__tests__/provider-authority-migration.test.ts`
//    ("schema-only invariants ..." cases) asserts all five triggers, the trigger
//    function, and the lifetime CHECK exist after migration so accidental
//    removal fails CI.

export const providerEnvironmentEnum = pgEnum("provider_environment", [
  "development",
  "staging",
  "production",
]);
export const providerAuthorityStatusEnum = pgEnum("provider_authority_status", [
  "active",
  "disabled",
  "revoked",
]);
export const providerPrincipalTypeEnum = pgEnum("provider_principal_type", [
  "human",
  "agent",
]);
export const providerRoleEnum = pgEnum("provider_role", [
  "tenant_authority_admin",
  "workspace_admin",
  "workspace_operator",
  "workspace_viewer",
  "workspace_approver",
]);
export const providerRiskClassEnum = pgEnum("provider_risk_class", [
  "read",
  "write",
  "consequential",
]);

/** Tenant-level CAS watermark for authority mutations. It is not an access dependency. */
export const providerAuthorityTenantState = pgTable(
  "provider_authority_tenant_state",
  {
    tenantId: varchar("tenant_id", { length: 64 })
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(0),
    bootstrapCompleted: boolean("bootstrap_completed").notNull().default(false),
    ...timestamps,
  },
);

// NOTE: owner immutability enforced by `workspaces_immutable_owner` trigger in
// 0079 raw SQL (tenant_id cannot change). Not visible to drizzle-kit.
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 128 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    environment: providerEnvironmentEnum("environment").notNull(),
    status: providerAuthorityStatusEnum("status").notNull().default("active"),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    ...timestamps,
  },
  (table) => ({
    tenantIdUnique: uniqueIndex("workspaces_tenant_id_id_idx").on(
      table.tenantId,
      table.id,
    ),
    tenantKeyUnique: uniqueIndex("workspaces_tenant_key_idx").on(
      table.tenantId,
      table.key,
    ),
    tenantStatusIdx: index("workspaces_tenant_status_idx").on(
      table.tenantId,
      table.status,
    ),
  }),
);

// NOTE: owner immutability (tenant_id + workspace_id) enforced by
// `provider_accounts_immutable_owner` trigger in 0079 raw SQL. Not visible to
// drizzle-kit.
export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    adapterKey: varchar("adapter_key", { length: 128 }).notNull(),
    externalRef: varchar("external_ref", { length: 512 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    status: providerAuthorityStatusEnum("status").notNull().default("active"),
    credentialSecretId: uuid("credential_secret_id"),
    credentialVersion: integer("credential_version"),
    revision: integer("revision").notNull().default(1),
    ...timestamps,
  },
  (table) => ({
    workspaceFk: foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
      name: "provider_accounts_tenant_workspace_fk",
    }).onDelete("cascade"),
    credentialFk: foreignKey({
      columns: [table.tenantId, table.credentialSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
      name: "provider_accounts_tenant_credential_fk",
    }).onDelete("restrict"),
    tenantWorkspaceIdUnique: uniqueIndex(
      "provider_accounts_tenant_workspace_id_idx",
    ).on(table.tenantId, table.workspaceId, table.id),
    externalRefUnique: uniqueIndex(
      "provider_accounts_workspace_external_ref_idx",
    ).on(
      table.tenantId,
      table.workspaceId,
      table.adapterKey,
      table.externalRef,
    ),
    credentialPairCheck: check(
      "provider_accounts_credential_pair_check",
      sql`(${table.credentialSecretId} IS NULL) = (${table.credentialVersion} IS NULL)`,
    ),
  }),
);

/**
 * Durable hand-off journal for OAuth responses that cannot be replayed safely.
 * Token material is never stored here: credentialSecretId points at a
 * tenant-bound, encrypted vault row.  The journal lets recovery distinguish a
 * request that has not called the provider from one whose one-time response
 * must be adopted or revoked.
 */
export const providerGoogleCredentialLifecycles = pgTable(
  "provider_google_credential_lifecycles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    providerAccountId: uuid("provider_account_id"),
    kind: varchar("kind", { length: 32 }).notNull(),
    state: varchar("state", { length: 32 }).notNull(),
    credentialSecretId: uuid("credential_secret_id"),
    expectedAccountRevision: integer("expected_account_revision"),
    attempts: integer("attempts").notNull().default(0),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    ...timestamps,
  },
  (table) => ({
    workspaceFk: foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
      name: "provider_google_lifecycle_workspace_fk",
    }).onDelete("cascade"),
    accountFk: foreignKey({
      columns: [table.tenantId, table.workspaceId, table.providerAccountId],
      foreignColumns: [
        providerAccounts.tenantId,
        providerAccounts.workspaceId,
        providerAccounts.id,
      ],
      name: "provider_google_lifecycle_account_fk",
    }).onDelete("cascade"),
    secretFk: foreignKey({
      columns: [table.tenantId, table.credentialSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
      name: "provider_google_lifecycle_secret_fk",
    }).onDelete("restrict"),
    stateCheck: check(
      "provider_google_lifecycle_state_check",
      sql`${table.state} IN ('inflight', 'credential_staged', 'revocation_pending', 'adopted', 'revoked', 'needs_attention', 'superseded')`,
    ),
    kindCheck: check(
      "provider_google_lifecycle_kind_check",
      sql`${table.kind} IN ('connect_exchange', 'refresh_rotation', 'disconnect_revoke')`,
    ),
    accountStateIdx: index("provider_google_lifecycle_account_state_idx").on(
      table.tenantId,
      table.providerAccountId,
      table.state,
    ),
    activeRefreshIdx: uniqueIndex(
      "provider_google_lifecycle_active_refresh_idx",
    )
      .on(table.tenantId, table.providerAccountId)
      .where(
        sql`${table.kind} = 'refresh_rotation' AND ${table.state} IN ('inflight', 'credential_staged')`,
      ),
  }),
);

/**
 * Durable hand-off journal for X OAuth code exchange, refresh rotation, and
 * disconnect cleanup. Provider responses and disconnect handles are encrypted
 * before fallible work, then adopted or revoked through bounded recovery.
 */
export const providerXCredentialLifecycles = pgTable(
  "provider_x_credential_lifecycles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    providerAccountId: uuid("provider_account_id"),
    kind: varchar("kind", { length: 32 }).notNull().default("refresh_rotation"),
    state: varchar("state", { length: 32 }).notNull(),
    credentialSecretId: uuid("credential_secret_id"),
    expectedAccountRevision: integer("expected_account_revision"),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    disabledRoutes: jsonb("disabled_routes")
      .$type<Array<{ id: string; authorityRevision: number }>>()
      .notNull()
      .default([]),
    ...timestamps,
  },
  (table) => ({
    workspaceFk: foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
      name: "provider_x_lifecycle_workspace_fk",
    }).onDelete("cascade"),
    accountFk: foreignKey({
      columns: [table.tenantId, table.workspaceId, table.providerAccountId],
      foreignColumns: [
        providerAccounts.tenantId,
        providerAccounts.workspaceId,
        providerAccounts.id,
      ],
      name: "provider_x_lifecycle_account_fk",
    }).onDelete("cascade"),
    secretFk: foreignKey({
      columns: [table.tenantId, table.credentialSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
      name: "provider_x_lifecycle_secret_fk",
    }).onDelete("restrict"),
    stateCheck: check(
      "provider_x_lifecycle_state_check",
      sql`${table.state} IN ('inflight', 'credential_staged', 'revocation_pending', 'adopted', 'revoked', 'needs_attention', 'superseded')`,
    ),
    kindCheck: check(
      "provider_x_lifecycle_kind_check",
      sql`${table.kind} IN ('connect_exchange', 'refresh_rotation', 'disconnect_revoke')`,
    ),
    revisionCheck: check(
      "provider_x_lifecycle_revision_check",
      sql`${table.expectedAccountRevision} IS NULL OR ${table.expectedAccountRevision} >= 1`,
    ),
    refreshBindingCheck: check(
      "provider_x_lifecycle_refresh_binding_check",
      sql`${table.kind} = 'connect_exchange' OR (${table.providerAccountId} IS NOT NULL AND ${table.expectedAccountRevision} IS NOT NULL)`,
    ),
    retryCheck: check(
      "provider_x_lifecycle_retry_check",
      sql`${table.attempts} >= 0 AND ${table.attempts} <= 5 AND (${table.state} <> 'revocation_pending' OR ${table.nextRetryAt} IS NOT NULL)`,
    ),
    disabledRoutesArrayCheck: check(
      "provider_x_lifecycle_disabled_routes_array_check",
      sql`jsonb_typeof(${table.disabledRoutes}) = 'array'`,
    ),
    secretStateCheck: check(
      "provider_x_lifecycle_secret_state_check",
      sql`(${table.state} = 'inflight' AND ${table.credentialSecretId} IS NULL) OR (${table.state} IN ('credential_staged', 'revocation_pending') AND ${table.credentialSecretId} IS NOT NULL) OR ${table.state} = 'needs_attention' OR (${table.state} IN ('adopted', 'revoked', 'superseded') AND ${table.credentialSecretId} IS NULL)`,
    ),
    accountStateIdx: index("provider_x_lifecycle_account_state_idx").on(
      table.tenantId,
      table.providerAccountId,
      table.state,
    ),
    recoveryIdx: index("provider_x_lifecycle_recovery_idx").on(
      table.state,
      table.nextRetryAt,
      table.updatedAt,
    ),
    activeRefreshIdx: uniqueIndex("provider_x_lifecycle_active_refresh_idx")
      .on(table.tenantId, table.providerAccountId)
      .where(
        sql`${table.kind} = 'refresh_rotation' AND ${table.state} IN ('inflight', 'credential_staged', 'revocation_pending', 'needs_attention')`,
      ),
  }),
);

// NOTE: owner immutability enforced by `provider_operations_immutable_owner`
// trigger in 0079 raw SQL. Not visible to drizzle-kit.
export const providerOperations = pgTable(
  "provider_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    providerAccountId: uuid("provider_account_id").notNull(),
    operationKey: varchar("operation_key", { length: 128 }).notNull(),
    riskClass: providerRiskClassEnum("risk_class").notNull(),
    capabilityId: uuid("capability_id"),
    secretRouteId: uuid("secret_route_id"),
    requestProfile: jsonb("request_profile")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    responseProfile: jsonb("response_profile")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: providerAuthorityStatusEnum("status").notNull().default("active"),
    revision: integer("revision").notNull().default(1),
    ...timestamps,
  },
  (table) => ({
    accountFk: foreignKey({
      columns: [table.tenantId, table.workspaceId, table.providerAccountId],
      foreignColumns: [
        providerAccounts.tenantId,
        providerAccounts.workspaceId,
        providerAccounts.id,
      ],
      name: "provider_operations_tenant_workspace_account_fk",
    }).onDelete("cascade"),
    routeFk: foreignKey({
      columns: [table.tenantId, table.secretRouteId],
      foreignColumns: [secretRoutes.tenantId, secretRoutes.id],
      name: "provider_operations_tenant_route_fk",
    }).onDelete("restrict"),
    operationUnique: uniqueIndex("provider_operations_account_key_idx").on(
      table.tenantId,
      table.workspaceId,
      table.providerAccountId,
      table.operationKey,
    ),
    tenantWorkspaceAccountIdUnique: uniqueIndex(
      "provider_operations_tenant_workspace_account_id_idx",
    ).on(table.tenantId, table.workspaceId, table.providerAccountId, table.id),
  }),
);

// NOTE: owner immutability enforced by `provider_role_bindings_immutable_owner`
// trigger, and the tri-state lifetime rule by
// `provider_role_bindings_lifetime_check` CHECK — BOTH in 0079 raw SQL only
// (see the section banner above). Not visible to drizzle-kit.
export const providerRoleBindings = pgTable(
  "provider_role_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id"),
    providerAccountId: uuid("provider_account_id"),
    principalType: providerPrincipalTypeEnum("principal_type").notNull(),
    principalId: varchar("principal_id", { length: 64 }).notNull(),
    roleKey: providerRoleEnum("role_key").notNull(),
    operationKeys: text("operation_keys").array().notNull().default([]),
    environment: providerEnvironmentEnum("environment"),
    notBefore: timestamp("not_before", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: providerAuthorityStatusEnum("status").notNull().default("active"),
    revision: integer("revision").notNull().default(1),
    grantedByUserId: uuid("granted_by_user_id").notNull(),
    reason: text("reason").notNull(),
    ...timestamps,
  },
  (table) => ({
    workspaceFk: foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
      name: "provider_role_bindings_tenant_workspace_fk",
    }).onDelete("cascade"),
    accountFk: foreignKey({
      columns: [table.tenantId, table.workspaceId, table.providerAccountId],
      foreignColumns: [
        providerAccounts.tenantId,
        providerAccounts.workspaceId,
        providerAccounts.id,
      ],
      name: "provider_role_bindings_tenant_workspace_account_fk",
    }).onDelete("cascade"),
    principalIdx: index("provider_role_bindings_principal_idx").on(
      table.tenantId,
      table.principalType,
      table.principalId,
      table.status,
    ),
    scopeCheck: check(
      "provider_role_bindings_scope_check",
      sql`(${table.roleKey} = 'tenant_authority_admin' AND ${table.workspaceId} IS NULL AND ${table.providerAccountId} IS NULL) OR (${table.roleKey} <> 'tenant_authority_admin' AND ${table.workspaceId} IS NOT NULL)`,
    ),
    accountNeedsWorkspaceCheck: check(
      "provider_role_bindings_account_workspace_check",
      sql`${table.providerAccountId} IS NULL OR ${table.workspaceId} IS NOT NULL`,
    ),
  }),
);

// NOTE: owner immutability enforced by `provider_grants_immutable_owner`
// trigger in 0079 raw SQL (lifetimeCheck IS declared in-schema below since
// expires_at is NOT NULL here). Not visible to drizzle-kit.
export const providerGrants = pgTable(
  "provider_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    providerAccountId: uuid("provider_account_id").notNull(),
    agentId: varchar("agent_id", { length: 64 }).notNull(),
    operationKeys: text("operation_keys").array().notNull(),
    environment: providerEnvironmentEnum("environment"),
    notBefore: timestamp("not_before", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: providerAuthorityStatusEnum("status").notNull().default("active"),
    revision: integer("revision").notNull().default(1),
    grantedByUserId: uuid("granted_by_user_id").notNull(),
    reason: text("reason").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id"),
    revocationReason: text("revocation_reason"),
    ...timestamps,
  },
  (table) => ({
    accountFk: foreignKey({
      columns: [table.tenantId, table.workspaceId, table.providerAccountId],
      foreignColumns: [
        providerAccounts.tenantId,
        providerAccounts.workspaceId,
        providerAccounts.id,
      ],
      name: "provider_grants_tenant_workspace_account_fk",
    }).onDelete("cascade"),
    agentFk: foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [agents.tenantId, agents.id],
      name: "provider_grants_tenant_agent_fk",
    }).onDelete("cascade"),
    agentScopeIdx: index("provider_grants_agent_scope_idx").on(
      table.tenantId,
      table.workspaceId,
      table.agentId,
      table.status,
    ),
    operationsNonempty: check(
      "provider_grants_operations_nonempty_check",
      sql`cardinality(${table.operationKeys}) > 0`,
    ),
    lifetimeCheck: check(
      "provider_grants_lifetime_check",
      sql`${table.notBefore} IS NULL OR ${table.expiresAt} > ${table.notBefore}`,
    ),
  }),
);

export type Workspace = typeof workspaces.$inferSelect;
export type ProviderAccount = typeof providerAccounts.$inferSelect;
export type ProviderGoogleCredentialLifecycle =
  typeof providerGoogleCredentialLifecycles.$inferSelect;
export type ProviderOperation = typeof providerOperations.$inferSelect;
export type ProviderRoleBinding = typeof providerRoleBindings.$inferSelect;
export type ProviderGrant = typeof providerGrants.$inferSelect;

// ─── Provider action bindings (migration 0080) ───────────────────────────────
// The 1:1 typed companion to `intents` that carries the canonical provider
// action, request envelope, and the two separate (access + policy) decision
// documents with distinct IDs/hashes. `intents` stays the sole lifecycle root.
//
// NOTE: several invariants live ONLY in 0080 raw SQL and are not visible to
// drizzle-kit: (a) the composite FKs to intents/agents/workspaces/accounts/
// operations, (b) the CHECK constraints (digest regex, effect enums, the
// access/policy/status state machine, byte-size bounds), and (c) the
// `provider_action_bindings_immutable` BEFORE UPDATE trigger that freezes every
// column except status/updated_at and allows only the
// allowed_stub -> stub_succeeded|stub_failed transition.
export const providerActionBindings = pgTable(
  "provider_action_bindings",
  {
    intentId: varchar("intent_id", { length: 64 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    actorAgentId: varchar("actor_agent_id", { length: 64 }).notNull(),
    providerAccountId: uuid("provider_account_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    operationRevision: integer("operation_revision").notNull(),

    canonicalProfile: varchar("canonical_profile", { length: 96 }).notNull(),
    canonicalActionBytes: bytea("canonical_action_bytes").notNull(),
    actionDigest: varchar("action_digest", { length: 71 }).notNull(),
    requestEnvelope: jsonb("request_envelope")
      .$type<Record<string, unknown>>()
      .notNull(),
    requestHash: varchar("request_hash", { length: 71 }).notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", {
      length: 71,
    }).notNull(),
    safeSummary: jsonb("safe_summary")
      .$type<Record<string, unknown>>()
      .notNull(),

    accessDecisionId: uuid("access_decision_id").notNull(),
    accessEffect: varchar("access_effect", { length: 16 }).notNull(),
    accessReasonCode: varchar("access_reason_code", { length: 96 }).notNull(),
    matchedBindingIds: uuid("matched_binding_ids")
      .array()
      .notNull()
      .default([]),
    matchedGrantIds: uuid("matched_grant_ids").array().notNull().default([]),
    dependencyRevisions: jsonb("dependency_revisions")
      .$type<Record<string, unknown>>()
      .notNull(),
    accessDecision: jsonb("access_decision")
      .$type<Record<string, unknown>>()
      .notNull(),
    accessDecisionHash: varchar("access_decision_hash", {
      length: 71,
    }).notNull(),

    policyDecisionId: uuid("policy_decision_id"),
    policyEffect: varchar("policy_effect", { length: 24 }).notNull(),
    policyReasonCodes: text("policy_reason_codes")
      .array()
      .notNull()
      .default([]),
    policyResults: jsonb("policy_results")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    policyRevisionHash: varchar("policy_revision_hash", { length: 71 }),
    policyDecision: jsonb("policy_decision").$type<Record<string, unknown>>(),
    policyDecisionHash: varchar("policy_decision_hash", { length: 71 }),

    // Authoritative execute-time policy evidence. Unlike the approval-time
    // decision above, this snapshot is derived from current rules immediately
    // before approval consumption and authorization mint.
    executionPolicyDecisionId: uuid("execution_policy_decision_id"),
    executionPolicyRevisionHash: varchar("execution_policy_revision_hash", {
      length: 71,
    }),
    executionPolicyDecision: jsonb("execution_policy_decision").$type<
      Record<string, unknown>
    >(),
    executionPolicyDecisionHash: varchar("execution_policy_decision_hash", {
      length: 71,
    }),
    executionPolicyEvaluatedAt: timestamp("execution_policy_evaluated_at", {
      withTimezone: true,
    }),
    // 0084 also installs the raw-SQL NOT VALID rollout fence
    // provider_action_bindings_execution_policy_ready_chk. It is intentionally
    // not modeled here because Drizzle cannot express NOT VALID: PostgreSQL
    // enforces it for every new execution_ready/executing row while tolerating
    // existing in-flight executions whose outcome may already be unknown.

    status: varchar("status", { length: 32 }).notNull(),
    // ── Migration 0081 approval lifecycle columns ──
    // Mutable only via the transition trigger; binding_revision increments by
    // exactly one per state-changing transition. Several invariants (transition
    // graph, per-state field-shape CHECK, frozen-column freeze) live in 0081 raw
    // SQL and are not visible to drizzle-kit.
    bindingRevision: integer("binding_revision").notNull().default(1),
    approvalQueueId: varchar("approval_queue_id", { length: 64 }),
    approvalActorUserId: uuid("approval_actor_user_id"),
    approvalCommitmentHash: varchar("approval_commitment_hash", { length: 71 }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    deniedAt: timestamp("denied_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    staleAt: timestamp("stale_at", { withTimezone: true }),
    staleReasonCode: varchar("stale_reason_code", { length: 96 }),
    resumeActor: varchar("resume_actor", { length: 64 }),
    resumeAttemptId: uuid("resume_attempt_id"),
    resumeValidatedAt: timestamp("resume_validated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    intentFk: foreignKey({
      columns: [table.tenantId, table.intentId],
      foreignColumns: [intents.tenantId, intents.id],
      name: "provider_action_bindings_intent_fk",
    }).onDelete("cascade"),
    // Provider-action evidence outlives deleted agent authority. Migration
    // 0110 replaces the actor FK with a writer/transition fence.
    workspaceFk: foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
      name: "provider_action_bindings_workspace_fk",
    }).onDelete("restrict"),
    accountFk: foreignKey({
      columns: [table.tenantId, table.workspaceId, table.providerAccountId],
      foreignColumns: [
        providerAccounts.tenantId,
        providerAccounts.workspaceId,
        providerAccounts.id,
      ],
      name: "provider_action_bindings_account_fk",
    }).onDelete("restrict"),
    operationFk: foreignKey({
      columns: [
        table.tenantId,
        table.workspaceId,
        table.providerAccountId,
        table.operationId,
      ],
      foreignColumns: [
        providerOperations.tenantId,
        providerOperations.workspaceId,
        providerOperations.providerAccountId,
        providerOperations.id,
      ],
      name: "provider_action_bindings_operation_fk",
    }).onDelete("restrict"),
    accessDecisionIdUnique: uniqueIndex(
      "provider_action_bindings_access_decision_id_uniq",
    ).on(table.accessDecisionId),
    requestHashUnique: uniqueIndex(
      "provider_action_bindings_request_hash_uniq",
    ).on(table.requestHash),
    idempotencyUnique: uniqueIndex(
      "provider_action_bindings_idempotency_uniq",
    ).on(
      table.tenantId,
      table.workspaceId,
      table.actorAgentId,
      table.operationId,
      table.idempotencyKeyHash,
    ),
    scopeCreatedIdx: index("provider_action_bindings_scope_created_idx").on(
      table.tenantId,
      table.workspaceId,
      table.createdAt,
    ),
    actorStatusCreatedIdx: index(
      "provider_action_bindings_actor_status_created_idx",
    ).on(table.tenantId, table.actorAgentId, table.status, table.createdAt),
  }),
);

export type ProviderActionBinding = typeof providerActionBindings.$inferSelect;

/** First-class aggregate limits spanning every provider operation for an agent.
 * Enforcement is an atomic Redis reservation; this row is the durable,
 * revisioned operator configuration bound into each provider policy decision. */
export const providerAgentBudgets = pgTable(
  "provider_agent_budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    workspaceId: uuid("workspace_id"),
    agentId: varchar("agent_id", { length: 64 }).notNull(),
    dimension: varchar("dimension", { length: 16 }).notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    max: bigint("max", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 64 }),
    autoFreeze: boolean("auto_freeze").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentFk: foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [agents.tenantId, agents.id],
      name: "provider_agent_budgets_agent_fk",
    }).onDelete("cascade"),
    workspaceFk: foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
      name: "provider_agent_budgets_workspace_fk",
    }).onDelete("cascade"),
    identityIdx: uniqueIndex("provider_agent_budgets_identity_idx").on(
      table.tenantId,
      sql`COALESCE(${table.workspaceId}::text, '')`,
      table.agentId,
      table.dimension,
      sql`COALESCE(${table.currency}, '')`,
      table.windowSeconds,
    ),
    lookupIdx: index("provider_agent_budgets_lookup_idx").on(
      table.tenantId,
      table.agentId,
      table.enabled,
      table.workspaceId,
    ),
  }),
);

export type ProviderAgentBudget = typeof providerAgentBudgets.$inferSelect;

/**
 * One-time, upstream-derived credential deliveries. The credential itself is
 * deliberately absent: only its SHA-256 digest and the immutable authority
 * binding survive the response boundary.
 */
export const upstreamCredentialLeases = pgTable(
  "upstream_credential_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    agentId: varchar("agent_id", { length: 64 }).notNull(),
    grantId: uuid("grant_id").notNull(),
    capabilityId: uuid("capability_id").notNull(),
    issuer: varchar("issuer", { length: 64 }).notNull(),
    resource: jsonb("resource").$type<Record<string, unknown>>().notNull(),
    resourceHash: varchar("resource_hash", { length: 64 }).notNull(),
    authorityDigest: varchar("authority_digest", { length: 64 }).notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", {
      length: 64,
    }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }),
    tokenCiphertext: text("token_ciphertext"),
    tokenIv: text("token_iv"),
    tokenAuthTag: text("token_auth_tag"),
    tokenSalt: text("token_salt"),
    status: varchar("status", { length: 24 }).notNull().default("issuing"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    authorityCheckedAt: timestamp("authority_checked_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Lease evidence intentionally outlives deleted agent authority. A database
    // trigger serializes new lease publication with agent deletion because an
    // ordinary retention-blocking agent FK is deliberately absent.
    // Lease evidence intentionally outlives deleted workspace authority. The
    // 0110 workspace-row fence serializes publication with workspace deletion.
    replayUnique: uniqueIndex("upstream_credential_leases_replay_uniq").on(
      table.tenantId,
      table.agentId,
      table.idempotencyKeyHash,
    ),
    tenantIdUnique: uniqueIndex("upstream_credential_leases_tenant_id_uniq").on(
      table.tenantId,
      table.id,
    ),
    statusExpiryIdx: index("upstream_credential_leases_status_expiry_idx").on(
      table.status,
      table.expiresAt,
    ),
    statusUpdatedIdx: index("upstream_credential_leases_status_updated_idx").on(
      table.status,
      table.updatedAt,
    ),
    statusAuthorityCheckedIdx: index(
      "upstream_credential_leases_status_authority_checked_idx",
    ).on(table.status, table.authorityCheckedAt),
    bindingIdx: index("upstream_credential_leases_binding_idx").on(
      table.tenantId,
      table.workspaceId,
      table.agentId,
      table.grantId,
    ),
    statusCheck: check(
      "upstream_credential_leases_status_check",
      sql`${table.status} IN ('issuing','delivery_pending','acknowledging','active','revoking','revoked','expired','failed','needs_attention')`,
    ),
  }),
);

export type UpstreamCredentialLease =
  typeof upstreamCredentialLeases.$inferSelect;

/** Durable, secret-free lifecycle evidence for upstream credential leases. */
export const upstreamCredentialLeaseEvents = pgTable(
  "upstream_credential_lease_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leaseId: uuid("lease_id").notNull(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    decision: varchar("decision", { length: 16 }).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    parentFk: foreignKey({
      columns: [table.tenantId, table.leaseId],
      foreignColumns: [
        upstreamCredentialLeases.tenantId,
        upstreamCredentialLeases.id,
      ],
      name: "upstream_credential_lease_events_parent_fk",
    }).onDelete("restrict"),
    leaseCreatedIdx: index(
      "upstream_credential_lease_events_lease_created_idx",
    ).on(table.leaseId, table.createdAt),
    tenantCreatedIdx: index(
      "upstream_credential_lease_events_tenant_created_idx",
    ).on(table.tenantId, table.createdAt),
  }),
);

export type UpstreamCredentialLeaseEvent =
  typeof upstreamCredentialLeaseEvents.$inferSelect;

/** Append-only reservation identities. Mutable reconciliation metadata is
 * isolated from the immutable generation payload and claimed with SKIP LOCKED. */
export const providerActionReservationGenerations = pgTable(
  "provider_action_reservation_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    intentId: varchar("intent_id", { length: 64 }).notNull(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    generation: integer("generation").notNull(),
    phase: varchar("phase", { length: 16 }).notNull(),
    handles: jsonb("handles").$type<Record<string, unknown>>().notNull(),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastError: text("last_error"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: uuid("claimed_by"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    intentFk: foreignKey({
      columns: [table.tenantId, table.intentId],
      foreignColumns: [intents.tenantId, intents.id],
      name: "provider_action_reservation_generations_intent_fk",
    }).onDelete("cascade"),
    generationUnique: uniqueIndex(
      "provider_action_reservation_generations_intent_gen_uniq",
    ).on(table.intentId, table.generation),
    dueIdx: index("provider_action_reservation_generations_due_idx").on(
      table.nextRetryAt,
      table.createdAt,
      table.id,
    ),
    tenantDueIdx: index(
      "provider_action_reservation_generations_tenant_due_idx",
    ).on(table.tenantId, table.nextRetryAt, table.createdAt, table.id),
  }),
);

// Transactional required-audit outbox (spec §6.4). A provider-action decision
// inserts its REQUIRED audit intent here in the SAME transaction as the binding;
// it is drained into the tamper-evident audit chain immediately after commit and
// BEFORE the executor stub can run. Guarantees the event is never lost even though
// the audit chain uses its own advisory-locked transaction.
export const providerActionAuditOutbox = pgTable(
  "provider_action_audit_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    intentId: varchar("intent_id", { length: 64 }).notNull(),
    action: varchar("action", { length: 96 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }).notNull(),
    resourceId: varchar("resource_id", { length: 255 }).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    intentFk: foreignKey({
      columns: [table.tenantId, table.intentId],
      foreignColumns: [intents.tenantId, intents.id],
      name: "provider_action_audit_outbox_intent_fk",
    }).onDelete("cascade"),
    undeliveredIdx: index("provider_action_audit_outbox_undelivered_idx").on(
      table.tenantId,
      table.createdAt,
    ),
  }),
);

export type ProviderActionAuditOutbox =
  typeof providerActionAuditOutbox.$inferSelect;

export const pendingProxyRequestStatusEnum = pgEnum(
  "pending_proxy_request_status",
  [
    "pending",
    "approved",
    "denied",
    "executing",
    "executed",
    "expired",
    "failed",
  ],
);

export const pendingProxyRequests = pgTable(
  "pending_proxy_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull(),
    agentId: varchar("agent_id", { length: 64 }).notNull(),
    routeId: uuid("route_id").notNull(),
    method: varchar("method", { length: 10 }).notNull(),
    targetHost: varchar("target_host", { length: 512 }).notNull(),
    targetPath: varchar("target_path", { length: 2048 }).notNull(),
    requestDigest: varchar("request_digest", { length: 64 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    preview: jsonb("preview")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    safeHeaders: jsonb("safe_headers")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    bodyCiphertext: text("body_ciphertext").notNull(),
    bodyIv: text("body_iv").notNull(),
    bodyAuthTag: text("body_auth_tag").notNull(),
    bodySalt: text("body_salt").notNull(),
    status: pendingProxyRequestStatusEnum("status")
      .notNull()
      .default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: varchar("approved_by", { length: 255 }),
    deniedAt: timestamp("denied_at", { withTimezone: true }),
    deniedBy: varchar("denied_by", { length: 255 }),
    denialReason: text("denial_reason"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    executionStatusCode: integer("execution_status_code"),
    executionError: text("execution_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => sql`now()`),
  },
  (table) => ({
    tenantStatusIdx: index("pending_proxy_requests_tenant_status_idx").on(
      table.tenantId,
      table.status,
      table.createdAt,
    ),
    agentIdx: index("pending_proxy_requests_agent_idx").on(table.agentId),
    routeIdx: index("pending_proxy_requests_route_idx").on(table.routeId),
    expiresAtIdx: index("pending_proxy_requests_expires_at_idx").on(
      table.expiresAt,
    ),
    idempotencyIdx: uniqueIndex("pending_proxy_requests_idempotency_idx").on(
      table.tenantId,
      table.agentId,
      table.idempotencyKey,
    ),
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
export type PendingProxyRequest = typeof pendingProxyRequests.$inferSelect;
export type NewPendingProxyRequest = typeof pendingProxyRequests.$inferInsert;

// ─── Proxy Audit Log ─────────────────────────────────────────────────────────

export const proxyAuditLog = pgTable(
  "proxy_audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentId: text("agent_id").notNull(),
    // No tenant FK: proxy logs are app-layer scoped by tenant_id and may record
    // platform/system principals not present in `tenants`.
    tenantId: text("tenant_id").notNull(),
    targetHost: varchar("target_host", { length: 512 }).notNull(),
    targetPath: varchar("target_path", { length: 512 }).notNull(),
    method: varchar("method", { length: 10 }).notNull(),
    statusCode: integer("status_code").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tenantIdx: index("proxy_audit_log_tenant_idx").on(table.tenantId),
    agentIdx: index("proxy_audit_log_agent_idx").on(table.agentId),
    createdAtIdx: index("proxy_audit_log_created_at_idx").on(table.createdAt),
  }),
);

export type ProxyAuditLogEntry = typeof proxyAuditLog.$inferSelect;
export type NewProxyAuditLogEntry = typeof proxyAuditLog.$inferInsert;

export const tradeSessions = pgTable(
  "trade_sessions",
  {
    id: varchar("id", { length: 128 }).primaryKey(),
    agentId: varchar("agent_id", { length: 64 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    venue: varchar("venue", { length: 64 }).notNull(),
    walletId: varchar("wallet_id", { length: 128 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    dailySpendUsd: numeric("daily_spend_usd", { precision: 18, scale: 6 })
      .notNull()
      .default("0"),
    dailyCapUsd: numeric("daily_cap_usd", { precision: 18, scale: 6 })
      .notNull()
      .default("100"),
    perOrderCapUsd: numeric("per_order_cap_usd", {
      precision: 18,
      scale: 6,
    }).notNull(),
    leverageCap: numeric("leverage_cap", { precision: 10, scale: 4 }).notNull(),
    allowedAssets: text("allowed_assets").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: varchar("revoked_by", { length: 255 }),
  },
  (table) => ({
    agentVenueStatusIdx: index("trade_sessions_agent_venue_status_idx").on(
      table.agentId,
      table.venue,
      table.status,
    ),
    tenantIdx: index("trade_sessions_tenant_idx").on(table.tenantId),
    expiresAtIdx: index("trade_sessions_expires_at_idx").on(table.expiresAt),
  }),
);

export type TradeSessionRow = typeof tradeSessions.$inferSelect;
export type NewTradeSessionRow = typeof tradeSessions.$inferInsert;

export const agentPolicies = pgTable(
  "agent_policies",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    dailyCapUsd: numeric("daily_cap_usd").notNull().default("1000"),
    perOrderCapUsd: numeric("per_order_cap_usd").notNull().default("500"),
    leverageCap: numeric("leverage_cap").notNull().default("10"),
    allowedAssets: text("allowed_assets")
      .array()
      .notNull()
      .default(["BTC", "ETH", "BNB"]),
    allowedVenues: text("allowed_venues")
      .array()
      .notNull()
      .default(["hyperliquid"]),
    allowBuilderPerps: boolean("allow_builder_perps").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedReason: text("updated_reason"),
  },
  (table) => ({
    tenantIdx: index("agent_policies_tenant_idx").on(table.tenantId),
  }),
);

export type AgentPolicyRow = typeof agentPolicies.$inferSelect;
export type NewAgentPolicyRow = typeof agentPolicies.$inferInsert;

// ─── Tamper-evident audit log ────────────────────────────────────────────────
//
// Per-tenant append-only HMAC chain. Each row's `hmac` commits to the previous
// row's `hmac` plus a canonical encoding of the event, so tampering with any
// historical row invalidates verification of every subsequent row. The HMAC
// key is held in app config (STEWARD_AUDIT_HMAC_KEY) separately from DB
// credentials, so DB-only write access cannot forge rows that verify.
// See packages/api/src/services/audit.ts for the writer and verifier.
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // No tenant FK: audit events also record platform/system principals whose ids
    // are not rows in `tenants`. Isolation is app-layer; tamper-evidence comes from
    // the HMAC chain + audit_chain_heads high-water-mark.
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    prevHash: bytea("prev_hash").notNull(),
    hmac: bytea("hmac").notNull(),
    actorType: varchar("actor_type", { length: 32 }).notNull(),
    actorId: varchar("actor_id", { length: 255 }),
    action: varchar("action", { length: 128 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }),
    resourceId: varchar("resource_id", { length: 255 }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tenantSeqIdx: uniqueIndex("audit_events_tenant_seq_idx").on(
      table.tenantId,
      table.seq,
    ),
    tenantCreatedIdx: index("audit_events_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
    actionIdx: index("audit_events_action_idx").on(table.action),
    actorIdx: index("audit_events_actor_idx").on(
      table.actorType,
      table.actorId,
    ),
  }),
);

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;

// Out-of-band high-water-mark for each tenant's audit chain. Updated atomically
// inside the advisory-locked append transaction. Lets verification detect
// tail-truncation / whole-chain deletion that an in-band walk alone cannot:
// if rows are missing or the table is unexpectedly empty, the stored
// expected_seq / expected_count / head_hmac will not match what's on disk.
// `floor_seq`/`floor_hmac` anchor the chain after a legitimate retention sweep
// archives+drops a prefix (verification then starts from floor_seq, not seq=1).
// No FK ON DELETE: this mirrors audit_events (RESTRICT) — heads are never
// silently dropped while audit rows exist.
export const auditChainHeads = pgTable("audit_chain_heads", {
  tenantId: varchar("tenant_id", { length: 64 }).primaryKey(),
  expectedSeq: bigint("expected_seq", { mode: "number" }).notNull(),
  expectedCount: bigint("expected_count", { mode: "number" }).notNull(),
  headHmac: bytea("head_hmac").notNull(),
  floorSeq: bigint("floor_seq", { mode: "number" }).notNull().default(0),
  floorHmac: bytea("floor_hmac"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AuditChainHead = typeof auditChainHeads.$inferSelect;
export type NewAuditChainHead = typeof auditChainHeads.$inferInsert;

// Ed25519 checkpoints over the audit chain head. The HMAC chain is symmetric
// (verifiable only with STEWARD_AUDIT_HMAC_KEY); a checkpoint signs a canonical
// statement about the chain head with an Ed25519 key whose PUBLIC half can be
// published, so an third-party auditor can verify a signed evidence bundle offline
// without any Steward secret. `payload` is the exact JSON object that was
// canonicalized+signed; `signature` is base64 Ed25519 over the canonical bytes;
// `publicKey` is the SPKI PEM (denormalized per row so a bundle is
// self-contained and key rotation is auditable). Append-only, never mutated.
export const auditCheckpoints = pgTable(
  "audit_checkpoints",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    headHmac: bytea("head_hmac").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    signature: text("signature").notNull(),
    publicKey: text("public_key").notNull(),
    anchorProof: jsonb("anchor_proof").$type<Record<string, unknown>>(),
    anchorVerifiedAt: timestamp("anchor_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tenantSeqIdx: index("audit_checkpoints_tenant_seq_idx").on(
      table.tenantId,
      table.seq,
    ),
    tenantCreatedIdx: index("audit_checkpoints_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
  }),
);

export type AuditCheckpointRow = typeof auditCheckpoints.$inferSelect;
export type NewAuditCheckpointRow = typeof auditCheckpoints.$inferInsert;

export const auditRetentionPolicies = pgTable(
  "audit_retention_policies",
  {
    tenantId: varchar("tenant_id", { length: 64 })
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    retentionDays: integer("retention_days").notNull().default(365),
    archiveChunkSize: integer("archive_chunk_size").notNull().default(1000),
    revision: integer("revision").notNull().default(1),
    updatedBy: varchar("updated_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    retentionBounds: check(
      "audit_retention_days_bounds",
      sql`${table.retentionDays} BETWEEN 30 AND 3650`,
    ),
    chunkBounds: check(
      "audit_retention_chunk_bounds",
      sql`${table.archiveChunkSize} BETWEEN 1 AND 10000`,
    ),
    revisionPositive: check(
      "audit_retention_revision_positive",
      sql`${table.revision} > 0`,
    ),
  }),
);

export const auditArchives = pgTable(
  "audit_archives",
  {
    id: uuid("id").primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    fromSeq: bigint("from_seq", { mode: "number" }).notNull(),
    toSeq: bigint("to_seq", { mode: "number" }).notNull(),
    eventCount: bigint("event_count", { mode: "number" }).notNull(),
    source: varchar("source", { length: 16 }).notNull().default("native"),
    retentionPolicyRevision: integer("retention_policy_revision"),
    status: varchar("status", { length: 16 }).notNull().default("building"),
    manifest: jsonb("manifest").$type<Record<string, unknown>>(),
    manifestSha256: varchar("manifest_sha256", { length: 64 }),
    signature: text("signature"),
    signingKeyId: varchar("signing_key_id", { length: 64 }),
    publicKey: text("public_key"),
    durabilityAck: jsonb("durability_ack").$type<Record<string, unknown>>(),
    durabilityAckKeyId: varchar("durability_ack_key_id", { length: 64 }),
    durabilityAckSignature: text("durability_ack_signature"),
    durabilityAckSha256: varchar("durability_ack_sha256", { length: 64 }),
    durabilityAckAt: timestamp("durability_ack_at", { withTimezone: true }),
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    prunedAt: timestamp("pruned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    rangeValid: check(
      "audit_archives_range_valid",
      sql`${table.fromSeq} > 0 AND ${table.toSeq} >= ${table.fromSeq}`,
    ),
    countValid: check(
      "audit_archives_count_valid",
      sql`${table.eventCount} = ${table.toSeq} - ${table.fromSeq} + 1`,
    ),
    statusValid: check(
      "audit_archives_status_valid",
      sql`${table.status} IN ('building', 'sealed', 'pruned')`,
    ),
    sourceValid: check(
      "audit_archives_source_valid",
      sql`${table.source} IN ('native', 'imported')`,
    ),
    policyRevisionValid: check(
      "audit_archives_policy_revision_valid",
      sql`${table.retentionPolicyRevision} IS NULL OR ${table.retentionPolicyRevision} > 0`,
    ),
    manifestTransportBound: check(
      "audit_archives_manifest_transport_bound",
      sql`${table.manifest} IS NULL OR octet_length(${table.manifest}::text) <= 786432`,
    ),
    sealedFieldsValid: check(
      "audit_archives_sealed_fields_valid",
      sql`${table.status} = 'building' OR
          (${table.manifest} IS NOT NULL AND ${table.manifestSha256} ~ '^[0-9a-f]{64}$' AND
           ${table.signature} IS NOT NULL AND ${table.signingKeyId} IS NOT NULL AND
           ${table.sealedAt} IS NOT NULL)`,
    ),
    durabilityAckComplete: check(
      "audit_archives_durability_ack_complete",
      sql`(${table.durabilityAck} IS NULL AND ${table.durabilityAckKeyId} IS NULL AND
           ${table.durabilityAckSignature} IS NULL AND ${table.durabilityAckSha256} IS NULL AND
           ${table.durabilityAckAt} IS NULL) OR
          (${table.durabilityAck} IS NOT NULL AND ${table.durabilityAckKeyId} IS NOT NULL AND
           ${table.durabilityAckSignature} IS NOT NULL AND
           ${table.durabilityAckSha256} ~ '^[0-9a-f]{64}$' AND ${table.durabilityAckAt} IS NOT NULL)`,
    ),
    nativeAuthorityUnique: uniqueIndex("audit_archives_native_authority_unique")
      .on(
        table.tenantId,
        table.fromSeq,
        table.toSeq,
        sql`COALESCE(${table.retentionPolicyRevision}, 0)`,
      )
      .where(sql`${table.source} = 'native'`),
    tenantCreatedIdx: index("audit_archives_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
    resumableIdx: index("audit_archives_resumable_idx").on(
      table.tenantId,
      table.status,
      table.fromSeq,
      table.toSeq,
    ),
  }),
);

export const auditArchiveChunks = pgTable(
  "audit_archive_chunks",
  {
    archiveId: uuid("archive_id")
      .notNull()
      .references(() => auditArchives.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    fromSeq: bigint("from_seq", { mode: "number" }).notNull(),
    toSeq: bigint("to_seq", { mode: "number" }).notNull(),
    eventCount: integer("event_count").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    byteLength: integer("byte_length").notNull(),
    jsonl: text("jsonl").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    primaryKey: primaryKey({
      name: "audit_archive_chunks_pk",
      columns: [table.archiveId, table.chunkIndex],
    }),
    rangeValid: check(
      "audit_archive_chunks_range_valid",
      sql`${table.chunkIndex} >= 0 AND ${table.fromSeq} > 0 AND ${table.toSeq} >= ${table.fromSeq}`,
    ),
    countValid: check(
      "audit_archive_chunks_count_valid",
      sql`${table.eventCount} = ${table.toSeq} - ${table.fromSeq} + 1 AND ${table.eventCount} BETWEEN 1 AND 10000`,
    ),
    bytesValid: check(
      "audit_archive_chunks_bytes_valid",
      sql`${table.byteLength} BETWEEN 1 AND 1048576`,
    ),
  }),
);

export type AuditRetentionPolicy = typeof auditRetentionPolicies.$inferSelect;
export type AuditArchive = typeof auditArchives.$inferSelect;
export type AuditArchiveChunk = typeof auditArchiveChunks.$inferSelect;
