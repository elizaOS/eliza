CREATE OR REPLACE FUNCTION validate_app_billing_customer_deletion_intent(command billing_subscription_commands) RETURNS void LANGUAGE plpgsql AS $$
DECLARE closure app_billing_customer_closures%ROWTYPE; request account_deletion_requests%ROWTYPE; scope app_billing_scopes%ROWTYPE; payload jsonb := command.request_payload;
BEGIN
  SELECT * INTO closure FROM app_billing_customer_closures WHERE customer_binding_id=(payload->>'customerBindingId')::uuid;
  SELECT * INTO request FROM account_deletion_requests WHERE id=(payload->>'requestId')::uuid;
  SELECT * INTO scope FROM app_billing_scopes WHERE id=command.billing_scope_id;
  IF NOT COALESCE(command.kind='delete_customer' AND payload->>'domain'='account_deletion'
    AND payload->>'action'='delete_customer' AND payload->>'version'='1'
    AND closure.customer_binding_id IS NOT NULL AND request.id IS NOT NULL AND scope.id IS NOT NULL
    AND command.app_id=closure.app_id AND command.merchant_id=closure.merchant_id AND command.livemode=closure.livemode
    AND command.merchant_key=closure.provider_account_key AND command.organization_id=scope.organization_id
    AND scope.billing_account_id=closure.billing_account_id AND scope.merchant_id=closure.merchant_id
    AND scope.app_id=closure.app_id AND scope.livemode=closure.livemode
    AND command.requested_by_user_id=request.user_id
    AND payload->>'requestDigest'=request.request_digest AND (payload->>'lifecycleRevision')::bigint=request.lifecycle_revision
    AND payload->>'closureRequestId'=closure.initiating_request_id::text AND payload->>'closureRequestDigest'=closure.request_digest
    AND payload->>'billingAccountId'=closure.billing_account_id::text
    AND payload->>'customerId'=closure.stripe_customer_id AND payload->>'providerAccountId'=closure.stripe_account_id
    AND command.idempotency_key='deletion-customer:'||closure.customer_binding_id::text
    AND command.provider_idempotency_key='app-'||command.idempotency_key
    AND command.subscription_id IS NULL AND command.expected_subscription_revision IS NULL
    AND command.target_plan_key IS NULL AND command.target_plan_revision_id IS NULL
    AND command.client_registration_id IS NULL,false)
  THEN RAISE EXCEPTION 'Customer deletion requires immutable original closure intent'; END IF;
END $$;
