-- Completion acquires the same owner-first lock order as billing admission and recovery.
CREATE OR REPLACE FUNCTION app_billing_deletion_completion_accounts(p_request uuid) RETURNS TABLE(account_id uuid) LANGUAGE sql STABLE AS $$
  WITH r AS (SELECT * FROM account_deletion_requests WHERE id=p_request), commands AS (
    SELECT c.* FROM billing_subscription_commands c CROSS JOIN r WHERE c.app_id IS NOT NULL AND (
      c.organization_id=r.organization_id OR c.requested_by_user_id=r.user_id OR
      c.request_payload->>'requestId'=r.id::text OR c.id IN(SELECT command_id FROM app_billing_deletion_refund_inventory(r.id))
    )
  )
  SELECT a.id FROM app_billing_accounts a JOIN apps app ON app.id=a.app_id CROSS JOIN r WHERE app.organization_id=r.organization_id
  UNION SELECT m.billing_account_id FROM app_billing_members m CROSS JOIN r WHERE m.user_id=r.user_id AND m.revoked_at IS NULL
  UNION SELECT a.id FROM app_billing_accounts a JOIN billing_identity_subjects identity ON identity.eligibility_principal_id=a.eligibility_principal_id CROSS JOIN r WHERE identity.id=r.user_id OR identity.live_user_id=r.user_id
  UNION SELECT s.billing_account_id FROM app_billing_scopes s JOIN commands c ON s.id=c.billing_scope_id OR s.id::text=c.request_payload->'source'->'scope'->>'scopeId'
  UNION SELECT s.billing_account_id FROM app_billing_scopes s JOIN app_subscription_paid_periods paid ON paid.billing_scope_id=s.id JOIN commands c ON paid.id::text=c.request_payload->'source'->>'paidPeriodId'
  UNION SELECT s.billing_account_id FROM app_billing_scopes s JOIN billing_subscriptions sub ON sub.billing_scope_id=s.id JOIN commands c ON c.result_subscription_id=sub.id
  UNION SELECT a.id FROM app_billing_accounts a JOIN commands c ON a.id::text=c.request_payload->>'billingAccountId' OR a.id::text=c.request_payload->'source'->'scope'->>'billingAccountId'
  UNION SELECT customer.billing_account_id FROM app_billing_customers customer JOIN commands c ON customer.id::text=c.request_payload->>'customerBindingId'
  UNION SELECT s.billing_account_id FROM app_billing_scopes s JOIN app_billing_deletion_dispositions decision ON decision.scope_id=s.id WHERE decision.request_id=p_request
  UNION SELECT customer.billing_account_id FROM app_billing_customers customer JOIN app_billing_customer_closures closure ON closure.customer_binding_id=customer.id WHERE closure.initiating_request_id=p_request;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_billing_deletion_completion_apps(p_request uuid) RETURNS TABLE(app_id uuid) LANGUAGE sql STABLE AS $$
  SELECT a.app_id FROM app_billing_accounts a JOIN app_billing_deletion_completion_accounts(p_request) inventory ON inventory.account_id=a.id
  UNION SELECT app.id FROM apps app JOIN account_deletion_requests r ON r.organization_id=app.organization_id WHERE r.id=p_request
  UNION SELECT c.app_id FROM billing_subscription_commands c JOIN account_deletion_requests r ON r.id=p_request WHERE c.app_id IS NOT NULL AND (c.organization_id=r.organization_id OR c.requested_by_user_id=r.user_id OR c.request_payload->>'requestId'=r.id::text);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lock_app_billing_deletion_completion(p_request uuid,p_phase uuid,p_generation bigint) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE observed record; current_request record; current_phase record; accounts uuid[]; applications uuid[]; owners uuid[]; actors uuid[]; refreshed uuid[];
