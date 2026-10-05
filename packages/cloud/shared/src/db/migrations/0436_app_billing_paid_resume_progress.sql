CREATE OR REPLACE FUNCTION validate_app_billing_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; registration record; merchant record; payload jsonb := NEW.request_payload; old_resume jsonb; new_resume jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.app_id,NEW.livemode,NEW.merchant_id,NEW.client_registration_id,NEW.request_payload) IS DISTINCT FROM ROW(OLD.app_id,OLD.livemode,OLD.merchant_id,OLD.client_registration_id,OLD.request_payload) THEN RAISE EXCEPTION 'App billing command intent is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result IS NOT NULL AND OLD.provider_result IS DISTINCT FROM NEW.provider_result THEN
    IF NEW.provider_result IS NULL OR (OLD.provider_result - ARRAY['subscriptionId','subscriptionRevision','resume']) IS DISTINCT FROM (NEW.provider_result - ARRAY['subscriptionId','subscriptionRevision','resume']) OR (OLD.provider_result->>'subscriptionId' IS NOT NULL AND (OLD.provider_result->>'subscriptionId') IS DISTINCT FROM (NEW.provider_result->>'subscriptionId')) OR (OLD.provider_result->>'subscriptionRevision' IS NOT NULL AND (OLD.provider_result->>'subscriptionRevision') IS DISTINCT FROM (NEW.provider_result->>'subscriptionRevision')) OR OLD.provider_result->>'kind' NOT IN ('checkout','completed') THEN RAISE EXCEPTION 'App billing provider result handles are immutable'; END IF;
  END IF;
  IF NEW.provider_result ? 'resume' THEN
    new_resume := NEW.provider_result->'resume';
    IF NOT COALESCE(
      NEW.provider_result->>'kind' = 'checkout'
      AND NEW.provider_result->>'mode' = 'setup'
      AND payload->>'domain' = 'buyer' AND payload->>'action' = 'checkout'
      AND NEW.provider_result->>'subscriptionId' IS NOT NULL
      AND jsonb_typeof(new_resume) = 'object'
      AND new_resume ?& ARRAY['notBefore','previousInvoiceId','invoiceId','action']
      AND (new_resume - ARRAY['notBefore','previousInvoiceId','invoiceId','action','invoicePaid']) = '{}'::jsonb
      AND jsonb_typeof(new_resume->'notBefore') = 'string'
      AND jsonb_typeof(new_resume->'previousInvoiceId') IN ('string','null')
      AND jsonb_typeof(new_resume->'invoiceId') IN ('string','null')
      AND jsonb_typeof(new_resume->'action') IN ('object','null')
      AND (NOT (new_resume ? 'invoicePaid') OR (new_resume->'invoicePaid' = 'true'::jsonb AND new_resume->>'invoiceId' IS NOT NULL)), false)
    THEN RAISE EXCEPTION 'Invalid setup resume payment progress'; END IF;
    IF NOT isfinite((new_resume->>'notBefore')::timestamptz)
      OR (new_resume->>'notBefore')::timestamptz < NEW.provider_started_at
      OR NEW.provider_started_at IS NULL
    THEN RAISE EXCEPTION 'Resume payment cannot precede command dispatch'; END IF;
    IF new_resume->>'previousInvoiceId' = '' THEN RAISE EXCEPTION 'Previous invoice must be a nonempty handle'; END IF;
    IF new_resume->>'invoiceId' IS NOT NULL AND
      (length(new_resume->>'invoiceId') = 0 OR new_resume->>'invoiceId' = new_resume->>'previousInvoiceId')
    THEN RAISE EXCEPTION 'Resume payment requires a new exact invoice'; END IF;
    IF new_resume->'action' <> 'null'::jsonb THEN
      IF NOT COALESCE(
      new_resume->'action'->>'kind' = 'payment'
      AND new_resume->'action'->>'invoiceId' = new_resume->>'invoiceId'
      AND new_resume->'action'->>'customerId' = NEW.provider_result->>'customerId'
      AND new_resume->'action'->>'subscriptionId' = NEW.provider_result->>'subscriptionId'
      AND jsonb_typeof(new_resume->'action'->'url') = 'string'
      AND jsonb_typeof(new_resume->'action'->'expiresAt') = 'string'
      AND ((new_resume->'action') - ARRAY['kind','invoiceId','customerId','subscriptionId','url','expiresAt']) = '{}'::jsonb, false)
      THEN RAISE EXCEPTION 'Resume payment action must match its original invoice'; END IF;
      IF NOT isfinite((new_resume->'action'->>'expiresAt')::timestamptz)
      THEN RAISE EXCEPTION 'Resume payment expiration must be finite'; END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result ? 'resume' THEN
    old_resume := OLD.provider_result->'resume';
    new_resume := NEW.provider_result->'resume';
    IF new_resume IS NULL
      OR (old_resume - ARRAY['invoiceId','action','invoicePaid']) IS DISTINCT FROM (new_resume - ARRAY['invoiceId','action','invoicePaid'])
      OR (old_resume->>'invoiceId' IS NOT NULL AND old_resume->'invoiceId' IS DISTINCT FROM new_resume->'invoiceId')
      OR (old_resume->'action' <> 'null'::jsonb AND old_resume->'action' IS DISTINCT FROM new_resume->'action')
      OR (old_resume ? 'invoicePaid' AND old_resume->'invoicePaid' IS DISTINCT FROM new_resume->'invoicePaid')
    THEN RAISE EXCEPTION 'Resume payment progress is immutable once observed'; END IF;
  END IF;
  IF NEW.app_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = NEW.app_id AND a.organization_id = NEW.organization_id) THEN RAISE EXCEPTION 'App billing command owner mismatch'; END IF;
  IF NEW.billing_scope_id IS NOT NULL THEN
    SELECT * INTO sc FROM app_billing_scopes WHERE id = NEW.billing_scope_id;
    IF (NEW.app_id,NEW.livemode,NEW.merchant_id) IS DISTINCT FROM (sc.app_id,sc.livemode,sc.merchant_id) THEN RAISE EXCEPTION 'App billing command scope mismatch'; END IF;
  END IF;
  IF NEW.merchant_id IS NOT NULL THEN
    SELECT * INTO merchant FROM billing_merchants WHERE id = NEW.merchant_id;
    IF (NEW.organization_id,NEW.livemode,NEW.merchant_key) IS DISTINCT FROM (merchant.organization_id,merchant.livemode,merchant.provider_account_key) THEN RAISE EXCEPTION 'App billing command merchant mismatch'; END IF;
  END IF;
  IF NEW.client_registration_id IS NOT NULL THEN
    SELECT * INTO registration FROM app_client_registrations WHERE id = NEW.client_registration_id;
    IF (NEW.app_id,NEW.organization_id,NEW.livemode) IS DISTINCT FROM (registration.app_id,registration.owner_organization_id,registration.billing_environment = 'live') THEN RAISE EXCEPTION 'App billing command registration mismatch'; END IF;
  END IF;
  IF TG_OP = 'INSERT' AND payload IS NULL THEN RAISE EXCEPTION 'New app billing commands require complete durable intent'; END IF;
  IF payload IS NOT NULL THEN
    IF NOT COALESCE(jsonb_typeof(payload) = 'object' AND payload->>'version' = '1',false) THEN RAISE EXCEPTION 'Invalid app billing command payload'; END IF;
    IF NEW.billing_scope_id IS NULL THEN
      IF NOT COALESCE(payload->>'domain' = 'admin' AND payload->>'action' = NEW.kind AND payload->>'clientRegistrationId' = NEW.client_registration_id::text,false) THEN RAISE EXCEPTION 'Invalid app administrator intent'; END IF;
    ELSIF NEW.kind = 'import' THEN
      IF NOT COALESCE(payload->>'domain' = 'operator' AND payload->>'action' = 'import' AND payload->>'manifestDigest' = NEW.request_digest AND payload->'manifest'->>'scopeId' = NEW.billing_scope_id::text AND payload->'manifest'->>'planRevisionId' = NEW.target_plan_revision_id::text AND payload->'manifest'->>'principalUserId' = NEW.requested_by_user_id::text AND (payload->'manifest'->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'Invalid operator import intent'; END IF;
    ELSE
      IF NOT COALESCE(payload->>'domain' = 'buyer' AND ((payload->>'action' = 'trial' AND NEW.kind = 'checkout') OR (payload->>'action' = 'checkout' AND NEW.kind IN ('checkout','upgrade')) OR (payload->>'action' = 'update' AND NEW.kind IN ('upgrade','downgrade')) OR (payload->>'action' = NEW.kind AND NEW.kind IN ('cancel','portal','expire_checkout'))),false) THEN RAISE EXCEPTION 'Invalid app purchaser intent'; END IF;
      IF payload->>'action' IN ('trial','checkout','update') AND NOT COALESCE(payload->>'planRevisionId' = NEW.target_plan_revision_id::text AND (payload->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'App billing command target payload mismatch'; END IF;
      IF payload->>'action' IN ('checkout','update') AND (payload->>'billingConsent') IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'App billing payment consent is required'; END IF;
    END IF;
  END IF;
  IF NEW.provider_result IS NOT NULL AND ((NEW.status NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','APPLIED') AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_CHECKOUT_EXPIRED' AND NEW.request_payload->>'action' = 'checkout' AND NEW.provider_result->>'kind' = 'checkout' AND NEW.provider_result->>'checkoutSessionId' IS NOT NULL) AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_PAYMENT_EXPIRED' AND NEW.request_payload->>'domain' = 'buyer' AND NEW.request_payload->>'action' = 'update' AND NEW.provider_result->>'kind' = 'payment' AND NEW.provider_result->>'invoiceId' IS NOT NULL)) OR jsonb_typeof(NEW.provider_result) <> 'object') THEN RAISE EXCEPTION 'Provider result requires started durable command'; END IF;
  RETURN NEW;
END $$;
