-- Budget grants hold funds in the existing reservation ledger. Request receipts
-- consume those holds; closing a durably sealed grant settles its aggregate once.
CREATE TABLE inference_funding_budget_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  funding_reservation_id uuid NOT NULL,
  request_digest text NOT NULL,
  policy_generation text NOT NULL,
  policy_epoch text NOT NULL,
  amount numeric(16,6) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  seal_sequence integer,
  seal_amount numeric(16,6),
  seal_signature text,
  CONSTRAINT inference_funding_budget_grants_reservation_tenant_fk FOREIGN KEY (funding_reservation_id,organization_id) REFERENCES billing_funding_reservations(id,organization_id) ON DELETE RESTRICT,
  CONSTRAINT inference_funding_budget_grants_shape CHECK (amount > 0 AND request_digest ~ '^[0-9a-f]{64}$' AND policy_generation ~ '^(0|[1-9][0-9]*)$' AND policy_epoch ~ '^(0|[1-9][0-9]*)$' AND expires_at > created_at AND
    ((closed_at IS NULL AND seal_sequence IS NULL AND seal_amount IS NULL AND seal_signature IS NULL) OR
     (closed_at IS NOT NULL AND seal_sequence >= 0 AND seal_amount >= 0 AND seal_amount <= amount AND seal_signature ~ '^[0-9a-f]{64}$')))
);
CREATE UNIQUE INDEX inference_funding_budget_grants_id_org_idx ON inference_funding_budget_grants(id,organization_id);
CREATE UNIQUE INDEX inference_funding_budget_grants_reservation_idx ON inference_funding_budget_grants(funding_reservation_id);
--> statement-breakpoint
CREATE TABLE inference_funding_budget_receipts (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  request_digest text NOT NULL,
  amount numeric(16,6) NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inference_funding_budget_receipts_shape CHECK (length(request_id) BETWEEN 1 AND 128 AND request_digest ~ '^[0-9a-f]{64}$' AND amount >= 0)
);
CREATE UNIQUE INDEX inference_funding_budget_receipts_org_request_idx ON inference_funding_budget_receipts(organization_id,request_id);
CREATE TABLE inference_funding_budget_consumptions (
  organization_id uuid NOT NULL,
  request_id text NOT NULL,
  grant_id uuid NOT NULL,
  sequence integer NOT NULL,
  amount numeric(16,6) NOT NULL,
  CONSTRAINT inference_funding_budget_consumptions_grant_tenant_fk FOREIGN KEY (grant_id,organization_id) REFERENCES inference_funding_budget_grants(id,organization_id) ON DELETE RESTRICT,
  CONSTRAINT inference_funding_budget_consumptions_receipt_tenant_fk FOREIGN KEY (organization_id,request_id) REFERENCES inference_funding_budget_receipts(organization_id,request_id) ON DELETE RESTRICT,
  CONSTRAINT inference_funding_budget_consumptions_shape CHECK (sequence > 0 AND amount > 0)
);
CREATE UNIQUE INDEX inference_funding_budget_consumptions_sequence_idx ON inference_funding_budget_consumptions(grant_id,sequence);
CREATE UNIQUE INDEX inference_funding_budget_consumptions_request_idx ON inference_funding_budget_consumptions(organization_id,request_id,grant_id);
--> statement-breakpoint
CREATE FUNCTION guard_inference_funding_budget_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE backing record; consumed numeric; n bigint; last_seq integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.closed_at IS NOT NULL OR
    ROW(NEW.id,NEW.organization_id,NEW.funding_reservation_id,NEW.request_digest,NEW.policy_generation,NEW.policy_epoch,NEW.amount,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.funding_reservation_id,OLD.request_digest,OLD.policy_generation,OLD.policy_epoch,OLD.amount,OLD.expires_at,OLD.created_at)) THEN
    RAISE EXCEPTION 'Budget grant identity and closed result are immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO backing FROM billing_funding_reservations WHERE id=NEW.funding_reservation_id AND organization_id=NEW.organization_id;
  IF backing.id IS NULL OR backing.logical_operation_id <> 'inference-budget:' || NEW.id::text OR backing.funding_class <> 'allowance_eligible' OR backing.billing_scope_id IS NOT NULL OR backing.merchant_key <> 'platform' OR backing.requested_amount <> NEW.amount OR backing.expires_at <> NEW.expires_at THEN
    RAISE EXCEPTION 'Budget grant must match its canonical funding reservation' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND (backing.status <> 'reserved' OR NEW.closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'New budget grant requires an open funding reservation' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    SELECT COALESCE(sum(amount),0),count(*),COALESCE(max(sequence),0) INTO consumed,n,last_seq FROM inference_funding_budget_consumptions WHERE grant_id=NEW.id;
    IF NEW.closed_at IS NULL OR NEW.seal_amount IS DISTINCT FROM consumed OR NEW.seal_sequence IS DISTINCT FROM last_seq OR n <> last_seq OR backing.status <> 'finalized' OR
      consumed <> (SELECT COALESCE(sum(finalized_amount),0) FROM billing_funding_allocations WHERE reservation_id=backing.id AND organization_id=NEW.organization_id) THEN
      RAISE EXCEPTION 'Budget close requires its complete consumed watermark and finalized backing' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inference_funding_budget_grants_guard BEFORE INSERT OR UPDATE ON inference_funding_budget_grants FOR EACH ROW EXECUTE FUNCTION guard_inference_funding_budget_grant();
CREATE TRIGGER inference_funding_budget_grants_retained BEFORE DELETE OR TRUNCATE ON inference_funding_budget_grants FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_inference_funding_budget_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE budget record; consumed numeric;
BEGIN
  SELECT * INTO budget FROM inference_funding_budget_grants WHERE id=NEW.grant_id AND organization_id=NEW.organization_id FOR UPDATE;
  IF budget.id IS NULL OR budget.closed_at IS NOT NULL THEN RAISE EXCEPTION 'Budget grant is not open' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum(amount),0) INTO consumed FROM inference_funding_budget_consumptions WHERE grant_id=NEW.grant_id;
  IF consumed + NEW.amount > budget.amount THEN RAISE EXCEPTION 'Budget consumption exceeds its reserved funds' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inference_funding_budget_consumptions_guard BEFORE INSERT ON inference_funding_budget_consumptions FOR EACH ROW EXECUTE FUNCTION guard_inference_funding_budget_consumption();