BEGIN
  SELECT * INTO observed FROM account_deletion_requests WHERE id=p_request;
  IF observed.id IS NULL OR observed.user_id IS NULL OR observed.organization_id IS NULL OR observed.status IS DISTINCT FROM 'processing' THEN RETURN false; END IF;
  SELECT COALESCE(array_agg(account_id ORDER BY account_id),'{}'::uuid[]) INTO accounts FROM app_billing_deletion_completion_accounts(p_request);
  SELECT COALESCE(array_agg(app_id ORDER BY app_id),'{}'::uuid[]) INTO applications FROM app_billing_deletion_completion_apps(p_request);
  SELECT array_agg(id ORDER BY id) INTO owners FROM (SELECT observed.organization_id AS id UNION SELECT organization_id FROM apps WHERE id=ANY(applications)) owner_set;
  PERFORM id FROM organizations WHERE id=ANY(owners) ORDER BY id FOR UPDATE;
  PERFORM id FROM apps WHERE id=ANY(applications) ORDER BY id FOR UPDATE;
  PERFORM id FROM app_billing_scopes WHERE billing_account_id=ANY(accounts) ORDER BY id FOR UPDATE;
  PERFORM id FROM app_billing_accounts WHERE id=ANY(accounts) ORDER BY id FOR UPDATE;
  PERFORM id FROM app_billing_customers WHERE billing_account_id=ANY(accounts) ORDER BY id FOR UPDATE;
  SELECT array_agg(id ORDER BY id) INTO actors FROM (SELECT observed.user_id AS id UNION SELECT user_id FROM app_billing_members WHERE billing_account_id=ANY(accounts) AND role='administrator') actor_set;
  PERFORM id FROM users WHERE id=ANY(actors) ORDER BY id FOR UPDATE;
  PERFORM id FROM app_billing_members WHERE billing_account_id=ANY(accounts) ORDER BY id FOR UPDATE;
  SELECT COALESCE(array_agg(account_id ORDER BY account_id),'{}'::uuid[]) INTO refreshed FROM app_billing_deletion_completion_accounts(p_request);
  IF refreshed IS DISTINCT FROM accounts THEN RAISE EXCEPTION 'Billing completion account inventory changed; retry from owners' USING ERRCODE='40001'; END IF;
  SELECT COALESCE(array_agg(app_id ORDER BY app_id),'{}'::uuid[]) INTO refreshed FROM app_billing_deletion_completion_apps(p_request);
  IF refreshed IS DISTINCT FROM applications OR EXISTS(SELECT 1 FROM apps WHERE id=ANY(applications) AND NOT(organization_id=ANY(owners))) OR EXISTS(SELECT 1 FROM app_billing_members WHERE billing_account_id=ANY(accounts) AND role='administrator' AND NOT(user_id=ANY(actors))) THEN RAISE EXCEPTION 'Billing completion owner inventory changed; retry from owners' USING ERRCODE='40001'; END IF;
  SELECT * INTO current_request FROM account_deletion_requests WHERE id=p_request FOR UPDATE;
  SELECT * INTO current_phase FROM account_deletion_phase_receipts WHERE id=p_phase AND request_id=p_request FOR UPDATE;
  RETURN COALESCE(current_request.user_id=observed.user_id AND current_request.organization_id=observed.organization_id AND current_request.request_digest=observed.request_digest AND current_request.lifecycle_revision=observed.lifecycle_revision
    AND current_request.status='processing' AND current_request.irreversible_at IS NOT NULL AND current_phase.phase='stripe' AND current_phase.lease_generation=p_generation
    AND current_phase.status IN('leased','calling','reconciling') AND isfinite(current_phase.lease_expires_at) AND (current_phase.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp()
    AND EXISTS(SELECT 1 FROM users u JOIN organizations org ON org.id=current_request.organization_id WHERE u.id=current_request.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=current_request.id AND u.account_lifecycle_revision=current_request.lifecycle_revision AND org.account_lifecycle_state='deletion_irreversible' AND org.account_deletion_request_id=current_request.id AND org.account_lifecycle_revision=current_request.lifecycle_revision),false);
END $$;
