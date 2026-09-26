-- Retain the actual canceled observation in the original command, without fabricating historical evidence.
CREATE OR REPLACE FUNCTION guard_app_billing_cancellation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jsonb; o jsonb; v jsonb; r record; p record; sc record; merchant record; revision record;
BEGIN
  e:=NEW.provider_result->'cancellationEvidence';
  IF e IS NOT NULL AND NOT COALESCE(NEW.kind='cancel' AND NEW.request_payload->>'domain'='account_deletion' AND NEW.request_payload->>'action'='cancel' AND NEW.status='APPLIED',false)
    THEN RAISE EXCEPTION 'Cancellation evidence requires its original applied deletion command'; END IF;
  IF NEW.request_payload->>'domain' IS DISTINCT FROM 'account_deletion' OR NEW.request_payload->>'action' IS DISTINCT FROM 'cancel' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.provider_result->'cancellationEvidence' IS NOT NULL
    AND OLD.provider_result->'cancellationEvidence' IS DISTINCT FROM e THEN RAISE EXCEPTION 'Cancellation evidence is immutable'; END IF;
  IF NEW.status IS DISTINCT FROM 'APPLIED' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.status='APPLIED' THEN RETURN NEW; END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Cancellation evidence requires an existing execution lease'; END IF;
  o:=e->'observation'; v:=o->'value';
  SELECT * INTO r FROM account_deletion_requests WHERE id=(NEW.request_payload->>'requestId')::uuid FOR SHARE;
  SELECT * INTO p FROM account_deletion_phase_receipts WHERE id=(NEW.request_payload->>'phaseReceiptId')::uuid AND request_id=r.id FOR SHARE;
  SELECT * INTO sc FROM app_billing_scopes WHERE id=NEW.billing_scope_id;
  SELECT * INTO merchant FROM billing_merchants WHERE id=NEW.merchant_id;
  SELECT * INTO revision FROM billing_subscription_revisions rev WHERE rev.subscription_id=NEW.result_subscription_id AND rev.revision=NEW.result_subscription_revision;
  IF NOT COALESCE(
    OLD.status='OUTCOME_UNKNOWN' AND OLD.provider_result IS NULL AND OLD.provider_started_at IS NOT NULL
    AND OLD.lease_token IS NOT NULL AND isfinite(OLD.lease_expires_at) AND OLD.lease_expires_at>clock_timestamp()
    AND e->>'commandId'=OLD.id::text AND (e->>'commandRevision')::bigint=OLD.state_revision
    AND (e->>'executionGeneration')::bigint=OLD.execution_generation AND OLD.execution_generation>0
    AND e->>'leaseToken'=OLD.lease_token::text AND NEW.execution_generation=OLD.execution_generation
    AND NEW.state_revision=OLD.state_revision+1 AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
    AND NEW.provider_started_at=OLD.provider_started_at AND NEW.error_code IS NULL
    AND NEW.request_digest=encode(sha256(convert_to(app_billing_refund_canonical_json(NEW.request_payload),'UTF8')),'hex')
    AND r.status='processing' AND r.irreversible_at IS NOT NULL AND r.request_digest=NEW.request_payload->>'requestDigest'
    AND r.user_id=NEW.requested_by_user_id AND r.lifecycle_revision=(NEW.request_payload->>'lifecycleRevision')::bigint
    AND p.phase='stripe' AND p.status IN('leased','calling','reconciling') AND p.lease_generation=(e->>'phaseGeneration')::bigint
    AND p.lease_generation>=(NEW.request_payload->>'initiatingPhaseGeneration')::bigint
    AND isfinite(p.lease_expires_at) AND (p.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp()
    AND EXISTS(SELECT 1 FROM users u JOIN organizations org ON org.id=r.organization_id WHERE u.id=r.user_id
      AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision
      AND org.account_lifecycle_state='deletion_irreversible' AND org.account_deletion_request_id=r.id AND org.account_lifecycle_revision=r.lifecycle_revision)
    AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=sc.id AND d.request_id=r.id AND d.disposition='close'
      AND d.request_digest=r.request_digest AND d.lifecycle_revision=r.lifecycle_revision AND d.phase_receipt_id=p.id AND d.phase_generation=p.lease_generation
      AND d.merchant_id=NEW.merchant_id AND d.provider_account_key=NEW.merchant_key AND d.livemode=NEW.livemode)
    AND sc.fenced_at IS NOT NULL AND sc.app_id=NEW.app_id AND sc.organization_id=NEW.organization_id AND sc.merchant_id=NEW.merchant_id AND sc.livemode=NEW.livemode
    AND o->>'merchantId'=NEW.merchant_id::text AND o->>'providerAccountId'=merchant.stripe_account_id
    AND merchant.stripe_account_id=NEW.request_payload->>'providerAccountId' AND merchant.provider_account_key=NEW.merchant_key
    AND o->'livemode'=to_jsonb(NEW.livemode) AND o->>'apiVersion'='2024-11-20.acacia'
    AND o->>'inputDigest'=NEW.request_digest AND o->>'digest'=NEW.provider_response_digest
    AND o->>'digest'=encode(sha256(convert_to(app_billing_refund_canonical_json(v),'UTF8')),'hex')
    AND isfinite((o->>'observedAt')::timestamptz) AND (o->>'observedAt')::timestamptz>=OLD.provider_started_at
    AND (o->>'observedAt')::timestamptz<=NEW.completed_at AND isfinite(NEW.completed_at) AND NEW.completed_at<=clock_timestamp()
    AND NEW.applied_at=NEW.completed_at AND v->>'status'='canceled' AND v->'pendingUpdate'='false'::jsonb
    AND NEW.provider_result->>'kind'='completed' AND NEW.request_payload->>'timing'='immediate'
    AND NEW.result_subscription_id=NEW.subscription_id AND NEW.subscription_id::text=NEW.request_payload->>'localSubscriptionId'
    AND NEW.provider_result->>'subscriptionId'=NEW.result_subscription_id::text AND (NEW.provider_result->>'subscriptionRevision')::bigint=NEW.result_subscription_revision
    AND revision.organization_id=NEW.organization_id AND revision.billing_scope_id=NEW.billing_scope_id AND revision.merchant_key=NEW.merchant_key
    AND revision.provider_environment=CASE WHEN NEW.livemode THEN 'live' ELSE 'test' END AND revision.status='canceled'
    AND revision.provider_object_digest=NEW.provider_response_digest
    AND revision.stripe_subscription_id=v->>'subscriptionId' AND v->>'subscriptionId'=NEW.request_payload->>'subscriptionId'
    AND revision.stripe_customer_id=v->>'customerId' AND v->>'customerId'=NEW.request_payload->>'customerId'
    AND revision.stripe_subscription_item_id=v->>'itemId' AND revision.quantity=(v->>'quantity')::integer
    AND revision.current_period_start=to_timestamp((v->>'currentPeriodStart')::double precision)
    AND revision.current_period_end=to_timestamp((v->>'currentPeriodEnd')::double precision)
    AND revision.cancel_at_period_end=(v->>'cancelAtPeriodEnd')::boolean
    AND EXISTS(SELECT 1 FROM app_billing_plan_revisions plan WHERE plan.id=NEW.target_plan_revision_id AND plan.id::text=NEW.request_payload->>'planRevisionId'
      AND plan.app_id=NEW.app_id AND plan.merchant_id=NEW.merchant_id AND plan.stripe_price_id=v->>'priceId' AND plan.stripe_product_id=v->>'productId')
    AND EXISTS(SELECT 1 FROM billing_subscriptions sub WHERE sub.id=NEW.subscription_id AND sub.billing_scope_id=NEW.billing_scope_id
      AND sub.lifecycle_revision=NEW.result_subscription_revision AND sub.status='canceled' AND sub.provider_object_digest=NEW.provider_response_digest),false)
    THEN RAISE EXCEPTION 'Cancellation requires exact retained observation, source revision and current execution authority'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_cancellation_evidence_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_app_billing_cancellation_evidence();
