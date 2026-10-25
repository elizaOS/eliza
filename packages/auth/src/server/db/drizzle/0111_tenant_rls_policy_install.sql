-- SEC-169 policy installation checkpoint.
--
-- This migration deliberately installs the complete policy surface without
-- enabling RLS. Activation is a separate, operator-controlled step after the
-- application role, bootstrap functions, request transactions, and background
-- jobs have passed the real-Postgres gate. Installing policies first is safe on
-- existing deployments because PostgreSQL ignores them until ENABLE ROW LEVEL
-- SECURITY is applied.

CREATE SCHEMA IF NOT EXISTS "steward_rls";
REVOKE ALL ON SCHEMA "steward_rls" FROM PUBLIC;

CREATE OR REPLACE FUNCTION "steward_rls"."tenant_id"()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting('steward.tenant_id', true), '')
$$;
REVOKE ALL ON FUNCTION "steward_rls"."tenant_id"() FROM PUBLIC;

CREATE OR REPLACE FUNCTION "steward_rls"."user_id"()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting('steward.user_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION "steward_rls"."user_id"() FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS "steward_bootstrap";
REVOKE ALL ON SCHEMA "steward_bootstrap" FROM PUBLIC;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."tenant_api_key_subject"(p_tenant_id text)
RETURNS TABLE (
  id varchar(64), name varchar(255), api_key_hash text, owner_address varchar(128),
  created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT t.id, t.name, t.api_key_hash, t.owner_address, t.created_at, t.updated_at
  FROM public.tenants t
  WHERE t.id = p_tenant_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."session_subject"(
  p_user_id uuid,
  p_tenant_id text
)
RETURNS TABLE (
  deactivated_at timestamptz, is_guest boolean, guest_expires_at timestamptz,
  membership_role varchar(32)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT u.deactivated_at, u.is_guest, u.guest_expires_at, ut.role
  FROM public.users u
  LEFT JOIN public.user_tenants ut
    ON ut.user_id = u.id AND ut.tenant_id = p_tenant_id
  WHERE u.id = p_user_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."agent_subject"(
  p_agent_id text,
  p_tenant_id text,
  p_jti text DEFAULT NULL
)
RETURNS TABLE (
  agent_id varchar(64), agent_name varchar(255), wallet_address varchar(128),
  signer_id uuid, signer_policy_ids jsonb, signer_expires_at timestamptz,
  signer_revoked_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT a.id, a.name, a.wallet_address, ss.id, ss.policy_ids, ss.expires_at, ss.revoked_at
  FROM public.agents a
  LEFT JOIN public.session_signers ss
    ON p_jti IS NOT NULL
   AND ss.jti = p_jti
   AND ss.tenant_id = p_tenant_id
   AND ss.agent_id = p_agent_id
  WHERE a.id = p_agent_id AND a.tenant_id = p_tenant_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."agent_tenant_subject"(p_agent_id text)
RETURNS TABLE (tenant_id varchar(64))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT a.tenant_id
  FROM public.agents a
  WHERE a.id = p_agent_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."app_client_subject"(
  p_tenant_id text,
  p_client_id text
)
RETURNS TABLE (
  secret_id uuid, secret_hash text, secret_status varchar(16),
  expires_at timestamptz, revoked_at timestamptz, client_enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT s.id, s.secret_hash, s.status, s.expires_at, s.revoked_at, c.enabled
  FROM public.tenant_app_client_secrets s
  JOIN public.tenant_app_clients c
    ON c.tenant_id = s.tenant_id AND c.id = s.client_id
  WHERE s.tenant_id = p_tenant_id
    AND s.client_id = p_client_id
    AND s.status IN ('active', 'retiring')
    AND c.enabled = true
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."tenant_ids_for_internal_job"()
RETURNS TABLE (tenant_id varchar(64))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT t.id FROM public.tenants t
  WHERE t.id NOT IN ('system', 'platform')
  ORDER BY t.id
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."ensure_default_tenant"(p_api_key_hash text)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  INSERT INTO public.tenants(id, name, api_key_hash)
  VALUES ('default', 'Default Tenant', p_api_key_hash)
  ON CONFLICT (id) DO NOTHING
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."ensure_system_tenant"()
RETURNS text
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  INSERT INTO public.tenants(id, name, api_key_hash)
  VALUES ('system', 'Steward Internal Jobs', 'disabled-internal-tenant')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
  RETURNING id
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."ensure_platform_tenant"()
RETURNS text
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  INSERT INTO public.tenants(id, name, api_key_hash)
  VALUES ('platform', 'Steward Platform Operations', 'disabled-platform-tenant')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
  RETURNING id
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."platform_user_tenant_ids"(p_user_id uuid)
RETURNS TABLE (tenant_id varchar(64))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT ut.tenant_id
  FROM public.user_tenants ut
  WHERE ut.user_id = p_user_id
    AND NULLIF(current_setting('steward.tenant_id', true), '') IS NOT NULL
    AND (
      NULLIF(current_setting('steward.tenant_id', true), '') = 'platform'
      OR ut.tenant_id = NULLIF(current_setting('steward.tenant_id', true), '')
    )
  ORDER BY ut.tenant_id
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."platform_set_user_deactivation"(
  p_user_id uuid,
  p_deactivated boolean
)
RETURNS TABLE (
  user_id uuid, previous_deactivated_at timestamptz,
  previous_updated_at timestamptz, deactivated_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  existing public.users%ROWTYPE;
  owner_tenant record;
  updated_deactivated_at timestamptz;
BEGIN
  IF NULLIF(current_setting('steward.tenant_id', true), '') IS DISTINCT FROM 'platform' THEN
    RAISE EXCEPTION 'platform lifecycle operation requires reserved platform context';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform_user_account_' || p_user_id::text, 0));
  SELECT u.* INTO existing FROM public.users u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;

  IF p_deactivated THEN
    FOR owner_tenant IN
      SELECT ut.tenant_id
      FROM public.user_tenants ut
      WHERE ut.user_id = p_user_id AND ut.role = 'owner'
      ORDER BY ut.tenant_id
    LOOP
      PERFORM pg_advisory_xact_lock(
        hashtextextended('tenant_owner_lifecycle_' || owner_tenant.tenant_id, 0)
      );
      IF NOT EXISTS (
        SELECT 1
        FROM public.user_tenants other
        JOIN public.users u ON u.id = other.user_id
        WHERE other.tenant_id = owner_tenant.tenant_id
          AND other.role = 'owner'
          AND other.user_id <> p_user_id
          AND u.deactivated_at IS NULL
      ) THEN
        RAISE EXCEPTION 'Cannot deactivate the sole active tenant owner';
      END IF;
    END LOOP;
  END IF;

  UPDATE public.users u
  SET deactivated_at = CASE WHEN p_deactivated THEN now() ELSE NULL END,
      updated_at = now()
  WHERE u.id = p_user_id
  RETURNING u.deactivated_at INTO updated_deactivated_at;
  DELETE FROM public.refresh_tokens r WHERE r.user_id = p_user_id;
  RETURN QUERY SELECT
    existing.id, existing.deactivated_at, existing.updated_at, updated_deactivated_at;
END
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."platform_delete_user"(p_user_id uuid)
RETURNS TABLE (user_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  owner_tenant record;
BEGIN
  IF NULLIF(current_setting('steward.tenant_id', true), '') IS DISTINCT FROM 'platform' THEN
    RAISE EXCEPTION 'platform lifecycle operation requires reserved platform context';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform_user_account_' || p_user_id::text, 0));
  PERFORM 1 FROM public.users u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;

  FOR owner_tenant IN
    SELECT ut.tenant_id
    FROM public.user_tenants ut
    WHERE ut.user_id = p_user_id AND ut.role = 'owner'
    ORDER BY ut.tenant_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('tenant_owner_lifecycle_' || owner_tenant.tenant_id, 0)
    );
    IF NOT EXISTS (
      SELECT 1
      FROM public.user_tenants other
      JOIN public.users u ON u.id = other.user_id
      WHERE other.tenant_id = owner_tenant.tenant_id
        AND other.role = 'owner'
        AND other.user_id <> p_user_id
        AND u.deactivated_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Cannot delete the sole active tenant owner';
    END IF;
  END LOOP;

  DELETE FROM public.refresh_tokens r WHERE r.user_id = p_user_id;
  DELETE FROM public.users u WHERE u.id = p_user_id;
  RETURN QUERY SELECT p_user_id;
END
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."platform_revoke_user_refresh_tokens"(
  p_user_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  IF NULLIF(current_setting('steward.tenant_id', true), '') IS DISTINCT FROM 'platform' THEN
    RAISE EXCEPTION 'platform lifecycle operation requires reserved platform context';
  END IF;
  DELETE FROM public.refresh_tokens r WHERE r.user_id = p_user_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."retention_delete_deactivated_users"(p_days integer)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  IF p_days < 30 OR p_days > 36500 THEN
    RAISE EXCEPTION 'deactivated-user retention days outside safe bounds';
  END IF;
  DELETE FROM public.users u
  WHERE u.deactivated_at IS NOT NULL
    AND u.deactivated_at < now() - make_interval(days => p_days)
    AND NOT EXISTS (
      SELECT 1 FROM public.user_tenants ut
      WHERE ut.user_id = u.id AND ut.role = 'owner'
    );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."platform_stats"()
RETURNS TABLE (tenant_count bigint, agent_count bigint, transaction_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT
    (SELECT count(*) FROM public.tenants),
    (SELECT count(*) FROM public.agents),
    (SELECT count(*) FROM public.transactions)
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."platform_tenants"(p_limit integer, p_offset integer)
RETURNS TABLE (
  id varchar(64), name varchar(255), owner_address varchar(128),
  created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT t.id, t.name, t.owner_address, t.created_at, t.updated_at
  FROM public.tenants t
  ORDER BY t.created_at DESC, t.id
  LIMIT LEAST(GREATEST(p_limit, 1), 200)
  OFFSET GREATEST(p_offset, 0)
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."auth_refresh_subject"(p_token_hash text)
RETURNS TABLE (user_id uuid, tenant_id varchar(64), expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT r.user_id, r.tenant_id, r.expires_at
  FROM public.refresh_tokens r
  WHERE r.token_hash = p_token_hash
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."auth_tenant_subject"(
  p_tenant_id text,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (tenant_id varchar(64), membership_role varchar(32), join_mode varchar(16))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT t.id, ut.role, tc.join_mode
  FROM public.tenants t
  LEFT JOIN public.user_tenants ut
    ON p_user_id IS NOT NULL AND ut.tenant_id = t.id AND ut.user_id = p_user_id
  LEFT JOIN public.tenant_configs tc ON tc.tenant_id = t.id
  WHERE t.id = p_tenant_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."auth_sso_domain_subject"(
  p_tenant_id text,
  p_domain text
)
RETURNS TABLE (tenant_id varchar(64), sso_required boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT d.tenant_id, d.sso_required
  FROM public.tenant_sso_domains d
  WHERE d.tenant_id = p_tenant_id AND d.domain = p_domain AND d.status = 'verified'
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."auth_sso_discovery_subject"(p_domain text)
RETURNS TABLE (tenant_id varchar(64), domain varchar(255), sso_required boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT d.tenant_id, d.domain, d.sso_required
  FROM public.tenant_sso_domains d
  WHERE d.domain = p_domain AND d.status = 'verified'
  ORDER BY d.tenant_id
  LIMIT 2
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."auth_tenant_config_subject"(p_tenant_id text)
RETURNS TABLE (
  auth_abuse_config jsonb, allowed_origins text[], email_config jsonb,
  oidc_providers jsonb, test_account jsonb, allowed_redirect_urls text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT
    c.auth_abuse_config, c.allowed_origins, c.email_config,
    c.oidc_providers, c.test_account, c.allowed_redirect_urls
  FROM public.tenant_configs c
  WHERE c.tenant_id = p_tenant_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."auth_app_clients_subject"(p_tenant_id text)
RETURNS TABLE (
  id varchar(64), allowed_redirect_urls text[], login_methods jsonb,
  allowed_bundle_ids text[], allowed_package_names text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT
    c.id, c.allowed_redirect_urls, c.login_methods,
    c.allowed_bundle_ids, c.allowed_package_names
  FROM public.tenant_app_clients c
  WHERE c.tenant_id = p_tenant_id AND c.enabled = true
  ORDER BY c.id
$$;

CREATE OR REPLACE FUNCTION "steward_bootstrap"."auth_rotate_refresh_token"(
  p_source_token_hash text,
  p_target_tenant_id text,
  p_successor_id text,
  p_successor_token_hash text,
  p_successor_expires_at timestamptz
)
RETURNS TABLE (
  id text, user_id uuid, tenant_id varchar(64), token_hash text,
  expires_at timestamptz, created_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  source public.refresh_tokens%ROWTYPE;
BEGIN
  SELECT r.* INTO source
  FROM public.refresh_tokens r
  WHERE r.token_hash = p_source_token_hash AND r.expires_at >= now()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF NULLIF(current_setting('steward.tenant_id', true), '') IS DISTINCT FROM source.tenant_id
    OR NULLIF(current_setting('steward.user_id', true), '')::uuid IS DISTINCT FROM source.user_id
    OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = source.user_id AND u.deactivated_at IS NOT NULL)
    OR NOT EXISTS (
      SELECT 1 FROM public.user_tenants ut
      WHERE ut.user_id = source.user_id AND ut.tenant_id = p_target_tenant_id
    )
  THEN
    RETURN;
  END IF;

  DELETE FROM public.refresh_tokens r WHERE r.id = source.id;
  INSERT INTO public.refresh_tokens(id, user_id, tenant_id, token_hash, expires_at)
  VALUES (
    p_successor_id, source.user_id, p_target_tenant_id,
    p_successor_token_hash, p_successor_expires_at
  );
  RETURN QUERY SELECT
    source.id, source.user_id, p_target_tenant_id::varchar(64),
    source.token_hash, source.expires_at, source.created_at;
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "steward_bootstrap" FROM PUBLIC;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'agent_key_quorums', 'agent_policies', 'agent_registrations', 'agent_signers',
    'agents', 'audit_archives', 'audit_chain_heads', 'audit_checkpoints',
    'audit_events', 'audit_retention_policies', 'auto_approval_rules',
    'condition_set_items', 'condition_sets', 'digital_asset_account_aggregations',
    'digital_asset_account_wallets', 'digital_asset_accounts',
    'evm_wallet_nonce_inflight', 'evm_wallet_nonce_owners', 'evm_wallet_nonces',
    'execution_authorization_nonces', 'global_wallet_action_confirmations', 'intents',
    'operator_transfer_reservations', 'pending_proxy_requests', 'policy_templates',
    'provider_accounts', 'provider_action_approvals', 'provider_action_audit_outbox',
    'provider_action_bindings', 'provider_action_reservation_generations',
    'provider_agent_budgets', 'provider_authority_tenant_state',
    'provider_google_credential_lifecycles', 'provider_grants', 'provider_operations',
    'provider_role_bindings', 'provider_x_credential_lifecycles', 'proxy_audit_log',
    'refresh_tokens', 'secret_routes', 'secrets', 'session_signers',
    'sponsored_gas_events', 'tenant_app_client_secrets', 'tenant_app_clients',
    'tenant_configs', 'tenant_invitations', 'tenant_request_signing_keys',
    'tenant_saml_assertion_replays', 'tenant_saml_authn_requests',
    'tenant_saml_sso_configs', 'tenant_sso_domains', 'trade_sessions',
    'upstream_credential_lease_events', 'upstream_credential_leases', 'user_tenants',
    'user_wallet_app_consents', 'vault_signing_freezes', 'webhook_configs',
    'webhook_deliveries', 'workspaces'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS steward_tenant_isolation ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY steward_tenant_isolation ON public.%I FOR ALL USING '
      || '(tenant_id = steward_rls.tenant_id()) WITH CHECK '
      || '(tenant_id = steward_rls.tenant_id())',
      table_name
    );
  END LOOP;
END
$$;

DROP POLICY IF EXISTS "steward_tenant_isolation" ON "tenants";
CREATE POLICY "steward_tenant_isolation" ON "tenants"
  FOR ALL
  USING ("id" = "steward_rls"."tenant_id"())
  WITH CHECK ("id" = "steward_rls"."tenant_id"());

DROP POLICY IF EXISTS "steward_tenant_isolation" ON "agent_wallets";
CREATE POLICY "steward_tenant_isolation" ON "agent_wallets"
  FOR ALL USING (EXISTS (
    SELECT 1 FROM "agents" parent
    WHERE parent."id" = "agent_wallets"."agent_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM "agents" parent
    WHERE parent."id" = "agent_wallets"."agent_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  ));

DROP POLICY IF EXISTS "steward_tenant_isolation" ON "encrypted_chain_keys";
CREATE POLICY "steward_tenant_isolation" ON "encrypted_chain_keys"
  FOR ALL USING (EXISTS (
    SELECT 1 FROM "agents" parent
    WHERE parent."id" = "encrypted_chain_keys"."agent_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM "agents" parent
    WHERE parent."id" = "encrypted_chain_keys"."agent_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  ));

DROP POLICY IF EXISTS "steward_tenant_isolation" ON "encrypted_keys";
CREATE POLICY "steward_tenant_isolation" ON "encrypted_keys"
  FOR ALL USING (EXISTS (
    SELECT 1 FROM "agents" parent
    WHERE parent."id" = "encrypted_keys"."agent_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM "agents" parent
    WHERE parent."id" = "encrypted_keys"."agent_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  ));

DROP POLICY IF EXISTS "steward_tenant_isolation" ON "policies";
CREATE POLICY "steward_tenant_isolation" ON "policies"
  FOR ALL USING (EXISTS (
    SELECT 1 FROM "agents" parent
    WHERE parent."id" = "policies"."agent_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM "agents" parent
    WHERE parent."id" = "policies"."agent_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  ));

DROP POLICY IF EXISTS "steward_tenant_isolation" ON "reputation_cache";
CREATE POLICY "steward_tenant_isolation" ON "reputation_cache"
  FOR ALL USING (EXISTS (
    SELECT 1 FROM "agents" parent
    WHERE parent."id" = "reputation_cache"."agent_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM "agents" parent
    WHERE parent."id" = "reputation_cache"."agent_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  ));

DROP POLICY IF EXISTS "steward_tenant_isolation" ON "transactions";
CREATE POLICY "steward_tenant_isolation" ON "transactions"
  FOR ALL USING (EXISTS (
    SELECT 1 FROM "agents" parent
    WHERE parent."id" = "transactions"."agent_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM "agents" parent
    WHERE parent."id" = "transactions"."agent_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  ));

DROP POLICY IF EXISTS "steward_tenant_isolation" ON "audit_archive_chunks";
CREATE POLICY "steward_tenant_isolation" ON "audit_archive_chunks"
  FOR ALL USING (EXISTS (
    SELECT 1 FROM "audit_archives" parent
    WHERE parent."id" = "audit_archive_chunks"."archive_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM "audit_archives" parent
    WHERE parent."id" = "audit_archive_chunks"."archive_id"
      AND parent."tenant_id" = "steward_rls"."tenant_id"()
  ));

DROP POLICY IF EXISTS "steward_tenant_direct" ON "approval_queue";
DROP POLICY IF EXISTS "steward_tenant_derived" ON "approval_queue";
CREATE POLICY "steward_tenant_direct" ON "approval_queue"
  FOR ALL
  USING ("tenant_id" = "steward_rls"."tenant_id"())
  WITH CHECK ("tenant_id" = "steward_rls"."tenant_id"());
CREATE POLICY "steward_tenant_derived" ON "approval_queue"
  FOR ALL USING (
    "tenant_id" IS NULL AND EXISTS (
      SELECT 1 FROM "agents" parent
      WHERE parent."id" = "approval_queue"."agent_id"
        AND parent."tenant_id" = "steward_rls"."tenant_id"()
    )
  ) WITH CHECK (
    "tenant_id" IS NULL AND EXISTS (
      SELECT 1 FROM "agents" parent
      WHERE parent."id" = "approval_queue"."agent_id"
        AND parent."tenant_id" = "steward_rls"."tenant_id"()
    )
  );

DROP POLICY IF EXISTS "steward_tenant_subscription" ON "user_push_subscriptions";
DROP POLICY IF EXISTS "steward_global_user_subscription" ON "user_push_subscriptions";
CREATE POLICY "steward_tenant_subscription" ON "user_push_subscriptions"
  FOR ALL
  USING ("tenant_id" = "steward_rls"."tenant_id"())
  WITH CHECK ("tenant_id" = "steward_rls"."tenant_id"());
CREATE POLICY "steward_global_user_subscription" ON "user_push_subscriptions"
  FOR ALL
  USING ("tenant_id" IS NULL AND "user_id" = "steward_rls"."user_id"())
  WITH CHECK ("tenant_id" IS NULL AND "user_id" = "steward_rls"."user_id"());

COMMENT ON SCHEMA "steward_rls" IS
  'SEC-169 policy helpers. Policies are installed by 0111 but activation remains an explicit gated operator action.';
