/**
 * SEC-169 inventory. Every Drizzle table must appear exactly once. Activation
 * migrations consume these categories to choose direct, join-derived,
 * bootstrap-root, or intentionally-global policy treatment.
 */
export const DIRECT_TENANT_TABLES = [
  "agent_key_quorums",
  "agent_policies",
  "agent_registrations",
  "agent_signers",
  "agents",
  "audit_archives",
  "audit_chain_heads",
  "audit_checkpoints",
  "audit_events",
  "audit_retention_policies",
  "auto_approval_rules",
  "condition_set_items",
  "condition_sets",
  "digital_asset_account_aggregations",
  "digital_asset_account_wallets",
  "digital_asset_accounts",
  "evm_wallet_nonce_inflight",
  "evm_wallet_nonce_owners",
  "evm_wallet_nonces",
  "execution_authorization_nonces",
  "global_wallet_action_confirmations",
  "intents",
  "operator_transfer_reservations",
  "pending_proxy_requests",
  "policy_templates",
  "provider_accounts",
  "provider_action_approvals",
  "provider_action_audit_outbox",
  "provider_action_bindings",
  "provider_action_reservation_generations",
  "provider_agent_budgets",
  "provider_authority_tenant_state",
  "provider_google_credential_lifecycles",
  "provider_grants",
  "provider_operations",
  "provider_role_bindings",
  "provider_x_credential_lifecycles",
  "proxy_audit_log",
  "refresh_tokens",
  "secret_routes",
  "secrets",
  "session_signers",
  "sponsored_gas_events",
  "tenant_app_client_secrets",
  "tenant_app_clients",
  "tenant_configs",
  "tenant_invitations",
  "tenant_request_signing_keys",
  "tenant_saml_assertion_replays",
  "tenant_saml_authn_requests",
  "tenant_saml_sso_configs",
  "tenant_sso_domains",
  "trade_sessions",
  "upstream_credential_lease_events",
  "upstream_credential_leases",
  "user_tenants",
  "user_wallet_app_consents",
  "vault_signing_freezes",
  "webhook_configs",
  "webhook_deliveries",
  "workspaces",
] as const;

export const INDIRECT_TENANT_TABLES = {
  agent_wallets: "EXISTS agents(id = agent_id AND tenant_id = current tenant)",
  audit_archive_chunks:
    "EXISTS audit_archives(id = archive_id AND tenant_id = current tenant)",
  encrypted_chain_keys:
    "EXISTS agents(id = agent_id AND tenant_id = current tenant)",
  encrypted_keys: "EXISTS agents(id = agent_id AND tenant_id = current tenant)",
  policies: "EXISTS agents(id = agent_id AND tenant_id = current tenant)",
  reputation_cache:
    "EXISTS agents(id = agent_id AND tenant_id = current tenant)",
  transactions: "EXISTS agents(id = agent_id AND tenant_id = current tenant)",
} as const;

export const TENANT_COLUMN_BACKFILL_TABLES = {} as const;

export const HYBRID_SCOPE_TABLES = {
  approval_queue:
    "provider approvals have tenant_id; legacy transaction approvals derive tenant through agent_id",
  user_push_subscriptions:
    "tenant_id is nullable for global user subscriptions; tenant and global access need separate policies",
} as const;

export const BOOTSTRAP_ROOT_TABLES = {
  tenants: "credential/JWT bootstrap resolves the tenant before SET LOCAL",
} as const;

export const INTENTIONALLY_GLOBAL_TABLES = {
  accounts:
    "global user OAuth identities; tenant access derives through user_tenants",
  authenticators:
    "global user WebAuthn identities; tenant access derives through user_tenants",
  registry_index: "public chain registry cache, not tenant-owned",
  sessions: "global user sessions; tenant membership is checked separately",
  users: "global user identity; tenant access derives through user_tenants",
} as const;

export const ALL_INVENTORIED_TABLES = [
  ...DIRECT_TENANT_TABLES,
  ...Object.keys(INDIRECT_TENANT_TABLES),
  ...Object.keys(TENANT_COLUMN_BACKFILL_TABLES),
  ...Object.keys(HYBRID_SCOPE_TABLES),
  ...Object.keys(BOOTSTRAP_ROOT_TABLES),
  ...Object.keys(INTENTIONALLY_GLOBAL_TABLES),
] as const;
