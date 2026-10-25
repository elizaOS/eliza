-- Validation locks only its captured inventory; newly discovered owners force an outer retry.
CREATE OR REPLACE FUNCTION lock_app_billing_completion_validation(p_request uuid,p_phase uuid,p_generation bigint) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE initial jsonb; refreshed jsonb; tab text; keys text[]; r record; p record;
BEGIN
  initial:=app_billing_completion_inventory(p_request);
  FOREACH tab IN ARRAY ARRAY['organizations','apps','app_billing_scopes','app_billing_accounts','app_billing_customers','users','app_billing_members','account_deletion_requests'] LOOP
    SELECT COALESCE(array_agg(item->>'identity' ORDER BY item->>'identity'),'{}'::text[]) INTO keys FROM jsonb_array_elements(initial) item WHERE item->>'relation'=tab;
    EXECUTE format('SELECT id FROM %I WHERE id::text=ANY($1) ORDER BY id FOR UPDATE',tab) USING keys;
  END LOOP;
  SELECT * INTO r FROM account_deletion_requests WHERE id=p_request;
  SELECT * INTO p FROM account_deletion_phase_receipts WHERE id=p_phase AND request_id=p_request FOR UPDATE;
  FOREACH tab IN ARRAY ARRAY['billing_merchants','app_billing_plan_revisions','billing_subscriptions','billing_subscription_commands','billing_funding_reservations'] LOOP
    SELECT COALESCE(array_agg(item->>'identity' ORDER BY item->>'identity'),'{}'::text[]) INTO keys FROM jsonb_array_elements(initial) item WHERE item->>'relation'=tab;
    EXECUTE format('SELECT id FROM %I WHERE id::text=ANY($1) ORDER BY id FOR UPDATE',tab) USING keys;
  END LOOP;
  refreshed:=app_billing_completion_inventory(p_request);
  IF (SELECT jsonb_agg(item- 'value' ORDER BY item->>'relation',item->>'identity') FROM jsonb_array_elements(initial) item) IS DISTINCT FROM (SELECT jsonb_agg(item- 'value' ORDER BY item->>'relation',item->>'identity') FROM jsonb_array_elements(refreshed) item) THEN RAISE EXCEPTION 'Billing validation obligation inventory changed; retry from owners' USING ERRCODE='40001'; END IF;
  RETURN COALESCE(r.status='processing' AND r.irreversible_at IS NOT NULL AND p.phase='stripe' AND p.lease_generation=p_generation
    AND p.status IN('leased','calling','reconciling') AND isfinite(p.lease_expires_at) AND (p.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp()
    AND EXISTS(SELECT 1 FROM users u JOIN organizations org ON org.id=r.organization_id WHERE u.id=r.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision AND org.account_lifecycle_state='deletion_irreversible' AND org.account_deletion_request_id=r.id AND org.account_lifecycle_revision=r.lifecycle_revision),false);
END $$;
