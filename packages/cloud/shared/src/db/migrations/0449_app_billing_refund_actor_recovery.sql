-- Original refund actors may settle historical intent without closing another account.
CREATE OR REPLACE FUNCTION require_app_billing_refund_recovery(p_command uuid,p_request uuid,p_digest text,p_revision bigint,p_phase uuid,p_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c billing_subscription_commands%ROWTYPE; r record; p record; s record; source jsonb; owner uuid; subject uuid;
BEGIN
  SELECT * INTO c FROM billing_subscription_commands WHERE id=p_command;
  SELECT organization_id,user_id INTO owner,subject FROM account_deletion_requests WHERE id=p_request;
  source := c.request_payload->'source';
  IF NOT COALESCE(c.kind='refund' AND c.billing_scope_id IS NULL AND c.request_payload->>'domain'='admin' AND c.request_payload->>'action'='refund'
    AND c.app_id IS NOT NULL AND c.client_registration_id IS NOT NULL AND c.merchant_id IS NOT NULL
    AND owner IS NOT NULL AND subject IS NOT NULL,false) THEN RAISE EXCEPTION 'Refund recovery requires an original authorized admin command'; END IF;
  PERFORM 1 FROM organizations WHERE id IN(owner,c.organization_id) ORDER BY id FOR UPDATE;
  PERFORM x.id FROM app_billing_scopes x JOIN app_subscription_paid_periods t ON t.billing_scope_id=x.id WHERE t.id=(source->>'paidPeriodId')::uuid FOR UPDATE OF x;
  PERFORM a.id FROM app_billing_accounts a JOIN app_billing_scopes x ON x.billing_account_id=a.id JOIN app_subscription_paid_periods t ON t.billing_scope_id=x.id WHERE t.id=(source->>'paidPeriodId')::uuid FOR UPDATE OF a;
  PERFORM binding.id FROM app_billing_customers binding JOIN app_billing_scopes x ON x.billing_account_id=binding.billing_account_id AND x.merchant_id=binding.merchant_id JOIN app_subscription_paid_periods t ON t.billing_scope_id=x.id WHERE t.id=(source->>'paidPeriodId')::uuid FOR UPDATE OF binding;
  PERFORM 1 FROM users WHERE id=subject FOR UPDATE;
  SELECT * INTO r FROM account_deletion_requests WHERE id=p_request FOR SHARE;
  SELECT * INTO p FROM account_deletion_phase_receipts WHERE id=p_phase AND request_id=p_request FOR SHARE;
  SELECT * INTO c FROM billing_subscription_commands WHERE id=p_command FOR UPDATE;
  IF NOT COALESCE(r.status='processing' AND r.irreversible_at IS NOT NULL AND r.request_digest=p_digest AND r.lifecycle_revision=p_revision
    AND r.organization_id=owner AND r.user_id=subject AND p.phase='stripe' AND p.lease_generation=p_generation
    AND p.status IN('leased','calling','reconciling') AND isfinite(p.lease_expires_at) AND (p.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp(),false)
    OR NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=owner WHERE u.id=subject AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=p_request AND u.account_lifecycle_revision=p_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=p_request AND o.account_lifecycle_revision=p_revision)
    THEN RAISE EXCEPTION 'Refund recovery requires current canonical irreversible authority'; END IF;
  SELECT t.*,x.app_id,x.organization_id,x.billing_account_id,x.merchant_id,x.product_family_key,m.provider_account_key,m.stripe_account_id,
    b.stripe_subscription_id,b.stripe_customer_id,b.billing_scope_id AS subscription_scope,b.provider_environment,b.organization_id AS subscription_organization,b.merchant_key AS subscription_merchant,
    plan.id AS historical_plan,plan.app_id AS plan_app,plan.merchant_id AS plan_merchant,plan.product_family_key AS plan_family,plan.stripe_price_id AS plan_price,to_jsonb(plan) AS plan_record
    INTO s FROM app_subscription_paid_periods t JOIN app_billing_scopes x ON x.id=t.billing_scope_id JOIN billing_merchants m ON m.id=x.merchant_id AND m.organization_id=x.organization_id AND m.livemode=x.livemode
    JOIN billing_subscriptions b ON b.id=t.subscription_id JOIN app_billing_plan_revisions plan ON plan.id=t.plan_revision_id
    WHERE t.id=(source->>'paidPeriodId')::uuid FOR SHARE OF t,m,b,plan;
  IF NOT COALESCE(s.app_id=c.app_id AND s.organization_id=c.organization_id AND s.merchant_id=c.merchant_id AND s.livemode=c.livemode
    AND s.subscription_scope=s.billing_scope_id AND s.subscription_organization=c.organization_id AND s.subscription_merchant=s.provider_account_key AND s.merchant_key=s.provider_account_key AND c.merchant_key=s.provider_account_key
    AND s.provider_environment=CASE WHEN c.livemode THEN 'live' ELSE 'test' END
    AND s.plan_app=c.app_id AND s.plan_merchant=c.merchant_id AND s.plan_family=s.product_family_key AND s.plan_price=s.stripe_price_id
    AND source->'scope'=jsonb_build_object('scopeId',s.billing_scope_id,'appId',s.app_id,'billingAccountId',s.billing_account_id)
    AND source->'merchant'=jsonb_build_object('merchantId',s.merchant_id,'kind',CASE WHEN s.provider_account_key='platform' THEN 'platform' ELSE 'connected' END,'stripeAccountId',s.stripe_account_id,'livemode',s.livemode)
    AND source->'invoice'->>'invoiceId'=s.stripe_invoice_id AND source->'invoice'->>'customerId'=s.stripe_customer_id AND source->'invoice'->>'subscriptionId'=s.stripe_subscription_id
    AND source->'invoice'->'plan'=jsonb_build_object('planRevisionId',s.historical_plan,'priceId',s.plan_price,'productId',s.plan_record->>'stripe_product_id','amountCents',s.plan_record->'amount_cents','currency',s.plan_record->>'currency','interval',s.plan_record->>'interval','intervalCount',s.plan_record->'interval_count','minimumQuantity',s.plan_record->'minimum_quantity','maximumQuantity',s.plan_record->'maximum_quantity','trialDays',s.plan_record->'trial_days')
    AND c.request_payload->>'clientRegistrationId'=c.client_registration_id::text AND c.request_payload->>'accessPolicy'='preserve'
    AND (c.request_payload->>'amountCents')::bigint>0,false) THEN RAISE EXCEPTION 'Refund recovery original payment binding mismatch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_billing_customers customer WHERE customer.billing_account_id=s.billing_account_id AND customer.merchant_id=s.merchant_id AND customer.stripe_customer_id=s.stripe_customer_id) THEN RAISE EXCEPTION 'Refund recovery requires its original bound customer'; END IF;
  IF c.requested_by_user_id IS DISTINCT FROM subject AND NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d JOIN app_billing_scopes x ON x.id=d.scope_id WHERE d.scope_id=s.billing_scope_id AND x.fenced_at IS NOT NULL AND d.request_id=p_request AND d.request_digest=p_digest AND d.lifecycle_revision=p_revision AND d.phase_receipt_id=p_phase AND d.phase_generation<=p_generation AND d.disposition='close' AND d.merchant_id=s.merchant_id AND d.provider_account_key=s.provider_account_key AND d.livemode=s.livemode) THEN RAISE EXCEPTION 'Refund recovery requires the original actor or exact canonical closed payment scope'; END IF;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION supersede_app_billing_refund_for_deletion(p_command uuid,p_request uuid,p_digest text,p_revision bigint,p_phase uuid,p_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c billing_subscription_commands%ROWTYPE;
BEGIN
  PERFORM require_app_billing_refund_recovery(p_command,p_request,p_digest,p_revision,p_phase,p_generation);
  SELECT * INTO c FROM billing_subscription_commands WHERE id=p_command;
  IF NOT EXISTS(SELECT 1 FROM account_deletion_requests r WHERE r.id=p_request AND r.user_id=c.requested_by_user_id) THEN RAISE EXCEPTION 'Only the original refund actor may supersede unstarted intent'; END IF;
  IF NOT COALESCE(c.status='PREPARED' AND c.execution_generation=0 AND c.provider_started_at IS NULL AND c.provider_result IS NULL AND c.provider_response_digest IS NULL AND c.lease_token IS NULL AND c.lease_expires_at IS NULL,false)
    THEN RAISE EXCEPTION 'Only never-dispatched refunds may be superseded'; END IF;
  UPDATE billing_subscription_commands SET status='SUPERSEDED',error_code='APP_BILLING_ACCOUNT_DELETION_SUPERSEDED',completed_at=clock_timestamp(),state_revision=state_revision+1,updated_at=clock_timestamp() WHERE id=c.id;
END $$;
