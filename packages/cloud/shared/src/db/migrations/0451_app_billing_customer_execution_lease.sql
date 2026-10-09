CREATE OR REPLACE FUNCTION require_app_billing_customer_terminal_obligations(p_binding_id uuid, p_request_id uuid, p_request_digest text, p_lifecycle_revision bigint, p_phase_id uuid, p_phase_generation bigint, p_command_id uuid, p_lease_token uuid, p_execution_generation bigint, p_state_revision bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE binding record; executing billing_subscription_commands%ROWTYPE;
BEGIN
  PERFORM require_app_billing_customer_closure(p_binding_id,p_request_id,p_request_digest,p_lifecycle_revision,p_phase_id,p_phase_generation);
  SELECT * INTO STRICT binding FROM app_billing_customers WHERE id=p_binding_id;
  IF NOT EXISTS(SELECT 1 FROM app_billing_customer_closures c WHERE c.customer_binding_id=p_binding_id
    AND c.billing_account_id=binding.billing_account_id AND c.merchant_id=binding.merchant_id
    AND c.stripe_customer_id=binding.stripe_customer_id)
    THEN RAISE EXCEPTION 'Customer deletion requires retained closure identity'; END IF;
  PERFORM b.id FROM billing_subscriptions b JOIN app_billing_scopes s ON s.id=b.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id ORDER BY b.id FOR UPDATE OF b;
  PERFORM c.id FROM billing_subscription_commands c JOIN app_billing_scopes s ON s.id=c.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id ORDER BY c.id FOR UPDATE OF c;
  PERFORM r.id FROM billing_funding_reservations r JOIN app_billing_scopes s ON s.id=r.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id ORDER BY r.id FOR UPDATE OF r;
  PERFORM require_app_billing_customer_closure(p_binding_id,p_request_id,p_request_digest,p_lifecycle_revision,p_phase_id,p_phase_generation);
  IF p_command_id IS NOT NULL THEN
    SELECT * INTO executing FROM billing_subscription_commands WHERE id=p_command_id;
    PERFORM validate_app_billing_customer_deletion_intent(executing);
    IF NOT COALESCE(executing.status='OUTCOME_UNKNOWN'
      AND executing.request_payload->>'customerBindingId'=p_binding_id::text
      AND executing.lease_token=p_lease_token AND executing.execution_generation=p_execution_generation
      AND executing.state_revision=p_state_revision AND executing.lease_expires_at IS NOT NULL
      AND isfinite(executing.lease_expires_at) AND executing.lease_expires_at>clock_timestamp(),false)
    THEN RAISE EXCEPTION 'Customer deletion requires its exact current execution lease'; END IF;
  ELSIF p_lease_token IS NOT NULL OR p_execution_generation IS NOT NULL OR p_state_revision IS NOT NULL THEN
    RAISE EXCEPTION 'Customer deletion lease cannot omit its command';
  END IF;
  IF EXISTS(SELECT 1 FROM billing_subscriptions b JOIN app_billing_scopes s ON s.id=b.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id
    AND (b.status IS DISTINCT FROM 'canceled' OR b.stripe_customer_id IS DISTINCT FROM binding.stripe_customer_id))
    THEN RAISE EXCEPTION 'Customer deletion has unresolved subscription obligations'; END IF;
  IF EXISTS(SELECT 1 FROM billing_subscription_commands c JOIN app_billing_scopes s ON s.id=c.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id
    AND (p_command_id IS NULL OR c.id<>p_command_id)
    AND NOT COALESCE(c.status IN ('APPLIED','FAILED','SUPERSEDED') OR
      (c.status='SUCCEEDED' AND (
        (c.kind='delete_customer' AND c.request_payload->>'domain'='account_deletion'
          AND c.request_payload->>'action'='delete_customer' AND c.provider_result->>'kind'='deleted_customer'
          AND c.provider_result->>'customerBindingId'=binding.id::text) OR
        (c.request_payload->>'domain'='account_deletion' AND c.request_payload->>'action'='expire_checkout') OR
        (c.request_payload->>'domain'='buyer' AND (
          (c.kind='portal' AND c.request_payload->>'action'='portal' AND c.provider_result->>'kind'='portal') OR
          (c.kind='expire_checkout' AND c.request_payload->>'action'='expire_checkout' AND c.provider_result->>'kind'='expired_checkout'))))),false))
    THEN RAISE EXCEPTION 'Customer deletion has unresolved provider commands'; END IF;
  IF EXISTS(SELECT 1 FROM billing_funding_reservations r JOIN app_billing_scopes s ON s.id=r.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id AND r.status NOT IN ('finalized','canceled'))
    THEN RAISE EXCEPTION 'Customer deletion has unsettled usage reservations'; END IF;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION require_app_billing_customer_terminal_obligations(p_binding_id uuid, p_request_id uuid, p_request_digest text, p_lifecycle_revision bigint, p_phase_id uuid, p_phase_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM require_app_billing_customer_terminal_obligations(p_binding_id,p_request_id,p_request_digest,p_lifecycle_revision,p_phase_id,p_phase_generation,NULL,NULL,NULL,NULL);
END $$;
