-- A retained customer tombstone proves its exact original binding and recomputed provider request/value digests.
CREATE OR REPLACE FUNCTION app_billing_customer_deletion_receipt_valid(command billing_subscription_commands) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE payload jsonb:=command.request_payload; result jsonb:=command.provider_result; observation jsonb:=result->'observation'; valid boolean;
BEGIN
  SELECT command.kind='delete_customer' AND command.status='SUCCEEDED'
    AND payload->>'version'='1' AND payload->>'domain'='account_deletion' AND payload->>'action'='delete_customer'
    AND command.app_id=cl.app_id AND command.merchant_id=cl.merchant_id AND command.merchant_key=cl.provider_account_key AND command.livemode=cl.livemode
    AND command.organization_id=s.organization_id AND s.organization_id=m.organization_id AND s.app_id=cl.app_id AND s.billing_account_id=cl.billing_account_id AND s.merchant_id=cl.merchant_id AND s.livemode=cl.livemode
    AND a.app_id=cl.app_id AND b.billing_account_id=cl.billing_account_id AND b.merchant_id=cl.merchant_id AND b.stripe_customer_id=cl.stripe_customer_id
    AND m.provider_account_key=cl.provider_account_key AND m.stripe_account_id=cl.stripe_account_id AND m.livemode=cl.livemode
    AND payload->>'closureRequestId'=cl.initiating_request_id::text AND payload->>'closureRequestDigest'=cl.request_digest
    AND payload->>'billingAccountId'=cl.billing_account_id::text AND payload->>'customerId'=cl.stripe_customer_id AND payload->>'providerAccountId'=cl.stripe_account_id
    AND command.idempotency_key='deletion-customer:'||cl.customer_binding_id::text AND command.provider_idempotency_key='app-'||command.idempotency_key
    AND command.request_digest=encode(sha256(convert_to(app_billing_refund_canonical_json(payload),'UTF8')),'hex')
    AND result->>'kind'='deleted_customer' AND result->>'customerBindingId'=cl.customer_binding_id::text
    AND observation->'value'=jsonb_build_object('customerId',cl.stripe_customer_id,'status','deleted')
    AND observation->>'merchantId'=cl.merchant_id::text AND observation->>'providerAccountId'=cl.stripe_account_id AND observation->'livemode'=to_jsonb(cl.livemode) AND observation->>'apiVersion'='2024-11-20.acacia'
    AND observation->>'digest'=encode(sha256(convert_to(app_billing_refund_canonical_json(observation->'value'),'UTF8')),'hex') AND observation->>'digest'=command.provider_response_digest
    AND observation->>'inputDigest'=encode(sha256(convert_to(app_billing_refund_canonical_json(jsonb_build_object('operation','inspectBoundCustomer','scope',jsonb_build_object('scopeId',s.id,'appId',cl.app_id,'billingAccountId',cl.billing_account_id),'customerId',cl.stripe_customer_id)),'UTF8')),'hex')
    AND command.execution_generation>0 AND command.lease_token IS NULL AND command.lease_expires_at IS NULL AND command.error_code IS NULL
    AND command.subscription_id IS NULL AND command.expected_subscription_revision IS NULL AND command.target_plan_key IS NULL AND command.target_plan_revision_id IS NULL AND command.client_registration_id IS NULL
    AND command.result_subscription_id IS NULL AND command.result_subscription_revision IS NULL AND command.applied_at IS NULL
    AND isfinite(command.provider_started_at) AND isfinite(command.completed_at) AND isfinite((observation->>'observedAt')::timestamptz)
    AND command.provider_started_at>=(cl.created_at) AND (observation->>'observedAt')::timestamptz>=command.provider_started_at AND (observation->>'observedAt')::timestamptz<=command.completed_at AND command.completed_at<=clock_timestamp()
  INTO valid
  FROM app_billing_customer_closures cl JOIN app_billing_customers b ON b.id=cl.customer_binding_id
    JOIN app_billing_accounts a ON a.id=b.billing_account_id JOIN app_billing_scopes s ON s.id=command.billing_scope_id JOIN billing_merchants m ON m.id=cl.merchant_id
  WHERE cl.customer_binding_id::text=payload->>'customerBindingId';
  RETURN COALESCE(valid,false);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_billing_customer_receipt_digest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='SUCCEEDED' AND (NEW.kind='delete_customer' OR NEW.provider_result->>'kind'='deleted_customer') AND NOT app_billing_customer_deletion_receipt_valid(NEW) THEN RAISE EXCEPTION 'Customer deletion requires exact retained tombstone evidence'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_customer_receipt_digest_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_app_billing_customer_receipt_digest();
