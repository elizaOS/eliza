-- Evidence is useful only when validation and the exact phase completion commit together.
CREATE OR REPLACE FUNCTION guard_app_billing_completion_validation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p record;
BEGIN
  IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Billing completion evidence is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL OR (to_jsonb(NEW)-'completed_at') IS DISTINCT FROM (to_jsonb(OLD)-'completed_at') OR OLD.validation_xid IS DISTINCT FROM pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM account_deletion_phase_receipts phase WHERE phase.id=OLD.phase_receipt_id AND phase.request_id=OLD.request_id AND phase.lease_generation=OLD.phase_generation AND phase.phase='stripe' AND phase.status='completed' AND phase.provider_receipt_digest=OLD.provider_receipt_digest) THEN RAISE EXCEPTION 'Billing completion linkage requires its atomic phase transition'; END IF;
    NEW.completed_at:=clock_timestamp(); RETURN NEW;
  END IF;
  IF NEW.completed_at IS NOT NULL THEN RAISE EXCEPTION 'Billing validation cannot fabricate a completion'; END IF;
  IF NOT lock_app_billing_completion_validation(NEW.request_id,NEW.phase_receipt_id,NEW.phase_generation) THEN RAISE EXCEPTION 'Billing validation requires current deletion authority'; END IF;
  SELECT * INTO STRICT r FROM account_deletion_requests WHERE id=NEW.request_id;
  SELECT * INTO STRICT p FROM account_deletion_phase_receipts WHERE id=NEW.phase_receipt_id;
  NEW.request_digest:=r.request_digest; NEW.lifecycle_revision:=r.lifecycle_revision; NEW.phase_generation:=p.lease_generation;
  NEW.validation_xid:=pg_current_xact_id(); NEW.validated_at:=clock_timestamp();
  NEW.inventory_digest:=encode(sha256(convert_to(app_billing_completion_inventory(r.id)::text,'UTF8')),'hex');
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_completion_validation_guard BEFORE INSERT OR UPDATE OR DELETE ON app_billing_completion_validations FOR EACH ROW EXECUTE FUNCTION guard_app_billing_completion_validation();
--> statement-breakpoint
CREATE TRIGGER app_billing_completion_validation_truncate_guard BEFORE TRUNCATE ON app_billing_completion_validations FOR EACH STATEMENT EXECUTE FUNCTION guard_app_billing_completion_validation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_app_billing_completion_validation(p_request uuid,p_phase uuid,p_generation bigint,p_provider_digest text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE evidence_id uuid;
BEGIN
  IF NOT lock_app_billing_completion_validation(p_request,p_phase,p_generation) THEN RETURN NULL; END IF;
  INSERT INTO app_billing_completion_validations(request_id,phase_receipt_id,phase_generation,provider_receipt_digest) VALUES(p_request,p_phase,p_generation,p_provider_digest) RETURNING id INTO evidence_id;
  RETURN evidence_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_billing_validated_phase_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence record; r record;
BEGIN
  IF NEW.phase IS DISTINCT FROM 'stripe' OR NEW.status IS DISTINCT FROM 'completed' THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN RAISE EXCEPTION 'Stripe completion requires an existing phase and same-transaction billing validation'; END IF;
  SELECT * INTO evidence FROM app_billing_completion_validations WHERE phase_receipt_id=OLD.id AND validation_xid=pg_current_xact_id();
  SELECT * INTO r FROM account_deletion_requests WHERE id=OLD.request_id;
  IF evidence.id IS NULL OR evidence.completed_at IS NOT NULL OR evidence.request_id IS DISTINCT FROM OLD.request_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR evidence.phase_generation IS DISTINCT FROM OLD.lease_generation OR NEW.lease_generation IS DISTINCT FROM OLD.lease_generation OR evidence.provider_receipt_digest IS DISTINCT FROM NEW.provider_receipt_digest OR evidence.request_digest IS DISTINCT FROM r.request_digest OR evidence.lifecycle_revision IS DISTINCT FROM r.lifecycle_revision THEN RAISE EXCEPTION 'Stripe completion requires exact same-transaction billing validation'; END IF;
  IF evidence.inventory_digest IS DISTINCT FROM encode(sha256(convert_to(app_billing_completion_inventory(r.id)::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'Billing obligations changed after validation'; END IF;
  IF NOT COALESCE(OLD.phase='stripe' AND OLD.status IN('leased','calling','reconciling') AND isfinite(OLD.lease_expires_at) AND (OLD.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp(),false) THEN RAISE EXCEPTION 'Billing completion lease expired after validation'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER zz_app_billing_validated_phase_completion_guard BEFORE INSERT OR UPDATE ON account_deletion_phase_receipts FOR EACH ROW EXECUTE FUNCTION guard_app_billing_validated_phase_completion();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION retain_app_billing_phase_completion_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phase='stripe' AND NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    UPDATE app_billing_completion_validations SET completed_at=clock_timestamp() WHERE phase_receipt_id=NEW.id AND validation_xid=pg_current_xact_id();
    IF NOT FOUND THEN RAISE EXCEPTION 'Billing phase completion linkage is missing'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_phase_completion_link AFTER UPDATE ON account_deletion_phase_receipts FOR EACH ROW EXECUTE FUNCTION retain_app_billing_phase_completion_link();
