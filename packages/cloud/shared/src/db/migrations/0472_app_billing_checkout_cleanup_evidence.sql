-- Only the existing execution and canonical deletion phase may accept a new retained Checkout observation.
CREATE OR REPLACE FUNCTION guard_app_billing_checkout_cleanup_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jsonb:=NEW.provider_result->'checkoutEvidence'; r record; p record; source record; sc record; decision record;
BEGIN
  IF e IS NOT NULL AND NOT COALESCE(NEW.kind='expire_checkout' AND NEW.request_payload->>'domain'='account_deletion' AND NEW.request_payload->>'action'='expire_checkout' AND NEW.status='SUCCEEDED',false)
    THEN RAISE EXCEPTION 'Checkout evidence requires its original succeeded cleanup command'; END IF;
  IF NEW.request_payload->>'domain' IS DISTINCT FROM 'account_deletion' OR NEW.request_payload->>'action' IS DISTINCT FROM 'expire_checkout' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.status='SUCCEEDED' THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Checkout cleanup completion is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM 'SUCCEEDED' THEN RETURN NEW; END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Checkout evidence requires an existing execution lease'; END IF;
  SELECT * INTO source FROM billing_subscription_commands WHERE id::text=NEW.request_payload->>'sourceCommandId';
  SELECT * INTO r FROM account_deletion_requests WHERE id::text=NEW.request_payload->>'requestId' FOR SHARE;
  SELECT * INTO p FROM account_deletion_phase_receipts WHERE id::text=NEW.request_payload->>'phaseReceiptId' AND request_id=r.id FOR SHARE;
  SELECT * INTO sc FROM app_billing_scopes WHERE id=NEW.billing_scope_id;
  IF NOT COALESCE(OLD.status='OUTCOME_UNKNOWN' AND OLD.provider_result IS NULL
    AND OLD.lease_token IS NOT NULL AND isfinite(OLD.lease_expires_at) AND OLD.lease_expires_at>clock_timestamp()
    AND e->>'leaseToken'=OLD.lease_token::text AND (e->>'commandRevision')::bigint=OLD.state_revision
    AND (e->>'executionGeneration')::bigint=OLD.execution_generation AND NEW.execution_generation=OLD.execution_generation
    AND (e->>'sourceRevision')::bigint=source.state_revision AND NEW.provider_started_at=OLD.provider_started_at
    AND app_billing_checkout_cleanup_receipt_valid(NEW)
    AND r.user_id=source.requested_by_user_id AND r.status='processing' AND r.irreversible_at IS NOT NULL
    AND r.request_digest=NEW.request_payload->>'requestDigest' AND r.lifecycle_revision=(NEW.request_payload->>'lifecycleRevision')::bigint
    AND p.phase='stripe' AND p.status IN('leased','calling','reconciling') AND p.lease_generation=(e->>'phaseGeneration')::bigint
    AND p.lease_generation>=(NEW.request_payload->>'initiatingPhaseGeneration')::bigint
    AND isfinite(p.lease_expires_at) AND (p.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp()
    AND EXISTS(SELECT 1 FROM users u JOIN organizations org ON org.id=r.organization_id WHERE u.id=r.user_id
      AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision
      AND org.account_lifecycle_state='deletion_irreversible' AND org.account_deletion_request_id=r.id AND org.account_lifecycle_revision=r.lifecycle_revision),false)
    THEN RAISE EXCEPTION 'Checkout cleanup requires retained observation and current source execution authority'; END IF;
  IF NEW.provider_result->>'kind'='completed_checkout' THEN
    SELECT * INTO decision FROM app_billing_deletion_dispositions WHERE request_id=r.id AND scope_id=sc.id;
    IF NOT COALESCE(decision.request_digest=r.request_digest AND decision.lifecycle_revision=r.lifecycle_revision
      AND decision.phase_receipt_id=p.id AND decision.phase_generation=p.lease_generation AND decision.merchant_id=NEW.merchant_id
      AND decision.provider_account_key=NEW.merchant_key AND decision.livemode=NEW.livemode
      AND ((decision.disposition='close' AND sc.fenced_at IS NOT NULL) OR (decision.disposition='retain_shared' AND sc.organization_id<>r.organization_id
        AND NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=sc.id AND d.disposition='close')
        AND EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id
          AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode) AND u.id<>r.user_id
          AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL
          AND (u.expires_at IS NULL OR (isfinite(u.expires_at) AND (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp()))))),false)
      THEN RAISE EXCEPTION 'Completed Checkout cleanup requires current disposition and survivor proof'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_checkout_cleanup_evidence_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_app_billing_checkout_cleanup_evidence();
