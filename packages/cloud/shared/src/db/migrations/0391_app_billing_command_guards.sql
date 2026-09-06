CREATE FUNCTION validate_app_billing_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$
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
    ELSE
      IF NOT COALESCE(payload->>'domain' = 'buyer' AND ((payload->>'action' = 'trial' AND NEW.kind = 'checkout') OR (payload->>'action' = 'checkout' AND NEW.kind IN ('checkout','upgrade')) OR (payload->>'action' = 'update' AND NEW.kind IN ('upgrade','downgrade')) OR (payload->>'action' = NEW.kind AND NEW.kind IN ('cancel','portal','expire_checkout'))),false) THEN RAISE EXCEPTION 'Invalid app purchaser intent'; END IF;
      IF payload->>'action' IN ('trial','checkout','update') AND NOT COALESCE(payload->>'planRevisionId' = NEW.target_plan_revision_id::text AND (payload->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'App billing command target payload mismatch'; END IF;
      IF payload->>'action' IN ('checkout','update') AND (payload->>'billingConsent') IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'App billing payment consent is required'; END IF;
    END IF;
  END IF;
  IF NEW.provider_result IS NOT NULL AND (NEW.status NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','APPLIED') OR jsonb_typeof(NEW.provider_result) <> 'object') THEN RAISE EXCEPTION 'Provider result requires started durable command'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER billing_commands_app_intent BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION validate_app_billing_command_intent();
