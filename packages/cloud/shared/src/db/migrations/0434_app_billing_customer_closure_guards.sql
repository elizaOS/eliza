CREATE OR REPLACE FUNCTION require_app_billing_customer_closure(p_binding_id uuid, p_request_id uuid, p_request_digest text, p_lifecycle_revision bigint, p_phase_id uuid, p_phase_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b record; r record; p record; owner_id uuid; subject_id uuid;
BEGIN
  SELECT c.*,a.app_id,x.organization_id,m.stripe_account_id,m.provider_account_key,m.livemode INTO b FROM app_billing_customers c JOIN app_billing_accounts a ON a.id=c.billing_account_id JOIN apps x ON x.id=a.app_id JOIN billing_merchants m ON m.id=c.merchant_id AND m.organization_id=x.organization_id WHERE c.id=p_binding_id;
  SELECT d.organization_id,d.user_id INTO owner_id,subject_id FROM account_deletion_requests d WHERE d.id=p_request_id;
  IF b.id IS NULL OR owner_id IS NULL THEN RAISE EXCEPTION 'Customer closure source is unavailable'; END IF;
  PERFORM 1 FROM organizations o WHERE o.id IN (owner_id,b.organization_id) ORDER BY o.id FOR UPDATE;
  PERFORM 1 FROM app_billing_scopes s WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id ORDER BY s.id FOR UPDATE;
  PERFORM 1 FROM app_billing_accounts a WHERE a.id=b.billing_account_id FOR UPDATE;
  PERFORM 1 FROM app_billing_customers c WHERE c.id=p_binding_id FOR UPDATE;
  PERFORM 1 FROM users u WHERE u.id=subject_id FOR UPDATE;
  SELECT * INTO r FROM account_deletion_requests d WHERE d.id=p_request_id FOR SHARE;
  SELECT * INTO p FROM account_deletion_phase_receipts d WHERE d.id=p_phase_id AND d.request_id=p_request_id FOR SHARE;
  IF r.id IS NULL OR r.organization_id IS DISTINCT FROM owner_id OR r.user_id IS DISTINCT FROM subject_id OR p.id IS NULL OR r.status IS DISTINCT FROM 'processing' OR r.irreversible_at IS NULL OR r.request_digest IS DISTINCT FROM p_request_digest OR r.lifecycle_revision IS DISTINCT FROM p_lifecycle_revision OR p.phase IS DISTINCT FROM 'stripe' OR p.lease_generation IS DISTINCT FROM p_phase_generation OR p.status IS NULL OR p.status NOT IN ('leased','calling','reconciling') OR p.lease_expires_at IS NULL OR NOT isfinite(p.lease_expires_at) OR (p.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp() THEN RAISE EXCEPTION 'Customer closure requires current canonical deletion phase'; END IF;
  IF NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=r.organization_id WHERE u.id=r.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=r.id AND o.account_lifecycle_revision=r.lifecycle_revision) THEN RAISE EXCEPTION 'Customer closure requires irreversible canonical subject'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_billing_scopes s WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id) THEN RAISE EXCEPTION 'Customer closure requires a sharing scope'; END IF;
  IF EXISTS(SELECT 1 FROM app_billing_scopes s WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id AND (s.app_id IS DISTINCT FROM b.app_id OR s.organization_id IS DISTINCT FROM b.organization_id OR s.livemode IS DISTINCT FROM b.livemode OR s.fenced_at IS NULL OR NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=s.id AND d.request_id=r.id AND d.disposition='close' AND d.request_digest=r.request_digest AND d.lifecycle_revision=r.lifecycle_revision AND d.phase_receipt_id=p.id AND d.phase_generation<=p.lease_generation AND d.merchant_id=b.merchant_id AND d.provider_account_key=b.provider_account_key AND d.livemode=b.livemode))) THEN RAISE EXCEPTION 'Every sharing scope requires a canonical close decision for this request'; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_billing_customer_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Customer closure identity is immutable'; END IF;
  PERFORM require_app_billing_customer_closure(NEW.customer_binding_id,NEW.initiating_request_id,NEW.request_digest,NEW.lifecycle_revision,NEW.phase_receipt_id,NEW.phase_generation);
  SELECT c.*,a.app_id,m.provider_account_key,m.stripe_account_id,m.livemode INTO b FROM app_billing_customers c JOIN app_billing_accounts a ON a.id=c.billing_account_id JOIN billing_merchants m ON m.id=c.merchant_id WHERE c.id=NEW.customer_binding_id;
  IF (NEW.billing_account_id,NEW.app_id,NEW.merchant_id,NEW.provider_account_key,NEW.stripe_account_id,NEW.livemode,NEW.stripe_customer_id) IS DISTINCT FROM (b.billing_account_id,b.app_id,b.merchant_id,b.provider_account_key,b.stripe_account_id,b.livemode,b.stripe_customer_id) THEN RAISE EXCEPTION 'Customer closure provider identity mismatch'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_customer_closure_guard BEFORE INSERT OR UPDATE OR DELETE ON app_billing_customer_closures FOR EACH ROW EXECUTE FUNCTION guard_app_billing_customer_closure();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_closing_app_billing_customer_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid;
BEGIN
  SELECT a.organization_id INTO owner_id FROM apps a JOIN app_billing_accounts b ON b.app_id=a.id WHERE b.id=NEW.billing_account_id;
  PERFORM 1 FROM organizations o WHERE o.id=owner_id FOR UPDATE;
  PERFORM 1 FROM app_billing_accounts b WHERE b.id=NEW.billing_account_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM app_billing_customer_closures c WHERE c.billing_account_id=NEW.billing_account_id AND c.merchant_id=NEW.merchant_id) THEN RAISE EXCEPTION 'Closed billing customer cannot admit a scope or reuse its binding'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_closing_customer_scope_admission BEFORE INSERT ON app_billing_scopes FOR EACH ROW EXECUTE FUNCTION guard_closing_app_billing_customer_admission();
--> statement-breakpoint
CREATE TRIGGER app_billing_closing_customer_binding_admission BEFORE INSERT ON app_billing_customers FOR EACH ROW EXECUTE FUNCTION guard_closing_app_billing_customer_admission();
--> statement-breakpoint
CREATE TRIGGER app_billing_customer_closure_truncate_guard BEFORE TRUNCATE ON app_billing_customer_closures FOR EACH STATEMENT EXECUTE FUNCTION guard_app_billing_customer_closure();
