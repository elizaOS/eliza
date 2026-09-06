-- A scope decision is not provider-completion or physical-erasure evidence.
-- These guards complement the repository transaction; writers must acquire its canonical owner/scope/user/request/phase locks.
CREATE OR REPLACE FUNCTION guard_app_billing_deletion_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p record; sc record; merchant record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Billing deletion disposition history is immutable'; END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(OLD)-ARRAY['disposition','phase_generation','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['disposition','phase_generation','updated_at']) OR NEW.phase_generation<OLD.phase_generation OR (OLD.disposition='close' AND NEW.disposition<>'close')) THEN RAISE EXCEPTION 'Billing deletion disposition cannot reopen or change identity'; END IF;
  SELECT * INTO r FROM account_deletion_requests WHERE id=NEW.request_id;
  SELECT * INTO p FROM account_deletion_phase_receipts WHERE id=NEW.phase_receipt_id AND request_id=NEW.request_id FOR SHARE;
  SELECT * INTO sc FROM app_billing_scopes WHERE id=NEW.scope_id;
  SELECT * INTO merchant FROM billing_merchants WHERE id=sc.merchant_id;
  IF r.id IS NULL OR p.id IS NULL OR sc.id IS NULL OR merchant.id IS NULL OR r.status<>'processing' OR r.irreversible_at IS NULL OR r.request_digest IS DISTINCT FROM NEW.request_digest OR r.lifecycle_revision IS DISTINCT FROM NEW.lifecycle_revision OR p.phase<>'stripe' OR p.lease_generation IS DISTINCT FROM NEW.phase_generation OR p.status NOT IN ('leased','calling','reconciling') OR p.lease_expires_at IS NULL OR NOT isfinite(p.lease_expires_at) OR (p.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp() THEN RAISE EXCEPTION 'Billing disposition requires current canonical deletion phase'; END IF;
  IF NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=r.organization_id WHERE u.id=r.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=r.id AND o.account_lifecycle_revision=r.lifecycle_revision) THEN RAISE EXCEPTION 'Billing disposition requires irreversible canonical subject'; END IF;
  IF (NEW.merchant_id,NEW.provider_account_key,NEW.livemode) IS DISTINCT FROM (sc.merchant_id,merchant.provider_account_key,sc.livemode) THEN RAISE EXCEPTION 'Billing deletion merchant scope mismatch'; END IF;
  IF r.organization_id IS DISTINCT FROM sc.organization_id AND NOT EXISTS(SELECT 1 FROM app_billing_members m WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id AND m.user_id=r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode)) AND NOT ((NEW.disposition='retain_shared' AND EXISTS(SELECT 1 FROM billing_subscription_commands c WHERE c.billing_scope_id=sc.id AND c.requested_by_user_id=r.user_id AND c.request_payload->>'domain'='buyer')) OR (NEW.disposition='close' AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions prior WHERE prior.request_id=NEW.request_id AND prior.scope_id=NEW.scope_id AND prior.disposition='close'))) THEN RAISE EXCEPTION 'Billing deletion subject does not administer scope'; END IF;
  IF NEW.disposition='close' AND sc.fenced_at IS NULL THEN RAISE EXCEPTION 'Closing billing scope must be fenced'; END IF;
  IF NEW.disposition='close' AND r.organization_id IS DISTINCT FROM sc.organization_id AND NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=NEW.scope_id AND d.disposition='close') AND EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp())) THEN RAISE EXCEPTION 'Surviving administrator requires shared retention'; END IF;
  IF NEW.disposition='retain_shared' AND (r.organization_id=sc.organization_id OR NOT EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp()))) THEN RAISE EXCEPTION 'Shared retention requires a current surviving administrator'; END IF;
  IF NEW.disposition='retain_shared' AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=NEW.scope_id AND d.disposition='close') THEN RAISE EXCEPTION 'Closing billing scope cannot reopen'; END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_billing_deletion_phase_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phase='stripe' AND NEW.status='completed' AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.request_id=NEW.request_id AND d.disposition='close') THEN RAISE EXCEPTION 'Closing app billing scope requires provider cleanup before phase completion'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_deletion_phase_completion_guard BEFORE INSERT OR UPDATE ON account_deletion_phase_receipts FOR EACH ROW EXECUTE FUNCTION guard_app_billing_deletion_phase_completion();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_billing_completed_checkout() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; r record; d record;
BEGIN
  IF NEW.provider_result->>'kind' IS DISTINCT FROM 'completed_checkout' THEN RETURN NEW; END IF;
  SELECT * INTO source FROM billing_subscription_commands WHERE id=(NEW.request_payload->>'sourceCommandId')::uuid;
  SELECT * INTO r FROM account_deletion_requests WHERE id=(NEW.request_payload->>'requestId')::uuid;
  SELECT * INTO d FROM app_billing_deletion_dispositions WHERE request_id=r.id AND scope_id=NEW.billing_scope_id;
  IF NOT COALESCE(NEW.request_payload->>'domain'='account_deletion' AND NEW.kind='expire_checkout' AND NEW.status='SUCCEEDED' AND source.status='APPLIED' AND source.result_subscription_revision IS NOT NULL AND source.result_subscription_id::text=NEW.provider_result->>'subscriptionId' AND source.result_subscription_revision::text=NEW.provider_result->>'subscriptionRevision' AND NEW.provider_result->>'checkoutSessionId'=source.provider_result->>'checkoutSessionId' AND source.applied_at IS NOT NULL AND d.scope_id IS NOT NULL AND d.phase_receipt_id::text=NEW.request_payload->>'phaseReceiptId' AND d.request_digest=NEW.request_payload->>'requestDigest',false) THEN RAISE EXCEPTION 'Completed cleanup requires canonical applied Checkout and disposition'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_completed_checkout_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_app_billing_completed_checkout();
