-- Sharing-only scopes are observed without granting billing disposition authority.
CREATE OR REPLACE FUNCTION require_app_billing_customer_retention(p_binding_id uuid, p_request_id uuid, p_request_digest text, p_lifecycle_revision bigint, p_phase_id uuid, p_phase_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b record; current_binding record; r record; p record; owner_id uuid; subject_id uuid; user_ids uuid[];
BEGIN
  SELECT c.*,a.app_id,x.organization_id,m.stripe_account_id,m.provider_account_key,m.livemode INTO b
    FROM app_billing_customers c JOIN app_billing_accounts a ON a.id=c.billing_account_id
    JOIN apps x ON x.id=a.app_id JOIN billing_merchants m ON m.id=c.merchant_id AND m.organization_id=x.organization_id WHERE c.id=p_binding_id;
  SELECT d.organization_id,d.user_id INTO owner_id,subject_id FROM account_deletion_requests d WHERE d.id=p_request_id;
  IF b.id IS NULL OR owner_id IS NULL OR subject_id IS NULL THEN RAISE EXCEPTION 'Customer retention source is unavailable'; END IF;
  PERFORM o.id FROM organizations o WHERE o.id IN (owner_id,b.organization_id) ORDER BY o.id FOR UPDATE;
  PERFORM x.id FROM apps x WHERE x.id=b.app_id FOR UPDATE;
  PERFORM s.id FROM app_billing_scopes s WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id ORDER BY s.id FOR UPDATE;
  PERFORM a.id FROM app_billing_accounts a WHERE a.id=b.billing_account_id FOR UPDATE;
  PERFORM c.id FROM app_billing_customers c WHERE c.id=p_binding_id FOR UPDATE;
  SELECT array_agg(q.id ORDER BY q.id) INTO user_ids FROM (
    SELECT subject_id AS id UNION SELECT m.user_id FROM app_billing_members m WHERE m.billing_account_id=b.billing_account_id
  ) q;
  PERFORM u.id FROM users u WHERE u.id=ANY(user_ids) ORDER BY u.id FOR UPDATE;
  PERFORM m.id FROM app_billing_members m WHERE m.billing_account_id=b.billing_account_id ORDER BY m.id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM app_billing_members m WHERE m.billing_account_id=b.billing_account_id AND NOT(m.user_id=ANY(user_ids))) THEN RAISE EXCEPTION 'Customer retention membership changed; retry'; END IF;
  SELECT * INTO r FROM account_deletion_requests d WHERE d.id=p_request_id FOR SHARE;
  SELECT * INTO p FROM account_deletion_phase_receipts d WHERE d.id=p_phase_id AND d.request_id=p_request_id FOR SHARE;
  IF r.id IS NULL OR r.organization_id IS DISTINCT FROM owner_id OR r.user_id IS DISTINCT FROM subject_id OR p.id IS NULL OR r.status IS DISTINCT FROM 'processing' OR r.irreversible_at IS NULL OR r.request_digest IS DISTINCT FROM p_request_digest OR r.lifecycle_revision IS DISTINCT FROM p_lifecycle_revision OR p.phase IS DISTINCT FROM 'stripe' OR p.lease_generation IS DISTINCT FROM p_phase_generation OR p.status IS NULL OR p.status NOT IN ('leased','calling','reconciling') OR p.lease_expires_at IS NULL OR NOT isfinite(p.lease_expires_at) OR (p.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp() THEN RAISE EXCEPTION 'Customer retention requires current canonical deletion phase'; END IF;
  IF NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=r.organization_id WHERE u.id=r.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=r.id AND o.account_lifecycle_revision=r.lifecycle_revision) THEN RAISE EXCEPTION 'Customer retention requires irreversible canonical subject'; END IF;
  SELECT c.*,a.app_id,x.organization_id,m.stripe_account_id,m.provider_account_key,m.livemode INTO current_binding
    FROM app_billing_customers c JOIN app_billing_accounts a ON a.id=c.billing_account_id
    JOIN apps x ON x.id=a.app_id JOIN billing_merchants m ON m.id=c.merchant_id AND m.organization_id=x.organization_id WHERE c.id=p_binding_id;
  IF current_binding.id IS NULL OR to_jsonb(current_binding) IS DISTINCT FROM to_jsonb(b) OR b.stripe_account_id IS NULL THEN RAISE EXCEPTION 'Customer retention binding changed; retry'; END IF;
  IF r.organization_id=b.organization_id OR EXISTS(SELECT 1 FROM app_billing_customer_closures c WHERE c.customer_binding_id=p_binding_id) THEN RAISE EXCEPTION 'Closing developer or customer cannot be retained'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_billing_scopes s JOIN app_billing_deletion_dispositions d ON d.scope_id=s.id WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id AND d.request_id=r.id AND d.disposition='retain_shared') THEN RAISE EXCEPTION 'Customer retention requires a retained sharing scope'; END IF;
  IF EXISTS(SELECT 1 FROM app_billing_scopes s WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id AND (
    s.app_id IS DISTINCT FROM b.app_id OR s.organization_id IS DISTINCT FROM b.organization_id OR s.livemode IS DISTINCT FROM b.livemode OR
    ((EXISTS(SELECT 1 FROM app_billing_members m WHERE m.billing_account_id=s.billing_account_id AND m.app_id=s.app_id AND m.user_id=r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=s.livemode))
      OR EXISTS(SELECT 1 FROM billing_subscription_commands c WHERE c.billing_scope_id=s.id AND c.requested_by_user_id=r.user_id AND c.request_payload->>'domain'='buyer')
      OR EXISTS(SELECT 1 FROM app_billing_deletion_dispositions own WHERE own.scope_id=s.id AND own.request_id=r.id))
    AND NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=s.id AND d.request_id=r.id AND d.request_digest=r.request_digest AND d.lifecycle_revision=r.lifecycle_revision AND d.phase_receipt_id=p.id AND d.phase_generation<=p.lease_generation AND d.merchant_id=b.merchant_id AND d.provider_account_key=b.provider_account_key AND d.livemode=b.livemode AND (
      (d.disposition='close' AND s.fenced_at IS NOT NULL) OR
      (d.disposition='retain_shared' AND NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions prior WHERE prior.scope_id=s.id AND prior.disposition='close'))
    )))
  )) THEN RAISE EXCEPTION 'Every administered or historical scope requires its current canonical retention or close decision'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=b.billing_account_id AND m.app_id=b.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=b.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (isfinite(u.expires_at) AND (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp()))) THEN RAISE EXCEPTION 'Customer retention requires a current surviving administrator'; END IF;
END $$;
