-- Historical quote bindings are unknown; never infer them from current catalog configuration.
ALTER TABLE organization_plan_change_quotes ADD COLUMN provider_binding jsonb;
--> statement-breakpoint
ALTER TABLE organization_plan_change_quotes ADD CONSTRAINT organization_upgrade_quote_binding_shape
CHECK (provider_binding IS NULL OR (
 jsonb_typeof(provider_binding)='object'
 AND (provider_binding-ARRAY['sourcePriceId','targetPriceId','sourceProductId','targetProductId','livemode','apiVersion'])='{}'::jsonb
 AND provider_binding->>'sourcePriceId' ~ '^price_[A-Za-z0-9]+$'
 AND provider_binding->>'targetPriceId' ~ '^price_[A-Za-z0-9]+$'
 AND provider_binding->>'sourceProductId' ~ '^prod_[A-Za-z0-9]+$'
 AND provider_binding->>'targetProductId' ~ '^prod_[A-Za-z0-9]+$'
 AND provider_binding->>'sourcePriceId'<>provider_binding->>'targetPriceId'
 AND provider_binding->>'sourceProductId'<>provider_binding->>'targetProductId'
 AND jsonb_typeof(provider_binding->'livemode')='boolean'
 AND provider_binding->>'apiVersion'='2024-11-20.acacia'
) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION guard_organization_upgrade_quote_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; quote record;
BEGIN
 IF TG_TABLE_NAME='organization_plan_change_quotes' THEN
  SELECT * INTO source FROM billing_subscriptions WHERE id=NEW.subscription_id AND organization_id=NEW.organization_id;
  IF NEW.provider_binding IS NULL OR NOT FOUND OR source.provider<>'stripe'
   OR (NEW.provider_binding->>'livemode')::boolean IS DISTINCT FROM (source.provider_environment='live') THEN
   RAISE EXCEPTION 'New upgrade quote requires its observed provider binding' USING ERRCODE='23514';
  END IF;
 ELSE
  IF OLD.organization_upgrade_dispatch_state='ready' AND NEW.organization_upgrade_dispatch_state='started' THEN
   SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=NEW.id;
   IF NOT FOUND OR quote.provider_binding IS NULL THEN
    RAISE EXCEPTION 'Upgrade dispatch cannot infer a historical quote binding' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organization_upgrade_quote_binding_guard BEFORE INSERT ON organization_plan_change_quotes
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_quote_binding();
--> statement-breakpoint
CREATE TRIGGER organization_upgrade_dispatch_binding_guard BEFORE UPDATE ON billing_subscription_commands
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_quote_binding();
