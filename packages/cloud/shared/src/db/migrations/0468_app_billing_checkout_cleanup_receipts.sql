-- Recompute retained Checkout read evidence against its original source and immutable provider input.
CREATE OR REPLACE FUNCTION app_billing_checkout_cleanup_receipt_valid(command billing_subscription_commands) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE payload jsonb:=command.request_payload; result jsonb:=command.provider_result; e jsonb:=result->'checkoutEvidence'; o jsonb:=e->'observation'; v jsonb:=o->'value'; source record; sc record; merchant record; plan record; expected jsonb; input jsonb;
BEGIN
  SELECT * INTO source FROM billing_subscription_commands WHERE id::text=payload->>'sourceCommandId';
  SELECT * INTO sc FROM app_billing_scopes WHERE id=command.billing_scope_id;
  SELECT * INTO merchant FROM billing_merchants WHERE id=command.merchant_id;
  input:=jsonb_build_object('sessionId',payload->>'checkoutSessionId','customerId',payload->>'customerId','mode',payload->>'mode');
  IF payload->>'mode'='setup' THEN
    SELECT * INTO plan FROM app_billing_plan_revisions WHERE id::text=payload->>'planRevisionId';
    IF plan.id IS NULL OR plan.app_id IS DISTINCT FROM command.app_id OR plan.merchant_id IS DISTINCT FROM command.merchant_id THEN RETURN false; END IF;
    input:=input||jsonb_build_object('subscriptionId',payload->>'subscriptionId','plan',jsonb_build_object('planRevisionId',plan.id,'priceId',plan.stripe_price_id,'productId',plan.stripe_product_id,'amountCents',plan.amount_cents,'currency',plan.currency,'interval',plan.interval,'intervalCount',plan.interval_count,'minimumQuantity',plan.minimum_quantity,'maximumQuantity',plan.maximum_quantity,'trialDays',plan.trial_days));
  END IF;
  expected:=jsonb_build_object('operation',CASE WHEN payload->>'mode'='setup' THEN 'readPaymentMethodCheckout' ELSE 'readCheckout' END,
    'scope',jsonb_build_object('scopeId',sc.id,'appId',sc.app_id,'billingAccountId',sc.billing_account_id),'input',input);
  RETURN COALESCE(command.kind='expire_checkout' AND command.status='SUCCEEDED' AND payload->>'version'='1'
    AND payload->>'domain'='account_deletion' AND payload->>'action'='expire_checkout' AND payload->>'mode' IN('setup','subscription')
    AND command.request_digest=encode(sha256(convert_to(app_billing_refund_canonical_json(payload),'UTF8')),'hex')
    AND source.id IS NOT NULL AND source.request_payload->>'domain'='buyer' AND source.request_payload->>'action'='checkout' AND source.provider_result->>'kind'='checkout'
    AND (command.billing_scope_id,command.app_id,command.organization_id,command.merchant_id,command.merchant_key,command.livemode,command.requested_by_user_id)
      IS NOT DISTINCT FROM (source.billing_scope_id,source.app_id,source.organization_id,source.merchant_id,source.merchant_key,source.livemode,source.requested_by_user_id)
    AND sc.app_id=command.app_id AND sc.organization_id=command.organization_id AND sc.merchant_id=command.merchant_id AND sc.livemode=command.livemode
    AND merchant.organization_id=command.organization_id AND merchant.provider_account_key=command.merchant_key AND merchant.livemode=command.livemode
    AND payload->>'checkoutSessionId'=source.provider_result->>'checkoutSessionId' AND payload->>'customerId'=source.provider_result->>'customerId'
    AND payload->>'mode'=source.provider_result->>'mode' AND (payload->>'planRevisionId') IS NOT DISTINCT FROM source.target_plan_revision_id::text
    AND ((payload->'subscriptionId') IS NOT DISTINCT FROM (source.provider_result->'subscriptionId') OR (payload->>'mode'='subscription' AND payload->'subscriptionId'='null'::jsonb))
    AND command.idempotency_key='deletion-expire:'||source.id::text AND command.provider_idempotency_key='app-'||command.idempotency_key
    AND e->>'commandId'=command.id::text AND e->>'sourceCommandId'=source.id::text
    AND (e->>'sourceRevision')::bigint<=source.state_revision AND (e->>'sourceRevision')::bigint>0
    AND (e->>'commandRevision')::bigint+1=command.state_revision AND (e->>'executionGeneration')::bigint=command.execution_generation
    AND command.execution_generation>0 AND (e->>'leaseToken')::uuid IS NOT NULL AND (e->>'phaseGeneration')::bigint>0
    AND command.lease_token IS NULL AND command.lease_expires_at IS NULL AND command.error_code IS NULL
    AND result->>'checkoutSessionId'=payload->>'checkoutSessionId' AND v->>'sessionId'=payload->>'checkoutSessionId'
    AND v->>'customerId'=payload->>'customerId' AND v->>'mode'=payload->>'mode'
    AND v ?& ARRAY['mode','sessionId','customerId','subscriptionId','status','url','expiresAt']
    AND jsonb_typeof(v->'url') IN('string','null') AND jsonb_typeof(v->'expiresAt')='number'
    AND (CASE WHEN payload->>'mode'='setup' THEN v ? 'setupIntentId' AND v->>'subscriptionId'=payload->>'subscriptionId' AND jsonb_typeof(v->'setupIntentId') IN('string','null')
      ELSE v ?& ARRAY['invoiceId','paymentStatus'] AND jsonb_typeof(v->'invoiceId') IN('string','null') AND v->>'paymentStatus' IN('paid','unpaid','no_payment_required') END)
    AND o->>'merchantId'=merchant.id::text AND o->>'providerAccountId'=merchant.stripe_account_id
    AND o->'livemode'=to_jsonb(command.livemode) AND o->>'apiVersion'='2024-11-20.acacia'
    AND o->>'digest'=command.provider_response_digest AND o->>'digest'=encode(sha256(convert_to(app_billing_refund_canonical_json(v),'UTF8')),'hex')
    AND o->>'inputDigest'=encode(sha256(convert_to(app_billing_refund_canonical_json(expected),'UTF8')),'hex')
    AND isfinite(command.provider_started_at) AND isfinite(command.completed_at) AND isfinite((o->>'observedAt')::timestamptz)
    AND (o->>'observedAt')::timestamptz>=command.provider_started_at AND (o->>'observedAt')::timestamptz<=command.completed_at AND command.completed_at<=clock_timestamp()
    AND command.result_subscription_id IS NULL AND command.result_subscription_revision IS NULL AND command.applied_at IS NULL
    AND ((result->>'kind'='expired_checkout' AND v->>'status'='expired' AND source.status='FAILED' AND source.error_code='APP_BILLING_CHECKOUT_EXPIRED')
      OR (result->>'kind'='completed_checkout' AND v->>'status'='complete' AND source.status='APPLIED' AND source.applied_at IS NOT NULL
        AND result->>'subscriptionId'=source.result_subscription_id::text AND (result->>'subscriptionRevision')::bigint=source.result_subscription_revision
        AND EXISTS(SELECT 1 FROM billing_subscription_revisions rev WHERE rev.subscription_id=source.result_subscription_id AND rev.revision=source.result_subscription_revision
          AND rev.organization_id=command.organization_id AND rev.billing_scope_id=command.billing_scope_id AND rev.merchant_key=command.merchant_key
          AND rev.provider_environment=CASE WHEN command.livemode THEN 'live' ELSE 'test' END AND rev.provider_object_digest=source.provider_response_digest
          AND rev.stripe_subscription_id=v->>'subscriptionId' AND rev.stripe_customer_id=v->>'customerId'))),false);
END $$;