CREATE TRIGGER inference_funding_budget_consumptions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON inference_funding_budget_consumptions FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
CREATE TRIGGER inference_funding_budget_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON inference_funding_budget_receipts FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
--> statement-breakpoint
CREATE FUNCTION validate_inference_funding_budget_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; consumed numeric;
BEGIN
  SELECT amount INTO expected FROM inference_funding_budget_receipts WHERE organization_id=NEW.organization_id AND request_id=NEW.request_id;
  SELECT COALESCE(sum(amount),0) INTO consumed FROM inference_funding_budget_consumptions WHERE organization_id=NEW.organization_id AND request_id=NEW.request_id;
  IF expected IS NULL OR expected <> consumed THEN RAISE EXCEPTION 'Budget receipt must conserve its grant allocations' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inference_funding_budget_receipt_conservation AFTER INSERT ON inference_funding_budget_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inference_funding_budget_receipt();
CREATE CONSTRAINT TRIGGER inference_funding_budget_consumption_conservation AFTER INSERT ON inference_funding_budget_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inference_funding_budget_receipt();

--> statement-breakpoint
-- A generic stale-hold cancellation must never return funds still owned by a DO.
CREATE FUNCTION guard_inference_budget_backing_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE budget_id uuid;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT id INTO budget_id FROM inference_funding_budget_grants WHERE funding_reservation_id=OLD.id AND closed_at IS NULL;
    IF budget_id IS NOT NULL AND current_setting('eliza.inference_budget_close',true) IS DISTINCT FROM budget_id::text THEN
      RAISE EXCEPTION 'Open inference budget requires its verified durable close' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inference_budget_backing_terminal_guard BEFORE UPDATE ON billing_funding_reservations FOR EACH ROW EXECUTE FUNCTION guard_inference_budget_backing_terminal();
