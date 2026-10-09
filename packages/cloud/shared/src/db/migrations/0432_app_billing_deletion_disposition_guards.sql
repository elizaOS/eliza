-- A scope decision is not provider-completion or physical-erasure evidence.
-- These guards complement the repository transaction; writers must acquire its canonical owner/scope/user/request/phase locks.
CREATE OR REPLACE FUNCTION guard_app_billing_deletion_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p record; sc record; merchant record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Billing deletion disposition history is immutable'; END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(OLD)-ARRAY['disposition','phase_generation','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['disposition','phase_generation','updated_at']) OR NEW.phase_generation<OLD.phase_generation OR (OLD.disposition='close' AND NEW.disposition<>'close')) THEN RAISE EXCEPTION 'Billing deletion disposition cannot reopen or change identity'; END IF;
  SELECT * INTO r FROM account_deletion_requests WHERE id=NEW.request_id;
  SELECT * INTO p FROM account_deletion_phase_receipts WHERE id=NEW.phase_receipt_id AND request_id=NEW.request_id;
  SELECT * INTO sc FROM app_billing_scopes WHERE id=NEW.scope_id;
  SELECT * INTO merchant FROM billing_merchants WHERE id=sc.merchant_id;
  IF r.id IS NULL OR p.id IS NULL OR sc.id IS NULL OR merchant.id IS NULL OR r.status<>'processing' OR r.irreversible_at IS NULL OR r.request_digest IS DISTINCT FROM NEW.request_digest OR r.lifecycle_revision IS DISTINCT FROM NEW.lifecycle_revision OR p.phase<>'stripe' OR p.lease_generation IS DISTINCT FROM NEW.phase_generation OR p.status NOT IN ('leased','calling','reconciling') OR p.lease_expires_at IS NULL OR NOT isfinite(p.lease_expires_at) OR (p.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp() THEN RAISE EXCEPTION 'Billing disposition requires current canonical deletion phase'; END IF;
  IF NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=r.organization_id WHERE u.id=r.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=r.id AND o.account_lifecycle_revision=r.lifecycle_revision) THEN RAISE EXCEPTION 'Billing disposition requires irreversible canonical subject'; END IF;
  IF (NEW.merchant_id,NEW.provider_account_key,NEW.livemode) IS DISTINCT FROM (sc.merchant_id,merchant.provider_account_key,sc.livemode) THEN RAISE EXCEPTION 'Billing deletion merchant scope mismatch'; END IF;
  IF r.organization_id IS DISTINCT FROM sc.organization_id AND NOT EXISTS(SELECT 1 FROM app_billing_members m WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id AND m.user_id=r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode)) THEN RAISE EXCEPTION 'Billing deletion subject does not administer scope'; END IF;
  IF NEW.disposition='close' AND sc.fenced_at IS NULL THEN RAISE EXCEPTION 'Closing billing scope must be fenced'; END IF;
  IF NEW.disposition='close' AND r.organization_id IS DISTINCT FROM sc.organization_id AND NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=NEW.scope_id AND d.disposition='close') AND EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp())) THEN RAISE EXCEPTION 'Surviving administrator requires shared retention'; END IF;
  IF NEW.disposition='retain_shared' AND (r.organization_id=sc.organization_id OR NOT EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp()))) THEN RAISE EXCEPTION 'Shared retention requires a current surviving administrator'; END IF;
  IF NEW.disposition='retain_shared' AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=NEW.scope_id AND d.disposition='close') THEN RAISE EXCEPTION 'Closing billing scope cannot reopen'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_deletion_disposition_guard BEFORE INSERT OR UPDATE OR DELETE ON app_billing_deletion_dispositions FOR EACH ROW EXECUTE FUNCTION guard_app_billing_deletion_disposition();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_closed_app_billing_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fenced_at IS NULL AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=OLD.id AND d.disposition='close') THEN RAISE EXCEPTION 'Canonical deletion closed scope cannot reopen'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_deletion_scope_fence BEFORE UPDATE ON app_billing_scopes FOR EACH ROW EXECUTE FUNCTION guard_closed_app_billing_scope();
