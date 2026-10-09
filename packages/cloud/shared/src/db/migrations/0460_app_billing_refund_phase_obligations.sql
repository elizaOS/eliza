-- Refund recovery evidence is required in addition to the existing scope completion guard.
CREATE OR REPLACE FUNCTION app_billing_deletion_refund_inventory(p_request uuid) RETURNS TABLE(command_id uuid) LANGUAGE sql STABLE AS $$
  SELECT c.id FROM billing_subscription_commands c CROSS JOIN account_deletion_requests r
  WHERE r.id=p_request AND (c.app_id IS NOT NULL OR c.request_payload->>'domain'='admin')
    AND (c.kind='refund' OR c.request_payload->>'action'='refund') AND (
      c.organization_id=r.organization_id OR c.requested_by_user_id=r.user_id OR
      EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.request_id=r.id AND d.disposition='close' AND (
        d.scope_id=c.billing_scope_id OR d.scope_id::text=c.request_payload->'source'->'scope'->>'scopeId' OR
        EXISTS(SELECT 1 FROM app_subscription_paid_periods paid WHERE paid.billing_scope_id=d.scope_id AND paid.id::text=c.request_payload->'source'->>'paidPeriodId')
      ))
    ) ORDER BY c.id;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_billing_refund_is_terminal(p_command uuid,p_request uuid,p_digest text,p_revision bigint,p_phase uuid,p_generation bigint) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(c.kind='refund' AND c.request_payload->>'domain'='admin' AND c.request_payload->>'action'='refund' AND (
    (c.status='SUPERSEDED' AND c.execution_generation=0 AND c.provider_started_at IS NULL AND c.provider_result IS NULL AND c.provider_response_digest IS NULL AND c.lease_token IS NULL AND c.lease_expires_at IS NULL AND c.completed_at IS NOT NULL) OR
    (c.status='SUCCEEDED' AND c.provider_started_at IS NOT NULL AND (c.lease_expires_at IS NULL OR (isfinite(c.lease_expires_at) AND c.lease_expires_at<=clock_timestamp()))
      AND o.request_id=p_request AND o.request_digest=p_digest AND o.lifecycle_revision=p_revision AND o.phase_receipt_id=p_phase AND o.phase_generation=p_generation
      AND o.execution_generation=c.execution_generation AND c.state_revision=o.command_revision+CASE WHEN o.discovery IS NULL THEN 0 ELSE 1 END
      AND o.observation->'value'->>'status' IN('succeeded','failed','canceled')
      AND c.provider_result=jsonb_build_object('kind','refund','refundId',o.observation->'value'->>'refundId','chargeId',o.observation->'value'->>'chargeId','amountCents',o.observation->'value'->'amountCents','currency',o.observation->'value'->>'currency')
      AND (o.discovery IS NULL OR c.provider_response_digest=o.observation->>'digest'))
  ),false)
  FROM billing_subscription_commands c LEFT JOIN LATERAL (
    SELECT evidence.* FROM app_billing_refund_observations evidence WHERE evidence.command_id=c.id ORDER BY evidence.observation_sequence DESC LIMIT 1
  ) o ON true WHERE c.id=p_command;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_billing_refund_phase_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF NEW.phase IS DISTINCT FROM 'stripe' OR NEW.status IS DISTINCT FROM 'completed' THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN RAISE EXCEPTION 'Stripe completion requires an existing leased phase'; END IF;
  SELECT * INTO r FROM account_deletion_requests WHERE id=OLD.request_id;
  IF NOT COALESCE(OLD.phase='stripe' AND NEW.request_id=OLD.request_id AND NEW.lease_generation=OLD.lease_generation
    AND OLD.status IN('leased','calling','reconciling') AND isfinite(OLD.lease_expires_at) AND (OLD.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp()
    AND r.status='processing' AND r.irreversible_at IS NOT NULL AND EXISTS(
      SELECT 1 FROM users u JOIN organizations org ON org.id=r.organization_id WHERE u.id=r.user_id
        AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision
        AND org.account_lifecycle_state='deletion_irreversible' AND org.account_deletion_request_id=r.id AND org.account_lifecycle_revision=r.lifecycle_revision
    ),false) THEN RAISE EXCEPTION 'Refund completion requires current canonical deletion authority'; END IF;
  IF EXISTS(SELECT 1 FROM app_billing_deletion_refund_inventory(r.id) inventory WHERE NOT COALESCE(
    app_billing_refund_is_terminal(inventory.command_id,r.id,r.request_digest,r.lifecycle_revision,OLD.id,OLD.lease_generation),false
  )) THEN RAISE EXCEPTION 'Unsettled app refund prevents Stripe phase completion'; END IF;
  IF (OLD.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp() THEN RAISE EXCEPTION 'Refund completion lease expired during validation'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_refund_phase_completion_guard BEFORE INSERT OR UPDATE ON account_deletion_phase_receipts FOR EACH ROW EXECUTE FUNCTION guard_app_billing_refund_phase_completion();
