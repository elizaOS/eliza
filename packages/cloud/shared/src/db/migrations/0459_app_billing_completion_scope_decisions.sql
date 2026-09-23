-- Completion revalidates required scope decisions without giving observers billing authority.
CREATE OR REPLACE FUNCTION guard_app_billing_completion_scope_decisions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; scope record; decision record; merchant record;
BEGIN
  IF NEW.phase IS DISTINCT FROM 'stripe' OR NEW.status IS DISTINCT FROM 'completed' THEN RETURN NEW; END IF;
  SELECT * INTO r FROM account_deletion_requests WHERE id=NEW.request_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Billing completion requires canonical request'; END IF;
  FOR scope IN
    SELECT s.* FROM app_billing_scopes s
    JOIN app_billing_deletion_completion_accounts(r.id) inventory ON inventory.account_id=s.billing_account_id
    WHERE s.organization_id=r.organization_id
      OR EXISTS(SELECT 1 FROM app_billing_members m WHERE m.billing_account_id=s.billing_account_id AND m.app_id=s.app_id AND m.user_id=r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=s.livemode))
      OR EXISTS(SELECT 1 FROM billing_subscription_commands c WHERE c.billing_scope_id=s.id AND c.requested_by_user_id=r.user_id AND c.request_payload->>'domain'='buyer')
      OR EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=s.id AND d.request_id=r.id)
    ORDER BY s.id
  LOOP
    SELECT * INTO decision FROM app_billing_deletion_dispositions WHERE request_id=r.id AND scope_id=scope.id;
    SELECT * INTO merchant FROM billing_merchants WHERE id=scope.merchant_id;
    IF decision.scope_id IS NULL OR merchant.id IS NULL OR decision.request_digest IS DISTINCT FROM r.request_digest OR decision.lifecycle_revision IS DISTINCT FROM r.lifecycle_revision OR decision.phase_receipt_id IS DISTINCT FROM NEW.id OR decision.phase_generation>NEW.lease_generation OR decision.merchant_id IS DISTINCT FROM scope.merchant_id OR decision.provider_account_key IS DISTINCT FROM merchant.provider_account_key OR decision.livemode IS DISTINCT FROM scope.livemode THEN
      RAISE EXCEPTION 'Billing completion requires every canonical scope decision';
    END IF;
    IF decision.disposition='close' THEN
      IF scope.fenced_at IS NULL THEN RAISE EXCEPTION 'Billing completion cannot accept an unfenced close decision'; END IF;
      -- The existing provider-completion guard still rejects close until full terminal proof is available.
    ELSIF decision.disposition='retain_shared' THEN
      IF scope.organization_id=r.organization_id OR EXISTS(SELECT 1 FROM app_billing_deletion_dispositions prior WHERE prior.scope_id=scope.id AND prior.disposition='close') THEN RAISE EXCEPTION 'Billing completion cannot retain a closing scope'; END IF;
      IF NOT EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=scope.billing_account_id AND m.app_id=scope.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=scope.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (isfinite(u.expires_at) AND (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp()))) THEN
        RAISE EXCEPTION 'Billing completion requires an eligible surviving administrator';
      END IF;
    ELSE
      RAISE EXCEPTION 'Billing completion has an unsupported scope decision';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_completion_scope_decisions_guard BEFORE INSERT OR UPDATE ON account_deletion_phase_receipts FOR EACH ROW EXECUTE FUNCTION guard_app_billing_completion_scope_decisions();
