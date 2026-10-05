CREATE OR REPLACE FUNCTION validate_app_billing_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; registration record; merchant record; payload jsonb := NEW.request_payload;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.app_id,NEW.livemode,NEW.merchant_id,NEW.client_registration_id,NEW.request_payload) IS DISTINCT FROM ROW(OLD.app_id,OLD.livemode,OLD.merchant_id,OLD.client_registration_id,OLD.request_payload) THEN RAISE EXCEPTION 'App billing command intent is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result IS NOT NULL AND OLD.provider_result IS DISTINCT FROM NEW.provider_result THEN
    IF NEW.provider_result IS NULL OR (OLD.provider_result - ARRAY['subscriptionId','subscriptionRevision']) IS DISTINCT FROM (NEW.provider_result - ARRAY['subscriptionId','subscriptionRevision']) OR (OLD.provider_result->>'subscriptionId' IS NOT NULL AND (OLD.provider_result->>'subscriptionId') IS DISTINCT FROM (NEW.provider_result->>'subscriptionId')) OR (OLD.provider_result->>'subscriptionRevision' IS NOT NULL AND (OLD.provider_result->>'subscriptionRevision') IS DISTINCT FROM (NEW.provider_result->>'subscriptionRevision')) OR OLD.provider_result->>'kind' NOT IN ('checkout','completed') THEN RAISE EXCEPTION 'App billing provider result handles are immutable'; END IF;
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
  IF NEW.provider_result IS NOT NULL AND ((NEW.status NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','APPLIED') AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_CHECKOUT_EXPIRED' AND NEW.request_payload->>'action' = 'checkout' AND NEW.provider_result->>'kind' = 'checkout' AND NEW.provider_result->>'checkoutSessionId' IS NOT NULL)) OR jsonb_typeof(NEW.provider_result) <> 'object') THEN RAISE EXCEPTION 'Provider result requires started durable command'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_importable_app_trial() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; p record; cmd record;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Trial eligibility cannot be reset'; END IF;
  SELECT s.*,b.eligibility_principal_id INTO sc FROM app_billing_scopes s JOIN app_billing_accounts b ON b.id=s.billing_account_id WHERE s.id=NEW.billing_scope_id;
  SELECT * INTO p FROM app_billing_plan_revisions WHERE id=NEW.plan_revision_id;
  SELECT * INTO cmd FROM billing_subscription_commands WHERE id=NEW.command_id;
  IF sc.id IS NULL OR p.id IS NULL OR cmd.id IS NULL OR (NEW.app_id,NEW.eligibility_principal_id,NEW.livemode) IS DISTINCT FROM (sc.app_id,sc.eligibility_principal_id,sc.livemode) OR (p.app_id,p.merchant_id,p.product_family_key) IS DISTINCT FROM (sc.app_id,sc.merchant_id,sc.product_family_key) OR cmd.billing_scope_id IS DISTINCT FROM sc.id OR (cmd.kind='checkout' AND cmd.target_plan_revision_id IS DISTINCT FROM p.id) OR (cmd.kind='import' AND cmd.request_payload->'manifest'->'trial'->>'planRevisionId' IS DISTINCT FROM p.id::text) OR cmd.kind NOT IN ('checkout','import') THEN RAISE EXCEPTION 'Trial eligibility source mismatch'; END IF;
  IF cmd.kind='import' AND NOT COALESCE(cmd.status='OUTCOME_UNKNOWN' AND cmd.request_payload->>'domain'='operator' AND (cmd.request_payload->'manifest'->'trial'->>'startsAt')::timestamptz=NEW.starts_at AND (cmd.request_payload->'manifest'->'trial'->>'endsAt')::timestamptz=NEW.ends_at AND NEW.starts_at<=clock_timestamp(),false) THEN RAISE EXCEPTION 'Imported trial must preserve reviewed original bounds'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS app_subscription_trials_authority ON app_subscription_trials;
CREATE TRIGGER app_subscription_trials_authority BEFORE INSERT OR UPDATE OR DELETE ON app_subscription_trials FOR EACH ROW EXECUTE FUNCTION validate_importable_app_trial();
