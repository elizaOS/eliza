-- Immutable original downgrade quote billing settings; legacy receipts remain recoverable.
CREATE TABLE organization_schedule_quote_terms (
 quote_id uuid PRIMARY KEY REFERENCES organization_plan_change_quotes(id) ON DELETE RESTRICT,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 snapshot jsonb NOT NULL,
 snapshot_digest text NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL,
 CONSTRAINT organization_schedule_quote_terms_shape CHECK((
  jsonb_typeof(snapshot)='object' AND snapshot->>'version'='1'
  AND jsonb_typeof(snapshot->'subscription')='object'
  AND jsonb_typeof(snapshot->'customer')='object'
  AND (snapshot-ARRAY['version','subscription','customer'])='{}'::jsonb
 ) IS TRUE)
);
--> statement-breakpoint
CREATE FUNCTION guard_organization_schedule_quote_terms() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record; s record;
BEGIN
 IF TG_OP <> 'INSERT' THEN
  RAISE EXCEPTION 'Original schedule quote terms are immutable' USING ERRCODE='23514';
 END IF;
 SELECT * INTO q FROM organization_plan_change_quotes WHERE id=NEW.quote_id FOR UPDATE;
 IF NOT FOUND OR q.organization_id<>NEW.organization_id OR q.review->>'kind'<>'downgrade_estimate'
 OR q.consumed_by_command_id IS NOT NULL OR q.expires_at<=clock_timestamp()
 OR NEW.created_at<q.created_at OR NEW.created_at>clock_timestamp() THEN
  RAISE EXCEPTION 'Schedule terms require the original live unconsumed quote' USING ERRCODE='23514';
 END IF;
 SELECT * INTO s FROM billing_subscriptions WHERE id=q.subscription_id AND organization_id=q.organization_id;
 IF NOT FOUND OR s.lifecycle_revision<>q.subscription_revision
 OR (NEW.snapshot->'subscription'->>'id') IS DISTINCT FROM s.stripe_subscription_id
 OR (NEW.snapshot->'subscription'->>'customer') IS DISTINCT FROM s.stripe_customer_id
 OR (NEW.snapshot->'customer'->>'customerId') IS DISTINCT FROM s.stripe_customer_id
 OR (NEW.snapshot->'subscription'->>'livemode') IS DISTINCT FROM (q.provider_binding->>'livemode')
 OR (NEW.snapshot->'customer'->>'livemode') IS DISTINCT FROM (q.provider_binding->>'livemode')
 OR (NEW.snapshot->'subscription'->>'current_period_start')::bigint IS DISTINCT FROM extract(epoch FROM s.current_period_start)::bigint
 OR (NEW.snapshot->'subscription'->>'current_period_end')::bigint IS DISTINCT FROM extract(epoch FROM s.current_period_end)::bigint
 OR (NEW.snapshot->'subscription'->'items'->'data'->0->>'id') IS DISTINCT FROM s.stripe_subscription_item_id
 OR (NEW.snapshot->'subscription'->'items'->'data'->0->'price'->>'id') IS DISTINCT FROM (q.provider_binding->>'sourcePriceId')
 THEN RAISE EXCEPTION 'Schedule terms source changed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER organization_schedule_quote_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_schedule_quote_terms FOR EACH ROW EXECUTE FUNCTION guard_organization_schedule_quote_terms();
--> statement-breakpoint
CREATE FUNCTION require_organization_schedule_quote_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.review->>'kind'='downgrade_estimate' AND OLD.consumed_by_command_id IS NULL AND NEW.consumed_by_command_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM organization_schedule_quote_terms WHERE quote_id=NEW.id AND organization_id=NEW.organization_id)
 THEN RAISE EXCEPTION 'Downgrade quote requires retained provider terms' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER organization_schedule_quote_terms_required BEFORE UPDATE ON organization_plan_change_quotes FOR EACH ROW EXECUTE FUNCTION require_organization_schedule_quote_terms();

--> statement-breakpoint
CREATE FUNCTION require_organization_schedule_effect_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR (OLD.state='ready' AND NEW.state='started') THEN
  IF NOT EXISTS (SELECT 1 FROM organization_plan_change_quotes q JOIN organization_schedule_quote_terms t ON t.quote_id=q.id AND t.organization_id=q.organization_id WHERE q.consumed_by_command_id=NEW.command_id AND q.organization_id=NEW.organization_id) THEN
   RAISE EXCEPTION 'New schedule effects require original retained terms' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER organization_schedule_effect_terms_required BEFORE INSERT OR UPDATE ON organization_schedule_effects FOR EACH ROW EXECUTE FUNCTION require_organization_schedule_effect_terms();
